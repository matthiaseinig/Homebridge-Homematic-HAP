/**
 * Talks to the CCU's TCL/ReGa interpreter via HTTP POST to /tclrega.exe.
 * Used for everything that doesn't fit XML-RPC: device discovery, room
 * lookup, variable read/write, program execution.
 *
 * Responses are ISO-8859-1 (Latin-1) and contain a chunk of XML. We
 * never eval or otherwise execute the response — we treat it as text and
 * extract values with a small parser in `parseRegaResult`.
 */

import { Buffer } from 'node:buffer';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { decode as iconvDecode } from 'iconv-lite';
import type { PrefixedLogger } from '../util/logger.js';

const REGA_PORT_HTTP = 8181;
const REGA_PORT_HTTPS = 48181;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SCRIPT_LENGTH = 256 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface RegaClientOptions {
  host: string;
  useTls?: boolean;
  /** Override the default 8181/48181 ports (mainly for tests). */
  port?: number;
  timeoutMs?: number;
  auth?: { username: string; password: string };
  log: PrefixedLogger;
}

export interface RegaResult {
  /** Body XML between <xml>…</xml>, decoded to UTF-8. */
  xml: string;
  /** Raw stdout (often empty), decoded. */
  stdout: string;
}

export class RegaError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'RegaError';
  }
}

export class RegaClient {
  private readonly host: string;
  private readonly useTls: boolean;
  private readonly portOverride: number | undefined;
  private readonly timeoutMs: number;
  private readonly auth?: { username: string; password: string };
  private readonly log: PrefixedLogger;

  constructor(opts: RegaClientOptions) {
    this.host = opts.host;
    this.useTls = Boolean(opts.useTls);
    this.portOverride = opts.port;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.auth = opts.auth;
    this.log = opts.log;
  }

  /** Execute a ReGa script, return parsed result. */
  async script(source: string): Promise<RegaResult> {
    if (typeof source !== 'string' || source.length === 0) {
      throw new RegaError('ReGa script is empty');
    }
    if (source.length > MAX_SCRIPT_LENGTH) {
      throw new RegaError(`ReGa script exceeds ${MAX_SCRIPT_LENGTH} bytes`);
    }
    const body = Buffer.from(source, 'utf8');
    this.log.debug('Sending ReGa script (%d bytes)', body.length);

    const raw = await this.post(body);
    return this.parseRegaResult(raw);
  }

  /** Get a single CCU variable's value. */
  async getVariable(name: string): Promise<string> {
    if (!isSafeIdentifier(name)) {
      throw new RegaError(`Refusing to query ReGa with unsafe variable name: ${name}`);
    }
    const out = await this.script(
      `var v=dom.GetObject(ID_SYSTEM_VARIABLES).Get("${name}");WriteLine(v.Value());`,
    );
    return out.stdout.trim();
  }

  /** Set a single CCU variable. The value is always sent as a quoted literal. */
  async setVariable(name: string, value: string | number | boolean): Promise<void> {
    if (!isSafeIdentifier(name)) {
      throw new RegaError(`Refusing to assign ReGa variable with unsafe name: ${name}`);
    }
    const literal = renderLiteral(value);
    await this.script(`dom.GetObject(ID_SYSTEM_VARIABLES).Get("${name}").State(${literal});`);
  }

  /** Run a CCU program. */
  async runProgram(name: string): Promise<void> {
    if (!isSafeIdentifier(name)) {
      throw new RegaError(`Refusing to run ReGa program with unsafe name: ${name}`);
    }
    await this.script(`dom.GetObject(ID_PROGRAMS).Get("${name}").ProgramExecute();`);
  }

  private parseRegaResult(raw: Buffer): RegaResult {
    const text = iconvDecode(raw, 'ISO-8859-1');
    const xmlOpen = text.lastIndexOf('<xml>');
    const xmlClose = text.lastIndexOf('</xml>');
    if (xmlOpen === -1 || xmlClose === -1 || xmlClose < xmlOpen) {
      // Some scripts produce no XML envelope, only stdout.
      return { xml: '', stdout: text };
    }
    const xml = text.slice(xmlOpen + '<xml>'.length, xmlClose);
    const stdout = text.slice(0, xmlOpen);
    return { xml, stdout };
  }

  private post(body: Buffer): Promise<Buffer> {
    const port = this.portOverride ?? (this.useTls ? REGA_PORT_HTTPS : REGA_PORT_HTTP);
    const reqFn = this.useTls ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=iso-8859-1',
      'Content-Length': String(body.length),
    };
    if (this.auth) {
      const token = Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64');
      headers['Authorization'] = `Basic ${token}`;
    }

    return new Promise<Buffer>((resolve, reject) => {
      const req = reqFn(
        {
          host: this.host,
          port,
          method: 'POST',
          path: '/tclrega.exe',
          headers,
          // CCU presents a self-signed cert; we accept it but only when the
          // user explicitly opted into TLS for this host.
          rejectUnauthorized: false,
          timeout: this.timeoutMs,
        },
        (res: IncomingMessage) => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            reject(new RegaError(`ReGa HTTP ${res.statusCode ?? 'unknown'}`));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_RESPONSE_BYTES) {
              res.destroy(new RegaError('ReGa response too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', (err) => reject(new RegaError('ReGa response error', err)));
        },
      );
      req.on('timeout', () => {
        req.destroy(new RegaError(`ReGa timeout after ${this.timeoutMs} ms`));
      });
      req.on('error', (err) => reject(new RegaError('ReGa request failed', err)));
      req.write(body);
      req.end();
    });
  }
}

const SAFE_NAME_RE = /^[A-Za-z0-9_\-. äöüÄÖÜß]{1,200}$/;

export function isSafeIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (!SAFE_NAME_RE.test(value)) {
    return false;
  }
  // Belt and braces: explicitly reject any character that would let the
  // string break out of a quoted ReGa literal even though SAFE_NAME_RE
  // already forbids them.
  return !/["\\\r\n;]/.test(value);
}

function renderLiteral(value: string | number | boolean): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RegaError('Cannot render non-finite number as ReGa literal');
    }
    return String(value);
  }
  // Strings — escape \ and ". The ReGa parser treats both specially.
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}
