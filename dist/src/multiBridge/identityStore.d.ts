/**
 * Read-only checks on the transplanted HAP identity files of a bridge
 * (`AccessoryInfo.<ID>.json` with the pairing keys, `IdentifierCache.<ID>.json`
 * with the accessory and instance ids) in Homebridge's persist directory,
 * which is also HAP-NodeJS's storage directory in a child bridge process.
 *
 * Without them HAP-NodeJS would silently create a *new* identity under the
 * old username: a second, unpaired bridge advertising the id of the real
 * one, and fresh instance ids that HomeKit treats as new accessories.
 *
 * Nothing here returns or logs key material, pins or setup ids; only
 * whether they match the configuration.
 */
import type { MultiBridgeEntry } from '../types.js';
export type FileState = 'ok' | 'missing' | 'unreadable';
export interface IdentityCheck {
    accessoryInfo: FileState;
    identifierCache: FileState;
    /** undefined when the AccessoryInfo could not be read. */
    pincodeMatches?: boolean;
    /** undefined when the config gives no setupID or the file could not be read. */
    setupIdMatches?: boolean;
}
export interface IdentityStore {
    check(entry: Pick<MultiBridgeEntry, 'username' | 'pincode' | 'setupID'>): IdentityCheck;
}
export declare function persistFileName(kind: 'AccessoryInfo' | 'IdentifierCache', username: string): string;
export declare function persistIdentityStore(persistDir: string): IdentityStore;
/** Human-readable reason why an identity must not be published, or undefined. */
export declare function identityProblem(check: IdentityCheck): string | undefined;
