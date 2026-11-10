/**
 * Behaviour needed to replace a real hap-homematic 0.0.63 installation:
 * the export's actual shape (instance arrays, `<var>:0` mapping keys,
 * nested settings), hap-homematic HomeKit identities, Homematic IP
 * thermostats, door openers that must switch off again, key-press
 * switches, and several platform blocks on one host.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create as tarCreate } from 'tar';
import { uuid as hapUuidLib } from '@homebridge/hap-nodejs';
import {
  HAP_HOMEMATIC_DEFAULT_INSTANCE,
  channelTypesFromDevicesJson,
  hapHomematicBridgeName,
  hapUuid,
  importBackupTarball,
  importConfigJson,
  mergeIntoConfig,
  splitReportIntoBridges,
  ImportError,
} from '../../src/import/HapHomematicImporter.js';
import { CcuClient, callbackIdFor } from '../../src/ccu/CcuClient.js';
import { EventServer } from '../../src/ccu/EventServer.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { resolveConfig } from '../../src/util/config.js';
import { asPlatformAccessory, makeAccessory, makeHapStub, makeLog, type CharacteristicStub, type ServiceStub } from '../helpers/hapStub.js';
import type { AccessoryContext, CcuChannel, RawConfig } from '../../src/types.js';
import type { ServiceContext } from '../../src/services/types.js';
import { thermostatService, thermostatProfileFor } from '../../src/services/impl/ThermostatAccessory.js';
import { doorOpenerService, doorOpenerOnTimeSeconds } from '../../src/services/impl/DoorOpenerAccessory.js';
import { temperatureService } from '../../src/services/impl/TemperatureAccessory.js';
import { keyPressSwitchService, keyPressSwitchSpecs } from '../../src/services/impl/KeyPressSwitchAccessory.js';
import { blindService } from '../../src/services/impl/BlindAccessory.js';
import { contactService } from '../../src/services/impl/ContactAccessory.js';
import { findServiceByKey } from '../../src/services/registry.js';

// --- a sanitized hap-homematic 0.0.63 export (shape copied from a real one) ---

const INST_ROOM_A = '2595a84c-0000-4000-8000-00000000000a';
const INST_ROOM_B = 'aaaa7332-0000-4000-8000-00000000000b';
const INST_GONE = 'deadbeef-0000-4000-8000-0000000000ff';

const REAL_SHAPE = {
  instances: {
    [HAP_HOMEMATIC_DEFAULT_INSTANCE]: { name: 'default', user: 'CC:22:3D:E3:CE:01', pin: '031-45-154', publishDevices: true },
    [INST_ROOM_A]: { name: 'Room_A', user: 'CC:22:3D:E3:CE:0A', pincode: '111-22-333', setupID: 'AB12', roomId: 1234, publishDevices: true },
    [INST_ROOM_B]: { name: 'Room B', user: 'CC:22:3D:E3:CE:0B', pincode: '444-55-666', setupID: 'CD34', roomId: 5678, publishDevices: true },
    'empty-instance': { name: 'Empty', user: 'CC:22:3D:E3:CE:0E', pincode: '777-88-999', setupID: 'EF56', publishDevices: true },
  },
  mappings: {
    '0000AAAAAAAAAA:4': { name: 'Blind A', Service: 'HomeMaticBlindIPAccessory', instance: [INST_ROOM_A], settings: { MaxForOpen: 100, MaxOpen: 100, observeInhibit: true, useSlats: false } },
    '0000BBBBBBBBBB:3': { name: 'Lamp B', Service: 'HomeMaticSwitchAccessory', instance: [INST_ROOM_B], settings: { Type: 'Lightbulb' } },
    '0000CCCCCCCCCC:1': { name: 'Orphan', Service: 'HomeMaticThermometerAccessory', instance: [INST_GONE], settings: {} },
    '0000DDDDDDDDDD:9': { name: 'Bell', Service: 'HomeMaticPushTheButtonAccessory', instance: [INST_ROOM_A], settings: { evntType: 'BOTH' } },
    'Var_Temp:0': { name: 'Hot water', instance: INST_ROOM_B, Service: 'HomeMaticVarBasedThermometerAccessory', settings: {} },
    'Var_Soc:0': { name: 'Battery', instance: INST_ROOM_B, Service: 'HomeMaticVariableNumberSensorAccessory', settings: { Type: 'Humidity' } },
    'Var_Pv:0': { name: 'PV', instance: INST_ROOM_B, Service: 'HomeMaticVariableNumberSensorAccessory', settings: { Type: 'LuxOmeter' } },
  },
  channels: ['0000AAAAAAAAAA:4', '0000BBBBBBBBBB:3', '0000CCCCCCCCCC:1', '0000DDDDDDDDDD:9'],
  programs: [],
  variables: ['Var_Temp', 'Var_Soc', 'Var_Pv'],
  useCCCAuthentication: true,
};

const DEVICES_JSON = {
  devices: [
    { id: 1, name: 'dev a', address: '0000AAAAAAAAAA', type: 'HmIPW-DRBL4', channels: [{ id: 11, name: 'ch', intf: 1011, address: '0000AAAAAAAAAA:4', type: 'BLIND_VIRTUAL_RECEIVER', access: 255 }] },
    { id: 2, name: 'dev b', address: '0000BBBBBBBBBB', type: 'HmIPW-DRS8', channels: [{ id: 21, name: 'ch', intf: 1011, address: '0000BBBBBBBBBB:3', type: 'SWITCH_VIRTUAL_RECEIVER', access: 255 }] },
    { id: 4, name: 'dev d', address: '0000DDDDDDDDDD', type: 'HmIPW-DRI32', channels: [{ id: 41, name: 'ch', intf: 1011, address: '0000DDDDDDDDDD:9', type: 'MULTI_MODE_INPUT_TRANSMITTER', access: 255 }] },
  ],
};

describe('hapUuid', () => {
  it('matches HAP-NodeJS uuid.generate', () => {
    for (const seed of ['0', 'BLIND_VIRTUAL_RECEIVER:Blind A', 'undefined:Hot water', 'Ümlaut Süd']) {
      expect(hapUuid(seed)).toBe(hapUuidLib.generate(seed));
    }
  });
});

describe('importConfigJson with a real hap-homematic export shape', () => {
  const report = importConfigJson(REAL_SHAPE, { channelTypes: channelTypesFromDevicesJson(DEVICES_JSON) });

  it('reads instance lists (arrays) instead of folding everything into one bridge', () => {
    expect(report.channels.find((c) => c.address === '0000AAAAAAAAAA:4')?.instance).toBe(INST_ROOM_A);
    expect(report.channels.find((c) => c.address === '0000BBBBBBBBBB:3')?.instance).toBe(INST_ROOM_B);
  });

  it('skips mappings whose hap-homematic bridge no longer exists (never published)', () => {
    expect(report.channels.find((c) => c.address === '0000CCCCCCCCCC:1')).toBeUndefined();
    expect(report.meta.skipped).toEqual([{ kind: 'channel', id: '0000CCCCCCCCCC:1', instance: INST_GONE }]);
    expect(report.warnings.some((w) => w.includes('0000CCCCCCCCCC:1'))).toBe(true);
  });

  it('lifts nested settings and their Type into the subtype', () => {
    const lamp = report.channels.find((c) => c.address === '0000BBBBBBBBBB:3')!;
    expect(lamp.subtype).toBe('lightbulb');
    expect(lamp.settings).toEqual({});
    const blind = report.channels.find((c) => c.address === '0000AAAAAAAAAA:4')!;
    expect(blind.settings).toEqual({ MaxForOpen: 100, MaxOpen: 100, observeInhibit: true, useSlats: false });
    const bell = report.channels.find((c) => c.address === '0000DDDDDDDDDD:9')!;
    expect(bell.service).toBe('KeyPressSwitchAccessory');
    expect(bell.settings).toEqual({ evntType: 'BOTH' });
  });

  it('reads variable mappings stored under `<name>:0`', () => {
    const byName = new Map(report.variables.map((v) => [v.name, v]));
    expect(byName.get('Var_Temp')).toMatchObject({ displayName: 'Hot water', service: 'VariableNumericSensorAccessory', subtype: 'temperature', instance: INST_ROOM_B });
    expect(byName.get('Var_Soc')).toMatchObject({ displayName: 'Battery', subtype: 'humidity' });
    expect(byName.get('Var_Pv')).toMatchObject({ displayName: 'PV', subtype: 'light' });
  });

  it('computes hap-homematic accessory UUID seeds', () => {
    expect(report.channels.find((c) => c.address === '0000AAAAAAAAAA:4')?.uuidSeed).toBe('BLIND_VIRTUAL_RECEIVER:Blind A');
    expect(report.variables.find((v) => v.name === 'Var_Temp')?.uuidSeed).toBe('undefined:Hot water');
  });

  it('leaves the seed out when the channel type is unknown', () => {
    const r = importConfigJson(REAL_SHAPE);
    expect(r.channels.every((c) => c.uuidSeed === undefined)).toBe(true);
  });

  it('puts mappings without instance on the default instance when it exists', () => {
    const r = importConfigJson({
      ...REAL_SHAPE,
      channels: ['0000EEEEEEEEEE:1'],
      mappings: { '0000EEEEEEEEEE:1': { name: 'X', Service: 'HomeMaticSwitchAccessory', settings: {} } },
      variables: [],
    });
    const blocks = splitReportIntoBridges(r);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.instanceUuid).toBe(HAP_HOMEMATIC_DEFAULT_INSTANCE);
  });
});

describe('splitReportIntoBridges', () => {
  const report = importConfigJson(REAL_SHAPE, { channelTypes: channelTypesFromDevicesJson(DEVICES_JSON) });

  it('emits one block per non-empty bridge with hap-homematic bridge names', () => {
    const blocks = splitReportIntoBridges(report);
    expect(blocks.map((b) => b.name).sort()).toEqual(['HomeMatic Room A', 'HomeMatic Room B']);
    expect(blocks.every((b) => b.hapHomematicIdentity === false)).toBe(true);
    // New identities: synthetic usernames, no seeds.
    expect(blocks.every((b) => !b.bridge.username.startsWith('CC:22:3D'))).toBe(true);
    expect(blocks.flatMap((b) => b.channels).every((c) => c.uuidSeed === undefined)).toBe(true);
  });

  it('carries the hap-homematic bridge identity when preserving it', () => {
    const blocks = splitReportIntoBridges(report, { preserveIdentity: true });
    const a = blocks.find((b) => b.instanceUuid === INST_ROOM_A)!;
    expect(a.hapHomematicIdentity).toBe(true);
    expect(a.bridge).toMatchObject({ username: 'CC:22:3D:E3:CE:0A', pin: '111-22-333', setupID: 'AB12', name: 'HomeMatic Room A' });
    expect(a.channels.find((c) => c.address === '0000AAAAAAAAAA:4')?.uuidSeed).toBe('BLIND_VIRTUAL_RECEIVER:Blind A');
    const b = blocks.find((x) => x.instanceUuid === INST_ROOM_B)!;
    expect(b.variables).toHaveLength(3);
  });

  it('refuses to preserve identity without instances', () => {
    const r = importConfigJson({ channels: ['X:1'], mappings: { 'X:1': { Service: 'HomeMaticSwitchAccessory' } } });
    expect(() => splitReportIntoBridges(r, { preserveIdentity: true })).toThrow(ImportError);
  });

  it('refuses to preserve identity of a bridge without a valid username', () => {
    const r = importConfigJson({
      channels: ['X:1'],
      mappings: { 'X:1': { Service: 'HomeMaticSwitchAccessory', instance: ['i'] } },
      instances: { i: { name: 'I', user: 'not-a-mac' } },
    });
    expect(() => splitReportIntoBridges(r, { preserveIdentity: true })).toThrow(/no valid HAP username/);
  });

  it('mergeIntoConfig drops seeds (one bridge = new identities)', () => {
    const merged = mergeIntoConfig({}, report);
    expect(merged.channels!.every((c) => c.uuidSeed === undefined)).toBe(true);
    expect(merged.variables!.every((v) => v.uuidSeed === undefined)).toBe(true);
  });

  it('formats bridge names like hap-homematic', () => {
    expect(hapHomematicBridgeName('Küche_Ost (1)')).toBe('HomeMatic Küche Ost  1 ');
    expect(hapHomematicBridgeName(undefined)).toBeUndefined();
  });
});

describe('importBackupTarball', () => {
  it('reads devices.json next to config.json and ignores nested config.json files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-hmhap-import-'));
    try {
      await fs.mkdir(path.join(dir, 'etc'));
      await fs.writeFile(path.join(dir, 'etc', 'config.json'), '{"channels":["WRONG:1"]}');
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(REAL_SHAPE));
      await fs.writeFile(path.join(dir, 'devices.json'), JSON.stringify(DEVICES_JSON));
      const file = path.join(dir, 'b.tar.gz');
      await tarCreate({ gzip: true, file, cwd: dir }, ['./etc/config.json', './config.json', './devices.json']);
      const r = await importBackupTarball(await fs.readFile(file));
      expect(r.channels.map((c) => c.address)).not.toContain('WRONG:1');
      expect(r.channels.find((c) => c.address === '0000BBBBBBBBBB:3')?.uuidSeed).toBe('SWITCH_VIRTUAL_RECEIVER:Lamp B');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('channelTypesFromDevicesJson tolerates junk', () => {
    expect(channelTypesFromDevicesJson(null)).toEqual({});
    expect(channelTypesFromDevicesJson({ devices: [{ channels: [{ address: 1 }, null] }, null] })).toEqual({});
  });
});

// --- services ---------------------------------------------------------------

function makeEnv() {
  const config = resolveConfig({ platform: 'HomematicHap', ccuIp: '127.0.0.1' });
  const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'mig-test') });
  const setValue = vi.spyOn(ccu, 'setValue').mockResolvedValue(undefined);
  const getValue = vi.spyOn(ccu, 'getValue').mockResolvedValue(undefined);
  const fire = (address: string, datapoint: string, value: unknown): void => {
    (ccu as unknown as { handleEvent(ev: object): void }).handleEvent({ callbackId: 'c', channelAddress: address, datapoint, value, receivedAt: 0 });
  };
  return { ccu, setValue, getValue, fire };
}

function build(key: string, ctxOverrides: Partial<AccessoryContext>, env = makeEnv()) {
  const hap = makeHapStub();
  const context: AccessoryContext = { kind: 'channel', id: 'A:1', service: key, name: 'Acc', ...ctxOverrides };
  const accessory = makeAccessory<AccessoryContext>('uuid', 'Acc', context);
  const ctx: ServiceContext = {
    accessory: asPlatformAccessory(accessory),
    ccu: env.ccu,
    log: new PrefixedLogger(makeLog(), 'svc'),
    Service: hap.Service,
    Characteristic: hap.Characteristic,
  };
  const handler = findServiceByKey(key)!.build(ctx);
  return { env, accessory, handler, hap };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function svc(accessory: { services: ServiceStub[] }, uuid: string, subtype?: string): ServiceStub {
  const s = accessory.services.find((x) => x.UUID === uuid && x.subtype === subtype);
  if (!s) {
    throw new Error(`no service ${uuid}/${subtype}; have ${accessory.services.map((x) => `${x.UUID}/${x.subtype}`).join(', ')}`);
  }
  return s;
}

function char(service: ServiceStub, name: string): CharacteristicStub {
  return service.getCharacteristic({ UUID: `char:${name}` }) as CharacteristicStub;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('legacy (hap-homematic) service layout', () => {
  const ch = (type: string): CcuChannel => ({ address: 'A:1', index: 1, type, name: 'Acc' });

  it('uses the service UUID as subtype, like hap-homematic', () => {
    const { accessory, handler } = build('BlindAccessory', { legacyLayout: true });
    handler.attach(ch('BLIND_VIRTUAL_RECEIVER'));
    expect(accessory.services.map((s) => `${s.UUID}|${s.subtype}`)).toEqual(['srv:WindowCovering|srv:WindowCovering']);
  });

  it('keeps no subtype for an accessory with its own identity', () => {
    const { accessory, handler } = build('BlindAccessory', {});
    handler.attach(ch('BLIND_VIRTUAL_RECEIVER'));
    expect(accessory.services[0]!.subtype).toBeUndefined();
  });

  it('window contact + battery match hap-homematic subtypes', () => {
    const { accessory, handler } = build('ContactAccessory', { legacyLayout: true, subtype: 'window' });
    handler.attach(ch('SHUTTER_CONTACT'));
    expect(accessory.services.map((s) => `${s.UUID}|${s.subtype}`).sort()).toEqual([
      'srv:Battery|srv:Battery',
      'srv:Window|srv:Window',
    ]);
  });

  it('thermostat has no subtype (hap-homematic used addService(new Thermostat()))', () => {
    const { accessory, handler } = build('ThermostatAccessory', { legacyLayout: true });
    handler.attach(ch('HEATING_CLIMATECONTROL_TRANSCEIVER'));
    expect(svc(accessory, 'srv:Thermostat', undefined)).toBeDefined();
    expect(svc(accessory, 'srv:Battery', 'srv:Battery')).toBeDefined();
  });

  it('modern layout keeps the "battery" subtype', () => {
    const { accessory, handler } = build('ContactAccessory', { subtype: 'window' });
    handler.attach(ch('SHUTTER_CONTACT'));
    expect(svc(accessory, 'srv:Battery', 'battery')).toBeDefined();
  });

  it('registry still knows blind/contact services', () => {
    expect(blindService.key).toBe('BlindAccessory');
    expect(contactService.key).toBe('ContactAccessory');
  });
});

describe('ThermostatAccessory with Homematic IP', () => {
  const channel: CcuChannel = { address: 'T:1', index: 1, type: 'HEATING_CLIMATECONTROL_TRANSCEIVER', name: 'Heat' };

  it('picks the datapoint profile by channel type', () => {
    expect(thermostatProfileFor('HEATING_CLIMATECONTROL_TRANSCEIVER').setPoint).toBe('SET_POINT_TEMPERATURE');
    expect(thermostatProfileFor('CLIMATECONTROL_RT_TRANSCEIVER').setPoint).toBe('SET_TEMPERATURE');
  });

  it('writes SET_POINT_TEMPERATURE and CONTROL_MODE', async () => {
    const { accessory, handler, env } = build('ThermostatAccessory', {});
    handler.attach(channel);
    const s = svc(accessory, 'srv:Thermostat');
    await char(s, 'TargetTemperature').onSetHandler!(21.5);
    expect(env.setValue).toHaveBeenCalledWith('T:1', 'SET_POINT_TEMPERATURE', 21.5);
    await char(s, 'TargetHeatingCoolingState').onSetHandler!(3);
    expect(env.setValue).toHaveBeenCalledWith('T:1', 'CONTROL_MODE', 0);
    env.setValue.mockClear();
    await char(s, 'TargetHeatingCoolingState').onSetHandler!(0);
    expect(env.setValue.mock.calls).toEqual([['T:1', 'CONTROL_MODE', 1], ['T:1', 'SET_POINT_TEMPERATURE', 4.5]]);
    env.setValue.mockClear();
    await char(s, 'TargetHeatingCoolingState').onSetHandler!(1);
    expect(env.setValue.mock.calls).toEqual([['T:1', 'CONTROL_MODE', 1], ['T:1', 'SET_POINT_TEMPERATURE', 21.5]]);
    expect(env.setValue).not.toHaveBeenCalledWith('T:1', 'SET_TEMPERATURE', expect.anything());
  });

  it('follows SET_POINT_TEMPERATURE and SET_POINT_MODE events', () => {
    const { accessory, handler, env } = build('ThermostatAccessory', {});
    handler.attach(channel);
    const s = svc(accessory, 'srv:Thermostat');
    env.fire('T:1', 'SET_POINT_TEMPERATURE', 20);
    env.fire('T:1', 'SET_POINT_MODE', 0);
    expect(char(s, 'TargetTemperature').value).toBe(20);
    expect(char(s, 'TargetHeatingCoolingState').value).toBe(3);
    env.fire('T:1', 'SET_POINT_MODE', 1);
    expect(char(s, 'TargetHeatingCoolingState').value).toBe(1);
    env.fire('T:1', 'SET_POINT_TEMPERATURE', 4.5);
    expect(char(s, 'TargetHeatingCoolingState').value).toBe(0);
  });

  it('adds humidity only when the device reports HUMIDITY', async () => {
    const env = makeEnv();
    env.getValue.mockImplementation(async (_a: string, dp: string) => (dp === 'HUMIDITY' ? 48 : undefined));
    const { accessory, handler } = build('ThermostatAccessory', {}, env);
    handler.attach(channel);
    await flush();
    expect(char(svc(accessory, 'srv:Thermostat'), 'CurrentRelativeHumidity').value).toBe(48);

    const env2 = makeEnv();
    const b = build('ThermostatAccessory', {}, env2);
    b.handler.attach(channel);
    await flush();
    expect(svc(b.accessory, 'srv:Thermostat').characteristics.has('char:CurrentRelativeHumidity')).toBe(false);
  });
});

describe('DoorOpenerAccessory', () => {
  const channel: CcuChannel = { address: 'D:3', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', name: 'Door' };

  it('derives the on-time like hap-homematic (default 10 s, capped)', () => {
    expect(doorOpenerOnTimeSeconds(undefined)).toBe(10);
    expect(doorOpenerOnTimeSeconds({ OnTime: '3' })).toBe(3);
    expect(doorOpenerOnTimeSeconds({ OnTime: 2 })).toBe(2);
    expect(doorOpenerOnTimeSeconds({ OnTime: 'x' })).toBe(10);
    expect(doorOpenerOnTimeSeconds({ OnTime: 999 })).toBe(60);
  });

  it('writes ON_TIME before STATE and switches the relay off afterwards', async () => {
    vi.useFakeTimers();
    const { accessory, handler, env } = build('DoorOpenerAccessory', { settings: { OnTime: 3 } });
    handler.attach(channel);
    await char(svc(accessory, 'srv:LockMechanism'), 'LockTargetState').onSetHandler!(0);
    expect(env.setValue.mock.calls).toEqual([['D:3', 'ON_TIME', 3], ['D:3', 'STATE', true]]);
    await vi.advanceTimersByTimeAsync(3600);
    expect(env.setValue).toHaveBeenLastCalledWith('D:3', 'STATE', false);
  });

  it('still pulses (and switches off) when ON_TIME is rejected', async () => {
    vi.useFakeTimers();
    const { accessory, handler, env } = build('DoorOpenerAccessory', {});
    env.setValue.mockImplementation(async (_a: string, dp: string) => {
      if (dp === 'ON_TIME') throw new Error('unknown parameter');
    });
    handler.attach(channel);
    await char(svc(accessory, 'srv:LockMechanism'), 'LockTargetState').onSetHandler!(0);
    expect(env.setValue).toHaveBeenCalledWith('D:3', 'STATE', true);
    await vi.advanceTimersByTimeAsync(10_600);
    expect(env.setValue).toHaveBeenLastCalledWith('D:3', 'STATE', false);
  });

  it('ignores "lock" requests', async () => {
    const { accessory, handler, env } = build('DoorOpenerAccessory', {});
    handler.attach(channel);
    await char(svc(accessory, 'srv:LockMechanism'), 'LockTargetState').onSetHandler!(1);
    expect(env.setValue).not.toHaveBeenCalled();
    expect(doorOpenerService.key).toBe('DoorOpenerAccessory');
  });
});

describe('TemperatureAccessory humidity', () => {
  it('adds a humidity sensor for climate sensor channels', async () => {
    const env = makeEnv();
    env.getValue.mockImplementation(async (_a: string, dp: string) => (dp === 'HUMIDITY' ? 61 : 19.5));
    const { accessory, handler } = build('TemperatureAccessory', {}, env);
    handler.attach({ address: 'S:1', index: 1, type: 'CLIMATE_TRANSCEIVER', name: 'Outside' });
    await flush();
    expect(char(svc(accessory, 'srv:HumiditySensor', 'humidity'), 'CurrentRelativeHumidity').value).toBe(61);
    env.fire('S:1', 'HUMIDITY', 140);
    expect(char(svc(accessory, 'srv:HumiditySensor', 'humidity'), 'CurrentRelativeHumidity').value).toBe(100);
    expect(temperatureService.key).toBe('TemperatureAccessory');
  });

  it('no humidity for plain temperature channels or when ignored', () => {
    const a = build('TemperatureAccessory', {});
    a.handler.attach({ address: 'S:1', index: 1, type: 'TEMPERATURE_SENSOR', name: 'T' });
    expect(a.accessory.services.some((s) => s.UUID === 'srv:HumiditySensor')).toBe(false);
    const b = build('TemperatureAccessory', { settings: { ignoreHumidity: true } });
    b.handler.attach({ address: 'S:1', index: 1, type: 'CLIMATE_TRANSCEIVER', name: 'T' });
    expect(b.accessory.services.some((s) => s.UUID === 'srv:HumiditySensor')).toBe(false);
  });

  it('legacy layout uses the hap-homematic subtypes', () => {
    const { accessory, handler } = build('TemperatureAccessory', { legacyLayout: true });
    handler.attach({ address: 'S:1', index: 1, type: 'HEATING_CLIMATECONTROL_TRANSCEIVER', name: 'T' });
    expect(accessory.services.map((s) => `${s.UUID}|${s.subtype}`).sort()).toEqual([
      'srv:Battery|srv:Battery',
      'srv:HumiditySensor|srv:HumiditySensor',
      'srv:TemperatureSensor|srv:TemperatureSensor',
    ]);
  });
});

describe('KeyPressSwitchAccessory', () => {
  const channel: CcuChannel = { address: 'K:9', index: 9, type: 'MULTI_MODE_INPUT_TRANSMITTER', name: 'Bell' };

  it('specs follow evntType', () => {
    expect(keyPressSwitchSpecs(undefined)).toEqual([{ suffix: '', event: 'PRESS_SHORT' }]);
    expect(keyPressSwitchSpecs({ evntType: 'PRESS_LONG' })).toEqual([{ suffix: '', event: 'PRESS_LONG' }]);
    expect(keyPressSwitchSpecs({ evntType: 'BOTH' }).map((s) => s.suffix)).toEqual(['_Short', '_Long']);
  });

  it('BOTH creates _Short/_Long switches that press the key and reset', async () => {
    vi.useFakeTimers();
    const { accessory, handler, env } = build('KeyPressSwitchAccessory', { settings: { evntType: 'BOTH' }, legacyLayout: true });
    handler.attach(channel);
    const short = svc(accessory, 'srv:Switch', '_Short');
    const long = svc(accessory, 'srv:Switch', '_Long');
    await char(short, 'On').onSetHandler!(true);
    expect(env.setValue).toHaveBeenCalledWith('K:9', 'PRESS_SHORT', true);
    await char(long, 'On').onSetHandler!(true);
    expect(env.setValue).toHaveBeenCalledWith('K:9', 'PRESS_LONG', true);
    await vi.advanceTimersByTimeAsync(600);
    expect(char(short, 'On').value).toBe(false);
    expect(await char(short, 'On').onGetHandler!()).toBe(false);
    await char(short, 'On').onSetHandler!(false);
    expect(env.setValue).toHaveBeenCalledTimes(2);
    handler.dispose?.();
  });

  it('a single switch has no subtype in either layout', () => {
    for (const legacyLayout of [true, false]) {
      const { accessory, handler } = build('KeyPressSwitchAccessory', { legacyLayout });
      handler.attach(channel);
      expect(accessory.services.map((s) => s.subtype)).toEqual([undefined]);
    }
    expect(keyPressSwitchService.priority).toBeGreaterThan(50);
  });

  it('honours the UI variant when settings carry no evntType', () => {
    const { accessory, handler } = build('KeyPressSwitchAccessory', { subtype: 'BOTH' });
    handler.attach(channel);
    expect(accessory.services).toHaveLength(2);
  });
});

// --- several platform blocks on one host ---------------------------------------

describe('several platform blocks on one host', () => {
  it('callback ids are unique per block, default unchanged', () => {
    expect(callbackIdFor('HomematicHap', 'HmIP-RF')).toBe('homebridge-homematic-hap:HmIP-RF');
    expect(callbackIdFor('HomeMatic Küche Süd', 'HmIP-RF')).toBe('homebridge-homematic-hap:HomeMatic-Kuche-Sud:HmIP-RF');
    expect(callbackIdFor('', 'HmIP-RF')).toBe('homebridge-homematic-hap:HmIP-RF');
    expect(callbackIdFor('###', 'HmIP-RF')).toBe('homebridge-homematic-hap:block:HmIP-RF');
  });

  it('event server falls back to the next free port', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const taken = (blocker.address() as net.AddressInfo).port;
    const log = new PrefixedLogger(makeLog(), 'ev');
    const server = new EventServer({ host: '127.0.0.1', port: taken, log });
    try {
      await server.start();
      expect(server.boundPort).not.toBe(taken);
      expect(server.boundPort).toBeGreaterThan(taken);
    } finally {
      await server.stop();
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('subscribes only to interfaces that mapped channels use', async () => {
    const raw: RawConfig = {
      platform: 'HomematicHap',
      name: 'HomeMatic Room A',
      ccuIp: '127.0.0.1',
      eventServer: { host: '127.0.0.1', port: 9875 },
      channels: [{ address: '0000AAAAAAAAAA:4', service: 'BlindAccessory' }],
    };
    const ccu = new CcuClient({ config: resolveConfig(raw), log: new PrefixedLogger(makeLog(), 'prune') });
    vi.spyOn(ccu.api, 'listInterfaces').mockResolvedValue([]);
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([
      { address: '0000AAAAAAAAAA', name: 'd', type: 'HmIPW-DRBL4', interface: 'HmIP-RF', channels: [{ address: '0000AAAAAAAAAA:4', index: 4, type: 'BLIND_VIRTUAL_RECEIVER', name: 'c' }] },
    ]);
    vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
    const infos: string[] = [];
    vi.spyOn(ccu['log'] as unknown as { info: (...a: unknown[]) => void }, 'info')
      .mockImplementation((...a: unknown[]) => { infos.push(a.map(String).join(' ')); });
    vi.spyOn(ccu['log'] as unknown as { warn: (...a: unknown[]) => void }, 'warn').mockImplementation(() => undefined);
    await ccu.start();
    const used = infos.filter((l) => l.startsWith('Using XML-RPC port')).map((l) => /\) \d+ (\S+)/.exec(l)?.[1]);
    expect(used).toEqual(['HmIP-RF']);
    await ccu.stop();
  });

  it('resolveConfig defaults hapHomematicIdentity to false', () => {
    expect(resolveConfig({ platform: 'HomematicHap', ccuIp: '1.2.3.4' }).hapHomematicIdentity).toBe(false);
    expect(resolveConfig({ platform: 'HomematicHap', ccuIp: '1.2.3.4', hapHomematicIdentity: true }).hapHomematicIdentity).toBe(true);
  });

  it('Buffer import stays referenced', () => {
    expect(Buffer.isBuffer(Buffer.alloc(1))).toBe(true);
  });
});

describe('branch coverage for migration paths', () => {
  it('BidCos thermostat keeps SET_TEMPERATURE / AUTO_MODE / MANU_MODE', async () => {
    const { accessory, handler, env } = build('ThermostatAccessory', { settings: { minTemp: 5, maxTemp: 28, minStep: 1 } });
    handler.attach({ address: 'B:4', index: 4, type: 'CLIMATECONTROL_RT_TRANSCEIVER', name: 'Old' });
    const s = svc(accessory, 'srv:Thermostat');
    expect(char(s, 'TargetTemperature').props).toMatchObject({ minValue: 5, maxValue: 28, minStep: 1 });
    await char(s, 'TargetTemperature').onSetHandler!(19);
    await char(s, 'TargetHeatingCoolingState').onSetHandler!(3);
    await char(s, 'TargetHeatingCoolingState').onSetHandler!(1);
    await char(s, 'TargetHeatingCoolingState').onSetHandler!(0);
    expect(env.setValue.mock.calls).toEqual([
      ['B:4', 'SET_TEMPERATURE', 19],
      ['B:4', 'AUTO_MODE', true],
      ['B:4', 'MANU_MODE', 19],
      ['B:4', 'SET_TEMPERATURE', 4.5],
    ]);
    env.fire('B:4', 'ACTUAL_TEMPERATURE', 'x');
    env.fire('B:4', 'SET_TEMPERATURE', 'x');
    env.fire('B:4', 'CONTROL_MODE', 'x');
    env.fire('B:4', 'ACTUAL_TEMPERATURE', 18);
    env.fire('B:4', 'SET_TEMPERATURE', 21);
    expect(await char(s, 'CurrentHeatingCoolingState').onGetHandler!()).toBe(1);
    env.fire('B:4', 'ACTUAL_TEMPERATURE', 22);
    expect(await char(s, 'CurrentHeatingCoolingState').onGetHandler!()).toBe(0);
    expect(await char(s, 'CurrentTemperature').onGetHandler!()).toBe(22);
    expect(await char(s, 'TargetTemperature').onGetHandler!()).toBe(21);
    expect(await char(s, 'TemperatureDisplayUnits').onGetHandler!()).toBe(0);
  });

  it('HmIP thermostat initial pull reads set point then mode', async () => {
    const env = makeEnv();
    env.getValue.mockImplementation(async (_a: string, dp: string) => ({ ACTUAL_TEMPERATURE: 19, SET_POINT_TEMPERATURE: 20.5, SET_POINT_MODE: 0, HUMIDITY: 'n/a' } as Record<string, unknown>)[dp]);
    const { accessory, handler } = build('ThermostatAccessory', {}, env);
    handler.attach({ address: 'T:1', index: 1, type: 'HEATING_CLIMATECONTROL_TRANSCEIVER', name: 'Heat' });
    await flush();
    const s = svc(accessory, 'srv:Thermostat');
    expect(char(s, 'TargetTemperature').value).toBe(20.5);
    expect(char(s, 'TargetHeatingCoolingState').value).toBe(3);
    expect(s.characteristics.has('char:CurrentRelativeHumidity')).toBe(false);
    env.fire('T:1', 'SET_POINT_TEMPERATURE', 4.5);
    env.fire('T:1', 'SET_POINT_MODE', 1);
    expect(char(s, 'TargetHeatingCoolingState').value).toBe(0);
  });

  it('door opener survives a failed STATE write and a failed explicit off', async () => {
    vi.useFakeTimers();
    const { accessory, handler, env } = build('DoorOpenerAccessory', { settings: { OnTime: 1 } });
    handler.attach({ address: 'D:3', index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', name: 'Door' });
    const target = char(svc(accessory, 'srv:LockMechanism'), 'LockTargetState');
    env.setValue.mockImplementation(async (_a: string, dp: string) => {
      if (dp === 'STATE') throw new Error('busy');
    });
    await target.onSetHandler!(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(env.setValue.mock.calls.filter((c) => c[1] === 'STATE')).toHaveLength(1);
    env.setValue.mockImplementation(async (_a: string, dp: string, v: unknown) => {
      if (dp === 'STATE' && v === false) throw new Error('busy');
    });
    await target.onSetHandler!(0);
    await target.onSetHandler!(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(env.setValue).toHaveBeenLastCalledWith('D:3', 'STATE', false);
    handler.dispose?.();
  });

  it('event server rethrows errors other than EADDRINUSE', async () => {
    const log = new PrefixedLogger(makeLog(), 'ev');
    const server = new EventServer({ host: '256.0.0.1', port: 40000, log });
    const errors: Error[] = [];
    server.on('error', (e) => errors.push(e));
    await expect(server.start()).rejects.toThrow();
    expect(errors).toHaveLength(1);
  });

  it('event server gives up past the last port', async () => {
    const log = new PrefixedLogger(makeLog(), 'ev');
    const server = new EventServer({ host: '127.0.0.1', port: 65535, log });
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(65535, '127.0.0.1', () => r())).catch(() => undefined);
    server.on('error', () => undefined);
    try {
      if (blocker.listening) {
        await expect(server.start()).rejects.toThrow();
      } else {
        await server.start();
        await server.stop();
      }
    } finally {
      if (blocker.listening) await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

describe('packaging', () => {
  it('no runtime import of the homebridge package (breaks linked or relocated installs)', async () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith('.ts')) files.push(full);
      }
    };
    await walk(root);
    const offenders: string[] = [];
    for (const f of files) {
      const text = await fs.readFile(f, 'utf8');
      for (const m of text.matchAll(/^import\s+([^;]*?)\s+from\s+'homebridge';/gms)) {
        if (!/^type\s/.test(m[1]!.trim())) offenders.push(path.relative(root, f));
      }
    }
    expect(offenders).toEqual([]);
  });
});
