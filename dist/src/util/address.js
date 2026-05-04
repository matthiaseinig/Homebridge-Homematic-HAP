const INTERFACE_RE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const SERIAL_RE = /^[A-Za-z0-9]{1,32}$/;
const DATAPOINT_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
function parseAddress(address) {
  if (typeof address !== "string" || address.length === 0 || address.length > 200) {
    throw new TypeError("Invalid CCU address");
  }
  let intf;
  let rest = address;
  const dotIdx = rest.indexOf(".");
  if (dotIdx !== -1) {
    intf = rest.slice(0, dotIdx);
    rest = rest.slice(dotIdx + 1);
    if (!INTERFACE_RE.test(intf)) {
      throw new TypeError(`Invalid interface in address: ${address}`);
    }
  }
  let datapoint;
  const dpIdx = rest.indexOf(".");
  if (dpIdx !== -1) {
    datapoint = rest.slice(dpIdx + 1);
    rest = rest.slice(0, dpIdx);
    if (!DATAPOINT_RE.test(datapoint)) {
      throw new TypeError(`Invalid datapoint in address: ${address}`);
    }
  }
  let serial;
  let channel;
  const colonIdx = rest.indexOf(":");
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
  if (serial !== void 0 && serial !== "" && !SERIAL_RE.test(serial)) {
    throw new TypeError(`Invalid serial in address: ${address}`);
  }
  if (serial === "") {
    serial = void 0;
  }
  return { interface: intf, serial, channel, datapoint };
}
function buildAddress(parts) {
  if (!parts.interface || !parts.serial) {
    throw new TypeError("buildAddress requires at least interface and serial");
  }
  let out = `${parts.interface}.${parts.serial}`;
  if (parts.channel !== void 0) {
    out += `:${parts.channel}`;
  }
  if (parts.datapoint !== void 0) {
    if (parts.channel === void 0) {
      throw new TypeError("Cannot build datapoint address without channel");
    }
    out += `.${parts.datapoint}`;
  }
  return out;
}
function deviceAddress(channelAddress) {
  const p = parseAddress(channelAddress);
  if (!p.interface || !p.serial) {
    throw new TypeError(`Cannot derive device from address: ${channelAddress}`);
  }
  return `${p.interface}.${p.serial}`;
}
export {
  buildAddress,
  deviceAddress,
  parseAddress
};
//# sourceMappingURL=address.js.map
