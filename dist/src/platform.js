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
import { CcuClient } from './ccu/CcuClient.js';
import { findProgramServiceByKey, findServiceByKey, findVariableServiceByKey, pickVariableService, PROGRAM_SERVICE_DEFINITIONS, } from './services/registry.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { ConfigError, resolveConfig } from './util/config.js';
import { PrefixedLogger } from './util/logger.js';
import { PluginStorage } from './util/storage.js';
export class HomematicPlatform {
    Service;
    Characteristic;
    api;
    log;
    storage;
    resolved;
    ccu;
    cachedAccessories = new Map();
    managed = new Map();
    /** Per-launch memo so N mapped channels cost one CCU device listing, not N. */
    devicesMemo;
    variablesMemo;
    constructor(log, config, api) {
        this.api = api;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.log = new PrefixedLogger(log, PLATFORM_NAME);
        this.storage = new PluginStorage(api);
        try {
            this.resolved = resolveConfig(config);
        }
        catch (err) {
            if (err instanceof ConfigError) {
                // Per the verified-plugin rule: log and stay idle, do not crash.
                this.log.error('Plugin not configured: %s', err.message);
                return;
            }
            throw err;
        }
        this.ccu = new CcuClient({ config: this.resolved, log: this.log.child('ccu') });
        this.api.on('didFinishLaunching', () => {
            this.didFinishLaunching().catch((err) => {
                this.log.error('Startup failed: %s', err.message);
            });
        });
        this.api.on('shutdown', () => {
            this.shutdown().catch((err) => {
                this.log.warn('Shutdown error: %s', err.message);
            });
        });
    }
    configureAccessory(accessory) {
        this.cachedAccessories.set(accessory.UUID, accessory);
        this.log.debug('Restored accessory %s', accessory.displayName);
    }
    /** Public for the homebridge-ui server to query CCU on demand. */
    getCcu() {
        return this.ccu;
    }
    // --- private -------------------------------------------------------
    async didFinishLaunching() {
        if (!this.resolved || !this.ccu) {
            return;
        }
        await this.storage.ensureRoot();
        await this.ccu.start();
        this.log.success('Connected to CCU at %s', this.resolved.ccuIp);
        // Materialize each channel/variable/program from config.
        const seen = new Set();
        for (const mapping of this.resolved.channels) {
            try {
                const uuid = this.accessoryUuid(`channel:${mapping.address}`, mapping.uuidSeed);
                seen.add(uuid);
                await this.attachChannel(uuid, mapping.address, mapping);
            }
            catch (err) {
                this.log.warn('Skipping channel %s: %s', mapping.address, err.message);
            }
        }
        for (const mapping of this.resolved.variables) {
            try {
                const uuid = this.accessoryUuid(`variable:${mapping.name}`, mapping.uuidSeed);
                seen.add(uuid);
                const legacyName = typeof mapping.settings?.name === 'string'
                    ? mapping.settings.name : undefined;
                const dn = mapping.displayName ?? legacyName;
                await this.attachVariable(uuid, mapping.name, mapping.service, mapping.settings, dn, mapping.subtype);
            }
            catch (err) {
                this.log.warn('Skipping variable %s: %s', mapping.name, err.message);
            }
        }
        for (const mapping of this.resolved.programs) {
            try {
                const uuid = this.api.hap.uuid.generate(`program:${mapping.name}`);
                seen.add(uuid);
                const legacyName = typeof mapping.settings?.name === 'string'
                    ? mapping.settings.name : undefined;
                await this.attachProgram(uuid, mapping.name, mapping.displayName ?? legacyName);
            }
            catch (err) {
                this.log.warn('Skipping program %s: %s', mapping.name, err.message);
            }
        }
        this.devicesMemo = undefined;
        this.variablesMemo = undefined;
        // Drop cached accessories that are no longer in config.
        const toRemove = [];
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
    async shutdown() {
        for (const m of this.managed.values()) {
            try {
                m.handler.dispose?.();
            }
            catch (err) {
                this.log.debug('dispose error: %s', err.message);
            }
        }
        this.managed.clear();
        /* c8 ignore next 3 */
        if (this.ccu) {
            await this.ccu.stop();
        }
    }
    async attachChannel(uuid, address, mapping) {
        /* c8 ignore start — unreachable: didFinishLaunching gates on ccu */
        if (!this.ccu) {
            return;
        }
        /* c8 ignore stop */
        const def = findServiceByKey(mapping.service);
        if (!def) {
            throw new Error(`Unknown service: ${mapping.service}`);
        }
        const channel = await this.fetchChannel(address, mapping.name);
        // mapping.name is the user-customised HomeKit display name (set in the
        // GUI or imported from hap-homematic). Falls back to the CCU's channel
        // name when the user hasn't overridden it.
        //
        // Pre-0.1.5 imports stored the custom name nested under settings.name
        // because the importer's drop-list excluded it. Pick it up from there
        // so users don't have to re-import.
        const settingsName = typeof mapping.settings?.name === 'string'
            ? mapping.settings.name
            : undefined;
        const displayName = (mapping.name && mapping.name.length > 0 && mapping.name)
            || (settingsName && settingsName.length > 0 ? settingsName : undefined)
            || channel.name;
        const accessory = this.getOrCreateAccessory(uuid, displayName, {
            kind: 'channel',
            id: address,
            service: def.key,
            subtype: mapping.subtype,
            settings: mapping.settings,
            name: displayName,
            legacyLayout: this.usesLegacyIdentity(mapping.uuidSeed),
        });
        const ctx = {
            accessory,
            ccu: this.ccu,
            log: this.log.child(`svc:${def.key}:${channel.address}`),
            Service: this.Service,
            Characteristic: this.Characteristic,
        };
        const handler = def.build(ctx);
        // Services name their HAP services after the channel. Use the HomeKit
        // name (as hap-homematic did), not the raw CCU channel name, which often
        // contains characters HomeKit rejects (`OG:Bad:Rollo`, `HmIP-WTH-2 0001…:1`).
        handler.attach({ ...channel, name: displayName });
        this.managed.set(uuid, { accessory, handler });
    }
    async attachVariable(uuid, name, serviceKey, settings, displayName, subtype) {
        /* c8 ignore start — unreachable: didFinishLaunching gates on ccu */
        if (!this.ccu) {
            return;
        }
        /* c8 ignore stop */
        this.variablesMemo ??= this.ccu.listVariables();
        const variables = await this.variablesMemo;
        const variable = variables.find((v) => v.name === name);
        if (!variable) {
            throw new Error(`Variable not found on CCU: ${name}`);
        }
        const explicit = serviceKey ? findVariableServiceByKey(serviceKey) : undefined;
        const def = explicit ?? pickVariableService(variable.valuetype);
        const finalName = displayName && displayName.length > 0 ? displayName : name;
        const seed = this.resolved?.variables.find((m) => m.name === name)?.uuidSeed;
        const accessory = this.getOrCreateAccessory(uuid, finalName, {
            kind: 'variable',
            id: name,
            service: def.key,
            subtype,
            settings,
            name: finalName,
            legacyLayout: this.usesLegacyIdentity(seed),
        });
        const ctx = {
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
    async attachProgram(uuid, name, displayName) {
        /* c8 ignore start — unreachable: didFinishLaunching gates on ccu */
        if (!this.ccu) {
            return;
        }
        /* c8 ignore stop */
        const def = findProgramServiceByKey('ProgramAccessory') ?? PROGRAM_SERVICE_DEFINITIONS[0];
        const finalName = displayName && displayName.length > 0 ? displayName : name;
        const accessory = this.getOrCreateAccessory(uuid, finalName, {
            kind: 'program',
            id: name,
            service: def.key,
            name: finalName,
        });
        const ctx = {
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
    async fetchChannel(address, fallbackName) {
        /* c8 ignore next 3 — same unreachable-in-prod guard as attachChannel/Variable/Program */
        if (!this.ccu) {
            throw new Error('CCU client not initialized');
        }
        this.devicesMemo ??= this.ccu.listDevices();
        const devices = await this.devicesMemo;
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
    /**
     * Accessory UUID. With `hapHomematicIdentity` and a `uuidSeed` from the
     * importer, reuse hap-homematic's UUID so HomeKit keeps the accessory
     * (name, room, automations) when its bridge identity is transplanted.
     */
    accessoryUuid(defaultSeed, uuidSeed) {
        const seed = this.usesLegacyIdentity(uuidSeed) ? uuidSeed : defaultSeed;
        return this.api.hap.uuid.generate(seed);
    }
    usesLegacyIdentity(uuidSeed) {
        return this.resolved?.hapHomematicIdentity === true
            && typeof uuidSeed === 'string' && uuidSeed.length > 0;
    }
    getOrCreateAccessory(uuid, displayName, context) {
        const existing = this.cachedAccessories.get(uuid);
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
        const accessory = new this.api.platformAccessory(displayName, uuid);
        accessory.context = context;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(uuid, accessory);
        return accessory;
    }
}
//# sourceMappingURL=platform.js.map