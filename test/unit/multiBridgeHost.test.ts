/**
 * Multi-bridge host ("A1"): one platform block publishing several HAP
 * bridges with transplanted hap-homematic identities. Uses the real
 * HAP-NodeJS object model with a fake publisher, so nothing touches the
 * network. Set HAP_NODEJS_PATH to run the same tests against another
 * HAP-NodeJS build (e.g. 0.14.3, the one Homebridge 1.11.4 ships).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { format } from 'node:util';
import type { HAP, PublishInfo } from 'homebridge';
import type { CcuClient } from '../../src/ccu/CcuClient.js';
import { MultiBridgeHost, hapPublisher, type BridgePublisher } from '../../src/multiBridge/MultiBridgeHost.js';
import { buildBridge, bridgeUuidFor, type HapBridge } from '../../src/multiBridge/bridgeBuilder.js';
import { identityProblem, persistFileName, persistIdentityStore, type IdentityStore } from '../../src/multiBridge/identityStore.js';
import { isTcpPortFree } from '../../src/multiBridge/portProbe.js';
import { BridgedAccessoryHandle } from '../../src/multiBridge/BridgedAccessoryHandle.js';
import { resolveMultiBridgeConfig } from '../../src/multiBridge/config.js';
import { ConfigError, resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { PLUGIN_VERSION } from '../../src/settings.js';
import type { CcuDevice, CcuVariable, MultiBridgeConfig, MultiBridgeEntry, RawConfig } from '../../src/types.js';
import { makeLog } from '../helpers/hapStub.js';

const HAP_ROOT = process.env.HAP_NODEJS_PATH ?? '@homebridge/hap-nodejs';
const hap = (await import(HAP_ROOT)) as unknown as HAP;
// Not re-exported by HAP-NodeJS; same class publish() uses.
const { IdentifierCache } = (await import(`${HAP_ROOT}/dist/lib/model/IdentifierCache.js`)) as {
  IdentifierCache: new (username: string) => CacheLike;
};
const fmt = (calls: unknown[][]): string[] => calls.map((c) => format(...(c as [string, ...unknown[]])));

// --- fixtures (synthetic identities, shapes copied from a real export) ---

const DOOR = '0000AAAAAAAAAA:3';
const WINDOW = '0000BBBBBBBBBB:1';
const LAMP = '0000CCCCCCCCCC:2';
const DEVICES: CcuDevice[] = [
  { address: '0000AAAAAAAAAA', type: 'HmIPW-DRS4', name: 'relay', interface: 'HmIP-RF', channels: [
    { address: DOOR, index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', name: 'Relay 3' },
  ] },
  { address: '0000BBBBBBBBBB', type: 'HmIP-SWDM', name: 'window', interface: 'HmIP-RF', channels: [
    { address: WINDOW, index: 1, type: 'SHUTTER_CONTACT', name: 'Window ch' },
  ] },
  { address: '0000CCCCCCCCCC', type: 'HmIPW-DRS8', name: 'lamp', interface: 'HmIP-RF', channels: [
    { address: LAMP, index: 2, type: 'SWITCH_VIRTUAL_RECEIVER', name: 'Lamp ch' },
  ] },
];
const VARIABLES: CcuVariable[] = [
  { name: 'Var_Soc', id: '1', valuetype: 4, subtype: 0, value: 50 },
];

function entry(over: Partial<MultiBridgeEntry> = {}): MultiBridgeEntry {
  return {
    name: 'HomeMatic Waschkueche',
    enabled: true,
    username: 'CC:22:3D:E3:CE:0A',
    pincode: '111-22-333',
    setupID: 'AB12',
    port: 51001,
    bridgeUuid: '880e3bf1-3038-414d-ae33-b2864d088626',
    category: 2,
    newIdentity: false,
    hapHomematicIdentity: true,
    channels: [{ address: DOOR, service: 'DoorOpenerAccessory', name: 'Waschkueche Schnapper', uuidSeed: 'SWITCH_VIRTUAL_RECEIVER:Waschkueche Schnapper' }],
    variables: [],
    programs: [],
    ...over,
  };
}

function multiConfig(bridges: MultiBridgeEntry[], over: Partial<MultiBridgeConfig> = {}): MultiBridgeConfig {
  return { advertiser: 'ciao', retrySeconds: 5, bridges, ...over };
}

interface FakeCcu {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  isLive: ReturnType<typeof vi.fn>;
  listDevices: ReturnType<typeof vi.fn>;
  listVariables: ReturnType<typeof vi.fn>;
  registerListener: ReturnType<typeof vi.fn>;
  getValue: ReturnType<typeof vi.fn>;
  setValue: ReturnType<typeof vi.fn>;
  api: Record<string, unknown>;
  listenerCount(): number;
}

function fakeCcu(): FakeCcu {
  const listeners = new Map<string, Set<unknown>>();
  const offline = () => Promise.reject(new Error('offline'));
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    isLive: vi.fn(() => true),
    listDevices: vi.fn(async () => DEVICES),
    listVariables: vi.fn(async () => VARIABLES),
    registerListener: vi.fn((key: string, fn: unknown) => {
      const set = listeners.get(key) ?? new Set();
      set.add(fn);
      listeners.set(key, set);
      return () => set.delete(fn);
    }),
    getValue: vi.fn(offline),
    setValue: vi.fn(async () => undefined),
    api: { getVariable: vi.fn(offline), setVariable: vi.fn(offline) },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

function okIdentity(): IdentityStore {
  return { check: () => ({ accessoryInfo: 'ok', identifierCache: 'ok', pincodeMatches: true, setupIdMatches: true }) };
}

interface FakePublisher extends BridgePublisher {
  published: Array<{ bridge: HapBridge; info: PublishInfo }>;
  unpublished: HapBridge[];
}

function fakePublisher(): FakePublisher {
  const p: FakePublisher = {
    published: [],
    unpublished: [],
    publish: vi.fn(async (bridge: HapBridge, info: PublishInfo) => {
      p.published.push({ bridge, info });
    }),
    unpublish: vi.fn(async (bridge: HapBridge) => {
      p.unpublished.push(bridge);
    }),
  };
  return p;
}

function host(config: MultiBridgeConfig, over: Partial<ConstructorParameters<typeof MultiBridgeHost>[0]> = {}) {
  const ccu = fakeCcu();
  const publisher = fakePublisher();
  const log = makeLog();
  const h = new MultiBridgeHost({
    hap,
    ccu: ccu as unknown as CcuClient,
    config,
    log: new PrefixedLogger(log, 'test'),
    version: PLUGIN_VERSION,
    identityStore: okIdentity(),
    publisher,
    portProbe: async () => true,
    ...over,
  });
  return { h, ccu, publisher, log };
}

interface CacheLike {
  _cache: Record<string, number>;
  save(): void;
  _usedCache: Record<string, number> | null;
  startTrackingUsage(): void;
}

/** What Accessory.publish does for IDs, without the network part. */
function assignIds(bridge: HapBridge, cacheContent: Record<string, number>): { cache: CacheLike; added: string[]; unused: string[] } {
  if (!bridge.getService(hap.Service.ProtocolInformation)) {
    bridge.addService(hap.Service.ProtocolInformation);
  }
  const cache = new IdentifierCache('CC:22:3D:E3:CE:0A');
  cache._cache = { ...cacheContent };
  cache.startTrackingUsage();
  (bridge as unknown as { _assignIDs(c: unknown): void })._assignIDs(cache);
  const used = cache._usedCache ?? {};
  const added = Object.keys(cache._cache).filter((k) => !(k in cacheContent));
  const unused = Object.keys(cacheContent).filter((k) => !(k in used));
  return { cache, added, unused };
}

