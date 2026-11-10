/**
 * Facade over the CCU adapters. Owns the lifecycle (connect / disconnect /
 * reconnect), exposes high-level operations to the platform and services,
 * and dispatches inbound events to registered listeners.
 *
 * Architecture:
 *   - control plane: CcuJsonRpcClient (JSON-RPC at /api/homematic.cgi)
 *     used for discovery, variable I/O, program execution, getValue/setValue.
 *   - event plane:    EventServer (local XML-RPC) + RpcClient per interface
 *     for the CCU's push events.
 *
 * Exactly one CcuClient lives per HomematicPlatform instance.
 */
import { EventEmitter } from 'node:events';
import { EventServer } from './EventServer.js';
import { CcuJsonRpcClient } from './CcuJsonRpcClient.js';
import type { CcuDevice, CcuInterfaceId, CcuProgram, CcuVariable, ResolvedConfig } from '../types.js';
import type { PrefixedLogger } from '../util/logger.js';
export interface CcuClientOptions {
    config: ResolvedConfig;
    log: PrefixedLogger;
}
type DatapointListener = (value: unknown) => void;
export declare class CcuClient extends EventEmitter {
    /** Modern JSON-RPC control plane. */
    readonly api: CcuJsonRpcClient;
    readonly eventServer: EventServer;
    private readonly rpcClients;
    private readonly datapointListeners;
    private readonly config;
    private readonly log;
    private watchdogTimer;
    private lastEventAt;
    private started;
    /** XML-RPC port discovered per interface from `Interface.listInterfaces`. */
    private readonly discoveredPorts;
    /** address → interface map built from `Device.listAllDetail` at startup. */
    private readonly addressInterface;
    constructor(opts: CcuClientOptions);
    start(): Promise<void>;
    private refreshInterfacePorts;
    private refreshAddressInterfaceMap;
    stop(): Promise<void>;
    /** All devices and their channels (one JSON-RPC call). */
    listDevices(): Promise<CcuDevice[]>;
    listVariables(): Promise<CcuVariable[]>;
    listPrograms(): Promise<CcuProgram[]>;
    listRooms(): Promise<{
        id: string;
        name: string;
        channelIds: string[];
    }[]>;
    /** Subscribe a callback to a `<interface>.<serial>:<chan>.<datapoint>` address. */
    registerListener(address: string, listener: DatapointListener): () => void;
    /** Returns true if any RPC interface is currently subscribed. */
    isLive(): boolean;
    /**
     * Set a CCU datapoint via XML-RPC (the event-plane interface client).
     * setValue HAS to go through XML-RPC because that's the path the CCU
     * also pushes events back from — round-trip latency is best there.
     * Falls back to JSON-RPC `Interface.setValue` if no XML-RPC client is
     * subscribed for that interface.
     */
    setValue(address: string, datapoint: string, value: unknown): Promise<void>;
    /**
     * Read a CCU datapoint. Prefers the XML-RPC interface client (single
     * round-trip, no auth overhead) and falls back to JSON-RPC.
     */
    getValue(address: string, datapoint: string): Promise<unknown>;
    private handleEvent;
    private interfaceForAddress;
    /**
     * Interfaces this block's mapped channels live on. Every subscription
     * makes the CCU push *all* of that interface's events to us, so a block
     * that only maps HmIP channels should not also subscribe to BidCos-RF.
     * `undefined` (subscribe to every enabled interface) when no channels
     * are mapped, e.g. the config UI's discovery client.
     */
    private interfacesInUse;
    private startWatchdog;
    private resolveCallbackHost;
}
/**
 * XML-RPC callback id. The default block keeps the historical id; other
 * blocks (one per former hap-homematic bridge) get the block name in it so
 * the CCU's subscription list shows which bridge a callback belongs to.
 */
export declare function callbackIdFor(blockName: string, interfaceId: CcuInterfaceId): string;
export {};
