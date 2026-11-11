/**
 * Shared types for service classes. A service is a small adapter that
 * binds one CCU channel/variable/program to one or more HAP services.
 *
 * Services are registered in `registry.ts` and selected by:
 *   1. The user's `subtype` in config.channels[i].subtype, if any.
 *   2. Otherwise the highest-priority service whose `channelTypes`
 *      includes the device's channel type.
 */

import type { Characteristic, Service, WithUUID } from 'homebridge';
import type { CcuClient } from '../ccu/CcuClient.js';
import type { PrefixedLogger } from '../util/logger.js';
import type { AccessoryContext, CcuChannel, CcuVariable } from '../types.js';

/**
 * The part of an accessory that service handlers use. A Homebridge
 * `PlatformAccessory` satisfies it, and so does the thin adapter over a
 * plain HAP-NodeJS `Accessory` used by the multi-bridge host, which
 * publishes its own HAP bridges instead of registering platform
 * accessories.
 */
export interface AccessoryHandle {
  readonly UUID: string;
  displayName: string;
  context: AccessoryContext;
  getService(name: string | WithUUID<typeof Service>): Service | undefined;
  getServiceById(uuid: string | WithUUID<typeof Service>, subType: string): Service | undefined;
  addService(service: Service): Service;
}

export interface ServiceContext {
  accessory: AccessoryHandle;
  ccu: CcuClient;
  log: PrefixedLogger;
  Service: typeof Service;
  Characteristic: typeof Characteristic;
}

export interface ServiceVariant {
  /** Display name shown in the UI. */
  label: string;
  /** Stable subtype identifier saved in config / accessory.context. */
  id: string;
  /** Optional list of HAP service categories produced (informational only). */
  hapServices?: string[];
}

export interface ServiceDefinition {
  /** Stable key used in config / accessory.context. */
  key: string;
  /** Human-readable description. */
  description: string;
  /** Channel-type strings this service can handle, e.g. `SWITCH_VIRTUAL_RECEIVER`. */
  channelTypes: string[];
  /** Lower number wins when multiple services claim the same channelType. */
  priority: number;
  /** Sub-variants the user can pick (optional). */
  variants?: ServiceVariant[];
  /** Constructor for the per-accessory handler. */
  build(ctx: ServiceContext): ChannelService;
}

export interface VariableServiceDefinition {
  key: string;
  description: string;
  /** True if this service handles boolean variables, false for numeric, undefined for any. */
  forValueType?: number;
  priority: number;
  build(ctx: ServiceContext): VariableService;
}

export interface ProgramServiceDefinition {
  key: string;
  description: string;
  build(ctx: ServiceContext): ProgramService;
}

/** Implemented by per-accessory channel handlers. */
export interface ChannelService {
  /** Wire HAP services + characteristics. Called once after construction. */
  attach(channel: CcuChannel): void;
  /** Disconnect listeners; called when the accessory is removed. */
  dispose?(): void;
}

export interface VariableService {
  attach(variable: CcuVariable): void;
  dispose?(): void;
}

export interface ProgramService {
  attach(programName: string): void;
  dispose?(): void;
}
