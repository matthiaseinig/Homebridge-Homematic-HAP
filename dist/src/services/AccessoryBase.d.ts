/**
 * Base class shared by per-accessory handlers. Provides:
 *   - access to platform-level objects (Service / Characteristic / api / ccu)
 *   - getOrAdd helpers for HAP services
 *   - registerListener() that auto-cleans on dispose()
 *   - safe wrappers for onGet / onSet that route errors to log + HAP fault
 *
 * Services subclass this and implement attach().
 */
import type { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { CcuClient } from '../ccu/CcuClient.js';
import type { PrefixedLogger } from '../util/logger.js';
import type { AccessoryContext } from '../types.js';
import type { ServiceContext } from './types.js';
export type DatapointListener = (value: unknown) => void;
export declare abstract class AccessoryBase {
    protected readonly accessory: PlatformAccessory<AccessoryContext>;
    protected readonly ccu: CcuClient;
    protected readonly log: PrefixedLogger;
    protected readonly Service: typeof Service;
    protected readonly Characteristic: typeof Characteristic;
    private readonly disposers;
    constructor(ctx: ServiceContext);
    /**
     * @param legacy Subtype to use when the accessory reuses a hap-homematic
     *   identity (`context.legacyLayout`). hap-homematic created most services
     *   with the service UUID as subtype; pass `null` for services it created
     *   without one (e.g. Thermostat), or a string for its explicit subtypes.
     *   Ignored for accessories with their own identity.
     */
    protected getOrAddService<T extends WithUUID<typeof Service>>(svc: T, name?: string, requestedSubtype?: string, legacy?: string | null): Service;
    protected isLegacyLayout(): boolean;
    private resolveSubtype;
    /**
     * Attach a listener for a CCU datapoint on this accessory. Returns a
     * disposer that is also tracked for automatic cleanup in dispose().
     */
    protected registerListener(address: string, datapoint: string, listener: DatapointListener): () => void;
    /** Tracked async setter that maps thrown errors to a HAP-friendly fault. */
    protected wrapSet<T extends CharacteristicValue>(handler: (v: T) => Promise<void> | void): (value: CharacteristicValue) => Promise<void>;
    protected wrapGet<T extends CharacteristicValue>(handler: () => Promise<T> | T): () => Promise<CharacteristicValue>;
    /**
     * Attach a HAP BatteryService that mirrors the device-level LOW_BAT
     * datapoint (and OPERATING_VOLTAGE / BATTERY_STATE if exposed) into
     * HomeKit's StatusLowBattery + BatteryLevel characteristics.
     *
     * Battery datapoints live on the **device** channel (`:0`), not on
     * any feature channel, so we strip the channel suffix from the
     * address we were given.
     *
     * Best-effort: if the device doesn't actually expose a battery
     * datapoint, the listeners are dormant and the service shows the
     * default "battery OK" state. Mains-powered devices simply shouldn't
     * call this.
     */
    protected attachBattery(featureChannelAddress: string): void;
    dispose(): void;
}
