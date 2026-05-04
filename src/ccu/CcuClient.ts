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
  /** XML-RPC port discovered per interface from `Interface.listInterfaces`. */
  private readonly discoveredPorts: Map<CcuInterfaceId, number> = new Map();
  /** address → interface map built from `Device.listAllDetail` at startup. */
  private readonly addressInterface: Map<string, CcuInterfaceId> = new Map();

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

    // Pull the actual XML-RPC ports from the CCU. RaspberryMatic exposes
    // them at +30000 (32001/32010/39292), but a stock CCU3 still uses
    // 2001/2010/9292 — so we trust whatever the CCU reports.
    await this.refreshInterfacePorts();
    // Build a lookup of channel-address → interface so setValue can route
    // unprefixed addresses (the way they appear in hap-homematic backups)
    // to the right XML-RPC client without guessing.
    await this.refreshAddressInterfaceMap();

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
        port: this.discoveredPorts.get(id) ?? INTERFACE_PORTS[id],
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

  private async refreshInterfacePorts(): Promise<void> {
    try {
      const list = await this.api.listInterfaces();
      for (const i of list) {
        const id = mapInterfaceName(i.name);
        if (id) {
          this.discoveredPorts.set(id, i.port);
          this.log.debug('Interface %s on port %d', id, i.port);
        }
      }
    } catch (err) {
      this.log.warn('Interface.listInterfaces failed (%s) — using default ports',
        (err as Error).message);
    }
  }

  private async refreshAddressInterfaceMap(): Promise<void> {
    try {
      const devices = await this.api.listDevices();
      const remember = (addr: string, intf: CcuInterfaceId): void => {
        if (!addr) return;
        this.addressInterface.set(addr, intf);
        // Also index without the interface prefix (some CCUs/backups
        // store addresses as `HmIP-RF.0001D7...` while others store the
        // bare `0001D7...:1`). Storing both forms means lookups succeed
        // either way.
        const dot = addr.indexOf('.');
        if (dot !== -1) {
          this.addressInterface.set(addr.slice(dot + 1), intf);
        } else {
          this.addressInterface.set(`${intf}.${addr}`, intf);
        }
      };
      for (const d of devices) {
        if (!d.interface) continue;
        remember(d.address, d.interface);
        for (const c of d.channels) {
          remember(c.address, d.interface);
        }
      }
      this.log.debug('Indexed %d addresses across interfaces', this.addressInterface.size);
    } catch (err) {
      this.log.debug('listDevices for address-interface map failed: %s',
        (err as Error).message);
    }
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
    // First check the device-discovery map (built at start()). This is the
    // only source that always tells the truth — hap-homematic backups
    // store bare addresses like "000123:1" with no interface prefix, and
    // a HmIP serial like "000123" can't be distinguished from a BidCos
    // serial without consulting the CCU.
    const direct = this.addressInterface.get(address);
    if (direct) {
      return direct;
    }
    // Try without the channel suffix (`:N`) — `listDevices` returns both
    // device- and channel-level addresses but external code may pass the
    // device address only.
    const colon = address.indexOf(':');
    if (colon !== -1) {
      const deviceOnly = this.addressInterface.get(address.slice(0, colon));
      if (deviceOnly) return deviceOnly;
    }
    // Fall back to prefix heuristics. This matches the pre-discovery
    // behavior so accessories created before start() completes still
    // route somewhere reasonable.
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

/**
 * Map the CCU's interface display name to our canonical CcuInterfaceId.
 * RaspberryMatic returns names like "BidCos-RF", "HmIP-RF", "BidCos-Wired",
 * "VirtualDevices", "CUxD" already — but some firmwares prefix with "HM-" or
 * use lowercase. We accept the obvious aliases and reject anything else
 * (notably "HmIPServer" used internally by HmIP-RF, which would otherwise
 * be misrouted, and "CCU-Jack" which we don't support).
 */
function mapInterfaceName(name: string): CcuInterfaceId | undefined {
  const n = name.trim();
  if (n === 'BidCos-RF' || n === 'BidCos-Wired' || n === 'HmIP-RF'
    || n === 'VirtualDevices' || n === 'CUxD') {
    return n;
  }
  // Tolerate case differences and a couple of historical aliases.
  const lower = n.toLowerCase();
  if (lower === 'bidcos-rf' || lower === 'rf') return 'BidCos-RF';
  if (lower === 'bidcos-wired' || lower === 'wired') return 'BidCos-Wired';
  if (lower === 'hmip-rf' || lower === 'hmip' || lower === 'hmiprf') return 'HmIP-RF';
  if (lower === 'virtualdevices' || lower === 'virtual') return 'VirtualDevices';
  if (lower === 'cuxd') return 'CUxD';
  return undefined;
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
