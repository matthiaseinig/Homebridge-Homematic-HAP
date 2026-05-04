/**
 * The DynamicPlatformPlugin entry point. Wires CCU client + service
 * registry + Homebridge accessory cache together. Lifecycle:
 *
 *   constructor()        — validate config, build CCU client
 *   configureAccessory() — restore one accessory from disk cache
 *   didFinishLaunching   — start CCU client, then materialize accessories
 *                          for every channel/variable/program in config
 *   shutdown             — stop CCU client (event server + RPC subs)
 */

import {
  APIEvent,
  type API,
  type Characteristic,
  type DynamicPlatformPlugin,
  type Logging,
  type PlatformAccessory,
  type PlatformConfig,
  type Service,
} from 'homebridge';
import { CcuClient } from './ccu/CcuClient.js';
import {
  findProgramServiceByKey,
  findServiceByKey,
  findVariableServiceByKey,
  pickVariableService,
  PROGRAM_SERVICE_DEFINITIONS,
} from './services/registry.js';
import type { ChannelService, ProgramService, ServiceContext, VariableService } from './services/types.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type {
  AccessoryContext,
  CcuChannel,
  RawConfig,
  ResolvedConfig,
} from './types.js';
import { ConfigError, resolveConfig } from './util/config.js';
import { PrefixedLogger } from './util/logger.js';
import { PluginStorage } from './util/storage.js';

interface ManagedAccessory {
  accessory: PlatformAccessory<AccessoryContext>;
  handler: ChannelService | VariableService | ProgramService;
}

