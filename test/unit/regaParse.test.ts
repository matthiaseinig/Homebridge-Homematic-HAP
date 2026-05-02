import { describe, it, expect } from 'vitest';
import { parseDevicesXml, parseProgramsXml, parseVariablesXml } from '../../src/ccu/regaParse.js';

describe('parseDevicesXml', () => {
  it('parses a single device with two channels', () => {
    const xml = `
      <devices>
        <device>
          <id>1</id>
          <address>HmIP.000123</address>
          <name>Living%20Lamp</name>
          <type>HmIP-PSM</type>
          <intf>2010</intf>
          <intfName>HmIP-RF</intfName>
          <channels>
            <channel>
              <id>10</id>
              <address>HmIP.000123:0</address>
              <name>Maintenance</name>
              <type>MAINTENANCE</type>
              <index>0</index>
            </channel>
            <channel>
              <id>11</id>
              <address>HmIP.000123:1</address>
              <name>Switch</name>
              <type>SWITCH_VIRTUAL_RECEIVER</type>
              <index>1</index>
            </channel>
          </channels>
        </device>
      </devices>
    `;
    const devices = parseDevicesXml(xml);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.address).toBe('HmIP.000123');
    expect(devices[0]?.name).toBe('Living Lamp');
    expect(devices[0]?.interface).toBe('HmIP-RF');
    expect(devices[0]?.channels).toHaveLength(2);
    expect(devices[0]?.channels[1]?.type).toBe('SWITCH_VIRTUAL_RECEIVER');
    expect(devices[0]?.channels[1]?.index).toBe(1);
  });

  it('returns [] on empty input', () => {
    expect(parseDevicesXml('')).toEqual([]);
  });

  it('falls back through interface heuristics', () => {
    const xml = '<devices><device><address>X.0</address><intfName>UnknownHmIPThing</intfName><channels></channels></device></devices>';
    expect(parseDevicesXml(xml)[0]?.interface).toBe('HmIP-RF');
  });

  it('handles malformed unicode encodings gracefully', () => {
    const xml = '<devices><device><address>X.0</address><name>%E0</name><intfName>BidCos-RF</intfName><channels></channels></device></devices>';
    // %E0 is not a valid utf-8 sequence; decodeURIComponent throws and we fall back to raw.
    expect(parseDevicesXml(xml)[0]?.name).toBe('%E0');
  });
});

describe('parseVariablesXml', () => {
  it('parses bool, number and string variables', () => {
    const xml = `<variables>
      <variable><id>1</id><name>Bool</name><info>x</info><valuetype>2</valuetype><subtype>2</subtype><min>0</min><max>1</max><unit></unit><value>true</value></variable>
      <variable><id>2</id><name>Num</name><info>x</info><valuetype>4</valuetype><subtype>0</subtype><min>0</min><max>100</max><unit>%25</unit><value>42.5</value></variable>
      <variable><id>3</id><name>Str</name><info>x</info><valuetype>16</valuetype><subtype>0</subtype><min></min><max></max><unit></unit><value>hello</value></variable>
    </variables>`;
    const vars = parseVariablesXml(xml);
    expect(vars).toHaveLength(3);
    expect(vars[0]?.value).toBe(true);
    expect(vars[1]?.value).toBe(42.5);
    expect(vars[1]?.unit).toBe('%');
    expect(vars[2]?.value).toBe('hello');
  });

  it('handles invalid numbers as 0', () => {
    const xml = '<variables><variable><name>X</name><valuetype>4</valuetype><value>NaN</value></variable></variables>';
    expect(parseVariablesXml(xml)[0]?.value).toBe(0);
  });
});

describe('parseProgramsXml', () => {
  it('parses programs', () => {
    const xml = '<programs><program><id>1</id><name>Wake%20up</name></program></programs>';
    expect(parseProgramsXml(xml)).toEqual([{ id: '1', name: 'Wake up' }]);
  });
});