const INFO = '0000003E-0000-1000-8000-0026BB765291';
const PROTO = '000000A2-0000-1000-8000-0026BB765291';
const LOCK = '00000045-0000-1000-8000-0026BB765291';
const ch = (id: string) => `000000${id}-0000-1000-8000-0026BB765291`;

/** A hap-homematic IdentifierCache for one bridge with one door opener (real key layout). */
function hapHomematicCache(bridgeUuid: string, accUuid: string): Record<string, number> {
  const c: Record<string, number> = {};
  c[`${bridgeUuid}|nextIID`] = 10;
  ['14', '20', '21', '23', '30', '52'].forEach((x, i) => { c[`${bridgeUuid}|${INFO}|${ch(x)}`] = i + 2; });
  c[`${bridgeUuid}|${PROTO}`] = 8;
  c[`${bridgeUuid}|${PROTO}|${ch('37')}`] = 9;
  c['|nextAID'] = 5;
  c[accUuid] = 4;
  c[`${accUuid}|nextIID`] = 12;
  ['14', '20', '21', '23', '30', '52'].forEach((x, i) => { c[`${accUuid}|${INFO}|${ch(x)}`] = i + 2; });
  c[`${accUuid}|${LOCK}|${LOCK}`] = 8;
  ['23', '1D', '1E'].forEach((x, i) => { c[`${accUuid}|${LOCK}|${LOCK}|${ch(x)}`] = i + 9; });
  return c;
}

