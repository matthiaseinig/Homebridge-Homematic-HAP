/**
 * Modern CCU control-plane client using the JSON-RPC API at
 * /api/homematic.cgi. This replaces the legacy ReGa-script transport
 * that the predecessor plugins (thkl/homebridge-homematic, hap-homematic,
 * AlexanderSchmutz/homebridge-homematic-asaw) all used.
 *
 * Why JSON-RPC instead of ReGa scripts:
 *   - Modern, structured API; methods listed via `system.listMethods`.
 *   - Returns typed JSON, not stringly-typed XML scraped from script
 *     stdout.
 *   - Properly authenticated via `Session.login` + a `_session_id_`
 *     parameter on every authenticated call.
 *   - Doesn't have the script-context permission hole where even an
 *     Admin user's `root.Devices().EnumIDs()` returns empty on some
 *     RaspberryMatic builds.
 *
 * **Event delivery is NOT migrated** — JSON-RPC has no event-push
 * mechanism. The EventServer + per-interface XML-RPC subscriptions
 * remain unchanged. This client is for the *control plane* only:
 * discovery, variable I/O, program execution, value get/set.
 */

import { Buffer } from 'node:buffer';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { PrefixedLogger } from '../util/logger.js';
import type { CcuDevice, CcuInterfaceId, CcuProgram, CcuVariable } from '../types.js';

const API_PORT_HTTP = 80;
const API_PORT_HTTPS = 443;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SAFE_NAME_RE = /^[A-Za-z0-9_\-. äöüÄÖÜß]{1,200}$/;

export interface CcuJsonRpcOptions {
  host: string;
  useTls?: boolean;
  /** Override the default 80/443 API port (mainly for tests). */
  port?: number;
  timeoutMs?: number;
  auth?: { username: string; password: string };
  log: PrefixedLogger;
}

