import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { Buffer } from 'node:buffer';
import iconv from 'iconv-lite';
const iconvEncode = iconv.encode.bind(iconv);
import { isSafeIdentifier, RegaClient } from '../../src/ccu/RegaClient.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

interface MockState {
  lastRegaBody: string;
  lastRegaPath: string;
  loginCalls: number;
  nextRegaResponse: Buffer;
  nextRegaStatus: number;
  nextRegaDelay: number;
  nextLoginPayload: unknown;
  nextLoginStatus: number;
  failFirstRegaWith401: boolean;
  authHeader: string | undefined;
}

let server: http.Server;
let port = 0;
let s: MockState;

beforeEach(async () => {
  s = {
    lastRegaBody: '',
    lastRegaPath: '',
    loginCalls: 0,
    nextRegaResponse: iconvEncode('<xml></xml>', 'ISO-8859-1'),
    nextRegaStatus: 200,
    nextRegaDelay: 0,
    nextLoginPayload: { version: '1.1', result: '@SID-from-test@', error: null },
    nextLoginStatus: 200,
    failFirstRegaWith401: false,
    authHeader: undefined,
  };
  server = http.createServer((req, res) => {
    s.authHeader = req.headers.authorization;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '/';
      if (url.startsWith('/api/homematic.cgi')) {
        s.loginCalls++;
        res.writeHead(s.nextLoginStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(s.nextLoginPayload));
        return;
      }
      // /tclrega.exe path
      s.lastRegaBody = Buffer.concat(chunks).toString('utf8');
      s.lastRegaPath = url;
      let status = s.nextRegaStatus;
      if (s.failFirstRegaWith401) {
        status = 401;
        s.failFirstRegaWith401 = false;
      }
      const finish = () => {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=iso-8859-1' });
        if (status >= 400) {
          res.end('error');
        } else {
          res.end(s.nextRegaResponse);
        }
      };
      if (s.nextRegaDelay > 0) {
        setTimeout(finish, s.nextRegaDelay);
      } else {
        finish();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(timeoutMs = 1000, auth?: { username: string; password: string }): RegaClient {
  return new RegaClient({
    host: '127.0.0.1',
    port,
    apiPort: port, // route /api/homematic.cgi through the same mock server
    timeoutMs,
    auth,
    log: new PrefixedLogger(makeLog(), 'rega-test'),
  });
}

describe('isSafeIdentifier', () => {
  it('accepts safe variable names', () => {
    expect(isSafeIdentifier('Living Room')).toBe(true);
    expect(isSafeIdentifier('Heizung_Wohnzimmer')).toBe(true);
    expect(isSafeIdentifier('Tür')).toBe(true);
  });

  it('rejects ReGa-injection chars', () => {
    expect(isSafeIdentifier('"; WriteLine("x")')).toBe(false);
    expect(isSafeIdentifier('foo\\bar')).toBe(false);
    expect(isSafeIdentifier('foo\nbar')).toBe(false);
    expect(isSafeIdentifier('foo;bar')).toBe(false);
    expect(isSafeIdentifier('')).toBe(false);
    expect(isSafeIdentifier(123 as unknown as string)).toBe(false);
  });
});

describe('RegaClient', () => {
  it('throws on empty / oversized scripts', async () => {
    const c = makeClient();
    await expect(c.script('')).rejects.toThrow(/empty/);
    await expect(c.script('a'.repeat(300_000))).rejects.toThrow(/exceeds/);
  });

  it('parses xml + stdout response', async () => {
    s.nextRegaResponse = iconvEncode('hello<xml><x>1</x></xml>', 'ISO-8859-1');
    const c = makeClient();
    const result = await c.script('WriteLine("hi");');
    expect(result.stdout).toBe('hello');
    expect(result.xml).toBe('<x>1</x>');
  });

  it('falls back to stdout when no <xml> envelope', async () => {
    s.nextRegaResponse = iconvEncode('plain text', 'ISO-8859-1');
    const c = makeClient();
    const result = await c.script('WriteLine("hi");');
    expect(result.xml).toBe('');
    expect(result.stdout).toBe('plain text');
  });

  it('decodes ISO-8859-1', async () => {
    s.nextRegaResponse = iconvEncode('Köpenick<xml></xml>', 'ISO-8859-1');
    const c = makeClient();
    expect((await c.script('x')).stdout).toBe('Köpenick');
  });

  it('refuses unsafe variable / program names', async () => {
    const c = makeClient();
    await expect(c.getVariable('foo;bar')).rejects.toThrow(/unsafe/);
    await expect(c.setVariable('foo;bar', true)).rejects.toThrow(/unsafe/);
    await expect(c.runProgram('foo;bar')).rejects.toThrow(/unsafe/);
  });

  it('renders bool, number and string literals safely', async () => {
    const c = makeClient();
    await c.setVariable('Foo', true);
    expect(s.lastRegaBody).toContain('.State(true)');
    await c.setVariable('Foo', false);
    expect(s.lastRegaBody).toContain('.State(false)');
    await c.setVariable('Foo', 12.5);
    expect(s.lastRegaBody).toContain('.State(12.5)');
    await c.setVariable('Foo', 'he"llo');
    expect(s.lastRegaBody).toContain('.State("he\\"llo")');
    await c.setVariable('Foo', 'a\\b');
    expect(s.lastRegaBody).toContain('.State("a\\\\b")');
  });

  it('rejects non-finite numbers', async () => {
    const c = makeClient();
    await expect(c.setVariable('Foo', Infinity)).rejects.toThrow(/non-finite/);
  });

  it('runProgram emits ProgramExecute', async () => {
    const c = makeClient();
    await c.runProgram('Wake up');
    expect(s.lastRegaBody).toContain('ProgramExecute');
  });

  it('getVariable returns trimmed stdout', async () => {
    s.nextRegaResponse = iconvEncode(' 42 \n<xml></xml>', 'ISO-8859-1');
    const c = makeClient();
    expect(await c.getVariable('Foo')).toBe('42');
  });

  it('reports HTTP non-2xx as RegaError', async () => {
    s.nextRegaStatus = 500;
    const c = makeClient();
    await expect(c.script('x')).rejects.toThrow(/HTTP/);
  });

  it('reports timeout', async () => {
    s.nextRegaDelay = 500;
    const c = makeClient(50);
    await expect(c.script('x')).rejects.toThrow(/timeout|failed/);
  });
});

describe('RegaClient session auth', () => {
  it('does NOT call /api/homematic.cgi when auth is unconfigured', async () => {
    const c = makeClient();
    await c.script('x');
    expect(s.loginCalls).toBe(0);
    expect(s.lastRegaPath).toBe('/tclrega.exe');
  });

  it('logs in once and reuses the session id', async () => {
    const c = makeClient(1000, { username: 'admin', password: 'secret' });
    await c.script('a');
    await c.script('b');
    expect(s.loginCalls).toBe(1);
    expect(s.lastRegaPath).toMatch(/^\/tclrega\.exe\?sid=@SID-from-test@$/);
  });

  it('strips wrapper @ chars from the returned sid before re-wrapping', async () => {
    s.nextLoginPayload = { version: '1.1', result: '@@@bare@@@', error: null };
    const c = makeClient(1000, { username: 'admin', password: 'secret' });
    await c.script('a');
    expect(s.lastRegaPath).toMatch(/^\/tclrega\.exe\?sid=@bare@$/);
  });

  it('renews the session on 401 and retries the original call once', async () => {
    s.failFirstRegaWith401 = true;
    const c = makeClient(1000, { username: 'admin', password: 'secret' });
    await c.script('a');
    expect(s.loginCalls).toBe(2);
  });

  it('surfaces a clear error when login fails', async () => {
    s.nextLoginPayload = {
      version: '1.1',
      result: null,
      error: { code: 501, message: 'invalid credentials or too many sessions' },
    };
    const c = makeClient(1000, { username: 'admin', password: 'wrong' });
    await expect(c.script('x')).rejects.toThrow(/CCU auth failed.*invalid credentials/);
  });

  it('rejects malformed JSON responses from /api/homematic.cgi', async () => {
    s.nextLoginPayload = '{not json' as unknown;
    const c = makeClient(1000, { username: 'admin', password: 'x' });
    await expect(c.script('y')).rejects.toThrow(/CCU auth/);
  });

  it('rejects empty session id', async () => {
    s.nextLoginPayload = { version: '1.1', result: '', error: null };
    const c = makeClient(1000, { username: 'admin', password: 'x' });
    await expect(c.script('y')).rejects.toThrow(/empty session/);
  });

  it('does NOT send an HTTP Basic Authorization header (CCU uses session ids)', async () => {
    const c = makeClient(1000, { username: 'admin', password: 'secret' });
    await c.script('x');
    expect(s.authHeader).toBeUndefined();
  });

  it('invalidateSession() forces a fresh login on next call', async () => {
    const c = makeClient(1000, { username: 'admin', password: 'secret' });
    await c.script('a');
    expect(s.loginCalls).toBe(1);
    c.invalidateSession();
    await c.script('b');
    expect(s.loginCalls).toBe(2);
  });
});
