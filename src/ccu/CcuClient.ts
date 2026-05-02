/**
 * Facade over the four lower-level CCU adapters. Owns the lifecycle
 * (connect/disconnect/reconnect), exposes high-level operations to the
 * platform and services, and dispatches inbound events to registered
 * listeners.
 *
 * Exactly one CcuClient lives per HomematicPlatform instance.
 */

import { networkInterfaces } from 'node:os';
import { EventEmitter } from 'node:events';
import { EventServer, type ChannelEvent } from './EventServer.js';
import { RegaClient } from './RegaClient.js';
import { RpcClient, INTERFACE_PORTS } from './RpcClient.js';
import {
  parseDevicesXml,
  parseProgramsXml,
  parseVariablesXml,
} from './regaParse.js';
import {
  DEVICES_SCRIPT,
  PROGRAMS_SCRIPT,
  ROOMS_SCRIPT,
  VARIABLES_SCRIPT,
} from './regaScripts.js';
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
  readonly rega: RegaClient;
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

    this.rega = new RegaClient({
      host: this.config.ccuIp,
      useTls: this.config.useTls,
      auth: this.config.ccuAuth.enabled
        ? { username: this.config.ccuAuth.username!, password: this.config.ccuAuth.password! }
        : undefined,
      log: this.log.child('rega'),
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
  }

  /** Fetches all devices as discovered by the CCU. */
  async listDevices(): Promise<CcuDevice[]> {
    const result = await this.rega.script(DEVICES_SCRIPT);
    return parseDevicesXml(result.xml);
  }

  async listVariables(): Promise<CcuVariable[]> {
    const result = await this.rega.script(VARIABLES_SCRIPT);
    return parseVariablesXml(result.xml);
  }

  async listPrograms(): Promise<CcuProgram[]> {
    const result = await this.rega.script(PROGRAMS_SCRIPT);
    return parseProgramsXml(result.xml);
  }

  async listRooms(): Promise<{ id: string; name: string; channelIds: string[] }[]> {
    const result = await this.rega.script(ROOMS_SCRIPT);
    const out: { id: string; name: string; channelIds: string[] }[] = [];
    const re = /<room>([\s\S]*?)<\/room>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(result.xml)) !== null) {
      const room = m[1] ?? '';
      const id = /<id>([\s\S]*?)<\/id>/.exec(room)?.[1] ?? '';
      const name = decodeURIComponent((/<name>([\s\S]*?)<\/name>/.exec(room)?.[1] ?? '').replace(/\+/g, ' '));
      const channelIds: string[] = [];
      const cre = /<channelId>([\s\S]*?)<\/channelId>/g;
      let cm: RegExpExecArray | null;
      while ((cm = cre.exec(room)) !== null) {
        channelIds.push(cm[1] ?? '');
      }
      out.push({ id, name, channelIds });
    }
    return out;
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

  /** Send setValue for a CCU datapoint, picking the right interface client. */
  async setValue(address: string, datapoint: string, value: unknown): Promise<void> {
    const intf = this.interfaceForAddress(address);
    const client = this.rpcClients.get(intf);
    if (!client) {
      throw new Error(`No RPC client for interface ${intf}`);
    }
    await client.setValue(address, datapoint, value);
  }

  async getValue(address: string, datapoint: string): Promise<unknown> {
    const intf = this.interfaceForAddress(address);
    const client = this.rpcClients.get(intf);
    if (!client) {
      throw new Error(`No RPC client for interface ${intf}`);
    }
    return client.getValue(address, datapoint);
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
