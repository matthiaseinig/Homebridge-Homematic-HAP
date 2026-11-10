/**
 * Builds one HAP-NodeJS Bridge for a multi-bridge entry: the bridge
 * accessory with the hap-homematic bridge UUID, and one bridged accessory
 * per mapping, built by the same service handlers as platform accessories.
 * Building has no network side effects; publishing is the host's job.
 * The offline IID check (scripts/iid-check.mjs) uses this directly.
 */

import type { HAP } from 'homebridge';
import type { CcuClient } from '../ccu/CcuClient.js';
import { findProgramServiceByKey, findServiceByKey, findVariableServiceByKey, pickVariableService, PROGRAM_SERVICE_DEFINITIONS } from '../services/registry.js';
import type { ChannelService, ProgramService, ServiceContext, VariableService } from '../services/types.js';
import { PLUGIN_NAME } from '../settings.js';
import type { AccessoryContext, CcuDevice, CcuVariable, MultiBridgeEntry } from '../types.js';
import type { PrefixedLogger } from '../util/logger.js';
import { channelDisplayName, findChannel, programDisplayName, variableDisplayName } from '../util/mappings.js';
import { BridgedAccessoryHandle } from './BridgedAccessoryHandle.js';

export type HapBridge = InstanceType<HAP['Bridge']>;
type Handler = ChannelService | VariableService | ProgramService;

/** What the CCU reported once at startup; shared by all bridges. */
export interface CcuSnapshot {
  devices: CcuDevice[];
  variables: CcuVariable[];
}

export interface BuiltAccessory {
  kind: AccessoryContext['kind'];
  id: string;
  name: string;
  uuid: string;
  legacyIdentity: boolean;
}

export interface BuiltBridge {
  entry: MultiBridgeEntry;
  bridge: HapBridge;
  accessories: BuiltAccessory[];
  /** Mappings that produced no accessory, with the reason. */
  skipped: Array<{ kind: AccessoryContext['kind']; id: string; reason: string }>;
  handlers: Handler[];
}

export interface BuildDeps {
  hap: HAP;
  ccu: CcuClient;
  log: PrefixedLogger;
  version: string;
}

/** hap-homematic created its bridges as `new Bridge(name, <instance id>)`. */
export function bridgeUuidFor(hap: HAP, entry: Pick<MultiBridgeEntry, 'bridgeUuid' | 'username'>): string {
  return entry.bridgeUuid ?? hap.uuid.generate(`${PLUGIN_NAME}:bridge:${entry.username}`);
}

export function buildBridge(deps: BuildDeps, entry: MultiBridgeEntry, snapshot: CcuSnapshot): BuiltBridge {
  const { hap } = deps;
  const bridge = new hap.Bridge(entry.name, bridgeUuidFor(hap, entry));
  // Keep ids of characteristics that are not there at publish time. HAP-NodeJS
  // otherwise expires them on every id assignment, so a characteristic added
  // after the first CCU read (thermostat humidity) or one that comes back
  // later would get a new IID, and HomeKit automations using it break.
  bridge.disableUnusedIDPurge();
  const info = bridge.getService(hap.Service.AccessoryInformation);
  info?.setCharacteristic(hap.Characteristic.Manufacturer, PLUGIN_NAME)
    .setCharacteristic(hap.Characteristic.Model, 'HAPHomematic')
    .setCharacteristic(hap.Characteristic.SerialNumber, entry.name)
    .setCharacteristic(hap.Characteristic.FirmwareRevision, deps.version);
  const log = deps.log.child(entry.name);
  bridge.on('characteristic-warning' as never, ((warning: { type?: string; message?: string }) => {
    const quiet = warning.type === 'slow-read' || warning.type === 'slow-write' || warning.type === 'debug-message';
    (quiet ? log.debug : log.warn).call(log, 'HAP %s: %s', warning.type ?? 'warning', warning.message ?? '');
  }) as never);

  const built: BuiltBridge = { entry, bridge, accessories: [], skipped: [], handlers: [] };
  const builder = new AccessoryFactory(deps, entry, snapshot, built, log);
  entry.channels.forEach((m) => builder.tryAdd('channel', m.address, () => builder.channel(m)));
  entry.variables.forEach((m) => builder.tryAdd('variable', m.name, () => builder.variable(m)));
  entry.programs.forEach((m) => builder.tryAdd('program', m.name, () => builder.program(m)));
  return built;
}

