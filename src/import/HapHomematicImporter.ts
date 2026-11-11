/**
 * Imports a hap-homematic configuration into our config schema.
 *
 * Two entry points:
 *   - importBackupTarball(buffer)  — stream a .tar.gz from the UI
 *   - importConfigJson(rawConfig)  — for users who only have config.json
 *
 * The mapping logic is the only place where we name-translate from the
 * old plugin's service classes to ours. New name aliases go in
 * `SERVICE_ALIASES`. Anything we can't map produces a warning in the
 * `ImportReport` rather than failing the whole import.
 *
 * For users who configured one HAP bridge per hap-homematic *instance*
 * (typically one bridge per room), `splitReportIntoBridges` converts the
 * flat report into one Homebridge platform-config block per instance,
 * each with a deterministic `_bridge: { username, port }` so child-bridge
 * identity is stable across re-runs of the import.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { list as tarList } from 'tar';
import type {
  ChannelMapping,
  ProgramMapping,
  ResolvedConfig,
  VariableMapping,
} from '../types.js';

const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_CONFIG_JSON_BYTES = 16 * 1024 * 1024;

/** hap-homematic service class -> our service key. */
const SERVICE_ALIASES: Record<string, string> = {
  HomeMaticSwitchAccessory: 'SwitchAccessory',
  HomeMaticDimmerAccessory: 'DimmerAccessory',
  HomeMaticBlindAccessory: 'BlindAccessory',
  HomeMaticBlindIPAccessory: 'BlindAccessory',
  HomeMaticContactSensorAccessory: 'ContactAccessory',
  HomeMaticWindowAccessory: 'ContactAccessory',
  HomeMaticDoorAccessory: 'ContactAccessory',
  HomeMaticMotionAccessory: 'MotionAccessory',
  HomeMaticIPMotionAccessory: 'MotionAccessory',
  HomeMaticPresenceAccessory: 'MotionAccessory',
  HomeMaticThermostatAccessory: 'ThermostatAccessory',
  HomeMaticRadiatorThermostatAccessory: 'ThermostatAccessory',
  HomeMaticThermometerAccessory: 'TemperatureAccessory',
  HomeMaticHumidityAccessory: 'HumidityAccessory',
  HomeMaticSmokeDetectorAccessory: 'SmokeAccessory',
  HomeMaticLeakSensorAccessory: 'LeakAccessory',
  HomeMaticVariableAccessory: 'VariableSwitchAccessory',
  HomeMaticVariableNumberSensorAccessory: 'VariableNumericSensorAccessory',
  HomeMaticVarBasedThermometerAccessory: 'VariableNumericSensorAccessory',
  // hap-homematic's PushTheButton is an *output*: a HomeKit switch that
  // sends PRESS_SHORT/PRESS_LONG to the CCU. Not a button sensor.
  HomeMaticPushTheButtonAccessory: 'KeyPressSwitchAccessory',
  HomeMaticDoorOpenerAccessory: 'DoorOpenerAccessory',
  HomeMaticProgramAccessory: 'ProgramAccessory',
};

/** Default subtype for service classes that have meaningful sub-variants. */
const SERVICE_DEFAULT_SUBTYPE: Record<string, string> = {
  HomeMaticWindowAccessory: 'window',
  HomeMaticDoorAccessory: 'door',
  HomeMaticContactSensorAccessory: 'contact',
  HomeMaticVarBasedThermometerAccessory: 'temperature',
};

/** hap-homematic Type setting -> our subtype. */
const SUBTYPE_ALIASES: Record<string, string> = {
  Switch: 'switch',
  Outlet: 'outlet',
  Lightbulb: 'lightbulb',
  Door: 'door',
  Window: 'window',
};

/** hap-homematic VariableNumberSensor `Type` -> VariableNumericSensorAccessory variant. */
const NUMBER_SENSOR_TYPES: Record<string, string> = {
  Humidity: 'humidity',
  LuxOmeter: 'light',
};

