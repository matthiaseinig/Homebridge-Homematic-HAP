/**
 * Wraps homematic-xmlrpc into a Promise-based, per-interface client. We
 * keep one RpcClient per CCU interface (BidCos-RF, HmIP-RF, …) — each one
 * connects to a different CCU port and registers a callback URL so the
 * EventServer receives push events.
 */
import type { PrefixedLogger } from '../util/logger.js';
import type { CcuInterfaceId } from '../types.js';
export declare const INTERFACE_PORTS: Record<CcuInterfaceId, number>;
export interface RpcClientOptions {
    interfaceId: CcuInterfaceId;
    host: string;
    port?: number;
    /** URL the CCU should call back. e.g. xmlrpc://192.168.1.20:9875 */
    callbackUrl: string;
    /** Identifier the CCU will tag callbacks with. */
    callbackId: string;
    log: PrefixedLogger;
    /**
     * Inject the underlying transport for tests. The default uses
     * homematic-xmlrpc to dial the CCU port.
     */
    transport?: RpcTransport;
    /**
     * Skip the pre-init TCP reachability probe. Tests that mock
     * `homematic-xmlrpc` via `vi.mock` rely on the module's mocked
     * createClient and never actually open a socket; the probe would
     * still try to connect to the configured port and fail.
     */
    skipProbe?: boolean;
}
export interface RpcTransport {
    call(method: string, params: unknown[]): Promise<unknown>;
    close(): Promise<void>;
}
export declare class RpcError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
export declare class RpcClient {
    readonly interfaceId: CcuInterfaceId;
    private readonly host;
    private readonly port;
    private readonly callbackUrl;
    private readonly callbackId;
    private readonly log;
    private transport;
    private readonly transportFactory?;
    private readonly skipProbe;
    private subscribed;
    constructor(opts: RpcClientOptions);
    ensureTransport(): Promise<RpcTransport>;
    /** Subscribe to events. Idempotent. */
    subscribe(): Promise<void>;
    private probeReachable;
    /** Unsubscribe — best-effort, swallows errors. */
    unsubscribe(): Promise<void>;
    getValue(channel: string, datapoint: string): Promise<unknown>;
    setValue(channel: string, datapoint: string, value: unknown): Promise<void>;
    ping(): Promise<boolean>;
    close(): Promise<void>;
    isSubscribed(): boolean;
}
/**
 * Monkey-patch homematic-xmlrpc's Deserializer to ignore non-spec wrapping
 * elements such as `<META>`. The default behaviour is to error out with
 * `Unknown XML-RPC tag 'META'`, which RaspberryMatic's HmIP server can
 * trigger on `init`. Idempotent — safe to call multiple times.
 *
 * Exported only for tests.
 */
export declare function patchDeserializerForUnknownTags(): void;
