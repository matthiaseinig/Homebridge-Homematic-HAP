/**
 * Multi-bridge host ("A1"): one platform block, one CCU connection and one
 * event subscription, publishing one HAP bridge per former hap-homematic
 * bridge, each with its original identity (username, pin, setupID,
 * AccessoryInfo and IdentifierCache in the persist directory).
 *
 * Publication rules, each guarding against HomeKit dropping accessories:
 *   - A disabled bridge is never built or published (its identity may still
 *     be live on the CCU; two hosts must never advertise one identity).
 *   - Nothing is published until the CCU answered (event subscription live,
 *     devices and variables listed). An unreachable bridge keeps its
 *     accessories in HomeKit; a bridge published with fewer accessories
 *     because of a transient CCU error would lose them.
 *   - A transplanted bridge is published only when its persist files are
 *     present and its pin/setupID match them (never a new identity under
 *     an old username).
 *   - Shutdown only unpublishes. `Accessory.destroy()` would delete the
 *     pairing keys from the persist directory.
 */

import type { HAP, PublishInfo } from 'homebridge';
import type { CcuClient } from '../ccu/CcuClient.js';
import type { MultiBridgeConfig, MultiBridgeEntry } from '../types.js';
import type { PrefixedLogger } from '../util/logger.js';
import { buildBridge, type BuiltBridge, type CcuSnapshot, type HapBridge } from './bridgeBuilder.js';
import { identityProblem, type IdentityStore } from './identityStore.js';
import { isTcpPortFree, type PortProbe } from './portProbe.js';

export interface BridgePublisher {
  publish(bridge: HapBridge, info: PublishInfo): Promise<void>;
  unpublish(bridge: HapBridge): Promise<void>;
}

/** The real thing. Never calls destroy(). */
export const hapPublisher: BridgePublisher = {
  publish: async (bridge, info) => {
    await bridge.publish(info, false);
  },
  unpublish: async (bridge) => {
    await bridge.unpublish();
  },
};

export interface MultiBridgeHostOptions {
  hap: HAP;
  ccu: CcuClient;
  config: MultiBridgeConfig;
  log: PrefixedLogger;
  version: string;
  identityStore: IdentityStore;
  publisher?: BridgePublisher;
  portProbe?: PortProbe;
  /** Upper bound for unpublishing all bridges on shutdown (Homebridge kills the child after 5 s). */
  shutdownTimeoutMs?: number;
}

export class MultiBridgeHost {
  private readonly opts: MultiBridgeHostOptions;
  private readonly publisher: BridgePublisher;
  private readonly portProbe: PortProbe;
  private readonly published: BuiltBridge[] = [];
  private stopped = false;
  private wake: (() => void) | undefined;

  constructor(opts: MultiBridgeHostOptions) {
    this.opts = opts;
    this.publisher = opts.publisher ?? hapPublisher;
    this.portProbe = opts.portProbe ?? isTcpPortFree;
  }

  /** Names of the bridges currently published. */
  publishedBridges(): string[] {
    return this.published.map((b) => b.entry.name);
  }

  async start(): Promise<void> {
    const { config, log } = this.opts;
    const enabled = config.bridges.filter((b) => b.enabled);
    const disabled = config.bridges.length - enabled.length;
    log.info('Multi-bridge mode: %d of %d bridges enabled (%d disabled, not published)',
      enabled.length, config.bridges.length, disabled);
    if (enabled.length === 0) {
      return;
    }
    const needsVariables = enabled.some((b) => b.variables.length > 0);
    const snapshot = await this.waitForCcu(needsVariables);
    if (!snapshot) {
      return;
    }
    for (const entry of enabled) {
      if (this.stopped) {
        return;
      }
      await this.publishOne(entry, snapshot);
    }
    log.info('Multi-bridge mode: %d bridge(s) published', this.published.length);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    const bridges = this.published.splice(0);
    const timeout = this.opts.shutdownTimeoutMs ?? 4000;
    await Promise.allSettled(bridges.map((b) => withTimeout(this.publisher.unpublish(b.bridge), timeout)
      .catch((err) => this.opts.log.warn('Unpublish %s failed: %s', b.entry.name, (err as Error).message))));
    bridges.forEach((b) => this.disposeHandlers(b));
    try {
      await this.opts.ccu.stop();
    } catch (err) {
      this.opts.log.warn('CCU stop failed: %s', (err as Error).message);
    }
  }

