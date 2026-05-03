/**
 * Covers start/stop/list-* and watchdog branches of CcuClient by stubbing
 * the JSON-RPC client and the event server so we never open sockets.
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
  it('listDevices delegates to the JSON-RPC client', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listDevices').mockResolvedValue([
      { address: 'HmIP.000123', name: 'X', type: 'T', interface: 'HmIP-RF', channels: [] },
    ]);
    const devices = await ccu.listDevices();
    expect(devices).toHaveLength(1);
  });

  it('listVariables delegates to the JSON-RPC client', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listVariables').mockResolvedValue([
      { id: '1', name: 'V', valuetype: 2, subtype: 0, value: true },
    ]);
    expect((await ccu.listVariables())).toHaveLength(1);
  });

  it('listPrograms delegates to the JSON-RPC client', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listPrograms').mockResolvedValue([{ id: '1', name: 'P' }]);
    expect((await ccu.listPrograms())).toHaveLength(1);
  });

  it('listRooms delegates to the JSON-RPC client', async () => {
    const ccu = makeCcu();
    vi.spyOn(ccu.api, 'listRooms').mockResolvedValue([
      { id: '1', name: 'Living', channelIds: ['10', '11'] },
    ]);
    const rooms = await ccu.listRooms();
    expect(rooms[0]?.name).toBe('Living');
    expect(rooms[0]?.channelIds).toEqual(['10', '11']);
  });
});

describe('CcuClient start/stop with no enabled interfaces', () => {
  it('start() succeeds without RPC subscriptions and stop() cleans up', async () => {
    const ccu = makeCcu();
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

describe('CcuClient setValue/getValue fallback to JSON-RPC', () => {
  it('falls back to api.setInterfaceValue when no XML-RPC client is subscribed', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'setInterfaceValue').mockResolvedValue(undefined);
    await ccu.setValue('HmIP-RF.000123:1', 'STATE', true);
    expect(spy).toHaveBeenCalledWith('HmIP-RF', '000123:1', 'STATE', 'boolean', true);
  });

  it('falls back to api.getInterfaceValue when no XML-RPC client is subscribed', async () => {
    const ccu = makeCcu();
    const spy = vi.spyOn(ccu.api, 'getInterfaceValue').mockResolvedValue('22.4');
    const v = await ccu.getValue('HmIP-RF.000123:1', 'ACTUAL_TEMPERATURE');
    expect(v).toBe('22.4');
    expect(spy).toHaveBeenCalledWith('HmIP-RF', '000123:1', 'ACTUAL_TEMPERATURE');
  });
});