export class HomematicPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly api: API;

  private readonly log: PrefixedLogger;
  private readonly storage: PluginStorage;
  private readonly resolved: ResolvedConfig | undefined;
  private readonly ccu: CcuClient | undefined;
  private readonly cachedAccessories = new Map<string, PlatformAccessory<AccessoryContext>>();
  private readonly managed = new Map<string, ManagedAccessory>();

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.log = new PrefixedLogger(log, PLATFORM_NAME);
    this.storage = new PluginStorage(api);

    try {
      this.resolved = resolveConfig(config as RawConfig);
    } catch (err) {
      if (err instanceof ConfigError) {
        // Per the verified-plugin rule: log and stay idle, do not crash.
        this.log.error('Plugin not configured: %s', err.message);
        return;
      }
      throw err;
    }

    this.ccu = new CcuClient({ config: this.resolved, log: this.log.child('ccu') });

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.didFinishLaunching().catch((err) => {
        this.log.error('Startup failed: %s', (err as Error).message);
      });
    });
    this.api.on(APIEvent.SHUTDOWN, () => {
      this.shutdown().catch((err) => {
        this.log.warn('Shutdown error: %s', (err as Error).message);
      });
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory as PlatformAccessory<AccessoryContext>);
    this.log.debug('Restored accessory %s', accessory.displayName);
  }

  /** Public for the homebridge-ui server to query CCU on demand. */
  getCcu(): CcuClient | undefined {
    return this.ccu;
  }

  // --- private -------------------------------------------------------

  private async didFinishLaunching(): Promise<void> {
    if (!this.resolved || !this.ccu) {
      return;
    }
    await this.storage.ensureRoot();
    await this.ccu.start();
    this.log.success('Connected to CCU at %s', this.resolved.ccuIp);

    // Materialize each channel/variable/program from config.
    const seen = new Set<string>();

    for (const mapping of this.resolved.channels) {
      try {
        const uuid = this.api.hap.uuid.generate(`channel:${mapping.address}`);
        seen.add(uuid);
        await this.attachChannel(uuid, mapping.address, mapping);
      } catch (err) {
        this.log.warn('Skipping channel %s: %s', mapping.address, (err as Error).message);
      }
    }

    for (const mapping of this.resolved.variables) {
      try {
        const uuid = this.api.hap.uuid.generate(`variable:${mapping.name}`);
        seen.add(uuid);
        const legacyName = typeof mapping.settings?.name === 'string'
          ? (mapping.settings.name as string) : undefined;
        const dn = mapping.displayName ?? legacyName;
        await this.attachVariable(uuid, mapping.name, mapping.service, mapping.settings, dn);
      } catch (err) {
        this.log.warn('Skipping variable %s: %s', mapping.name, (err as Error).message);
      }
    }

    for (const mapping of this.resolved.programs) {
      try {
        const uuid = this.api.hap.uuid.generate(`program:${mapping.name}`);
        seen.add(uuid);
        const legacyName = typeof mapping.settings?.name === 'string'
          ? (mapping.settings.name as string) : undefined;
        await this.attachProgram(uuid, mapping.name, mapping.displayName ?? legacyName);
      } catch (err) {
        this.log.warn('Skipping program %s: %s', mapping.name, (err as Error).message);
      }
    }

    // Drop cached accessories that are no longer in config.
    const toRemove: PlatformAccessory[] = [];
    for (const [uuid, acc] of this.cachedAccessories) {
      if (!seen.has(uuid)) {
        toRemove.push(acc);
        this.cachedAccessories.delete(uuid);
      }
    }
    if (toRemove.length > 0) {
      this.log.info('Removing %d stale accessories', toRemove.length);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRemove);
    }
  }

  private async shutdown(): Promise<void> {
    for (const m of this.managed.values()) {
      try {
        m.handler.dispose?.();
      } catch (err) {
        this.log.debug('dispose error: %s', (err as Error).message);
      }
    }
    this.managed.clear();
    /* c8 ignore next 3 */
    if (this.ccu) {
      await this.ccu.stop();
    }
  }

  private async attachChannel(
    uuid: string,
    address: string,
    mapping: { address: string; service: string; subtype?: string; settings?: Record<string, unknown>; name?: string },
  ): Promise<void> {
    /* c8 ignore start — unreachable: didFinishLaunching gates on ccu */
    if (!this.ccu) {
      return;
    }
    /* c8 ignore stop */
    const def = findServiceByKey(mapping.service);
    if (!def) {
      throw new Error(`Unknown service: ${mapping.service}`);
    }

    const channel: CcuChannel = await this.fetchChannel(address, mapping.name);
    // mapping.name is the user-customised HomeKit display name (set in the
    // GUI or imported from hap-homematic). Falls back to the CCU's channel
    // name when the user hasn't overridden it.
    //
    // Pre-0.1.5 imports stored the custom name nested under settings.name
    // because the importer's drop-list excluded it. Pick it up from there
    // so users don't have to re-import.
    const settingsName = typeof mapping.settings?.name === 'string'
      ? (mapping.settings.name as string)
      : undefined;
    const displayName = (mapping.name && mapping.name.length > 0 && mapping.name)
      || (settingsName && settingsName.length > 0 ? settingsName : undefined)
      || channel.name;
    const accessory = this.getOrCreateAccessory<AccessoryContext>(uuid, displayName, {
      kind: 'channel',
      id: address,
      service: def.key,
      subtype: mapping.subtype,
      settings: mapping.settings,
      name: displayName,
    });
    const ctx: ServiceContext = {
      accessory,
      ccu: this.ccu,
      log: this.log.child(`svc:${def.key}:${channel.address}`),
      Service: this.Service,
      Characteristic: this.Characteristic,
    };
    const handler = def.build(ctx);
    handler.attach(channel);
    this.managed.set(uuid, { accessory, handler });
  }

  private async attachVariable(
    uuid: string,
    name: string,
    serviceKey: string | undefined,
    _settings: Record<string, unknown> | undefined,
    displayName?: string,
  ): Promise<void> {
    /* c8 ignore start — unreachable: didFinishLaunching gates on ccu */
    if (!this.ccu) {
      return;
    }
    /* c8 ignore stop */
    const variables = await this.ccu.listVariables();
    const variable = variables.find((v) => v.name === name);
    if (!variable) {
      throw new Error(`Variable not found on CCU: ${name}`);
    }
    const explicit = serviceKey ? findVariableServiceByKey(serviceKey) : undefined;
    const def = explicit ?? pickVariableService(variable.valuetype);
    const finalName = displayName && displayName.length > 0 ? displayName : name;
    const accessory = this.getOrCreateAccessory<AccessoryContext>(uuid, finalName, {
      kind: 'variable',
      id: name,
      service: def.key,
      name: finalName,
    });
    const ctx: ServiceContext = {
      accessory,
      ccu: this.ccu,
      log: this.log.child(`svc:${def.key}:${name}`),
      Service: this.Service,
      Characteristic: this.Characteristic,
    };
    const handler = def.build(ctx);
    handler.attach(variable);
    this.managed.set(uuid, { accessory, handler });
  }

  private async attachProgram(uuid: string, name: string, displayName?: string): Promise<void> {
    /* c8 ignore start — unreachable: didFinishLaunching gates on ccu */
    if (!this.ccu) {
      return;
    }
    /* c8 ignore stop */
    const def = findProgramServiceByKey('ProgramAccessory') ?? PROGRAM_SERVICE_DEFINITIONS[0]!;
    const finalName = displayName && displayName.length > 0 ? displayName : name;
    const accessory = this.getOrCreateAccessory<AccessoryContext>(uuid, finalName, {
      kind: 'program',
      id: name,
      service: def.key,
      name: finalName,
    });
    const ctx: ServiceContext = {
      accessory,
      ccu: this.ccu,
      log: this.log.child(`svc:${def.key}:${name}`),
      Service: this.Service,
      Characteristic: this.Characteristic,
    };
    const handler = def.build(ctx);
    handler.attach(name);
    this.managed.set(uuid, { accessory, handler });
  }

  private async fetchChannel(address: string, fallbackName: string | undefined): Promise<CcuChannel> {
    /* c8 ignore next 3 — same unreachable-in-prod guard as attachChannel/Variable/Program */
    if (!this.ccu) {
      throw new Error('CCU client not initialized');
    }
    const devices = await this.ccu.listDevices();
    for (const device of devices) {
      const channel = device.channels.find((c) => c.address === address);
      if (channel) {
        return channel;
      }
    }
    // Channel not currently visible — fall back to a stub so the accessory
    // still registers; events for it will still flow when the CCU sees it.
    return {
      address,
      index: 0,
      name: fallbackName ?? address,
      type: 'UNKNOWN',
    };
  }

  private getOrCreateAccessory<T extends AccessoryContext>(
    uuid: string,
    displayName: string,
    context: T,
  ): PlatformAccessory<T> {
    const existing = this.cachedAccessories.get(uuid) as PlatformAccessory<T> | undefined;
    if (existing) {
      Object.assign(existing.context, context);
      // If the user renamed the accessory (or imported a hap-homematic
      // backup with custom HomeKit names), update the cached accessory's
      // display name + AccessoryInformation Name characteristic so
      // HomeKit shows the new name. Note: HomeKit caches the room/name
      // pairing on the device side too, so this only takes effect for
      // *newly-paired* HomeKit hubs — already-paired accessories keep
      // the user's manual rename in the Home app.
      if (existing.displayName !== displayName) {
        existing.displayName = displayName;
        const infoSvc = existing.getService(this.Service.AccessoryInformation);
        if (infoSvc) {
          infoSvc.setCharacteristic(this.Characteristic.Name, displayName);
        }
      }
      this.api.updatePlatformAccessories([existing]);
      return existing;
    }
    const accessory = new this.api.platformAccessory<T>(displayName, uuid);
    accessory.context = context;
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.cachedAccessories.set(uuid, accessory as unknown as PlatformAccessory<AccessoryContext>);
    return accessory;
  }
}
