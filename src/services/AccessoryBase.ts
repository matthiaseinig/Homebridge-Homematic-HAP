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

export abstract class AccessoryBase {
  protected readonly accessory: PlatformAccessory<AccessoryContext>;
  protected readonly ccu: CcuClient;
  protected readonly log: PrefixedLogger;
  protected readonly Service: typeof Service;
  protected readonly Characteristic: typeof Characteristic;

  private readonly disposers: Array<() => void> = [];

  constructor(ctx: ServiceContext) {
    this.accessory = ctx.accessory;
    this.ccu = ctx.ccu;
    this.log = ctx.log;
    this.Service = ctx.Service;
    this.Characteristic = ctx.Characteristic;
  }

  protected getOrAddService<T extends WithUUID<typeof Service>>(svc: T, name?: string, subtype?: string): Service {
    const existing = subtype === undefined
      ? this.accessory.getService(svc)
      : this.accessory.getServiceById(svc, subtype);
    if (existing) {
      if (name !== undefined) {
        existing.setCharacteristic(this.Characteristic.Name, name);
      }
      return existing;
    }
    // hap-nodejs Service constructors take (displayName, subtype). The
    // overloaded addService(svc) signature cannot express that mix, so
    // we instantiate ourselves when we need a non-default name/subtype.
    const instance = subtype === undefined
      ? new (svc as unknown as new (displayName: string) => Service)(name ?? this.accessory.displayName)
      : new (svc as unknown as new (displayName: string, subtype: string) => Service)(
        name ?? this.accessory.displayName,
        subtype,
      );
    return this.accessory.addService(instance);
  }

  /**
   * Attach a listener for a CCU datapoint on this accessory. Returns a
   * disposer that is also tracked for automatic cleanup in dispose().
   */
  protected registerListener(address: string, datapoint: string, listener: DatapointListener): () => void {
    const key = `${address}.${datapoint}`;
    const off = this.ccu.registerListener(key, listener);
    this.disposers.push(off);
    return off;
  }

  /** Tracked async setter that maps thrown errors to a HAP-friendly fault. */
  protected wrapSet<T extends CharacteristicValue>(handler: (v: T) => Promise<void> | void) {
    return async (value: CharacteristicValue) => {
      try {
        await handler(value as T);
      } catch (err) {
        this.log.warn('setValue failed: %s', (err as Error).message);
        throw err;
      }
    };
  }

  protected wrapGet<T extends CharacteristicValue>(handler: () => Promise<T> | T) {
    return async (): Promise<CharacteristicValue> => {
      try {
        const v = await handler();
        return v as CharacteristicValue;
      } catch (err) {
        this.log.debug('getValue cache miss: %s', (err as Error).message);
        throw err;
      }
    };
  }

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
  protected attachBattery(featureChannelAddress: string): void {
    const colon = featureChannelAddress.lastIndexOf(':');
    const deviceAddress = colon === -1
      ? `${featureChannelAddress}:0`
      : `${featureChannelAddress.slice(0, colon)}:0`;
    const service = this.getOrAddService(this.Service.Battery, undefined, 'battery');
    let lowBat = false;
    let level = 100;

    service.getCharacteristic(this.Characteristic.StatusLowBattery)
      .onGet(this.wrapGet<number>(() => lowBat
        ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL));
    service.getCharacteristic(this.Characteristic.BatteryLevel)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(this.wrapGet<number>(() => level));
    service.getCharacteristic(this.Characteristic.ChargingState)
      .onGet(() => this.Characteristic.ChargingState.NOT_CHARGEABLE);

    const applyLow = (raw: unknown): void => {
      lowBat = raw === true || raw === 1 || raw === '1' || raw === 'true';
      service.updateCharacteristic(
        this.Characteristic.StatusLowBattery,
        lowBat
          ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
    };
    const applyVoltage = (raw: unknown): void => {
      // HmIP devices nominally report 0..4 V; map 2.4..3.2 → 0..100 %.
      // Anything outside that range gets clamped. This is a heuristic;
      // CCU does not surface a real % anywhere.
      const v = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
      if (!Number.isFinite(v)) return;
      const pct = Math.min(100, Math.max(0, Math.round(((v - 2.4) / (3.2 - 2.4)) * 100)));
      level = pct;
      service.updateCharacteristic(this.Characteristic.BatteryLevel, pct);
    };

    this.registerListener(deviceAddress, 'LOW_BAT', applyLow);
    this.registerListener(deviceAddress, 'LOWBAT', applyLow); // legacy spelling
    this.registerListener(deviceAddress, 'OPERATING_VOLTAGE', applyVoltage);

    // Best-effort initial pulls so HomeKit doesn't sit on default values.
    this.ccu.getValue(deviceAddress, 'LOW_BAT').then(applyLow).catch(() => undefined);
    this.ccu.getValue(deviceAddress, 'OPERATING_VOLTAGE').then(applyVoltage).catch(() => undefined);
  }

  dispose(): void {
    while (this.disposers.length > 0) {
      const fn = this.disposers.pop();
      try {
        fn?.();
      } catch (err) {
        this.log.debug('dispose listener error: %s', (err as Error).message);
      }
    }
  }
}