/** hap-homematic's default instance id: HAP uuid.generate('0'). */
export const HAP_HOMEMATIC_DEFAULT_INSTANCE = hapUuid('0');

const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;
const SETUP_ID_RE = /^[0-9A-Z]{4}$/;
const PIN_RE = /^\d{3}-\d{2}-\d{3}$/;

export interface HapHomematicInstance {
  name?: string;
  /** HAP username (bridge MAC) of this hap-homematic bridge. */
  user?: string;
  pincode?: string;
  pin?: string;
  setupID?: string;
  roomId?: number | string;
  publishDevices?: boolean;
}

export interface ImportOptions {
  /**
   * CCU channel address -> channel type (e.g. `BLIND_VIRTUAL_RECEIVER`),
   * from the backup's `devices.json`. Needed to compute hap-homematic's
   * accessory UUID seeds (`<type>:<name>`). Filled automatically by
   * `importBackupTarball`.
   */
  channelTypes?: Record<string, string>;
}

export interface ImportReport {
  channels: ChannelMapping[];
  variables: VariableMapping[];
  programs: ProgramMapping[];
  warnings: string[];
  meta: {
    instanceCount: number;
    sourceVersion?: string;
    ccuIp?: string;
    instances: Record<string, HapHomematicInstance>;
    /** Mappings hap-homematic does not publish (their instance no longer exists). */
    skipped?: Array<{ kind: 'channel' | 'variable' | 'program'; id: string; instance: string }>;
  };
}

/** A single Homebridge platform-config block emitted by multi-bridge import. */
export interface BridgeImportBlock {
  /** Source instance UUID, kept for traceability. */
  instanceUuid: string;
  /** Display name shown in the Home app. */
  name: string;
  /**
   * `_bridge` identity for the child-bridge feature. With
   * `preserveIdentity` it carries the hap-homematic bridge's username,
   * pin and setupID so a transplanted pairing stays valid.
   */
  bridge: { username: string; port: number; pin?: string; setupID?: string; name?: string };
  /** True when mappings carry hap-homematic `uuidSeed`s (see ResolvedConfig). */
  hapHomematicIdentity: boolean;
  channels: ChannelMapping[];
  variables: VariableMapping[];
  programs: ProgramMapping[];
}

export interface SplitOptions {
  /**
   * Reuse each hap-homematic bridge's HomeKit identity (username, pin,
   * setupID, accessory UUIDs). Only useful together with copying that
   * bridge's `persist/AccessoryInfo.*.json` and `IdentifierCache.*.json`
   * into Homebridge's persist directory; see the migration doc.
   */
  preserveIdentity?: boolean;
}

export interface HapHomematicConfigShape {
  ccuIP?: string;
  channels?: string[];
  variables?: string[];
  programs?: string[];
  mappings?: Record<string, {
    Service?: string;
    Type?: string;
    /** hap-homematic stores a list of instance ids; older/hand-made configs a string. */
    instance?: string | string[];
    name?: string;
    /** hap-homematic keeps per-service settings (incl. `Type`) nested here. */
    settings?: Record<string, unknown>;
    [k: string]: unknown;
  }>;
  instances?: Record<string, HapHomematicInstance>;
  version?: string;
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export async function importBackupTarball(tarball: Buffer): Promise<ImportReport> {
  if (!Buffer.isBuffer(tarball) || tarball.length === 0) {
    throw new ImportError('Empty or invalid tarball');
  }
  if (tarball.length > MAX_TARBALL_BYTES) {
    throw new ImportError(`Tarball larger than ${MAX_TARBALL_BYTES / (1024 * 1024)} MiB`);
  }
  const files = await extractJsonFiles(tarball, ['config.json', 'devices.json']);
  const configJson = files.get('config.json');
  if (!configJson) {
    throw new ImportError('No config.json found in backup');
  }
  const devicesJson = files.get('devices.json');
  return importConfigJson(configJson as HapHomematicConfigShape, {
    channelTypes: devicesJson ? channelTypesFromDevicesJson(devicesJson) : undefined,
  });
}

/** `devices.json` (hap-homematic's CCU cache) -> channel address -> channel type. */
export function channelTypesFromDevicesJson(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const devices = (raw as { devices?: unknown })?.devices;
  if (!Array.isArray(devices)) {
    return out;
  }
  for (const d of devices) {
    const chans = (d as { channels?: unknown })?.channels;
    if (!Array.isArray(chans)) continue;
    for (const c of chans) {
      const address = (c as { address?: unknown })?.address;
      const type = (c as { type?: unknown })?.type;
      if (typeof address === 'string' && typeof type === 'string' && type.length > 0) {
        out[address] = type;
      }
    }
  }
  return out;
}

type RawMapping = NonNullable<HapHomematicConfigShape['mappings']>[string];

export function importConfigJson(raw: HapHomematicConfigShape | string, options: ImportOptions = {}): ImportReport {
  const config: HapHomematicConfigShape = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!config || typeof config !== 'object') {
    throw new ImportError('Invalid config payload');
  }

