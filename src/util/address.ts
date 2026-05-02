/**
 * Helpers for parsing CCU device/channel/datapoint addresses.
 *
 *   <interface>.<serial>:<channel>.<datapoint>
 *
 * All four parts are optional past the interface, so a parsed address
 * may have undefined fields; helpers that need a specific shape assert
 * on it themselves.
 */

export interface ParsedAddress {
  interface?: string;
  serial?: string;
  channel?: number;
  datapoint?: string;
}

const INTERFACE_RE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const SERIAL_RE = /^[A-Za-z0-9]{1,32}$/;
const DATAPOINT_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function parseAddress(address: string): ParsedAddress {
  if (typeof address !== 'string' || address.length === 0 || address.length > 200) {
    throw new TypeError('Invalid CCU address');
  }

  let intf: string | undefined;
  let rest = address;
  const dotIdx = rest.indexOf('.');
  if (dotIdx !== -1) {
    intf = rest.slice(0, dotIdx);
    rest = rest.slice(dotIdx + 1);
    if (!INTERFACE_RE.test(intf)) {
      throw new TypeError(`Invalid interface in address: ${address}`);
    }
  }

  let datapoint: string | undefined;
  const dpIdx = rest.indexOf('.');
  if (dpIdx !== -1) {
    datapoint = rest.slice(dpIdx + 1);
    rest = rest.slice(0, dpIdx);
    if (!DATAPOINT_RE.test(datapoint)) {
      throw new TypeError(`Invalid datapoint in address: ${address}`);
    }
  }

  let serial: string | undefined;
  let channel: number | undefined;
  const colonIdx = rest.indexOf(':');
  if (colonIdx !== -1) {
    serial = rest.slice(0, colonIdx);
    const channelStr = rest.slice(colonIdx + 1);
    if (channelStr.length === 0 || !/^[0-9]{1,3}$/.test(channelStr)) {
      throw new TypeError(`Invalid channel index in address: ${address}`);
    }
    channel = parseInt(channelStr, 10);
  } else {
    serial = rest;
  }

  if (serial !== undefined && serial !== '' && !SERIAL_RE.test(serial)) {
    throw new TypeError(`Invalid serial in address: ${address}`);
  }
  if (serial === '') {
    serial = undefined;
  }

  return { interface: intf, serial, channel, datapoint };
}

export function buildAddress(parts: ParsedAddress): string {
  if (!parts.interface || !parts.serial) {
    throw new TypeError('buildAddress requires at least interface and serial');
  }
  let out = `${parts.interface}.${parts.serial}`;
  if (parts.channel !== undefined) {
    out += `:${parts.channel}`;
  }
  if (parts.datapoint !== undefined) {
    if (parts.channel === undefined) {
      throw new TypeError('Cannot build datapoint address without channel');
    }
    out += `.${parts.datapoint}`;
  }
  return out;
}

export function deviceAddress(channelAddress: string): string {
  const p = parseAddress(channelAddress);
  if (!p.interface || !p.serial) {
    throw new TypeError(`Cannot derive device from address: ${channelAddress}`);
  }
  return `${p.interface}.${p.serial}`;
}
