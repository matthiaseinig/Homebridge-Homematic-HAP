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

import { networkInterfaces } from 'node:os';
import { EventEmitter } from 'node:events';
import { EventServer, type ChannelEvent } from './EventServer.js';
import { CcuJsonRpcClient } from './CcuJsonRpcClient.js';
import { RpcClient, INTERFACE_PORTS } from './RpcClient.js';
import type {
  CcuDevice,
  CcuInterfaceId,
  CcuProgram,
  CcuVariable,
  ResolvedConfig,
} from '../types.js';
import type { PrefixedLogger } from '../util/logger.js';
import { PLUGIN_NAME } from '../settings.js';

export interface CcuClientOptions {
  config: ResolvedConfig;
  log: PrefixedLogger;
}

type DatapointListener = (value: unknown) => void;

const ENABLED_INTERFACES: ReadonlyArray<{
  id: CcuInterfaceId;
  flag: keyof ResolvedConfig['interfaces'];
}> = [
  { id: 'BidCos-RF',     flag: 'bidcosRf' },
  { id: 'HmIP-RF',       flag: 'hmIpRf' },
  { id: 'BidCos-Wired',  flag: 'bidcosWired' },
  { id: 'VirtualDevices', flag: 'virtualDevices' },
  { id: 'CUxD',          flag: 'cuxd' },
];

export class CcuClient extends EventEmitter {
  /** Modern JSON-RPC control plane. */
  readonly api: CcuJsonRpcClient;
  readonly eventServer: EventServer;
  private readonly rpcClients: Map<CcuInterfaceId, RpcClient> = new Map();
  private readonly datapointListeners: Map<string, Set<DatapointListener>> = new Map();
  private readonly config: ResolvedConfig;
  private readonly log: PrefixedLogger;
  private watchdogTimer: NodeJS.Timeout | undefined;
  private lastEventAt = 0;
  private started = false;