  const warnings: string[] = [];
  const channels: ChannelMapping[] = [];
  const variables: VariableMapping[] = [];
  const programs: ProgramMapping[] = [];
  const skipped: NonNullable<ImportReport['meta']['skipped']> = [];
  const instances = config.instances ?? {};
  const channelTypes = options.channelTypes ?? {};

  /**
   * hap-homematic semantics: a mapping is published on the bridges listed
   * in `instance` (an array); without one it goes to the default instance.
   * A mapping whose instances no longer exist is not published at all, so
   * importing it would create an accessory HomeKit never had.
   */
  const resolveInstance = (kind: 'channel' | 'variable' | 'program', id: string, mapping: RawMapping): string | undefined | null => {
    const list = Array.isArray(mapping.instance)
      ? mapping.instance.filter((i): i is string => typeof i === 'string' && i.length > 0)
      : typeof mapping.instance === 'string' && mapping.instance.length > 0 ? [mapping.instance] : [];
    if (Object.keys(instances).length === 0) {
      return list[0];
    }
    if (list.length === 0) {
      return undefined;
    }
    const known = list.filter((i) => i in instances);
    if (known.length === 0) {
      skipped.push({ kind, id, instance: list[0]! });
      warnings.push(`${kind} ${id}: its hap-homematic bridge no longer exists, so hap-homematic does not publish it; skipped`);
      return null;
    }
    if (known.length > 1) {
      warnings.push(`${kind} ${id} is published on ${known.length} hap-homematic bridges; only the first is migrated`);
    }
    return known[0];
  };

  for (const address of config.channels ?? []) {
    if (typeof address !== 'string' || address.length === 0) {
      continue;
    }
    const mapping: RawMapping = config.mappings?.[address] ?? {};
    const sourceService = mapping.Service ?? '';
    const service = SERVICE_ALIASES[sourceService];
    if (!service) {
      warnings.push(`Could not map service "${sourceService || '?'}" for channel ${address} — skipped`);
      continue;
    }
    const instance = resolveInstance('channel', address, mapping);
    if (instance === null) {
      continue;
    }
    const settings = flattenSettings(mapping);
    const type = typeof settings.Type === 'string' ? settings.Type : undefined;
    const subtype = type
      ? SUBTYPE_ALIASES[type] ?? SERVICE_DEFAULT_SUBTYPE[sourceService]
      : SERVICE_DEFAULT_SUBTYPE[sourceService];
    // hap-homematic stores the user-customised HomeKit display name under
    // `name`. Lift it to the top-level mapping field so the platform can
    // use it as the accessory display name (otherwise we'd inherit the
    // raw HomeMatic name from the CCU).
    const customName = typeof mapping.name === 'string' && mapping.name.length > 0
      ? mapping.name : undefined;
    const channelType = channelTypes[address];
    channels.push(withoutUndefined({
      address,
      name: customName,
      service,
      subtype,
      instance,
      settings: dropKeys(settings, ['Type']),
      // hap-homematic: uuid.generate(`${channel.type}:${name}`)
      uuidSeed: customName && channelType ? `${channelType}:${customName}` : undefined,
    }));
  }

