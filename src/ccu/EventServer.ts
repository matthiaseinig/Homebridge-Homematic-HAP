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

import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { parseXml, serializeFault, serializeResponse } from './xmlRpc.js';
import type { PrefixedLogger } from '../util/logger.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
/**
 * How many consecutive ports to try when the configured one is taken.
 * Several platform blocks (one Homebridge child bridge per former
 * hap-homematic bridge) on one host would otherwise all fight over 9875.
 */
export const PORT_FALLBACK_SPAN = 64;

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
  listening: (info: { host: string; port: number }) => void;
  error: (err: Error) => void;
}

export class EventServer extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly log: PrefixedLogger;
  private server: http.Server | undefined;
  private actualPort: number | undefined;

  constructor(opts: EventServerOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port;
    this.log = opts.log;
  }

  override on<K extends keyof EventServerEvents>(event: K, listener: EventServerEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof EventServerEvents>(event: K, ...args: Parameters<EventServerEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /** Port actually bound (may differ from the configured one), once started. */
  get boundPort(): number {
    return this.actualPort ?? this.port;
  }

  async start(): Promise<void> {
    let lastErr: Error | undefined;
    for (let offset = 0; offset < PORT_FALLBACK_SPAN; offset++) {
      const port = this.port + offset;
      if (port > 65535) {
        break;
      }
      try {
        await this.listenOn(port);
        if (offset > 0) {
          this.log.warn(
            'Event server port %d is in use; using %d instead. Give each platform block '
              + 'its own eventServer.port to keep the CCU callback URL stable.',
            this.port, port,
          );
        }
        return;
      } catch (err) {
        lastErr = err as Error;
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          this.emit('error', lastErr);
          throw lastErr;
        }
      }
    }
    const err = lastErr ?? new Error(`No free event server port from ${this.port}`);
    this.emit('error', err);
    throw err;
  }

  private listenOn(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      const onError = (err: Error): void => {
        server.close();
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, this.host, () => {
        server.off('error', onError);
        server.on('error', (err) => this.emit('error', err));
        this.server = server;
        this.actualPort = port;
        this.log.info('Event server listening on %s:%d', this.host, port);
        this.emit('listening', { host: this.host, port });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const parsed = parseXml(body);
        const result = this.dispatch(parsed.method, parsed.params);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(serializeResponse(result));
      } catch (err) {
        this.log.error('Event server handler error: %s', (err as Error).message);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(serializeFault(-1, (err as Error).message));
      }
    });
    req.on('error', (err) => {
      this.log.debug('Event server request error: %s', err.message);
    });
  }

  private dispatch(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'event': {
        const [callbackId, channelAddress, datapoint, value] = params as [string, string, string, unknown];
        const ev: ChannelEvent = {
          callbackId,
          channelAddress,
          datapoint,
          value,
          receivedAt: Date.now(),
        };
        this.emit('event', ev);
        return '';
      }
      case 'system.multicall': {
        const calls = (params[0] as Array<{ methodName: string; params: unknown[] }> | undefined) ?? [];
        const results: unknown[] = [];
        for (const call of calls) {
          if (call && typeof call.methodName === 'string') {
            try {
              results.push(this.dispatch(call.methodName, call.params ?? []));
            } catch (err) {
              this.log.debug('multicall sub-call failed: %s', (err as Error).message);
              results.push('');
            }
          } else {
            results.push('');
          }
        }
        return results;
      }
      case 'newDevices': {
        const [callbackId] = params as [string];
        this.emit('newDevices', callbackId);
        return '';
      }
      case 'listDevices': {
        return [];
      }
      case 'system.listMethods': {
        return ['event', 'system.multicall', 'newDevices', 'listDevices', 'system.listMethods'];
      }
      default:
        return '';
    }
  }
}
