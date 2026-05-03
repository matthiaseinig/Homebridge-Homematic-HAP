/**
 * Talks to the CCU's TCL/ReGa interpreter via HTTP POST to /tclrega.exe.
 * Used for everything that doesn't fit XML-RPC: device discovery, room
 * lookup, variable read/write, program execution.
 *
 * Responses are ISO-8859-1 (Latin-1) and contain a chunk of XML. We
 * never eval or otherwise execute the response — we treat it as text and
 * extract values with a small parser in `parseRegaResult`.
 *
 * **Authentication.** RaspberryMatic / CCU3 do not use HTTP Basic auth on
 * /tclrega.exe; they use a session-token model:
 *
 *   1. POST {"version":"1.1","method":"Session.login","params":{...}}
 *      to /api/homematic.cgi (port 80 / 443) → returns a session id.
 *   2. Subsequent ReGa requests pass that id as `?sid=<id>` on the URL.
 *
 * We acquire a session lazily on first authenticated call, cache it on
 * the client, and renew transparently on 401.
 */

import { Buffer } from 'node:buffer';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
// iconv-lite is a CommonJS module; the named-import form only works under
// vitest's esbuild transform, not in real Node ESM. Default import + namespace
// access is the portable form.
import iconv from 'iconv-lite';
import type { PrefixedLogger } from '../util/logger.js';

const REGA_PORT_HTTP = 8181;
const REGA_PORT_HTTPS = 48181;
const API_PORT_HTTP = 80;
const API_PORT_HTTPS = 443;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SCRIPT_LENGTH = 256 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface RegaClientOptions {
  host: string;
  useTls?: boolean;
  /** Override the default 8181/48181 ports (mainly for tests). */
  port?: number;
  /** Override the default 80/443 port for /api/homematic.cgi (mainly for tests). */
  apiPort?: number;
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
  private readonly apiPortOverride: number | undefined;
  private readonly timeoutMs: number;
  private readonly auth?: { username: string; password: string };
  private readonly log: PrefixedLogger;
  private sessionId: string | undefined;

  constructor(opts: RegaClientOptions) {
    this.host = opts.host;
    this.useTls = Boolean(opts.useTls);
    this.portOverride = opts.port;
    this.apiPortOverride = opts.apiPort;
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

    const raw = await this.postRega(body);
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

  /** Drop the cached session id; the next authenticated call will re-login. */
  invalidateSession(): void {
    this.sessionId = undefined;
  }

  private parseRegaResult(raw: Buffer): RegaResult {
    const text = iconv.decode(raw, 'ISO-8859-1');
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

  // --- session auth -------------------------------------------------

  /**
   * Lazily acquire a CCU session id when authentication is configured.
   * Returns undefined if no auth is configured (so callers can omit the
   * `?sid=` query param on open CCUs).
   */
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

    const raw = await this.httpRequest(
      this.apiPortOverride ?? (this.useTls ? API_PORT_HTTPS : API_PORT_HTTP),
      '/api/homematic.cgi',
      body,
      'application/json',
    );
    const text = raw.toString('utf8');
    let parsed: { result?: unknown; error?: { message?: string } };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RegaError('CCU auth: malformed JSON response');
    }
    if (parsed.error) {
      throw new RegaError(`CCU auth failed: ${parsed.error.message ?? 'unknown'}`);
    }
    if (typeof parsed.result !== 'string' || parsed.result.length === 0) {
      throw new RegaError('CCU auth: empty session id');
    }
    // The CCU returns the sid wrapped in literal '@' chars in some
    // contexts. Normalise to the bare value; we re-wrap on use.
    this.sessionId = parsed.result.replace(/^@+|@+$/g, '');
    this.log.debug('Acquired CCU session (length=%d)', this.sessionId.length);
    return this.sessionId;
  }

  // --- HTTP plumbing -----------------------------------------------

  /** POST to /tclrega.exe; renews session once on 401. */
  private async postRega(body: Buffer): Promise<Buffer> {
    const sid = await this.ensureSession();
    try {
      return await this.postRegaOnce(body, sid);
    } catch (err) {
      if (err instanceof RegaError && /HTTP 401/.test(err.message) && this.auth) {
        this.log.debug('CCU rejected session, renewing');
        this.invalidateSession();
        const fresh = await this.ensureSession();
        return await this.postRegaOnce(body, fresh);
      }
      throw err;
    }
  }

  private async postRegaOnce(body: Buffer, sid: string | undefined): Promise<Buffer> {
    const port = this.portOverride ?? (this.useTls ? REGA_PORT_HTTPS : REGA_PORT_HTTP);
    const path = sid ? `/tclrega.exe?sid=@${encodeURIComponent(sid)}@` : '/tclrega.exe';
    return this.httpRequest(port, path, body, 'text/plain; charset=iso-8859-1');
  }

  private httpRequest(port: number, path: string, body: Buffer, contentType: string): Promise<Buffer> {
    const reqFn = this.useTls ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(body.length),
    };
    const opts: RequestOptions & { rejectUnauthorized?: boolean } = {
      host: this.host,
      port,
      method: 'POST',
      path,
      headers,
      timeout: this.timeoutMs,
    };
    if (this.useTls) {
      // CCU presents a self-signed cert; we accept it but only when the
      // user explicitly opted into TLS for this host.
      opts.rejectUnauthorized = false;
    }

    return new Promise<Buffer>((resolve, reject) => {
      const req = reqFn(opts, (res: IncomingMessage) => {
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
      });
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
