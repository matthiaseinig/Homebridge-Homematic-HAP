/**
 * Minimal XML-RPC server the CCU calls back into. We deliberately do
 * NOT depend on homematic-xmlrpc's createServer for this so we can keep
 * tight control over the parsing surface; we only handle the four
 * methods the CCU actually invokes.
 *
 *   event(callbackId, channelAddress, datapoint, value)
 *   listDevices(callbackId)
 *   newDevices(callbackId, deviceArray)
 *   system.multicall([{methodName, params}])  -- batched events
 *   system.listMethods()                       -- discovery
 *
 * Events are dispatched through a typed EventEmitter for the rest of
 * the plugin to consume.
 */
import { EventEmitter } from 'node:events';
import type { PrefixedLogger } from '../util/logger.js';
/**
 * How many consecutive ports to try when the configured one is taken.
 * Several platform blocks (one Homebridge child bridge per former
 * hap-homematic bridge) on one host would otherwise all fight over 9875.
 */
export declare const PORT_FALLBACK_SPAN = 64;
export interface EventServerOptions {
    host: string;
    port: number;
    log: PrefixedLogger;
}
export interface ChannelEvent {
    callbackId: string;
    channelAddress: string;
    datapoint: string;
    value: unknown;
    /** Wall-clock time in ms when the event arrived locally. */
    receivedAt: number;
}
export interface EventServerEvents {
    event: (ev: ChannelEvent) => void;
    newDevices: (callbackId: string) => void;
    listening: (info: {
        host: string;
        port: number;
    }) => void;
    error: (err: Error) => void;
}
export declare class EventServer extends EventEmitter {
    private readonly host;
    private readonly port;
    private readonly log;
    private server;
    private actualPort;
    constructor(opts: EventServerOptions);
    on<K extends keyof EventServerEvents>(event: K, listener: EventServerEvents[K]): this;
    emit<K extends keyof EventServerEvents>(event: K, ...args: Parameters<EventServerEvents[K]>): boolean;
    /** Port actually bound (may differ from the configured one), once started. */
    get boundPort(): number;
    start(): Promise<void>;
    private listenOn;
    stop(): Promise<void>;
    private handleRequest;
    private dispatch;
}
