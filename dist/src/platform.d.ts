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
import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { CcuClient } from './ccu/CcuClient.js';
export declare class HomematicPlatform implements DynamicPlatformPlugin {
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly api: API;
    private readonly log;
    private readonly storage;
    private readonly resolved;
    private readonly ccu;
    private readonly cachedAccessories;
    private readonly managed;
    /** Per-launch memo so N mapped channels cost one CCU device listing, not N. */
    private devicesMemo;
    private variablesMemo;
    constructor(log: Logging, config: PlatformConfig, api: API);
    configureAccessory(accessory: PlatformAccessory): void;
    /** Public for the homebridge-ui server to query CCU on demand. */
    getCcu(): CcuClient | undefined;
    private didFinishLaunching;
    private shutdown;
    private attachChannel;
    private attachVariable;
    private attachProgram;
    private fetchChannel;
    /**
     * Accessory UUID. With `hapHomematicIdentity` and a `uuidSeed` from the
     * importer, reuse hap-homematic's UUID so HomeKit keeps the accessory
     * (name, room, automations) when its bridge identity is transplanted.
     */
    private accessoryUuid;
    private usesLegacyIdentity;
    private getOrCreateAccessory;
}