  for (const name of config.variables ?? []) {
    if (typeof name !== 'string' || name.length === 0) {
      continue;
    }
    // hap-homematic keys variable mappings by `<name>:0`.
    const mapping: RawMapping = config.mappings?.[`${name}:0`] ?? config.mappings?.[name] ?? {};
    const sourceService = mapping.Service ?? '';
    const service = SERVICE_ALIASES[sourceService];
    if (sourceService && !service) {
      warnings.push(`Could not map variable service "${sourceService}" for "${name}" — kept with default mapping`);
    }
    const instance = resolveInstance('variable', name, mapping);
    if (instance === null) {
      continue;
    }
    const settings = flattenSettings(mapping);
    const type = typeof settings.Type === 'string' ? settings.Type : undefined;
    let subtype = SERVICE_DEFAULT_SUBTYPE[sourceService];
    if (sourceService === 'HomeMaticVariableNumberSensorAccessory' && type) {
      subtype = NUMBER_SENSOR_TYPES[type];
      if (!subtype) {
        warnings.push(`Variable "${name}": sensor type "${type}" has no equivalent; it will be derived from the variable's unit`);
      }
    }
    const customName = typeof mapping.name === 'string' && mapping.name.length > 0
      ? mapping.name : undefined;
    variables.push(withoutUndefined({
      name,
      displayName: customName,
      service,
      subtype,
      instance,
      settings: dropKeys(settings, ['Type']),
      // hap-homematic variables have no channel type: `undefined:<name>`.
      uuidSeed: customName ? `undefined:${customName}` : undefined,
    }));
  }

  for (const name of config.programs ?? []) {
    if (typeof name !== 'string' || name.length === 0) {
      continue;
    }
    const mapping: RawMapping = config.mappings?.[`${name}:0`] ?? config.mappings?.[name] ?? {};
    const instance = resolveInstance('program', name, mapping);
    if (instance === null) {
      continue;
    }
    const customName = typeof mapping.name === 'string' && mapping.name.length > 0
      ? mapping.name : undefined;
    programs.push(withoutUndefined({
      name,
      displayName: customName,
      instance,
    }));
  }

  return {
    channels,
    variables,
    programs,
    warnings,
    meta: {
      instanceCount: Object.keys(instances).length,
      sourceVersion: config.version,
      ccuIp: config.ccuIP,
      instances,
      skipped,
    },
  };
}

/** Merge an ImportReport into an existing ResolvedConfig (channels, variables, programs). */
export function mergeIntoConfig(target: Partial<ResolvedConfig>, report: ImportReport): Partial<ResolvedConfig> {
  // Merging several hap-homematic bridges into one bridge always creates
  // new HomeKit identities, so the hap-homematic UUID seeds do not apply.
  const existingChannels = new Map((target.channels ?? []).map((m) => [m.address, m]));
  for (const m of report.channels) {
    existingChannels.set(m.address, stripSeed(m));
  }
  const existingVars = new Map((target.variables ?? []).map((m) => [m.name, m]));
  for (const m of report.variables) {
    existingVars.set(m.name, stripSeed(m));
  }
  const existingProgs = new Map((target.programs ?? []).map((m) => [m.name, m]));
  for (const m of report.programs) {
    existingProgs.set(m.name, m);
  }
  return {
    ...target,
    ccuIp: target.ccuIp ?? report.meta.ccuIp,
    channels: Array.from(existingChannels.values()),
    variables: Array.from(existingVars.values()),
    programs: Array.from(existingProgs.values()),
  };
}

/**
 * Split a flat ImportReport into one Homebridge platform block per
 * hap-homematic instance. Items whose `instance` field is missing or
 * unknown are folded into the first block (so nothing is silently
 * dropped). Each block gets a deterministic `_bridge.username` and
 * `_bridge.port` derived from the instance UUID — re-imports produce
 * the same identities, which preserves Homebridge child-bridge pairing
 * across runs.
 */
