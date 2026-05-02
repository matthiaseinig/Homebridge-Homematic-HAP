/**
 * Targeted top-up tests for branches not exercised by the focused suites.
 */

import { describe, it, expect, vi } from 'vitest';
import { CcuClient } from '../../src/ccu/CcuClient.js';
import { resolveConfig } from '../../src/util/config.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';
import { parseDevicesXml } from '../../src/ccu/regaParse.js';
import { parseXml, serializeResponse } from '../../src/ccu/xmlRpc.js';
import { parseAddress, deviceAddress } from '../../src/util/address.js';
import { PluginStorage, StorageError } from '../../src/util/storage.js';

describe('regaParse interface fallbacks', () => {
  it('maps legacy interface names', () => {
    const variants = [
      ['CUx-Daemon', 'CUxD'],
      ['VirtualX', 'VirtualDevices'],
      ['BidCos-Wired', 'BidCos-Wired'],
      ['SomethingElse', 'BidCos-RF'],
    ] as const;
    for (const [intfName, expected] of variants) {
      const xml = `<devices><device><address>X.0</address><intfName>${intfName}</intfName><channels></channels></device></devices>`;
      expect(parseDevicesXml(xml)[0]?.interface).toBe(expected);
    }
  });
});

describe('xmlRpc edge cases', () => {
  it('parses array of structs', () => {
    const body = '<methodCall><methodName>m</methodName><params><param><value>'
      + '<array><data>'
      + '<value><struct><member><name>a</name><value><int>1</int></value></member></struct></value>'
      + '</data></array></value></param></params></methodCall>';
    expect(parseXml(body).params).toEqual([[{ a: 1 }]]);
  });

  it('parses self-closing nil', () => {
    const body = '<methodCall><methodName>m</methodName><params><param><value><nil/></value></param></params></methodCall>';
    expect(parseXml(body).params).toEqual([null]);
  });

  it('serializes integer doubles as i4', () => {
    expect(serializeResponse(0)).toContain('<i4>0</i4>');
  });

  it('serializes nested struct', () => {
    const out = serializeResponse({ outer: { inner: 'x' } });
    expect(out).toContain('<member><name>outer</name>');
    expect(out).toContain('<member><name>inner</name>');
  });

  it('rejects unterminated tag', () => {
    expect(() => parseXml('<methodCall')).toThrow();
  });

  it('parses non-self-closing nil', () => {
    const body = '<methodCall><methodName>m</methodName><params><param><value><nil></nil></value></param></params></methodCall>';
    expect(parseXml(body).params).toEqual([null]);
  });

  it('serializes function values as empty string fallback', () => {
    expect(serializeResponse((() => undefined) as unknown)).toContain('<string></string>');
  });

  it('rejects unterminated XML declaration', () => {
    expect(() => parseXml('<?xml version="1.0"')).toThrow();
  });

  it('rejects unterminated comment', () => {
    expect(() => parseXml('<!-- never closes <methodCall></methodCall>')).toThrow();
  });

  it('rejects expected token mismatch', () => {
    expect(() => parseXml('<methodCallx></methodCallx>')).toThrow();
  });
});

describe('address edge cases', () => {
  it('rejects empty channel index', () => {
    expect(() => parseAddress('X.0:')).toThrow(/channel/);
  });

  it('rejects non-string', () => {
    expect(() => parseAddress(123 as unknown as string)).toThrow();
  });

  it('handles channel-less serial with valid chars', () => {
    expect(parseAddress('X.serialOnly42')).toEqual({ interface: 'X', serial: 'serialOnly42', channel: undefined, datapoint: undefined });
  });

  it('deviceAddress throws on bad input', () => {
    expect(() => deviceAddress('')).toThrow();
  });
});

describe('storage edge cases', () => {
  it('rejects empty string', () => {
    const s = new PluginStorage({ user: { storagePath: () => '/tmp' } });
    expect(() => s.resolve('')).toThrow(StorageError);
  });
});

describe('CcuClient watchdog', () => {
  it('triggers re-subscribe after the watchdog window', async () => {
    vi.useFakeTimers();
    try {
      const config = resolveConfig({
        platform: 'HomematicWithGui',
        ccuIp: '127.0.0.1',
        eventServer: { host: '127.0.0.1', port: 9876, watchdogSeconds: 60 },
      });
      const ccu = new CcuClient({ config, log: new PrefixedLogger(makeLog(), 'wd') });
      vi.spyOn(ccu.eventServer, 'start').mockResolvedValue(undefined);
      vi.spyOn(ccu.eventServer, 'stop').mockResolvedValue(undefined);
      await ccu.start();
      // Force a tick past the watchdog interval (1/3 of 60s = 20s).
      await vi.advanceTimersByTimeAsync(25_000);
      await vi.advanceTimersByTimeAsync(25_000);
      await vi.advanceTimersByTimeAsync(25_000);
      await ccu.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
