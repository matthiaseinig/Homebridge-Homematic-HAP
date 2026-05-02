import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PluginStorage, StorageError } from '../../src/util/storage.js';

let tmp = '';
function makeApi(storagePath: string) {
  return { user: { storagePath: () => storagePath } };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-storage-test-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('PluginStorage', () => {
  it('confines files to storage root', () => {
    const s = new PluginStorage(makeApi(tmp));
    expect(() => s.resolve('../escape')).toThrow(StorageError);
    expect(() => s.resolve('foo/../../escape')).toThrow(StorageError);
    expect(() => s.resolve('foo bar')).toThrow(StorageError);
    expect(() => s.resolve('')).toThrow(StorageError);
    expect(() => s.resolve('a'.repeat(250))).toThrow(StorageError);
  });

  it('writes and reads JSON', async () => {
    const s = new PluginStorage(makeApi(tmp));
    await s.writeJson('foo.json', { a: 1 });
    expect(await s.readJson<{ a: number }>('foo.json')).toEqual({ a: 1 });
  });

  it('returns undefined when missing', async () => {
    const s = new PluginStorage(makeApi(tmp));
    expect(await s.readJson('missing.json')).toBeUndefined();
  });

  it('removes files', async () => {
    const s = new PluginStorage(makeApi(tmp));
    await s.writeJson('foo.json', { a: 1 });
    await s.remove('foo.json');
    expect(await s.readJson('foo.json')).toBeUndefined();
  });

  it('remove on missing file is a no-op', async () => {
    const s = new PluginStorage(makeApi(tmp));
    await expect(s.remove('nope.json')).resolves.toBeUndefined();
  });

  it('writes nested paths with mkdir -p semantics', async () => {
    const s = new PluginStorage(makeApi(tmp));
    await s.writeJson('a/b/c.json', { ok: true });
    expect(await s.readJson('a/b/c.json')).toEqual({ ok: true });
  });

  it('rootPath returns the resolved root', () => {
    const s = new PluginStorage(makeApi(tmp));
    expect(s.rootPath().startsWith(tmp)).toBe(true);
  });

  it('readJson rethrows non-ENOENT errors', async () => {
    const s = new PluginStorage(makeApi(tmp));
    // Path with bad name forces resolve() to throw.
    await expect(s.readJson('../escape')).rejects.toThrow(StorageError);
  });

  it('remove rethrows non-ENOENT errors', async () => {
    const s = new PluginStorage(makeApi(tmp));
    // Pass an invalid name that hits resolve()'s validator.
    await expect(s.remove('../escape')).rejects.toThrow(StorageError);
  });

  it('readJson rethrows JSON parse errors', async () => {
    const s = new PluginStorage(makeApi(tmp));
    // Manually plant a malformed file
    await s.ensureRoot();
    await fs.writeFile(path.join(s.rootPath(), 'bad.json'), '{not json}');
    await expect(s.readJson('bad.json')).rejects.toThrow();
  });
});