  // --- internals -----------------------------------------------------

  private async waitForCcu(needsVariables: boolean): Promise<CcuSnapshot | undefined> {
    const { ccu, log, config } = this.opts;
    for (let attempt = 1; !this.stopped; attempt++) {
      try {
        await ccu.start();
        if (!ccu.isLive()) {
          throw new Error('no event subscription to the CCU');
        }
        const devices = await ccu.listDevices();
        if (devices.length === 0) {
          throw new Error('the CCU listed no devices');
        }
        const variables = needsVariables ? await ccu.listVariables() : [];
        log.success('Connected to CCU at attempt %d', attempt);
        return { devices, variables };
      } catch (err) {
        log.warn('CCU not ready (attempt %d): %s. No bridge is published until it is; retrying in %d s',
          attempt, (err as Error).message, config.retrySeconds);
        await ccu.stop().catch((e: Error) => log.debug('CCU stop after failed start: %s', e.message));
        await this.sleep(config.retrySeconds * 1000);
      }
    }
    return undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.wake = done;
    });
  }

  private async publishOne(entry: MultiBridgeEntry, snapshot: CcuSnapshot): Promise<void> {
    const { hap, ccu, log, version, identityStore, config } = this.opts;
    let built: BuiltBridge;
    try {
      built = buildBridge({ hap, ccu, log, version }, entry, snapshot);
    } catch (err) {
      log.error('Bridge %s not published: build failed: %s', entry.name, (err as Error).message);
      return;
    }
    const refuse = (reason: string): void => {
      log.error('Bridge %s not published: %s', entry.name, reason);
      this.disposeHandlers(built);
    };
    if (built.accessories.length === 0) {
      refuse('no accessory could be built (HomeKit would drop all of its accessories)');
      return;
    }
    if (!entry.newIdentity) {
      const problem = identityProblem(identityStore.check(entry));
      if (problem) {
        refuse(`transplanted identity not usable: ${problem}`);
        return;
      }
    }
    if (!(await this.portProbe(entry.port))) {
      refuse(`port ${entry.port} is in use`);
      return;
    }
    if (this.stopped) {
      this.disposeHandlers(built);
      return;
    }
    const info: PublishInfo = {
      username: entry.username,
      pincode: entry.pincode,
      port: entry.port,
      category: entry.category,
      advertiser: config.advertiser as PublishInfo['advertiser'],
      addIdentifyingMaterial: false,
    };
    if (entry.setupID) {
      info.setupID = entry.setupID;
    }
    if (config.bind !== undefined) {
      info.bind = config.bind;
    }
    try {
      await this.publisher.publish(built.bridge, info);
    } catch (err) {
      refuse(`publish failed: ${(err as Error).message}`);
      await this.publisher.unpublish(built.bridge).catch(() => undefined);
      return;
    }
    if (this.stopped) {
      // Shutdown began while this bridge was being published.
      await this.publisher.unpublish(built.bridge).catch(() => undefined);
      this.disposeHandlers(built);
      return;
    }
    this.published.push(built);
    log.success('Published bridge %s on port %d with %d accessories%s', entry.name, entry.port,
      built.accessories.length, built.skipped.length ? ` (${built.skipped.length} mapping(s) skipped)` : '');
  }

  private disposeHandlers(built: BuiltBridge): void {
    for (const h of built.handlers) {
      try {
        h.dispose?.();
      } catch (err) {
        this.opts.log.debug('dispose error: %s', (err as Error).message);
      }
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref?.();
    p.then((v) => {
      clearTimeout(timer);
      resolve(v);
    }, (e: unknown) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
