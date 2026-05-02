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
 */

import { Buffer } from 'node:buffer';
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
  HomeMaticProgramAccessory: 'ProgramAccessory',
};

/** hap-homematic Type setting -> our subtype. */
const SUBTYPE_ALIASES: Record<string, string> = {
  Switch: 'switch',
  Outlet: 'outlet',
  Lightbulb: 'lightbulb',
  Door: 'door',
  Window: 'window',
};

export interface ImportReport {
  channels: ChannelMapping[];
  variables: VariableMapping[];
  programs: ProgramMapping[];
  warnings: string[];
  meta: {
    instanceCount: number;
    sourceVersion?: string;
    ccuIp?: string;
  };
}

export interface HapHomematicConfigShape {
  ccuIP?: string;
  channels?: string[];
  variables?: string[];
  programs?: string[];
  mappings?: Record<string, {
    Service?: string;
    Type?: string;
    instance?: string;
    [k: string]: unknown;
  }>;
  instances?: Record<string, { name?: string }>;
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
  const configJson = await extractConfigJson(tarball);
  return importConfigJson(configJson);
}

export function importConfigJson(raw: HapHomematicConfigShape | string): ImportReport {
  const config: HapHomematicConfigShape = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!config || typeof config !== 'object') {
    throw new ImportError('Invalid config payload');
  }

  const warnings: string[] = [];
  const channels: ChannelMapping[] = [];
  const variables: VariableMapping[] = [];
  const programs: ProgramMapping[] = [];

  for (const address of config.channels ?? []) {
    if (typeof address !== 'string' || address.length === 0) {
      continue;
    }
    const mapping = config.mappings?.[address] ?? {};
    const service = SERVICE_ALIASES[mapping.Service ?? ''] ?? undefined;
    if (!service) {
      warnings.push(`Could not map service "${mapping.Service ?? '?'}" for channel ${address} — skipped`);
      continue;
    }
    const subtype = mapping.Type ? SUBTYPE_ALIASES[mapping.Type] : undefined;
    channels.push({
      address,
      service,
      subtype,
      settings: dropKnownKeys(mapping, ['Service', 'Type', 'instance']),
    });
  }

  for (const name of config.variables ?? []) {
    if (typeof name !== 'string' || name.length === 0) {
      continue;
    }
    const mapping = config.mappings?.[name] ?? {};
    const service = SERVICE_ALIASES[mapping.Service ?? ''] ?? undefined;
    variables.push({
      name,
      service,
      settings: dropKnownKeys(mapping, ['Service', 'Type', 'instance']),
    });
  }

  for (const name of config.programs ?? []) {
    if (typeof name !== 'string' || name.length === 0) {
      continue;
    }
    programs.push({ name });
  }

  return {
    channels,
    variables,
    programs,
    warnings,
    meta: {
      instanceCount: Object.keys(config.instances ?? {}).length,
      sourceVersion: config.version,
      ccuIp: config.ccuIP,
    },
  };
}

/** Merge an ImportReport into an existing ResolvedConfig (channels, variables, programs). */
export function mergeIntoConfig(target: Partial<ResolvedConfig>, report: ImportReport): Partial<ResolvedConfig> {
  const existingChannels = new Map((target.channels ?? []).map((m) => [m.address, m]));
  for (const m of report.channels) {
    existingChannels.set(m.address, m);
  }
  const existingVars = new Map((target.variables ?? []).map((m) => [m.name, m]));
  for (const m of report.variables) {
    existingVars.set(m.name, m);
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

// --- internals -------------------------------------------------------

async function extractConfigJson(tarball: Buffer): Promise<HapHomematicConfigShape> {
  return new Promise<HapHomematicConfigShape>((resolve, reject) => {
    let resolved = false;
    const stream = Readable.from(tarball);
    // `tar.list` is parse-only — unlike `tar.extract` it never writes
    // files to disk, which matters because we run inside a long-lived
    // Homebridge process whose cwd we should never modify.
    const parser = tarList({
      filter: (path) => path.endsWith('config.json'),
      onReadEntry: (entry) => {
        if (resolved) {
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        entry.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_CONFIG_JSON_BYTES) {
            entry.destroy(new ImportError('config.json too large'));
            return;
          }
          chunks.push(chunk);
        });
        entry.on('end', () => {
          if (resolved) {
            return;
          }
          resolved = true;
          try {
            const parsed = safeParse(Buffer.concat(chunks).toString('utf8'));
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
        entry.on('error', (err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
      },
    });
    parser.on('end', () => {
      if (!resolved) {
        reject(new ImportError('No config.json found in backup'));
      }
    });
    parser.on('error', (err: Error) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
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

function dropKnownKeys<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k)) {
      out[k] = v;
    }
  }
  return out;
}
