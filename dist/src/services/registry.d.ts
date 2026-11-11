/**
 * Central service registry. Each service definition declares the CCU
 * channel types it can handle, its priority, and its variants. The
 * registry is queried at platform discovery time to pick a default
 * service for every channel, and at UI rendering time to populate the
 * "service" dropdown.
 *
 * To add a new service:
 *   1. Create src/services/impl/MyAccessory.ts implementing ChannelService.
 *   2. Export a ServiceDefinition from that file.
 *   3. Add the import + push() below.
 *
 * That's it — no auto-discovery. We deliberately avoid fs.readdir-based
 * "magic" loaders so the dependency graph is statically analysable.
 */
import type { ProgramServiceDefinition, ServiceDefinition, VariableServiceDefinition } from './types.js';
export declare const SERVICE_DEFINITIONS: ServiceDefinition[];
export declare const VARIABLE_SERVICE_DEFINITIONS: VariableServiceDefinition[];
export declare const PROGRAM_SERVICE_DEFINITIONS: ProgramServiceDefinition[];
/** Find candidate services for a channel type, sorted by priority asc. */
export declare function servicesForChannelType(channelType: string): ServiceDefinition[];
export declare function findServiceByKey(key: string): ServiceDefinition | undefined;
export declare function findVariableServiceByKey(key: string): VariableServiceDefinition | undefined;
export declare function pickVariableService(valueType: number): VariableServiceDefinition;
export declare function findProgramServiceByKey(key: string): ProgramServiceDefinition | undefined;