  constructor(opts: CcuClientOptions) {
    super();
    this.config = opts.config;
    this.log = opts.log;

    this.api = new CcuJsonRpcClient({
      host: this.config.ccuIp,
      useTls: this.config.useTls,
      auth: this.config.ccuAuth.enabled
        ? { username: this.config.ccuAuth.username!, password: this.config.ccuAuth.password! }
        : undefined,
      log: this.log.child('api'),
    });

    this.eventServer = new EventServer({
      host: this.config.eventServer.host,
      port: this.config.eventServer.port,
      log: this.log.child('events'),
    });

    this.eventServer.on('event', (ev) => this.handleEvent(ev));
    this.eventServer.on('error', (err) => {
      this.log.error('Event server error: %s', err.message);
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.eventServer.start();

    const callbackHost = this.resolveCallbackHost();
    const callbackUrl = `http://${callbackHost}:${this.config.eventServer.port}`;

    for (const { id, flag } of ENABLED_INTERFACES) {
      if (!this.config.interfaces[flag]) {
        continue;
      }
      const callbackId = `${PLUGIN_NAME}:${id}`;
      const client = new RpcClient({
        interfaceId: id,
        host: this.config.ccuIp,
        port: INTERFACE_PORTS[id],
        callbackUrl,
        callbackId,
        log: this.log.child(`rpc:${id}`),
      });
      try {
        await client.subscribe();
        this.rpcClients.set(id, client);
      } catch (err) {
        this.log.warn('Could not subscribe to %s: %s', id, (err as Error).message);
      }
    }

    this.lastEventAt = Date.now();
    this.startWatchdog();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    for (const client of this.rpcClients.values()) {
      await client.unsubscribe();
      await client.close();
    }
    this.rpcClients.clear();
    await this.eventServer.stop();
    this.api.invalidateSession();
  }

  /** All devices and their channels (one JSON-RPC call). */
  listDevices(): Promise<CcuDevice[]> {
    return this.api.listDevices();
  }

  listVariables(): Promise<CcuVariable[]> {
    return this.api.listVariables();
  }

  listPrograms(): Promise<CcuProgram[]> {
    return this.api.listPrograms();
  }

  listRooms(): Promise<{ id: string; name: string; channelIds: string[] }[]> {
    return this.api.listRooms();
  }

  /** Subscribe a callback to a `<interface>.<serial>:<chan>.<datapoint>` address. */
  registerListener(address: string, listener: DatapointListener): () => void {
    let set = this.datapointListeners.get(address);
    if (!set) {
      set = new Set();
      this.datapointListeners.set(address, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.datapointListeners.delete(address);
      }
    };
  }

  /** Returns true if any RPC interface is currently subscribed. */
  isLive(): boolean {
    for (const c of this.rpcClients.values()) {
      if (c.isSubscribed()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Set a CCU datapoint via XML-RPC (the event-plane interface client).
   * setValue HAS to go through XML-RPC because that's the path the CCU
   * also pushes events back from — round-trip latency is best there.
   * Falls back to JSON-RPC `Interface.setValue` if no XML-RPC client is
   * subscribed for that interface.
   */
  async setValue(address: string, datapoint: string, value: unknown): Promise<void> {
    const intf = this.interfaceForAddress(address);
    const client = this.rpcClients.get(intf);
    if (client) {
      await client.setValue(address, datapoint, value);
      return;
    }
    // Fall back to JSON-RPC. JSON-RPC's Interface.setValue takes the
    // address WITHOUT the interface prefix.
    const bareAddress = stripInterfacePrefix(address);
    const type = guessJsonRpcType(value);
    await this.api.setInterfaceValue(intf, bareAddress, datapoint, type, value);
  }

  /**
   * Read a CCU datapoint. Prefers the XML-RPC interface client (single
   * round-trip, no auth overhead) and falls back to JSON-RPC.
   */
  async getValue(address: string, datapoint: string): Promise<unknown> {
    const intf = this.interfaceForAddress(address);
    const client = this.rpcClients.get(intf);
    if (client) {
      return client.getValue(address, datapoint);
    }
    return this.api.getInterfaceValue(intf, stripInterfacePrefix(address), datapoint);
  }

  // --- internals -----------------------------------------------------

  private handleEvent(ev: ChannelEvent): void {
    this.lastEventAt = ev.receivedAt;
    const fullAddress = `${ev.channelAddress}.${ev.datapoint}`;
    const set = this.datapointListeners.get(fullAddress);
    if (!set) {
      this.log.debug('Unrouted event %s = %s', fullAddress, String(ev.value));
      return;
    }
    for (const listener of set) {
      try {
        listener(ev.value);
      } catch (err) {
        this.log.error('Listener for %s threw: %s', fullAddress, (err as Error).message);
      }
    }
  }

  private interfaceForAddress(address: string): CcuInterfaceId {
    const dot = address.indexOf('.');
    const prefix = dot === -1 ? address : address.slice(0, dot);
    if (prefix === 'BidCos-RF' || prefix === 'HmIP-RF' || prefix === 'BidCos-Wired'
      || prefix === 'VirtualDevices' || prefix === 'CUxD') {
      return prefix;
    }
    if (prefix.startsWith('HmIP') || prefix.startsWith('hmip')) {
      return 'HmIP-RF';
    }
    if (prefix.startsWith('CUX')) {
      return 'CUxD';
    }
    if (prefix.startsWith('BidCos-Wired')) {
      return 'BidCos-Wired';
    }
    return 'BidCos-RF';
  }

  private startWatchdog(): void {
    const intervalMs = Math.max(30_000, Math.floor(this.config.eventServer.watchdogSeconds * 1000 / 3));
    this.watchdogTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastEventAt;
      if (elapsed > this.config.eventServer.watchdogSeconds * 1000) {
        this.log.warn('No events for %d ms, re-subscribing to all interfaces', elapsed);
        for (const client of this.rpcClients.values()) {
          client.subscribe().catch((err) =>
            this.log.warn('Re-subscribe failed for %s: %s', client.interfaceId, (err as Error).message),
          );
        }
        this.lastEventAt = Date.now();
      }
    }, intervalMs);
    if (this.watchdogTimer.unref) {
      this.watchdogTimer.unref();
    }
  }

  private resolveCallbackHost(): string {
    if (this.config.eventServer.host !== '0.0.0.0' && this.config.eventServer.host !== '::') {
      return this.config.eventServer.host;
    }
    const ifs = networkInterfaces();
    for (const list of Object.values(ifs)) {
      for (const i of list ?? []) {
        if (i.family === 'IPv4' && !i.internal) {
          return i.address;
        }
      }
    }
    return '127.0.0.1';
  }
}

function stripInterfacePrefix(address: string): string {
  const dot = address.indexOf('.');
  return dot === -1 ? address : address.slice(dot + 1);
}

function guessJsonRpcType(value: unknown): 'boolean' | 'string' | 'integer' | 'double' {
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'double';
  }
  return 'string';
}
