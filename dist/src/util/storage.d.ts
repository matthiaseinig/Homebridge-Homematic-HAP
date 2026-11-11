/**
 * All plugin disk writes go through here so we never write outside
 * Homebridge's storage directory and never follow user-controlled paths.
 *
 * Verified plugins MUST keep cache/state inside `api.user.storagePath()`;
 * this is the chokepoint that enforces it.
 */
export declare class StorageError extends Error {
    constructor(message: string);
}
/** Just enough of the homebridge API surface for storage. */
export interface StorageHost {
    user: {
        storagePath(): string;
    };
}
export declare class PluginStorage {
    private readonly root;
    constructor(api: StorageHost);
    /** Resolves `name` under our storage root, refusing path traversal. */
    resolve(name: string): string;
    ensureRoot(): Promise<void>;
    readJson<T>(name: string): Promise<T | undefined>;
    writeJson(name: string, value: unknown): Promise<void>;
    remove(name: string): Promise<void>;
    rootPath(): string;
}
