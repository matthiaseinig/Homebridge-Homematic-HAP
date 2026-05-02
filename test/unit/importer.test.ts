import { describe, it, expect, beforeAll } from 'vitest';
import { Buffer } from 'node:buffer';
import * as zlib from 'node:zlib';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { create as tarCreate } from 'tar';
import {
  importBackupTarball,
  importConfigJson,
  ImportError,
  mergeIntoConfig,
} from '../../src/import/HapHomematicImporter.js';

const SAMPLE_CONFIG = {
  ccuIP: '192.168.1.10',
  channels: ['HmIP.000123:1', 'HmIP.000456:2'],
  variables: ['MyVar'],
  programs: ['MyProg'],
  mappings: {
    'HmIP.000123:1': { Service: 'HomeMaticSwitchAccessory', Type: 'Outlet', instance: 'i1', extra: 'keep' },
    'HmIP.000456:2': { Service: 'HomeMaticDimmerAccessory' },
    'MyVar': { Service: 'HomeMaticVariableAccessory' },
  },
  instances: { i1: { name: 'main' } },
  version: '1.2.3',
};

describe('importConfigJson', () => {
  it('translates known service classes', () => {
    const r = importConfigJson(SAMPLE_CONFIG);
    expect(r.channels).toHaveLength(2);
    const sw = r.channels.find((c) => c.address === 'HmIP.000123:1')!;
    expect(sw.service).toBe('SwitchAccessory');
    expect(sw.subtype).toBe('outlet');
    expect(sw.settings).toEqual({ extra: 'keep' });
    const dim = r.channels.find((c) => c.address === 'HmIP.000456:2')!;
    expect(dim.service).toBe('DimmerAccessory');
    expect(r.variables[0]?.service).toBe('VariableSwitchAccessory');
    expect(r.programs[0]?.name).toBe('MyProg');
  });

  it('warns about unmappable service classes', () => {
    const r = importConfigJson({ ...SAMPLE_CONFIG, mappings: { 'HmIP.000123:1': { Service: 'NopeAccessory' } } });
    expect(r.channels.find((c) => c.address === 'HmIP.000123:1')).toBeUndefined();
    expect(r.warnings.some((w) => /Could not map/.test(w))).toBe(true);
  });

  it('skips empty addresses and names', () => {
    const r = importConfigJson({ channels: ['', 1 as unknown as string], variables: [''], programs: [''] });
    expect(r.channels).toHaveLength(0);
    expect(r.variables).toHaveLength(0);
    expect(r.programs).toHaveLength(0);
  });

  it('accepts a JSON string', () => {
    expect(importConfigJson(JSON.stringify(SAMPLE_CONFIG)).channels).toHaveLength(2);
  });

  it('rejects non-object payloads', () => {
    expect(() => importConfigJson('"hello"')).toThrow(ImportError);
    expect(() => importConfigJson(null as unknown as string)).toThrow(ImportError);
    expect(() => importConfigJson('not json')).toThrow(ImportError);
  });

  it('reports meta', () => {
    const r = importConfigJson(SAMPLE_CONFIG);
    expect(r.meta).toEqual({ instanceCount: 1, sourceVersion: '1.2.3', ccuIp: '192.168.1.10' });
  });
});

describe('mergeIntoConfig', () => {
  it('merges report into existing config without losing entries', () => {
    const existing = {
      channels: [{ address: 'HmIP.X:1', service: 'OldKey' }],
      variables: [{ name: 'Existing' }],
      programs: [{ name: 'OldProg' }],
    };
    const report = importConfigJson(SAMPLE_CONFIG);
    const merged = mergeIntoConfig(existing, report);
    expect(merged.channels?.find((c) => c.address === 'HmIP.X:1')).toBeDefined();
    expect(merged.variables?.find((v) => v.name === 'Existing')).toBeDefined();
    expect(merged.programs?.find((p) => p.name === 'OldProg')).toBeDefined();
  });

  it('does not overwrite existing ccuIp', () => {
    const merged = mergeIntoConfig({ ccuIp: '10.0.0.1' }, importConfigJson(SAMPLE_CONFIG));
    expect(merged.ccuIp).toBe('10.0.0.1');
  });

  it('uses report ccuIp if missing', () => {
    const merged = mergeIntoConfig({}, importConfigJson(SAMPLE_CONFIG));
    expect(merged.ccuIp).toBe('192.168.1.10');
  });
});

describe('importBackupTarball', () => {
  let tmpDir = '';
  let tarballPath = '';

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-import-'));
    await fs.writeFile(path.join(tmpDir, 'config.json'), JSON.stringify(SAMPLE_CONFIG));
    await fs.writeFile(path.join(tmpDir, 'irrelevant.txt'), 'noise');
    tarballPath = path.join(tmpDir, 'backup.tar.gz');

    await tarCreate({ gzip: true, file: tarballPath, cwd: tmpDir }, ['config.json', 'irrelevant.txt']);
  });

  it('extracts config.json from a real .tar.gz', async () => {
    const buf = await fs.readFile(tarballPath);
    const r = await importBackupTarball(buf);
    expect(r.channels.length).toBeGreaterThan(0);
  });

  it('rejects empty buffer', async () => {
    await expect(importBackupTarball(Buffer.alloc(0))).rejects.toThrow(ImportError);
    await expect(importBackupTarball('not a buffer' as unknown as Buffer)).rejects.toThrow(ImportError);
  });

  it('rejects oversized tarball', async () => {
    const big = Buffer.alloc(70 * 1024 * 1024);
    await expect(importBackupTarball(big)).rejects.toThrow(/larger than/);
  });

  it('reports missing config.json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-import-empty-'));
    await fs.writeFile(path.join(dir, 'empty.txt'), '');
    const empty = path.join(dir, 'empty.tar.gz');
    await tarCreate({ gzip: true, file: empty, cwd: dir }, ['empty.txt']);
    const buf = await fs.readFile(empty);
    await expect(importBackupTarball(buf)).rejects.toThrow(/No config\.json/);
  });

  it('reports invalid JSON in config.json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-import-bad-'));
    await fs.writeFile(path.join(dir, 'config.json'), 'not json');
    const tar = path.join(dir, 'bad.tar.gz');
    await tarCreate({ gzip: true, file: tar, cwd: dir }, ['config.json']);
    const buf = await fs.readFile(tar);
    await expect(importBackupTarball(buf)).rejects.toThrow(/Invalid JSON/);
  });

  it('rejects gzip with junk content', async () => {
    const junk = zlib.gzipSync(Buffer.from('this is not a tar archive'));
    await expect(importBackupTarball(junk)).rejects.toThrow();
  });
});
