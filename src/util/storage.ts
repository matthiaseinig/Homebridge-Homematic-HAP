/**
 * All plugin disk writes go through here so we never write outside
 * Homebridge's storage directory and never follow user-controlled paths.
 *
 * Verified plugins MUST keep cache/state inside `api.user.storagePath()`;
 * this is the chokepoint that enforces it.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PLUGIN_NAME } from '../settings.js';

const SUBDIR = PLUGIN_NAME;
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

/** Just enough of the homebridge API surface for storage. */
export interface StorageHost {
  user: { storagePath(): string };
}

export class PluginStorage {
  private readonly root: string;

  constructor(api: StorageHost) {
    this.root = path.resolve(api.user.storagePath(), SUBDIR);
  }

  /** Resolves `name` under our storage root, refusing path traversal. */
  resolve(name: string): string {
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
      throw new StorageError('Invalid storage entry name');
    }
    // Allow nested-but-safe path segments (no ".." escape) by validating each.
    const parts = name.split('/');
    for (const part of parts) {
      if (!SAFE_NAME_RE.test(part)) {
        throw new StorageError(`Unsafe storage entry name: ${name}`);
      }
    }
    const resolved = path.resolve(this.root, ...parts);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new StorageError(`Storage path escapes root: ${name}`);
    }
    return resolved;
  }

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  async readJson<T>(name: string): Promise<T | undefined> {
    try {
      const buf = await fs.readFile(this.resolve(name), 'utf8');
      return JSON.parse(buf) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await this.ensureRoot();
    const target = this.resolve(name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(tmp, target);
  }

  async remove(name: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  rootPath(): string {
    return this.root;
  }
}
