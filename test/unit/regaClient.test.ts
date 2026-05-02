import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { Buffer } from 'node:buffer';
import { encode as iconvEncode } from 'iconv-lite';
import { isSafeIdentifier, RegaClient } from '../../src/ccu/RegaClient.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

let server: http.Server;
let port = 0;
let lastBody = '';
let nextResponse: Buffer = Buffer.from('');
let nextStatus = 200;
let nextDelay = 0;

beforeEach(async () => {
  lastBody = '';
  nextResponse = iconvEncode('<xml></xml>', 'ISO-8859-1');
  nextStatus = 200;
  nextDelay = 0;
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      const finish = () => {
        res.writeHead(nextStatus, { 'Content-Type': 'text/plain; charset=iso-8859-1' });
        res.end(nextResponse);
      };
      if (nextDelay > 0) {
        setTimeout(finish, nextDelay);
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
    nextResponse = iconvEncode('hello<xml><x>1</x></xml>', 'ISO-8859-1');
    const c = makeClient();
    const result = await c.script('WriteLine("hi");');
    expect(result.stdout).toBe('hello');
    expect(result.xml).toBe('<x>1</x>');
  });

  it('falls back to stdout when no <xml> envelope', async () => {
    nextResponse = iconvEncode('plain text', 'ISO-8859-1');
    const c = makeClient();
    const result = await c.script('WriteLine("hi");');
    expect(result.xml).toBe('');
    expect(result.stdout).toBe('plain text');
  });

  it('decodes ISO-8859-1', async () => {
    nextResponse = iconvEncode('Köpenick<xml></xml>', 'ISO-8859-1');
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
    expect(lastBody).toContain('.State(true)');
    await c.setVariable('Foo', false);
    expect(lastBody).toContain('.State(false)');
    await c.setVariable('Foo', 12.5);
    expect(lastBody).toContain('.State(12.5)');
    await c.setVariable('Foo', 'he"llo');
    expect(lastBody).toContain('.State("he\\"llo")');
    await c.setVariable('Foo', 'a\\b');
    expect(lastBody).toContain('.State("a\\\\b")');
  });

  it('rejects non-finite numbers', async () => {
    const c = makeClient();
    await expect(c.setVariable('Foo', Infinity)).rejects.toThrow(/non-finite/);
  });

  it('runProgram emits ProgramExecute', async () => {
    const c = makeClient();
    await c.runProgram('Wake up');
    expect(lastBody).toContain('ProgramExecute');
  });

  it('getVariable returns trimmed stdout', async () => {
    nextResponse = iconvEncode(' 42 \n<xml></xml>', 'ISO-8859-1');
    const c = makeClient();
    expect(await c.getVariable('Foo')).toBe('42');
  });

  it('reports HTTP non-2xx as RegaError', async () => {
    nextStatus = 500;
    const c = makeClient();
    await expect(c.script('x')).rejects.toThrow(/HTTP/);
  });

  it('reports timeout', async () => {
    nextDelay = 500;
    const c = makeClient(50);
    await expect(c.script('x')).rejects.toThrow(/timeout|failed/);
  });

  it('emits Authorization header when auth is set', async () => {
    let capturedHeaders: http.IncomingHttpHeaders = {};
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      capturedHeaders = req.headers;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=iso-8859-1' });
        res.end(iconvEncode('<xml></xml>', 'ISO-8859-1'));
      });
    });
    const c = makeClient(1000, { username: 'admin', password: 'hunter2' });
    await c.script('x');
    expect(capturedHeaders.authorization).toMatch(/^Basic /);
  });
});
