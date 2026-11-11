/**
 * The command line tools for the multi-bridge cutover: the generator
 * (hap-homematic backup -> one multi-bridge block) and the batch
 * enable/disable tool. They run the built plugin (dist/), like on the Mac.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create as tarCreate } from 'tar';
import { resolveConfig } from '../../src/util/config.js';
import type { RawConfig } from '../../src/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEN = path.join(root, 'scripts', 'hap-homematic-to-config.mjs');
const ENABLE = path.join(root, 'scripts', 'multi-bridge-enable.mjs');

const INST_A = '2595a84c-0000-4000-8000-00000000000a';
const INST_B = 'aaaa7332-0000-4000-8000-00000000000b';
const PIN_A = '111-22-333';
const PIN_B = '444-55-666';
const CONFIG = {
  instances: {
    [INST_A]: { name: 'Room_A', user: 'CC:22:3D:E3:CE:0A', pincode: PIN_A, setupID: 'AB12', publishDevices: true },
    [INST_B]: { name: 'Room B', user: 'CC:22:3D:E3:CE:0B', pincode: PIN_B, setupID: 'CD34', publishDevices: true },
    'empty-instance': { name: 'Empty', user: 'CC:22:3D:E3:CE:0E', pincode: '777-88-999', publishDevices: true },
  },
  mappings: {
    '0000AAAAAAAAAA:4': { name: 'Blind A', Service: 'HomeMaticBlindIPAccessory', instance: [INST_A], settings: {} },
    '0000BBBBBBBBBB:3': { name: 'Lamp B', Service: 'HomeMaticSwitchAccessory', instance: [INST_B], settings: { Type: 'Lightbulb' } },
  },
  channels: ['0000AAAAAAAAAA:4', '0000BBBBBBBBBB:3'],
  variables: [],
  programs: [],
};
const DEVICES = {
  devices: [
    { id: 1, name: 'a', address: '0000AAAAAAAAAA', type: 'HmIPW-DRBL4', channels: [{ id: 11, name: 'c', address: '0000AAAAAAAAAA:4', type: 'BLIND_VIRTUAL_RECEIVER' }] },
    { id: 2, name: 'b', address: '0000BBBBBBBBBB', type: 'HmIPW-DRS8', channels: [{ id: 21, name: 'c', address: '0000BBBBBBBBBB:3', type: 'SWITCH_VIRTUAL_RECEIVER' }] },
  ],
};

let dir = '';
let tarball = '';

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hmhap-scripts-'));
  await fs.mkdir(path.join(dir, 'persist'));
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(CONFIG));
  await fs.writeFile(path.join(dir, 'devices.json'), JSON.stringify(DEVICES));
  for (const id of ['CC223DE3CE0A', 'CC223DE3CE0B']) {
    await fs.writeFile(path.join(dir, 'persist', `AccessoryInfo.${id}.json`), JSON.stringify({ signSk: 'fake', pincode: 'x' }));
    await fs.writeFile(path.join(dir, 'persist', `IdentifierCache.${id}.json`), JSON.stringify({ cache: {} }));
  }
  tarball = path.join(dir, 'backup.tar.gz');
  await tarCreate({ gzip: true, file: tarball, cwd: dir }, ['./config.json', './devices.json', './persist']);
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const gen = (args: string[]) => spawnSync(process.execPath, [GEN, tarball, '--ccu-ip', '10.0.0.2', ...args], { encoding: 'utf8' });
const enable = (args: string[]) => spawnSync(process.execPath, [ENABLE, ...args], { encoding: 'utf8' });
const readJson = async (f: string) => JSON.parse(await fs.readFile(f, 'utf8'));

describe('hap-homematic-to-config.mjs (multi-bridge layout)', () => {
  it('emits one valid block, every bridge disabled unless --enable, identities preserved', async () => {
    const out = path.join(dir, 'multi.json');
    const persistOut = path.join(dir, 'p-out');
    const r = gen(['--out', out, '--enable', 'Room_A', '--smoke-bridge', '0000AAAAAAAAAA:4', '--persist-out', persistOut, '--persist-bridge', 'Room_A']);
    expect(r.status, r.stderr).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/111-22-333|444-55-666|AB12|CD34/);
    expect(r.stderr).toMatch(/1 multi-bridge block, 3 bridge\(s\), 1 enabled/);
    expect(statSync(out).mode & 0o777).toBe(0o600);

    const blocks = await readJson(out);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block.channels).toBeUndefined();
    expect(block._bridge.username).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/);
    const bridges = block.multiBridge.bridges;
    expect(bridges.map((b: { name: string; enabled: boolean }) => [b.name, b.enabled])).toEqual([
      ['HomeMatic Room A', true],
      ['HomeMatic Room B', false],
      ['HomeMatic Smoke Test', false],
    ]);
    expect(bridges[0]).toMatchObject({ username: 'CC:22:3D:E3:CE:0A', pincode: PIN_A, setupID: 'AB12', bridgeUuid: INST_A });
    expect(bridges[0].channels[0].uuidSeed).toBe('BLIND_VIRTUAL_RECEIVER:Blind A');
    expect(bridges[2]).toMatchObject({ newIdentity: true, hapHomematicIdentity: false });
    expect(bridges[2].username).not.toMatch(/^CC:22/);

    const resolved = resolveConfig(block as RawConfig);
    expect(resolved.channels.map((c) => c.address)).toEqual(['0000AAAAAAAAAA:4']);

    expect((await fs.readdir(persistOut)).sort()).toEqual(['AccessoryInfo.CC223DE3CE0A.json', 'IdentifierCache.CC223DE3CE0A.json']);
    expect(statSync(path.join(persistOut, 'AccessoryInfo.CC223DE3CE0A.json')).mode & 0o777).toBe(0o600);
  });

  it('still writes the per-bridge layout on request', async () => {
    const r = gen(['--per-bridge-blocks', '--preserve-identity']);
    expect(r.status, r.stderr).toBe(0);
    const blocks = JSON.parse(r.stdout);
    expect(blocks.map((b: { name: string }) => b.name)).toEqual(['HomeMatic Room A', 'HomeMatic Room B']);
    expect(blocks[0]._bridge.username).toBe('CC:22:3D:E3:CE:0A');
  });

  it('rejects unknown names and options that need the multi-bridge layout', () => {
    expect(gen(['--enable', 'Nope']).stderr).toMatch(/--enable: no non-empty hap-homematic bridge named: Nope/);
    expect(gen(['--per-bridge-blocks', '--enable', 'Room_A']).stderr).toMatch(/need the multi-bridge layout/);
    expect(gen(['--frobnicate']).stderr).toMatch(/Unknown option/);
  });
});

describe('multi-bridge-enable.mjs', () => {
  async function homebridgeConfig(): Promise<string> {
    const r = gen([]);
    const file = path.join(dir, `config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const doc = { bridge: { name: 'Homebridge' }, platforms: [{ platform: 'Other' }, ...JSON.parse(r.stdout)] };
    await fs.writeFile(file, JSON.stringify(doc, null, 4), { mode: 0o640 });
    return file;
  }

  it('enables and disables named bridges in a Homebridge config.json, keeping mode and indentation', async () => {
    const file = await homebridgeConfig();
    const r = enable([file, '--bridge', 'HomeMatic Room B']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Enabled: HomeMatic Room B/);
    expect(r.stdout).toMatch(/^enabled +HomeMatic Room B$/m);
    expect(r.stdout).toMatch(/^disabled +HomeMatic Room A$/m);
    expect(r.stdout).not.toMatch(/444-55-666|111-22-333/);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    const text = await fs.readFile(file, 'utf8');
    expect(text).toMatch(/\n {4}"platforms"/);
    const doc = JSON.parse(text);
    expect(doc.platforms[0]).toEqual({ platform: 'Other' });
    expect(doc.platforms[1].multiBridge.bridges[1].enabled).toBe(true);

    expect(enable([file, '--bridge', 'HomeMatic Room B']).stdout).toMatch(/No change/);
    const off = enable([file, '--disable', '--bridge', 'HomeMatic Room B']);
    expect(off.stdout).toMatch(/Disabled: HomeMatic Room B/);
    expect((await readJson(file)).platforms[1].multiBridge.bridges[1].enabled).toBe(false);
  });

  it('dry run, list, unknown names and missing persist files change nothing', async () => {
    const file = await homebridgeConfig();
    const before = await fs.readFile(file, 'utf8');
    expect(enable([file, '--bridge', 'HomeMatic Room A', '--dry-run']).stdout).toMatch(/Would enable: HomeMatic Room A/);
    expect(enable([file, '--list']).stdout).toMatch(/^disabled +HomeMatic Room A$/m);
    const unknown = enable([file, '--bridge', 'Nope']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown bridge/);
    const lacking = enable([file, '--bridge', 'HomeMatic Room A', '--persist-dir', path.join(dir, 'empty-persist')]);
    expect(lacking.status).toBe(1);
    expect(lacking.stderr).toMatch(/Persist files missing for: HomeMatic Room A/);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    const ok = enable([file, '--bridge', 'HomeMatic Room A', '--persist-dir', path.join(dir, 'persist')]);
    expect(ok.status, ok.stderr).toBe(0);
  });

  it('needs a multi-bridge block and picks one by --block when there are several', async () => {
    const plain = path.join(dir, 'plain.json');
    await fs.writeFile(plain, JSON.stringify({ platform: 'HomematicHap', name: 'x' }));
    expect(enable([plain, '--list']).stderr).toMatch(/No HomematicHap multi-bridge block/);
    const two = path.join(dir, 'two.json');
    const block = JSON.parse(execFileSync(process.execPath, [GEN, tarball, '--ccu-ip', '10.0.0.2'], { encoding: 'utf8' }))[0];
    await fs.writeFile(two, JSON.stringify([block, { ...block, name: 'Second' }], null, 2));
    expect(enable([two, '--list']).stderr).toMatch(/pick one with --block/);
    expect(enable([two, '--list', '--block', 'Second']).status).toBe(0);
    expect(enable([]).status).toBe(2);
  });
});
