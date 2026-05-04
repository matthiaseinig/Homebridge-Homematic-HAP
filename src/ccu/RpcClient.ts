/**
 * Wraps homematic-xmlrpc into a Promise-based, per-interface client. We
 * keep one RpcClient per CCU interface (BidCos-RF, HmIP-RF, …) — each one
 * connects to a different CCU port and registers a callback URL so the
 * EventServer receives push events.
 */

import type { PrefixedLogger } from '../util/logger.js';
import type { CcuInterfaceId } from '../types.js';

export const INTERFACE_PORTS: Record<CcuInterfaceId, number> = {
  'BidCos-RF': 2001,
  'HmIP-RF': 2010,
  'BidCos-Wired': 2000,
  'VirtualDevices': 9292,
  'CUxD': 8701,
};

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
}

export interface RpcTransport {
  call(method: string, params: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

export class RpcError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

export class RpcClient {
  readonly interfaceId: CcuInterfaceId;
  private readonly host: string;
  private readonly port: number;
  private readonly callbackUrl: string;
  private readonly callbackId: string;
  private readonly log: PrefixedLogger;
  private transport: RpcTransport | undefined;
  private readonly transportFactory?: RpcTransport;
  private subscribed = false;

  constructor(opts: RpcClientOptions) {
    this.interfaceId = opts.interfaceId;
    this.host = opts.host;
    this.port = opts.port ?? INTERFACE_PORTS[opts.interfaceId];
    this.callbackUrl = opts.callbackUrl;
    this.callbackId = opts.callbackId;
    this.log = opts.log;
    this.transportFactory = opts.transport;
  }

  async ensureTransport(): Promise<RpcTransport> {
    if (this.transport) {
      return this.transport;
    }
    if (this.transportFactory) {
      this.transport = this.transportFactory;
      return this.transport;
    }
    // Late-load the runtime dep so unit tests can inject a transport
    // without resolving the homematic-xmlrpc native module path.
    //
    // homematic-xmlrpc is published as CommonJS; under ESM dynamic import
    // its real `createClient` shows up on `.default`, not directly on the
    // module namespace. Same gotcha we hit with iconv-lite earlier.
    type CreateClientFn = (opts: { host: string; port: number }) => {
      methodCall(method: string, params: unknown[],
        cb: (err: Error | null, value: unknown) => void): void;
    };
    const mod = (await import('homematic-xmlrpc')) as {
      createClient?: CreateClientFn;
      default?: { createClient?: CreateClientFn };
    };
    const createClient = mod.createClient ?? mod.default?.createClient;
    if (typeof createClient !== 'function') {
      throw new RpcError('homematic-xmlrpc module did not expose createClient');
    }
    const client = createClient({ host: this.host, port: this.port });
    this.transport = {
      call: (method, params) =>
        new Promise((resolve, reject) => {
          client.methodCall(method, params, (err, value) => {
            if (err) {
              const e = err as { message?: string; faultString?: string; faultCode?: number };
              const detail = e.faultString
                ? `${e.faultString}${e.faultCode !== undefined ? ` (${e.faultCode})` : ''}`
                : e.message ?? 'unknown error';
              reject(new RpcError(`${method} failed: ${detail}`, err));
            } else {
              resolve(value);
            }
          });
        }),
      close: async () => undefined,
    };
    return this.transport;
  }

  /** Subscribe to events. Idempotent. */
  async subscribe(): Promise<void> {
    const t = await this.ensureTransport();
    await t.call('init', [this.callbackUrl, this.callbackId]);
    this.subscribed = true;
    this.log.info('Subscribed (%s -> %s)', this.callbackId, this.callbackUrl);
  }

  /** Unsubscribe — best-effort, swallows errors. */
  async unsubscribe(): Promise<void> {
    if (!this.subscribed) {
      return;
    }
    try {
      const t = await this.ensureTransport();
      // CCU convention: empty interfaceId removes the subscription.
      await t.call('init', [this.callbackUrl, '']);
    } catch (err) {
      this.log.debug('unsubscribe error (ignored): %s', (err as Error).message);
    } finally {
      this.subscribed = false;
    }
  }

  async getValue(channel: string, datapoint: string): Promise<unknown> {
    const t = await this.ensureTransport();
    return t.call('getValue', [channel, datapoint]);
  }

  async setValue(channel: string, datapoint: string, value: unknown): Promise<void> {
    const t = await this.ensureTransport();
    await t.call('setValue', [channel, datapoint, value]);
  }

  async ping(): Promise<boolean> {
    try {
      const t = await this.ensureTransport();
      // listMethods is a cheap no-op for liveness probing.
      await t.call('system.listMethods', []);
      return true;
    } catch (err) {
      this.log.debug('ping failed: %s', (err as Error).message);
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = undefined;
    }
  }

  isSubscribed(): boolean {
    return this.subscribed;
  }
}
