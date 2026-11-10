/**
 * Thin adapter that lets the existing service handlers (written against
 * Homebridge's PlatformAccessory) build on a plain HAP-NodeJS Accessory.
 * Only public HAP-NodeJS API is used, so no Homebridge internals
 * (`_associatedHAPAccessory`) are involved and nothing is registered with
 * Homebridge's own bridge.
 */

import type { HAP, Service, WithUUID } from 'homebridge';
import type { AccessoryHandle } from '../services/types.js';
import type { AccessoryContext } from '../types.js';

export type HapAccessory = InstanceType<HAP['Accessory']>;

export class BridgedAccessoryHandle implements AccessoryHandle {
  readonly hapAccessory: HapAccessory;
  context: AccessoryContext;

  constructor(hapAccessory: HapAccessory, context: AccessoryContext) {
    this.hapAccessory = hapAccessory;
    this.context = context;
  }

  get UUID(): string {
    return this.hapAccessory.UUID;
  }

  get displayName(): string {
    return this.hapAccessory.displayName;
  }

  set displayName(name: string) {
    this.hapAccessory.displayName = name;
  }

  getService(name: string | WithUUID<typeof Service>): Service | undefined {
    return this.hapAccessory.getService(name);
  }

  getServiceById(uuid: string | WithUUID<typeof Service>, subType: string): Service | undefined {
    return this.hapAccessory.getServiceById(uuid, subType);
  }

  addService(service: Service): Service {
    return this.hapAccessory.addService(service);
  }
}
