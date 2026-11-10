/**
 * Validation of the `multiBridge` section of a platform block. Any invalid
 * entry makes the whole block refuse to start (ConfigError): publishing
 * part of a misconfigured set is worse than publishing nothing, because a
 * HomeKit bridge that is unreachable keeps its accessories while a bridge
 * that comes back with fewer accessories loses them.
 */
import type { MultiBridgeConfig, RawMultiBridgeConfig } from '../types.js';
/** Ports and username that the block's own Homebridge child bridge uses. */
export interface HostBridgeIdentity {
    username?: string;
    port?: number;
}
export interface ReservedPorts {
    eventServerPort: number;
    host?: HostBridgeIdentity;
}
export declare function resolveMultiBridgeConfig(raw: RawMultiBridgeConfig, reserved: ReservedPorts): MultiBridgeConfig;
