/**
 * Resolves and validates the raw plugin config from Homebridge into the
 * strongly-typed ResolvedConfig the rest of the code depends on. Bad
 * input produces a thrown ConfigError with a human-readable explanation;
 * the platform turns that into a single user-visible log line and
 * refuses to start (per the verified-plugin rule "must not start unless
 * configured").
 */
import type { RawConfig, ResolvedConfig } from '../types.js';
export declare class ConfigError extends Error {
    constructor(message: string);
}
export declare function isValidHost(value: unknown): value is string;
export declare function resolveConfig(raw: RawConfig): ResolvedConfig;
