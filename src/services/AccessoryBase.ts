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