let tmp = '';
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hmhap-multibridge-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tmp, { recursive: true, force: true });
});

// --- config -------------------------------------------------------------

describe('multiBridge config', () => {
  const raw = (over: Record<string, unknown> = {}, bridges?: unknown[]): RawConfig => ({
    platform: 'HomematicHap',
    name: 'HomeMatic Bridges',
    ccuIp: '10.0.0.2',
    eventServer: { port: 9875 },
    _bridge: { username: '0E:00:00:00:00:01', port: 51999 },
    multiBridge: {
      bridges: bridges ?? [
        { ...entry(), enabled: undefined },
        { ...entry({ name: 'HomeMatic Flur', username: 'CC:22:3D:E3:CE:0B', port: 51002, bridgeUuid: undefined }), enabled: true, channels: [{ address: LAMP, service: 'SwitchAccessory' }] },
      ],
    },
    ...over,
  } as unknown as RawConfig);

  it('defaults bridges to disabled and puts only enabled mappings into the CCU subscription set', () => {
    const r = resolveConfig(raw());
    expect(r.multiBridge?.bridges.map((b) => b.enabled)).toEqual([false, true]);
    expect(r.channels.map((c) => c.address)).toEqual([LAMP]);
    expect(r.hapHomematicIdentity).toBe(true);
    expect(r.multiBridge?.advertiser).toBe('ciao');
    expect(r.multiBridge?.retrySeconds).toBe(30);
    expect(r.multiBridge?.bridges[0]?.hapHomematicIdentity).toBe(true);
    expect(r.multiBridge?.bridges[1]?.bridgeUuid).toBeUndefined();
  });

  it('keeps bind and a lower-case bridge uuid, upper-cases usernames', () => {
    const r = resolveMultiBridgeConfig({
      bind: ['eth0'],
      advertiser: 'bonjour-hap',
      bridges: [{ ...entry(), username: 'cc:22:3d:e3:ce:0a', bridgeUuid: '880E3BF1-3038-414D-AE33-B2864D088626' }],
    }, { eventServerPort: 9875 });
    expect(r.bind).toEqual(['eth0']);
    expect(r.bridges[0]?.username).toBe('CC:22:3D:E3:CE:0A');
    expect(r.bridges[0]?.bridgeUuid).toBe('880e3bf1-3038-414d-ae33-b2864d088626');
  });

  it.each([
    ['mappings in the block', raw({ channels: [{ address: LAMP, service: 'SwitchAccessory' }] }), /into the bridges/],
    ['no bridges', raw({}, []), /non-empty list/],
    ['bad advertiser', raw({ multiBridge: { advertiser: 'mdns', bridges: [entry()] } }), /advertiser/],
    ['bad retry', raw({ multiBridge: { retrySeconds: 1, bridges: [entry()] } }), /retrySeconds/],
    ['bad bind', raw({ multiBridge: { bind: [''], bridges: [entry()] } }), /bind/],
    ['not an object', raw({ multiBridge: [] }), /must be an object/],
    ['entry not an object', raw({}, ['x']), /bridges\[0\] must be an object/],
    ['no name', raw({}, [{ ...entry(), name: ' ' }]), /name is required/],
    ['bad username', raw({}, [{ ...entry(), username: 'nope' }]), /username/],
    ['bad pin', raw({}, [{ ...entry(), pincode: '1234' }]), /pincode/],
    ['bad setupID', raw({}, [{ ...entry(), setupID: 'ab' }]), /setupID/],
    ['bad port', raw({}, [{ ...entry(), port: 80 }]), /port must be/],
    ['bad uuid', raw({}, [{ ...entry(), bridgeUuid: 'x' }]), /bridgeUuid/],
    ['bad category', raw({}, [{ ...entry(), category: 0 }]), /category/],
    ['enabled not boolean', raw({}, [{ ...entry(), enabled: 'yes' }]), /enabled must be/],
    ['channels not a list', raw({}, [{ ...entry(), channels: {} }]), /channels must be a list/],
    ['incomplete channel', raw({}, [{ ...entry(), channels: [{ address: LAMP }] }]), /channels\[0\] is incomplete/],
    ['incomplete variable', raw({}, [{ ...entry(), variables: [{}] }]), /variables\[0\]/],
    ['incomplete program', raw({}, [{ ...entry(), programs: [null] }]), /programs\[0\]/],
    ['duplicate name', raw({}, [entry(), entry({ username: 'CC:22:3D:E3:CE:0B', port: 51002, bridgeUuid: undefined })]), /name used twice/],
    ['duplicate username', raw({}, [entry(), entry({ name: 'B', port: 51002, bridgeUuid: undefined })]), /username used twice/],
    ['username of the host bridge', raw({}, [entry({ username: '0E:00:00:00:00:01' })]), /username used twice/],
    ['duplicate port', raw({}, [entry(), entry({ name: 'B', username: 'CC:22:3D:E3:CE:0B', bridgeUuid: undefined })]), /port 51001 used twice/],
    ['event server port', raw({}, [entry({ port: 9875 })]), /port 9875/],
    ['host bridge port', raw({}, [entry({ port: 51999 })]), /port 51999/],
    ['duplicate bridge uuid', raw({}, [entry(), entry({ name: 'B', username: 'CC:22:3D:E3:CE:0B', port: 51002 })]), /bridgeUuid used twice/],
  ])('rejects %s', (_label, cfg, re) => {
    expect(() => resolveConfig(cfg)).toThrow(ConfigError);
    expect(() => resolveConfig(cfg)).toThrow(re);
  });
});