export class JsonRpcError extends Error {
  constructor(message: string, public readonly code?: number, public override readonly cause?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

interface JsonRpcResponse<T> {
  version?: string;
  result?: T;
  error?: { name?: string; code?: number; message?: string } | null;
}

/** Raw API surface — exposed for callers that need methods we don't wrap yet. */
export class CcuJsonRpcClient {
  private readonly host: string;
  private readonly useTls: boolean;
  private readonly portOverride: number | undefined;
  private readonly timeoutMs: number;
  private readonly auth?: { username: string; password: string };
  private readonly log: PrefixedLogger;
  private sessionId: string | undefined;

  constructor(opts: CcuJsonRpcOptions) {
    this.host = opts.host;
    this.useTls = Boolean(opts.useTls);
    this.portOverride = opts.port;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.auth = opts.auth;
    this.log = opts.log;
  }

  /** Drop the cached session id; the next authenticated call will re-login. */
  invalidateSession(): void {
    this.sessionId = undefined;
  }

  /**
   * Invoke a JSON-RPC method, automatically attaching `_session_id_` if
   * authentication is configured. Renews the session once on a 401-style
   * "session expired" response and retries the call.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.callOnce<T>(method, params, false);
  }

  private async callOnce<T>(method: string, params: Record<string, unknown>, retried: boolean): Promise<T> {
    const sid = await this.ensureSession();
    const body = Buffer.from(JSON.stringify({
      version: '1.1',
      method,
      params: sid ? { ...params, _session_id_: sid } : params,
    }), 'utf8');
    const raw = await this.postJson(body);
    const text = raw.toString('utf8');
    let parsed: JsonRpcResponse<T>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new JsonRpcError(`malformed JSON-RPC response from ${method}`);
    }
    if (parsed.error) {
      const code = parsed.error.code;
      const message = parsed.error.message ?? 'unknown error';
      // Code 401/403 with a session-expired hint → re-login once.
      const looksLikeSessionExpiry = (code === 401 || code === 403)
        || /session/i.test(message);
      if (looksLikeSessionExpiry && this.auth && !retried) {
        this.log.debug('JSON-RPC session expired, re-logging in');
        this.invalidateSession();
        return this.callOnce<T>(method, params, true);
      }
      throw new JsonRpcError(`${method}: ${message}`, code);
    }
    return parsed.result as T;
  }

  // --- session ------------------------------------------------------

  private async ensureSession(): Promise<string | undefined> {
    if (!this.auth) {
      return undefined;
    }
    if (this.sessionId) {
      return this.sessionId;
    }
    const body = Buffer.from(JSON.stringify({
      version: '1.1',
      method: 'Session.login',
      params: { username: this.auth.username, password: this.auth.password },
    }), 'utf8');
    const raw = await this.postJson(body);
    const text = raw.toString('utf8');
    let parsed: JsonRpcResponse<string>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new JsonRpcError('CCU auth: malformed JSON response');
    }
    if (parsed.error) {
      throw new JsonRpcError(`CCU auth failed: ${parsed.error.message ?? 'unknown'}`, parsed.error.code);
    }
    if (typeof parsed.result !== 'string' || parsed.result.length === 0) {
      throw new JsonRpcError('CCU auth: empty session id');
    }
    // The CCU may wrap the sid in literal '@' chars; normalise.
    this.sessionId = parsed.result.replace(/^@+|@+$/g, '');
    this.log.debug('Acquired CCU session (length=%d)', this.sessionId.length);
    return this.sessionId;
  }

  // --- high-level helpers -------------------------------------------

  /**
   * One-shot CCU device tree: every device with its channels embedded.
   * Maps RaspberryMatic's `Device.listAllDetail` into our internal shape.
   */
  async listDevices(): Promise<CcuDevice[]> {
    interface RawChannel {
      name?: string;
      address?: string;
      index?: number | string;
      channelType?: string;
    }
    interface RawDevice {
      name?: string;
      address?: string;
      type?: string;
      interface?: string;
      channels?: RawChannel[];
    }
    const result = await this.call<RawDevice[]>('Device.listAllDetail');
    return result.map((d) => ({
      address: d.address ?? '',
      name: d.name ?? '',
      type: d.type ?? '',
      interface: asInterfaceId(d.interface ?? ''),
      channels: (d.channels ?? []).map((c) => ({
        address: c.address ?? '',
        name: c.name ?? '',
        index: typeof c.index === 'number' ? c.index : parseInt(String(c.index ?? 0), 10) || 0,
        type: c.channelType ?? '',
      })),
    }));
  }

  async listVariables(): Promise<CcuVariable[]> {
    interface RawVar {
      id?: string;
      name?: string;
      type?: string; // 'BOOL' | 'FLOAT' | 'ENUM' | 'STRING'
      subtype?: string | number;
      minValue?: number | string;
      maxValue?: number | string;
      unit?: string;
      value?: unknown;
      valueList?: string[];
    }
    const raw = await this.call<RawVar[]>('SysVar.getAll');
    return raw.map((v) => {
      const valuetype = mapVariableValueType(v.type);
      const numericValue = (typeof v.value === 'number')
        ? v.value
        : Number.parseFloat(String(v.value ?? ''));
      let value: boolean | number | string;
      if (valuetype === 2) {
        value = String(v.value).toLowerCase() === 'true' || v.value === true || v.value === 1 || v.value === '1';
      } else if (valuetype === 4) {
        value = Number.isFinite(numericValue) ? numericValue : 0;
      } else {
        value = String(v.value ?? '');
      }
      return {
        id: v.id ?? '',
        name: v.name ?? '',
        valuetype,
        subtype: typeof v.subtype === 'number' ? v.subtype : Number.parseInt(String(v.subtype ?? 0), 10) || 0,
        minValue: numberOrUndef(v.minValue),
        maxValue: numberOrUndef(v.maxValue),
        unit: v.unit || undefined,
        enumValues: v.valueList,
        value,
      };
    });
  }

  async listPrograms(): Promise<CcuProgram[]> {
    interface RawProgram { id?: string; name?: string }
    const raw = await this.call<RawProgram[]>('Program.getAll');
    return raw.map((p) => ({ id: p.id ?? '', name: p.name ?? '' }));
  }

  async listRooms(): Promise<{ id: string; name: string; channelIds: string[] }[]> {
    interface RawRoom { id?: string; name?: string; channelIds?: (string | number)[] }
    const raw = await this.call<RawRoom[]>('Room.getAll');
    return raw.map((r) => ({
      id: String(r.id ?? ''),
      name: r.name ?? '',
      channelIds: (r.channelIds ?? []).map((c) => String(c)),
    }));
  }

  async getInterfaceValue(interfaceName: string, address: string, valueKey: string): Promise<string> {
    return this.call<string>('Interface.getValue', { interface: interfaceName, address, valueKey });
  }

  async setInterfaceValue(
    interfaceName: string,
    address: string,
    valueKey: string,
    type: 'boolean' | 'string' | 'integer' | 'double',
    value: unknown,
  ): Promise<void> {
    await this.call('Interface.setValue', { interface: interfaceName, address, valueKey, type, value });
  }

  async getVariable(name: string): Promise<string> {
    if (!isSafeIdentifier(name)) {
      throw new JsonRpcError(`unsafe variable name: ${name}`);
    }
    const raw = await this.call<string | number | boolean>('SysVar.getValueByName', { name });
    return String(raw);
  }

  async setVariable(name: string, value: string | number | boolean): Promise<void> {
    if (!isSafeIdentifier(name)) {
      throw new JsonRpcError(`unsafe variable name: ${name}`);
    }
    interface RawVar { id?: string; name?: string; type?: string }
    // Look up the SysVar id + type — the JSON-RPC setters need an id.
    const all = await this.call<RawVar[]>('SysVar.getAll');
    const found = all.find((v) => v.name === name);
    if (!found?.id) {
      throw new JsonRpcError(`SysVar not found: ${name}`);
    }
    const t = (found.type ?? '').toUpperCase();
    if (t === 'BOOL') {
      await this.call('SysVar.setBool', { id: found.id, value: Boolean(value) });
    } else if (t === 'FLOAT') {
      const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
      if (!Number.isFinite(n)) {
        throw new JsonRpcError('Cannot store non-finite number in SysVar');
      }
      await this.call('SysVar.setFloat', { id: found.id, value: n });
    } else if (t === 'ENUM') {
      await this.call('SysVar.setEnum', { id: found.id, value });
    } else {
      // STRING or unknown — try generic setValue if it exists, otherwise float.
      await this.call('SysVar.setFloat', { id: found.id, value });
    }
  }

  async runProgram(name: string): Promise<void> {
    if (!isSafeIdentifier(name)) {
      throw new JsonRpcError(`unsafe program name: ${name}`);
    }
    interface RawProgram { id?: string; name?: string }
    const all = await this.call<RawProgram[]>('Program.getAll');
    const found = all.find((p) => p.name === name);
    if (!found?.id) {
      throw new JsonRpcError(`Program not found: ${name}`);
    }
    await this.call('Program.execute', { id: found.id });
  }

  // --- HTTP plumbing ------------------------------------------------

  private postJson(body: Buffer): Promise<Buffer> {
    const port = this.portOverride ?? (this.useTls ? API_PORT_HTTPS : API_PORT_HTTP);
    const reqFn = this.useTls ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
    };
    const opts: RequestOptions & { rejectUnauthorized?: boolean } = {
      host: this.host,
      port,
      method: 'POST',
      path: '/api/homematic.cgi',
      headers,
      timeout: this.timeoutMs,
    };
    if (this.useTls) {
      opts.rejectUnauthorized = false;
    }
    return new Promise<Buffer>((resolve, reject) => {
      const req = reqFn(opts, (res: IncomingMessage) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new JsonRpcError(`HTTP ${res.statusCode ?? 'unknown'}`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            res.destroy(new JsonRpcError('JSON-RPC response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', (err) => reject(new JsonRpcError('JSON-RPC response error', undefined, err)));
      });
      req.on('timeout', () => {
        req.destroy(new JsonRpcError(`JSON-RPC timeout after ${this.timeoutMs} ms`));
      });
      req.on('error', (err) => reject(new JsonRpcError('JSON-RPC request failed', undefined, err)));
      req.write(body);
      req.end();
    });
  }
}

// --- helpers --------------------------------------------------------

export function isSafeIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (!SAFE_NAME_RE.test(value)) {
    return false;
  }
  return !/["\\\r\n;]/.test(value);
}

function numberOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') {
    return undefined;
  }
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

function mapVariableValueType(type: string | undefined): number {
  switch ((type ?? '').toUpperCase()) {
    case 'BOOL': return 2;
    case 'FLOAT': return 4;
    case 'STRING': return 16;
    case 'ENUM': return 20;
    default: return 0;
  }
}

function asInterfaceId(name: string): CcuInterfaceId {
  if (name === 'BidCos-RF' || name === 'HmIP-RF' || name === 'BidCos-Wired'
      || name === 'VirtualDevices' || name === 'CUxD') {
    return name;
  }
  if (/hmip/i.test(name)) {
    return 'HmIP-RF';
  }
  if (/cux/i.test(name)) {
    return 'CUxD';
  }
  if (/virt/i.test(name)) {
    return 'VirtualDevices';
  }
  if (/wired/i.test(name)) {
    return 'BidCos-Wired';
  }
  return 'BidCos-RF';
}