/** Run `step`; on failure release the handler's CCU listeners before rethrowing. */
function attachOrDispose<H extends Handler>(handler: H, step: (h: H) => unknown): H {
  try {
    step(handler);
  } catch (err) {
    handler.dispose?.();
    throw err;
  }
  return handler;
}

interface Prepared {
  name: string;
  seed: string;
  legacy: boolean;
  context: AccessoryContext;
  attach: (ctx: ServiceContext) => Handler;
}

class AccessoryFactory {
  private readonly uuids = new Set<string>();

  constructor(
    private readonly deps: BuildDeps,
    private readonly entry: MultiBridgeEntry,
    private readonly snapshot: CcuSnapshot,
    private readonly built: BuiltBridge,
    private readonly log: PrefixedLogger,
  ) {}

  tryAdd(kind: AccessoryContext['kind'], id: string, prepare: () => Prepared): void {
    try {
      this.add(kind, id, prepare());
    } catch (err) {
      const reason = (err as Error).message;
      this.built.skipped.push({ kind, id, reason });
      this.log.warn('Skipping %s %s: %s', kind, id, reason);
    }
  }

  channel(m: MultiBridgeEntry['channels'][number]): Prepared {
    const def = findServiceByKey(m.service);
    if (!def) {
      throw new Error(`Unknown service: ${m.service}`);
    }
    const channel = findChannel(this.snapshot.devices, m.address, m.name);
    const name = channelDisplayName(m, channel);
    const legacy = this.legacy(m.uuidSeed);
    return {
      name,
      seed: legacy ? m.uuidSeed! : `channel:${m.address}`,
      legacy,
      context: { kind: 'channel', id: m.address, service: def.key, subtype: m.subtype, settings: m.settings, name, legacyLayout: legacy },
      attach: (ctx) => attachOrDispose(def.build(ctx), (h) => h.attach({ ...channel, name })),
    };
  }

  variable(m: MultiBridgeEntry['variables'][number]): Prepared {
    const variable = this.snapshot.variables.find((v) => v.name === m.name);
    if (!variable) {
      throw new Error('variable not found on the CCU');
    }
    const explicit = m.service ? findVariableServiceByKey(m.service) : undefined;
    const def = explicit ?? pickVariableService(variable.valuetype);
    const name = variableDisplayName(m);
    const legacy = this.legacy(m.uuidSeed);
    return {
      name,
      seed: legacy ? m.uuidSeed! : `variable:${m.name}`,
      legacy,
      context: { kind: 'variable', id: m.name, service: def.key, subtype: m.subtype, settings: m.settings, name, legacyLayout: legacy },
      attach: (ctx) => attachOrDispose(def.build(ctx), (h) => h.attach(variable)),
    };
  }

  program(m: MultiBridgeEntry['programs'][number]): Prepared {
    const def = findProgramServiceByKey('ProgramAccessory') ?? PROGRAM_SERVICE_DEFINITIONS[0]!;
    const name = programDisplayName(m);
    return {
      name,
      seed: `program:${m.name}`,
      legacy: false,
      context: { kind: 'program', id: m.name, service: def.key, name },
      attach: (ctx) => attachOrDispose(def.build(ctx), (h) => h.attach(m.name)),
    };
  }

  private legacy(seed: string | undefined): boolean {
    return this.entry.hapHomematicIdentity && typeof seed === 'string' && seed.length > 0;
  }

  private add(kind: AccessoryContext['kind'], id: string, p: Prepared): void {
    const { hap, ccu } = this.deps;
    const uuid = hap.uuid.generate(p.seed);
    if (this.uuids.has(uuid)) {
      throw new Error(`accessory UUID already used on this bridge (${p.name})`);
    }
    const accessory = new hap.Accessory(p.name, uuid);
    const handle = new BridgedAccessoryHandle(accessory, p.context);
    const handler = p.attach({
      accessory: handle,
      ccu,
      log: this.log.child(`svc:${p.context.service}:${id}`),
      Service: hap.Service,
      Characteristic: hap.Characteristic,
    });
    attachOrDispose(handler, () => this.built.bridge.addBridgedAccessory(accessory));
    this.uuids.add(uuid);
    this.built.handlers.push(handler);
    this.built.accessories.push({ kind, id, name: p.name, uuid, legacyIdentity: p.legacy });
  }
}
