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
export declare class BridgedAccessoryHandle implements AccessoryHandle {
    readonly hapAccessory: HapAccessory;
    context: AccessoryContext;
    constructor(hapAccessory: HapAccessory, context: AccessoryContext);
    get UUID(): string;
    get displayName(): string;
    set displayName(name: string);
    getService(name: string | WithUUID<typeof Service>): Service | undefined;
    getServiceById(uuid: string | WithUUID<typeof Service>, subType: string): Service | undefined;
    addService(service: Service): Service;
}
