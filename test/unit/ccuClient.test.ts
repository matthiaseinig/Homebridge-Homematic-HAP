import { describe, it, expect, vi } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';
import { resolveConfig } from '../../src/util/config.js';
import type { ChannelEvent } from '../../src/ccu/EventServer.js';

function makeCcu(): CcuClient {
  const config = resolveConfig({ platform: 'HomematicWithGui', ccuIp: '127.0.0.1' });
  return new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'ccu-test') });
}

describe('CcuClient registerListener / event dispatch', () => {
  it('routes events to all matching listeners', () => {
    const ccu = makeCcu();
    const a = vi.fn();
    const b = vi.fn();
    ccu.registerListener('HmIP.0:1.STATE', a);
    ccu.registerListener('HmIP.0:1.STATE', b);
    const ev: ChannelEvent = {
      callbackId: 'cb',
      channelAddress: 'HmIP.0:1',
      datapoint: 'STATE',
      value: true,
      receivedAt: Date.now(),
    };
    (ccu as unknown as { handleEvent(ev: ChannelEvent): void }).handleEvent(ev);
    expect(a).toHaveBeenCalledWith(true);
    expect(b).toHaveBeenCalledWith(true);
  });

  it('off() removes the listener', () => {
    const ccu = makeCcu();
    const a = vi.fn();
    const off = ccu.registerListener('HmIP.0:1.STATE', a);
    off();
    (ccu as unknown as { handleEvent(ev: ChannelEvent): void }).handleEvent({
      callbackId: 'c', channelAddress: 'HmIP.0:1', datapoint: 'STATE', value: 1, receivedAt: 0,
    });
    expect(a).not.toHaveBeenCalled();
  });

  it('catches listener exceptions without breaking', () => {
    const ccu = makeCcu();
    const a = vi.fn(() => { throw new Error('nope'); });
    const b = vi.fn();
    ccu.registerListener('HmIP.0:1.STATE', a);
    ccu.registerListener('HmIP.0:1.STATE', b);
    expect(() => (ccu as unknown as { handleEvent(ev: ChannelEvent): void }).handleEvent({
      callbackId: 'c', channelAddress: 'HmIP.0:1', datapoint: 'STATE', value: 1, receivedAt: 0,
    })).not.toThrow();
    expect(b).toHaveBeenCalled();
  });

  it('drops unrouted events silently', () => {
    const ccu = makeCcu();
    expect(() => (ccu as unknown as { handleEvent(ev: ChannelEvent): void }).handleEvent({
      callbackId: 'c', channelAddress: 'HmIP.X:9', datapoint: 'STATE', value: 1, receivedAt: 0,
    })).not.toThrow();
  });

  it('routes setValue/getValue to interface based on prefix', () => {
    const ccu = makeCcu();
    const intfFor = (ccu as unknown as { interfaceForAddress(a: string): string }).interfaceForAddress.bind(ccu);
    expect(intfFor('BidCos-RF.0:1')).toBe('BidCos-RF');
    expect(intfFor('HmIP-RF.0:1')).toBe('HmIP-RF');
    expect(intfFor('HmIP.0:1')).toBe('HmIP-RF');
    expect(intfFor('CUX.0:1')).toBe('CUxD');
    expect(intfFor('BidCos-Wired.0:1')).toBe('BidCos-Wired');
    expect(intfFor('VirtualDevices.0:1')).toBe('VirtualDevices');
    expect(intfFor('weird.0:1')).toBe('BidCos-RF');
  });

  it('throws when calling setValue without RPC clients', async () => {
    const ccu = makeCcu();
    await expect(ccu.setValue('HmIP.0:1', 'STATE', true)).rejects.toThrow(/No RPC client/);
    await expect(ccu.getValue('HmIP.0:1', 'STATE')).rejects.toThrow(/No RPC client/);
  });

  it('isLive returns false with no subscribed clients', () => {
    const ccu = makeCcu();
    expect(ccu.isLive()).toBe(false);
  });
});