// --- building ----------------------------------------------------------

describe('buildBridge', () => {
  it('uses the hap-homematic bridge uuid and accessory uuid seeds', () => {
    const built = buildBridge({ hap, ccu: fakeCcu() as unknown as CcuClient, log: new PrefixedLogger(makeLog(), 't'), version: PLUGIN_VERSION },
      entry(), { devices: DEVICES, variables: VARIABLES });
    expect(built.bridge.UUID).toBe('880e3bf1-3038-414d-ae33-b2864d088626');
    expect(built.bridge.displayName).toBe('HomeMatic Waschkueche');
    expect(built.accessories).toEqual([{
      kind: 'channel', id: DOOR, name: 'Waschkueche Schnapper',
      uuid: hap.uuid.generate('SWITCH_VIRTUAL_RECEIVER:Waschkueche Schnapper'), legacyIdentity: true,
    }]);
    expect(built.bridge.bridgedAccessories).toHaveLength(1);
    const info = built.bridge.getService(hap.Service.AccessoryInformation)!;
    expect(info.getCharacteristic(hap.Characteristic.SerialNumber).value).toBe('HomeMatic Waschkueche');
    expect(info.getCharacteristic(hap.Characteristic.FirmwareRevision).value).toBe(PLUGIN_VERSION);
  });

  it('the accessory handle forwards to the HAP accessory', () => {
    const acc = new hap.Accessory('Name One', hap.uuid.generate('x'));
    const handle = new BridgedAccessoryHandle(acc, { kind: 'channel', id: 'A:1', service: 'SwitchAccessory' });
    expect(handle.UUID).toBe(acc.UUID);
    handle.displayName = 'Name Two';
    expect(acc.displayName).toBe('Name Two');
    expect(handle.displayName).toBe('Name Two');
    const sw = handle.addService(new hap.Service.Switch('Sw', 'sub'));
    expect(handle.getServiceById(hap.Service.Switch, 'sub')).toBe(sw);
    expect(handle.getService(hap.Service.AccessoryInformation)).toBeDefined();
  });

  it('derives a stable bridge uuid when none is configured', () => {
    expect(bridgeUuidFor(hap, { username: 'CC:22:3D:E3:CE:0A' })).toBe(hap.uuid.generate('homebridge-homematic-hap:bridge:CC:22:3D:E3:CE:0A'));
  });

  it('allocates no new AID or IID against a hap-homematic IdentifierCache', () => {
    const built = buildBridge({ hap, ccu: fakeCcu() as unknown as CcuClient, log: new PrefixedLogger(makeLog(), 't'), version: PLUGIN_VERSION },
      entry(), { devices: DEVICES, variables: VARIABLES });
    const accUuid = hap.uuid.generate('SWITCH_VIRTUAL_RECEIVER:Waschkueche Schnapper');
    const content = hapHomematicCache('880e3bf1-3038-414d-ae33-b2864d088626', accUuid);
    const { added, unused } = assignIds(built.bridge, content);
    expect(added).toEqual([]);
    expect(unused).toEqual([]);
    expect(built.bridge.bridgedAccessories[0]?.aid).toBe(4);
  });

  it('gives a characteristic added after publish its old IID back (no id purge)', () => {
    const accUuid = hap.uuid.generate('SWITCH_VIRTUAL_RECEIVER:Waschkueche Schnapper');
    const statusFault = hap.Characteristic.StatusFault.UUID;
    const content = {
      ...hapHomematicCache('880e3bf1-3038-414d-ae33-b2864d088626', accUuid),
      [`${accUuid}|${LOCK}|${LOCK}|${statusFault}`]: 12,
      [`${accUuid}|nextIID`]: 13,
    };
    const run = (purge: boolean): number | null => {
      const built = buildBridge({ hap, ccu: fakeCcu() as unknown as CcuClient, log: new PrefixedLogger(makeLog(), 't'), version: PLUGIN_VERSION },
        entry(), { devices: DEVICES, variables: VARIABLES });
      if (purge) {
        built.bridge.enableUnusedIDPurge();
      }
      const cache = new IdentifierCache('CC:22:3D:E3:CE:0A');
      cache._cache = { ...content };
      cache.save = () => undefined; // never write to HAPStorage from a test
      // As after publish(): the bridge owns the cache and reassigns on every change.
      (built.bridge as unknown as { _identifierCache: unknown })._identifierCache = cache;
      const assign = () => (built.bridge as unknown as { _assignIDs(c: unknown): void })._assignIDs(cache);
      assign();
      const lock = built.bridge.bridgedAccessories[0]!.getServiceById(hap.Service.LockMechanism, LOCK)!;
      lock.addCharacteristic(hap.Characteristic.StatusFault);
      assign();
      built.handlers.forEach((h) => h.dispose?.());
      return lock.getCharacteristic(hap.Characteristic.StatusFault).iid;
    };
    expect(run(false)).toBe(12);
    expect(run(true)).not.toBe(12);
  });

  it('builds variables and programs, skips what the CCU does not know, refuses duplicate uuids', () => {
    const log = makeLog();
    const built = buildBridge({ hap, ccu: fakeCcu() as unknown as CcuClient, log: new PrefixedLogger(log, 't'), version: PLUGIN_VERSION },
      entry({
        hapHomematicIdentity: false,
        channels: [
          { address: WINDOW, service: 'ContactAccessory', name: 'Window' },
          { address: WINDOW, service: 'ContactAccessory', name: 'Window again' },
          { address: LAMP, service: 'NoSuchAccessory' },
          { address: '0000ZZZZZZZZZZ:1', service: 'SwitchAccessory' },
        ],
        variables: [
          { name: 'Var_Soc', displayName: 'Battery', service: 'VariableNumericSensorAccessory', subtype: 'humidity', uuidSeed: 'undefined:Battery' },
          { name: 'PV_Gone', service: 'VariableNumericSensorAccessory' },
        ],
        programs: [{ name: 'Morning' }],
      }), { devices: DEVICES, variables: VARIABLES });
    expect(built.accessories.map((a) => [a.kind, a.name, a.legacyIdentity])).toEqual([
      ['channel', 'Window', false],
      ['channel', '0000ZZZZZZZZZZ:1', false],
      ['variable', 'Battery', false],
      ['program', 'Morning', false],
    ]);
    expect(built.accessories[2]?.uuid).toBe(hap.uuid.generate('variable:Var_Soc'));
    expect(built.skipped.map((s) => s.reason)).toEqual([
      expect.stringMatching(/already used/),
      'Unknown service: NoSuchAccessory',
      'variable not found on the CCU',
    ]);
    built.handlers.forEach((h) => h.dispose?.());
  });

  it('releases the CCU listeners of an accessory that cannot be added', () => {
    const ccu = fakeCcu();
    const deps = { hap, ccu: ccu as unknown as CcuClient, log: new PrefixedLogger(makeLog(), 't'), version: PLUGIN_VERSION };
    const spy = vi.spyOn(hap.Bridge.prototype, 'addBridgedAccessory').mockImplementation(() => {
      throw new Error('bridge full');
    });
    try {
      const built = buildBridge(deps, entry({ channels: [{ address: WINDOW, service: 'ContactAccessory', name: 'W' }] }), { devices: DEVICES, variables: [] });
      expect(built.accessories).toEqual([]);
      expect(built.skipped[0]?.reason).toBe('bridge full');
      expect(ccu.listenerCount()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

// --- host lifecycle ----------------------------------------------------

describe('MultiBridgeHost', () => {
  it('publishes only enabled bridges with their original identity, never a disabled one', async () => {
    const disabled = entry({ name: 'HomeMatic Live', enabled: false, username: 'CC:22:3D:E3:CE:0F', port: 51009, bridgeUuid: undefined });
    const { h, publisher, ccu } = host(multiConfig([entry(), disabled], { bind: '10.0.0.5' }));
    await h.start();
    expect(publisher.published).toHaveLength(1);
    const { bridge, info } = publisher.published[0]!;
    expect(bridge.displayName).toBe('HomeMatic Waschkueche');
    expect(info).toEqual({
      username: 'CC:22:3D:E3:CE:0A', pincode: '111-22-333', setupID: 'AB12', port: 51001,
      category: 2, advertiser: 'ciao', addIdentifyingMaterial: false, bind: '10.0.0.5',
    });
    expect(h.publishedBridges()).toEqual(['HomeMatic Waschkueche']);
    expect(ccu.listVariables).not.toHaveBeenCalled();
  });

  it('does nothing (not even the CCU) when no bridge is enabled', async () => {
    const { h, publisher, ccu } = host(multiConfig([entry({ enabled: false })]));
    await h.start();
    expect(ccu.start).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('waits for a live CCU before publishing anything, then retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { h, publisher, ccu } = host(multiConfig([entry({ variables: [{ name: 'Var_Soc', service: 'VariableNumericSensorAccessory' }] })]));
    ccu.isLive.mockReturnValueOnce(false);
    ccu.listDevices.mockResolvedValueOnce([]).mockResolvedValue(DEVICES);
    ccu.listVariables.mockRejectedValueOnce(new Error('timeout'));
    const started = h.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(publisher.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); // attempt 2: no devices
    expect(publisher.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); // attempt 3: variables fail
    expect(publisher.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); // attempt 4: ok
    await started;
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(ccu.start).toHaveBeenCalledTimes(4);
    expect(ccu.stop).toHaveBeenCalledTimes(3);
    await h.stop();
  });

  it('stop() while waiting for the CCU ends start() without publishing', async () => {
    const { h, publisher, ccu } = host(multiConfig([entry()]));
    ccu.isLive.mockReturnValue(false);
    const started = h.start();
    await new Promise((r) => setTimeout(r, 5));
    await h.stop();
    await started;
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['missing AccessoryInfo', { accessoryInfo: 'missing', identifierCache: 'ok' }, /AccessoryInfo file missing/],
    ['missing IdentifierCache', { accessoryInfo: 'ok', identifierCache: 'missing' }, /IdentifierCache file missing/],
    ['pin mismatch', { accessoryInfo: 'ok', identifierCache: 'ok', pincodeMatches: false }, /pincode differs/],
    ['setupID mismatch', { accessoryInfo: 'ok', identifierCache: 'ok', pincodeMatches: true, setupIdMatches: false }, /setupID differs/],
  ] as const)('refuses a transplanted bridge with %s', async (_l, check, re) => {
    const { h, publisher, log, ccu } = host(multiConfig([entry()]), { identityStore: { check: () => ({ ...check }) } });
    await h.start();
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(fmt(vi.mocked(log.error).mock.calls)[0]).toMatch(/not published/);
    expect(fmt(vi.mocked(log.error).mock.calls)[0]).toMatch(re);
    expect(ccu.listenerCount()).toBe(0);
  });

  it('publishes a smoke-test bridge with a new identity without persist files', async () => {
    const check = vi.fn(() => ({ accessoryInfo: 'missing' as const, identifierCache: 'missing' as const }));
    const { h, publisher } = host(multiConfig([entry({ newIdentity: true })]), { identityStore: { check } });
    await h.start();
    expect(check).not.toHaveBeenCalled();
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('refuses a bridge whose port is taken, or that has no accessory, and continues with the next', async () => {
    const second = entry({ name: 'HomeMatic Flur', username: 'CC:22:3D:E3:CE:0B', port: 51002, bridgeUuid: undefined,
      channels: [{ address: LAMP, service: 'SwitchAccessory', name: 'Flur' }] });
    const empty = entry({ name: 'HomeMatic Leer', username: 'CC:22:3D:E3:CE:0C', port: 51003, bridgeUuid: undefined,
      channels: [{ address: LAMP, service: 'NoSuchAccessory' }] });
    const { h, publisher, log } = host(multiConfig([entry(), second, empty]), { portProbe: async (p) => p !== 51001 });
    await h.start();
    expect(publisher.published.map((p) => p.bridge.displayName)).toEqual(['HomeMatic Flur']);
    const errors = fmt(vi.mocked(log.error).mock.calls);
    expect(errors.some((e) => /port 51001 is in use/.test(e))).toBe(true);
    expect(errors.some((e) => /no accessory could be built/.test(e))).toBe(true);
  });

  it('logs a build failure and a publish failure without publishing', async () => {
    const { h, publisher, log } = host(multiConfig([entry()]));
    vi.mocked(publisher.publish).mockRejectedValueOnce(new Error('EADDRNOTAVAIL'));
    await h.start();
    expect(publisher.unpublish).toHaveBeenCalledTimes(1);
    expect(h.publishedBridges()).toEqual([]);
    expect(fmt(vi.mocked(log.error).mock.calls)[0]).toMatch(/publish failed: EADDRNOTAVAIL/);

    const spy = vi.spyOn(hap.Bridge.prototype, 'getService').mockImplementation(() => {
      throw new Error('broken');
    });
    try {
      const again = host(multiConfig([entry()]));
      await again.h.start();
      expect(again.publisher.publish).not.toHaveBeenCalled();
      expect(fmt(vi.mocked(again.log.error).mock.calls)[0]).toMatch(/build failed: broken/);
    } finally {
      spy.mockRestore();
    }
  });

  it('unpublishes (never destroys) every bridge on stop and releases listeners and the CCU', async () => {
    const second = entry({ name: 'HomeMatic Flur', username: 'CC:22:3D:E3:CE:0B', port: 51002, bridgeUuid: undefined,
      channels: [{ address: WINDOW, service: 'ContactAccessory', name: 'Flur Fenster' }] });
    const { h, publisher, ccu } = host(multiConfig([entry(), second]));
    await h.start();
    expect(ccu.listenerCount()).toBeGreaterThan(0);
    const destroy = vi.spyOn(hap.Accessory.prototype, 'destroy');
    try {
      await h.stop();
      expect(publisher.unpublished).toHaveLength(2);
      expect(destroy).not.toHaveBeenCalled();
      expect(ccu.listenerCount()).toBe(0);
      expect(ccu.stop).toHaveBeenCalled();
      expect(h.publishedBridges()).toEqual([]);
    } finally {
      destroy.mockRestore();
    }
  });

  it('bounds shutdown time and survives unpublish and CCU stop errors', async () => {
    const { h, publisher, ccu, log } = host(multiConfig([entry()]), { shutdownTimeoutMs: 20 });
    await h.start();
    vi.mocked(publisher.unpublish).mockImplementationOnce(() => new Promise(() => undefined));
    ccu.stop.mockRejectedValueOnce(new Error('gone'));
    await h.stop();
    const warns = fmt(vi.mocked(log.warn).mock.calls);
    expect(warns.some((w) => /Unpublish HomeMatic Waschkueche failed: timed out/.test(w))).toBe(true);
    expect(warns.some((w) => /CCU stop failed: gone/.test(w))).toBe(true);
  });

  it('unpublishes a bridge whose publish finished after shutdown began', async () => {
    const { h, publisher } = host(multiConfig([entry()]));
    let release: () => void = () => undefined;
    vi.mocked(publisher.publish).mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const started = h.start();
    await new Promise((r) => setTimeout(r, 5));
    const stopped = h.stop();
    release();
    await Promise.all([started, stopped]);
    expect(publisher.unpublish).toHaveBeenCalledTimes(1);
    expect(h.publishedBridges()).toEqual([]);
  });

  it('the real publisher calls publish(info, false) and unpublish(), nothing else', async () => {
    const bridge = { publish: vi.fn(async () => undefined), unpublish: vi.fn(async () => undefined), destroy: vi.fn() };
    const info = { username: 'CC:22:3D:E3:CE:0A', pincode: '111-22-333', port: 1 } as PublishInfo;
    await hapPublisher.publish(bridge as unknown as HapBridge, info);
    await hapPublisher.unpublish(bridge as unknown as HapBridge);
    expect(bridge.publish).toHaveBeenCalledWith(info, false);
    expect(bridge.unpublish).toHaveBeenCalledTimes(1);
    expect(bridge.destroy).not.toHaveBeenCalled();
  });
});

// --- identity files and ports ----------------------------------------

describe('persistIdentityStore', () => {
  const user = 'CC:22:3D:E3:CE:0A';
  const write = (kind: 'AccessoryInfo' | 'IdentifierCache', body: string) =>
    fs.writeFile(path.join(tmp, persistFileName(kind, user)), body, { mode: 0o600 });

  it('names files like HAP-NodeJS', () => {
    expect(persistFileName('AccessoryInfo', 'cc:22:3d:e3:ce:0a')).toBe('AccessoryInfo.CC223DE3CE0A.json');
  });

  it('reports missing files', () => {
    const r = persistIdentityStore(tmp).check({ username: user, pincode: '111-22-333' });
    expect(r).toEqual({ accessoryInfo: 'missing', identifierCache: 'missing' });
    expect(identityProblem(r)).toBe('AccessoryInfo file missing');
  });

  it('compares pin and setupID without exposing them', async () => {
    await write('AccessoryInfo', JSON.stringify({ signSk: 'x', pincode: '111-22-333', setupID: 'AB12' }));
    await write('IdentifierCache', JSON.stringify({ cache: {} }));
    const store = persistIdentityStore(tmp);
    const ok = store.check({ username: user, pincode: '111-22-333', setupID: 'AB12' });
    expect(ok).toEqual({ accessoryInfo: 'ok', identifierCache: 'ok', pincodeMatches: true, setupIdMatches: true });
    expect(identityProblem(ok)).toBeUndefined();
    const bad = store.check({ username: user, pincode: '999-99-999', setupID: 'ZZ99' });
    expect(bad).toEqual({ accessoryInfo: 'ok', identifierCache: 'ok', pincodeMatches: false, setupIdMatches: false });
    expect(JSON.stringify(bad)).not.toMatch(/111|AB12/);
    expect(store.check({ username: user, pincode: '111-22-333' }).setupIdMatches).toBeUndefined();
  });

  it('treats broken or keyless files as unreadable', async () => {
    await write('AccessoryInfo', JSON.stringify({ pincode: '111-22-333' }));
    await write('IdentifierCache', '{not json');
    const r = persistIdentityStore(tmp).check({ username: user, pincode: '111-22-333' });
    expect(r).toEqual({ accessoryInfo: 'unreadable', identifierCache: 'unreadable' });
    await write('AccessoryInfo', '[]');
    await write('IdentifierCache', JSON.stringify({ cache: null }));
    const r2 = persistIdentityStore(tmp).check({ username: user, pincode: '111-22-333' });
    expect(r2).toEqual({ accessoryInfo: 'unreadable', identifierCache: 'unreadable' });
    expect(identityProblem({ accessoryInfo: 'ok', identifierCache: 'unreadable' })).toBe('IdentifierCache file unreadable');
  });

  it('reports a directory in place of a file as unreadable', async () => {
    await fs.mkdir(path.join(tmp, persistFileName('AccessoryInfo', user)));
    expect(persistIdentityStore(tmp).check({ username: user, pincode: '111-22-333' }).accessoryInfo).toBe('unreadable');
  });
});

describe('isTcpPortFree', () => {
  it('sees a busy and a free port', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(await isTcpPortFree(port)).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(await isTcpPortFree(port)).toBe(true);
  });
});