export function splitReportIntoBridges(report: ImportReport, options: SplitOptions = {}): BridgeImportBlock[] {
  const preserve = options.preserveIdentity === true;
  const instances = report.meta.instances ?? {};
  const uuids = Object.keys(instances);
  const seedFilter = <T extends { uuidSeed?: string }>(m: T): T => (preserve ? { ...m } : stripSeed(m));

  if (uuids.length === 0) {
    if (preserve) {
      throw new ImportError('preserveIdentity needs the hap-homematic instances (bridge identities) from the backup');
    }
    return [{
      instanceUuid: 'default',
      name: 'HomematicHap',
      bridge: bridgeIdentityFor('default'),
      hapHomematicIdentity: false,
      channels: report.channels.map(seedFilter),
      variables: report.variables.map(seedFilter),
      programs: [...report.programs],
    }];
  }

  const blocks = new Map<string, BridgeImportBlock>();
  for (const uuid of uuids) {
    const inst = instances[uuid] ?? {};
    blocks.set(uuid, {
      instanceUuid: uuid,
      name: hapHomematicBridgeName(inst.name) ?? `HomematicHap-${uuid.slice(0, 8)}`,
      bridge: preserve ? preservedBridgeIdentity(uuid, inst) : bridgeIdentityFor(uuid),
      hapHomematicIdentity: preserve,
      channels: [],
      variables: [],
      programs: [],
    });
  }

  // Mappings without an instance go where hap-homematic put them: the
  // default instance if it exists, otherwise the first block.
  const fallbackUuid = blocks.has(HAP_HOMEMATIC_DEFAULT_INSTANCE) ? HAP_HOMEMATIC_DEFAULT_INSTANCE : uuids[0]!;
  const targetFor = (instance?: string): BridgeImportBlock => {
    const direct = instance ? blocks.get(instance) : undefined;
    return direct ?? blocks.get(fallbackUuid)!;
  };
  report.channels.forEach((m) => { targetFor(m.instance).channels.push(seedFilter(m)); });
  report.variables.forEach((m) => { targetFor(m.instance).variables.push(seedFilter(m)); });
  report.programs.forEach((m) => { targetFor(m.instance).programs.push({ ...m }); });

  // Bridges without accessories are not worth a Homebridge child process.
  const all = Array.from(blocks.values());
  const nonEmpty = all.filter((b) => b.channels.length + b.variables.length + b.programs.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : all;
}

/** hap-homematic's bridge name: `HomeMatic <instance name>` with `.:#_()-` blanked. */
export function hapHomematicBridgeName(instanceName: string | undefined): string | undefined {
  if (typeof instanceName !== 'string' || instanceName.length === 0) {
    return undefined;
  }
  return `HomeMatic ${instanceName.replace(/[.:#_()-]/g, ' ')}`;
}

function preservedBridgeIdentity(uuid: string, inst: HapHomematicInstance): BridgeImportBlock['bridge'] {
  const user = typeof inst.user === 'string' ? inst.user.toUpperCase() : '';
  if (!MAC_RE.test(user)) {
    throw new ImportError(`hap-homematic bridge "${inst.name ?? uuid}" has no valid HAP username; cannot preserve its identity`);
  }
  const pin = typeof inst.pincode === 'string' ? inst.pincode : inst.pin;
  const identity: BridgeImportBlock['bridge'] = {
    username: user,
    port: bridgeIdentityFor(uuid).port,
  };
  if (typeof pin === 'string' && PIN_RE.test(pin)) {
    identity.pin = pin;
  }
  if (typeof inst.setupID === 'string' && SETUP_ID_RE.test(inst.setupID)) {
    identity.setupID = inst.setupID;
  }
  const name = hapHomematicBridgeName(inst.name);
  if (name) {
    identity.name = name;
  }
  return identity;
}

/**
 * Deterministic, locally-administered MAC + port pair from an instance
 * identifier. The MAC sets the locally-administered + unicast bits so
 * it never collides with real OUI-assigned NICs. The port is in
 * 9000..14999 — well clear of the default Homebridge range and unlikely
 * to clash with common services.
 */
export function bridgeIdentityFor(seed: string): { username: string; port: number } {
  const hash = createHash('sha256').update(seed).digest();
  const bytes: string[] = [];
  for (let i = 0; i < 6; i++) {
    let b = hash[i]!;
    if (i === 0) {
      // Force locally-administered (bit 1 set) and unicast (bit 0 cleared).
      b = (b & 0xfe) | 0x02;
    }
    bytes.push(b.toString(16).toUpperCase().padStart(2, '0'));
  }
  const port = 9000 + (hash.readUInt16BE(6) % 6000);
  return { username: bytes.join(':'), port };
}

// --- internals -------------------------------------------------------

/**
 * HAP-NodeJS `uuid.generate`: SHA-1 hex digits poured into the template
 * `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` (the literal 4 consumes no digit,
 * `y` gets the RFC 4122 variant bits).
 */
export function hapUuid(seed: string): string {
  const h = createHash('sha1').update(seed).digest('hex');
  let i = -1;
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    i += 1;
    const digit = h[i]!;
    return c === 'y' ? ((parseInt(digit, 16) & 0x3) | 0x8).toString(16) : digit;
  });
}

