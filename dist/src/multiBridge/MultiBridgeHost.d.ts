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
import type { MultiBridgeConfig } from '../types.js';
import type { PrefixedLogger } from '../util/logger.js';
import { type HapBridge } from './bridgeBuilder.js';
import { type IdentityStore } from './identityStore.js';
import { type PortProbe } from './portProbe.js';
export interface BridgePublisher {
    publish(bridge: HapBridge, info: PublishInfo): Promise<void>;
    unpublish(bridge: HapBridge): Promise<void>;
}
/** The real thing. Never calls destroy(). */
export declare const hapPublisher: BridgePublisher;
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
export declare class MultiBridgeHost {
    private readonly opts;
    private readonly publisher;
    private readonly portProbe;
    private readonly published;
    private stopped;
    private wake;
    constructor(opts: MultiBridgeHostOptions);
    /** Names of the bridges currently published. */
    publishedBridges(): string[];
    start(): Promise<void>;
    stop(): Promise<void>;
    private waitForCcu;
    private sleep;
    private publishOne;
    private disposeHandlers;
}
