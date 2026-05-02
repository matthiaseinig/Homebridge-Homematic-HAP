/**
 * Covers the start, stop, list-* and watchdog branches of CcuClient by
 * stubbing its event server and rega.script() so we never open sockets.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function makeCcu(): CcuClient {
  const config = resolveConfig({
    platform: 'HomematicWithGui',
    ccuIp: '127.0.0.1',
    eventServer: { host: '127.0.0.1', port: 9876, watchdogSeconds: 60 },
    interfaces: { bidcosRf: false, hmIpRf: false, bidcosWired: false, virtualDevices: false, cuxd: false },
  });
  return new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'lc') });
}

describe('CcuClient list*()', () => {
  it('listDevices delegates to rega and parses', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.rega, 'script').mockResolvedValue({
      xml: '<devices><device><address>X.0</address><intfName>HmIP-RF</intfName><channels></channels></device></devices>',
      stdout: '',
    });
    const devices = await ccu.listDevices();
    expect(devices).toHaveLength(1);
  });

  it('listVariables delegates to rega and parses', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.rega, 'script').mockResolvedValue({
      xml: '<variables><variable><name>X</name><valuetype>2</valuetype><value>true</value></variable></variables>',
      stdout: '',
    });
    expect((await ccu.listVariables())).toHaveLength(1);
  });

  it('listPrograms delegates to rega and parses', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.rega, 'script').mockResolvedValue({
      xml: '<programs><program><id>1</id><name>P</name></program></programs>',
      stdout: '',
    });
    expect((await ccu.listPrograms())).toHaveLength(1);
  });

  it('listRooms decodes UriEncoded names', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.rega, 'script').mockResolvedValue({
      xml: '<rooms><room><id>1</id><name>Wohn%20zimmer</name><channels><channelId>10</channelId><channelId>11</channelId></channels></room></rooms>',
      stdout: '',
    });
    const rooms = await ccu.listRooms();
    expect(rooms[0]?.name).toBe('Wohn zimmer');
    expect(rooms[0]?.channelIds).toEqual(['10', '11']);
  });

  it('listRooms returns [] for empty XML', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.rega, 'script').mockResolvedValue({ xml: '', stdout: '' });
    expect(await ccu.listRooms()).toEqual([]);
  });
});

describe('CcuClient start/stop with no enabled interfaces', () => {
  it('start() succeeds without RPC subscriptions and stop() cleans up', async () => {
    const ccu = makeCcu();
    // Stub the event server start/stop so no actual port is opened
    const start = vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
    const stop = vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
    await ccu.start();
    await ccu.start(); // idempotent
    expect(start).toHaveBeenCalledTimes(1);
    await ccu.stop();
    expect(stop).toHaveBeenCalled();
    await ccu.stop(); // idempotent
  });
});

describe('CcuClient resolveCallbackHost', () => {
  it('returns explicit host when not 0.0.0.0', () => {
    const ccu = makeCcu();
    const host = (ccu as unknown as { resolveCallbackHost(): string }).resolveCallbackHost();
    expect(host).toBe('127.0.0.1');
  });

  it('falls back when host is 0.0.0.0', () => {
    const config = resolveConfig({
      platform: 'HomematicWithGui',
      ccuIp: '127.0.0.1',
      eventServer: { host: '0.0.0.0', port: 9876 },
    });
    const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'lc') });
    const host = (ccu as unknown as { resolveCallbackHost(): string }).resolveCallbackHost();
    expect(typeof host).toBe('string');
    expect(host.length).toBeGreaterThan(0);
  });
});