/** Top-level archive member (`config.json`, `./config.json`), not `etc/config.json`. */
function topLevelName(path: string): string | undefined {
  const p = path.replace(/^\.\//, '');
  return p.includes('/') ? undefined : p;
}

/**
 * Parse the named top-level JSON members out of a .tar.gz without
 * touching the filesystem (`tar.list` is parse-only, unlike
 * `tar.extract`, which matters inside a long-lived Homebridge process).
 */
async function extractJsonFiles(tarball: Buffer, names: string[]): Promise<Map<string, unknown>> {
  return new Promise<Map<string, unknown>>((resolve, reject) => {
    const found = new Map<string, unknown>();
    let failed = false;
    const fail = (err: Error): void => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    };
    const stream = Readable.from(tarball);
    const parser = tarList({
      filter: (path) => {
        const n = topLevelName(path);
        return n !== undefined && names.includes(n);
      },
      onReadEntry: (entry) => {
        const name = topLevelName(entry.path)!;
        if (found.has(name)) {
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        entry.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_CONFIG_JSON_BYTES) {
            entry.destroy(new ImportError(`${name} too large`));
            return;
          }
          chunks.push(chunk);
        });
        entry.on('end', () => {
          try {
            found.set(name, safeParse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            fail(err as Error);
          }
        });
        entry.on('error', (err) => fail(err as Error));
      },
    });
    parser.on('end', () => {
      if (!failed) {
        resolve(found);
      }
    });
    parser.on('error', (err: Error) => fail(err));
    stream.pipe(parser as unknown as NodeJS.WritableStream);
  });
}

function safeParse(text: string): HapHomematicConfigShape {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ImportError('Backup config.json is not a JSON object');
    }
    return parsed as HapHomematicConfigShape;
  } catch (err) {
    if (err instanceof ImportError) {
      throw err;
    }
    throw new ImportError(`Invalid JSON: ${(err as Error).message}`);
  }
}

function dropKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k)) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * hap-homematic keeps service settings in `mapping.settings`; hand-made or
 * older configs put them next to `Service`. Merge both levels (nested wins)
 * and drop the keys that are lifted elsewhere.
 */
function flattenSettings(mapping: RawMapping): Record<string, unknown> {
  const top = dropKeys(mapping as Record<string, unknown>, ['Service', 'instance', 'name', 'settings']);
  const nested = mapping.settings && typeof mapping.settings === 'object' && !Array.isArray(mapping.settings)
    ? mapping.settings : {};
  return { ...top, ...nested };
}

function stripSeed<T extends { uuidSeed?: string }>(m: T): T {
  const { uuidSeed: _drop, ...rest } = m;
  return rest as T;
}

function withoutUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}
