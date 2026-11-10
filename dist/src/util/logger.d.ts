/**
 * Thin Logger wrapper that adds a stable component prefix and gives us a
 * single chokepoint to (a) attach extra fields uniformly and (b) make
 * sure secrets in args are scrubbed before reaching `log.*`.
 *
 * The plugin never logs CCU credentials. `scrubArgs` walks args and
 * replaces any value whose property name matches /password|secret|token/i.
 */
import type { Logging } from 'homebridge';
export declare function scrubArgs(args: unknown[]): unknown[];
export declare class PrefixedLogger {
    private readonly underlying;
    readonly prefix: string;
    constructor(underlying: Logging, prefix: string);
    child(suffix: string): PrefixedLogger;
    info(message: string, ...args: unknown[]): void;
    success(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
}
