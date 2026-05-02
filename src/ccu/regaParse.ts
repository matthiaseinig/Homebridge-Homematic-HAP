/**
 * Tiny tag/CDATA-free XML extractor for the well-formed output our
 * own ReGa scripts produce. We never feed external XML through here.
 *
 * This avoids pulling in a full XML parser (and its attendant XXE
 * surface) for what is in practice a dozen tag names of our own choosing.
 */

import type { CcuChannel, CcuDevice, CcuInterfaceId, CcuProgram, CcuVariable } from '../types.js';

const TAG_RE = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');

function extractAll(source: string, tag: string): string[] {
  const out: string[] = [];
  const re = TAG_RE(tag);
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push(m[1] ?? '');
  }
  return out;
}

function extractOne(source: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = re.exec(source);
  return m?.[1];
}

function decode(value: string | undefined): string {
  if (value === undefined) {
    return '';
  }
  // ReGa's UriEncode() produces application/x-www-form-urlencoded.
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function asInterfaceId(name: string): CcuInterfaceId {
  switch (name) {
    case 'BidCos-RF':
    case 'HmIP-RF':
    case 'BidCos-Wired':
    case 'VirtualDevices':
    case 'CUxD':
      return name;
    default:
      // Map unknown names to closest interface; HmIP-RF is the safer default
      // for newer devices, but BidCos-RF kept the legacy semantics.
      if (name.toUpperCase().includes('HMIP')) {
        return 'HmIP-RF';
      }
      if (name.toUpperCase().includes('CUX')) {
        return 'CUxD';
      }
      if (name.toUpperCase().includes('VIRT')) {
        return 'VirtualDevices';
      }
      if (name.toUpperCase().includes('WIRED')) {
        return 'BidCos-Wired';
      }
      return 'BidCos-RF';
  }
}

export function parseDevicesXml(xml: string): CcuDevice[] {
  return extractAll(xml, 'device').map((deviceXml) => {
    const channels: CcuChannel[] = extractAll(deviceXml, 'channel').map((channelXml) => ({
      address: decode(extractOne(channelXml, 'address')),
      index: toInt(extractOne(channelXml, 'index')) ?? 0,
      type: decode(extractOne(channelXml, 'type')),
      name: decode(extractOne(channelXml, 'name')),
    }));
    return {
      address: decode(extractOne(deviceXml, 'address')),
      type: decode(extractOne(deviceXml, 'type')),
      name: decode(extractOne(deviceXml, 'name')),
      interface: asInterfaceId(decode(extractOne(deviceXml, 'intfName'))),
      channels,
    };
  });
}

export function parseVariablesXml(xml: string): CcuVariable[] {
  return extractAll(xml, 'variable').map((vXml) => {
    const valuetype = toInt(extractOne(vXml, 'valuetype')) ?? 0;
    const valueRaw = decode(extractOne(vXml, 'value'));
    let value: boolean | number | string;
    if (valuetype === 2) {
      value = valueRaw === 'true' || valueRaw === '1';
    } else if (valuetype === 4) {
      const n = parseFloat(valueRaw);
      value = Number.isFinite(n) ? n : 0;
    } else {
      value = valueRaw;
    }
    return {
      id: decode(extractOne(vXml, 'id')),
      name: decode(extractOne(vXml, 'name')),
      valuetype,
      subtype: toInt(extractOne(vXml, 'subtype')) ?? 0,
      minValue: parseFloat(decode(extractOne(vXml, 'min'))) || undefined,
      maxValue: parseFloat(decode(extractOne(vXml, 'max'))) || undefined,
      unit: decode(extractOne(vXml, 'unit')) || undefined,
      value,
    };
  });
}

export function parseProgramsXml(xml: string): CcuProgram[] {
  return extractAll(xml, 'program').map((pXml) => ({
    id: decode(extractOne(pXml, 'id')),
    name: decode(extractOne(pXml, 'name')),
  }));
}
