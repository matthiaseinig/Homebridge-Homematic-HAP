/**
 * Validation of the `multiBridge` section of a platform block. Any invalid
 * entry makes the whole block refuse to start (ConfigError): publishing
 * part of a misconfigured set is worse than publishing nothing, because a
 * HomeKit bridge that is unreachable keeps its accessories while a bridge
 * that comes back with fewer accessories loses them.
 */

import { ConfigError } from '../util/config.js';
import type {
  ChannelMapping,
  MdnsAdvertiser,
  MultiBridgeConfig,
  MultiBridgeEntry,
  ProgramMapping,
  RawMultiBridgeConfig,
  VariableMapping,
} from '../types.js';

const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
const PIN_RE = /^\d{3}-\d{2}-\d{3}$/;
const SETUP_ID_RE = /^[0-9A-Z]{4}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADVERTISERS: ReadonlySet<MdnsAdvertiser> = new Set(['ciao', 'bonjour-hap', 'avahi', 'resolved']);
const BRIDGE_CATEGORY = 2;
const DEFAULT_RETRY_SECONDS = 30;

/** Ports and username that the block's own Homebridge child bridge uses. */
export interface HostBridgeIdentity {
  username?: string;
  port?: number;
}

export interface ReservedPorts {
  eventServerPort: number;
  host?: HostBridgeIdentity;
}

export function resolveMultiBridgeConfig(raw: RawMultiBridgeConfig, reserved: ReservedPorts): MultiBridgeConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('multiBridge must be an object');
  }
  const advertiser = (raw.advertiser ?? 'ciao') as MdnsAdvertiser;
  if (!ADVERTISERS.has(advertiser)) {
    throw new ConfigError(`multiBridge.advertiser must be one of ${[...ADVERTISERS].join(', ')}`);
  }
  const retrySeconds = Number(raw.retrySeconds ?? DEFAULT_RETRY_SECONDS);
  if (!Number.isInteger(retrySeconds) || retrySeconds < 5 || retrySeconds > 600) {
    throw new ConfigError('multiBridge.retrySeconds must be an integer in [5, 600]');
  }
  if (raw.bind !== undefined && !isBind(raw.bind)) {
    throw new ConfigError('multiBridge.bind must be a string or a list of strings');
  }
  if (!Array.isArray(raw.bridges) || raw.bridges.length === 0) {
    throw new ConfigError('multiBridge.bridges must be a non-empty list');
  }

  const bridges = raw.bridges.map((b, i) => resolveEntry(b, i));
  checkUnique(bridges, reserved);

  const out: MultiBridgeConfig = { advertiser, retrySeconds, bridges };
  if (raw.bind !== undefined) {
    out.bind = raw.bind;
  }
  return out;
}

function isBind(v: unknown): v is string | string[] {
  if (typeof v === 'string') {
    return v.length > 0;
  }
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0);
}

type RawEntry = NonNullable<RawMultiBridgeConfig['bridges']>[number];

function resolveEntry(raw: RawEntry, index: number): MultiBridgeEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`multiBridge.bridges[${index}] must be an object`);
  }
  const where = typeof raw.name === 'string' && raw.name.length > 0
    ? `multiBridge bridge "${raw.name}"`
    : `multiBridge.bridges[${index}]`;
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    throw new ConfigError(`${where}: name is required`);
  }
  const username = typeof raw.username === 'string' ? raw.username.toUpperCase() : '';
  if (!MAC_RE.test(username)) {
    throw new ConfigError(`${where}: username must look like AA:BB:CC:DD:EE:FF`);
  }
  if (typeof raw.pincode !== 'string' || !PIN_RE.test(raw.pincode)) {
    throw new ConfigError(`${where}: pincode must look like 123-45-678`);
  }
  if (raw.setupID !== undefined && (typeof raw.setupID !== 'string' || !SETUP_ID_RE.test(raw.setupID))) {
    throw new ConfigError(`${where}: setupID must be 4 characters 0-9 A-Z`);
  }
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ConfigError(`${where}: port must be an integer in [1024, 65535]`);
  }
  if (raw.bridgeUuid !== undefined && (typeof raw.bridgeUuid !== 'string' || !UUID_RE.test(raw.bridgeUuid))) {
    throw new ConfigError(`${where}: bridgeUuid must be a UUID`);
  }
  const category = Number(raw.category ?? BRIDGE_CATEGORY);
  if (!Number.isInteger(category) || category < 1 || category > 255) {
    throw new ConfigError(`${where}: category must be an integer HAP category`);
  }
  for (const key of ['enabled', 'newIdentity', 'hapHomematicIdentity'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') {
      throw new ConfigError(`${where}: ${key} must be true or false`);
    }
  }
  const channels = mappingList<ChannelMapping>(raw.channels, `${where}: channels`, (m) => typeof m.address === 'string' && typeof m.service === 'string');
  const variables = mappingList<VariableMapping>(raw.variables, `${where}: variables`, (m) => typeof m.name === 'string');
  const programs = mappingList<ProgramMapping>(raw.programs, `${where}: programs`, (m) => typeof m.name === 'string');

  const entry: MultiBridgeEntry = {
    name: raw.name,
    enabled: raw.enabled === true,
    username,
    pincode: raw.pincode,
    port,
    category,
    newIdentity: raw.newIdentity === true,
    hapHomematicIdentity: raw.hapHomematicIdentity !== false,
    channels,
    variables,
    programs,
  };
  if (raw.setupID !== undefined) {
    entry.setupID = raw.setupID;
  }
  if (raw.bridgeUuid !== undefined) {
    entry.bridgeUuid = raw.bridgeUuid.toLowerCase();
  }
  return entry;
}

function mappingList<T>(raw: unknown, where: string, valid: (m: T) => boolean): T[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ConfigError(`${where} must be a list`);
  }
  raw.forEach((m, i) => {
    if (!m || typeof m !== 'object' || !valid(m as T)) {
      throw new ConfigError(`${where}[${i}] is incomplete`);
    }
  });
  return raw as T[];
}

function checkUnique(bridges: MultiBridgeEntry[], reserved: ReservedPorts): void {
  const seen = {
    name: new Set<string>(),
    username: new Set<string>(),
    port: new Set<number>(),
    uuid: new Set<string>(),
  };
  const hostUser = reserved.host?.username?.toUpperCase();
  for (const b of bridges) {
    const where = `multiBridge bridge "${b.name}"`;
    if (seen.name.has(b.name)) {
      throw new ConfigError(`${where}: name used twice`);
    }
    if (seen.username.has(b.username) || b.username === hostUser) {
      throw new ConfigError(`${where}: username used twice (or by the block's own _bridge)`);
    }
    if (seen.port.has(b.port) || b.port === reserved.eventServerPort || b.port === reserved.host?.port) {
      throw new ConfigError(`${where}: port ${b.port} used twice (or by the event server or the block's own _bridge)`);
    }
    if (b.bridgeUuid && seen.uuid.has(b.bridgeUuid)) {
      throw new ConfigError(`${where}: bridgeUuid used twice`);
    }
    seen.name.add(b.name);
    seen.username.add(b.username);
    seen.port.add(b.port);
    if (b.bridgeUuid) {
      seen.uuid.add(b.bridgeUuid);
    }
  }
}
