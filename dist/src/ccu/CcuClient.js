import { networkInterfaces } from "node:os";
import { EventEmitter } from "node:events";
import { EventServer } from "./EventServer.js";
import { CcuJsonRpcClient } from "./CcuJsonRpcClient.js";
import { RpcClient, INTERFACE_PORTS } from "./RpcClient.js";
import { PLUGIN_NAME } from "../settings.js";
const ENABLED_INTERFACES = [
  { id: "BidCos-RF", flag: "bidcosRf" },
  { id: "HmIP-RF", flag: "hmIpRf" },
  { id: "BidCos-Wired", flag: "bidcosWired" },
  { id: "VirtualDevices", flag: "virtualDevices" },
  { id: "CUxD", flag: "cuxd" }
];
class CcuClient extends EventEmitter {
  /** Modern JSON-RPC control plane. */
  api;
  eventServer;
  rpcClients = /* @__PURE__ */ new Map();
  datapointListeners = /* @__PURE__ */ new Map();
  config;
  log;
  watchdogTimer;
  lastEventAt = 0;
  started = false;
  /** XML-RPC port discovered per interface from `Interface.listInterfaces`. */
  discoveredPorts = /* @__PURE__ */ new Map();
  /** address → interface map built from `Device.listAllDetail` at startup. */
  addressInterface = /* @__PURE__ */ new Map();
  constructor(opts) {
    super();
    this.config = opts.config;
    this.log = opts.log;
    this.api = new CcuJsonRpcClient({
      host: this.config.ccuIp,
      useTls: this.config.useTls,
      auth: this.config.ccuAuth.enabled ? { username: this.config.ccuAuth.username, password: this.config.ccuAuth.password } : void 0,
      log: this.log.child("api")
    });
    this.eventServer = new EventServer({
      host: this.config.eventServer.host,
      port: this.config.eventServer.port,
      log: this.log.child("events")
    });
    this.eventServer.on("event", (ev) => this.handleEvent(ev));
    this.eventServer.on("error", (err) => {
      this.log.error("Event server error: %s", err.message);
    });
  }
  async start() {
    if (this.started) {
      return;
    }
    await this.eventServer.start();
    await this.refreshInterfacePorts();
    await this.refreshAddressInterfaceMap();
    const callbackHost = this.resolveCallbackHost();
    const callbackUrl = `http://${callbackHost}:${this.config.eventServer.port}`;
    for (const { id, flag } of ENABLED_INTERFACES) {
      if (!this.config.interfaces[flag]) {
        continue;
      }
      const callbackId = `${PLUGIN_NAME}:${id}`;
      const client = new RpcClient({
        interfaceId: id,
        host: this.config.ccuIp,
        port: this.discoveredPorts.get(id) ?? INTERFACE_PORTS[id],
        callbackUrl,
        callbackId,
        log: this.log.child(`rpc:${id}`)
      });
      try {
        await client.subscribe();
        this.rpcClients.set(id, client);
      } catch (err) {
        this.log.warn("Could not subscribe to %s: %s", id, err.message);
      }
    }
    this.lastEventAt = Date.now();
    this.startWatchdog();
    this.started = true;
  }
  async refreshInterfacePorts() {
    try {
      const list = await this.api.listInterfaces();
      for (const i of list) {
        const id = mapInterfaceName(i.name);
        if (id) {
          this.discoveredPorts.set(id, i.port);
          this.log.debug("Interface %s on port %d", id, i.port);
        }
      }
    } catch (err) {
      this.log.warn(
        "Interface.listInterfaces failed (%s) \u2014 using default ports",
        err.message
      );
    }
  }
  async refreshAddressInterfaceMap() {
    try {
      const devices = await this.api.listDevices();
      const remember = (addr, intf) => {
        if (!addr) return;
        this.addressInterface.set(addr, intf);
        const dot = addr.indexOf(".");
        if (dot !== -1) {
          this.addressInterface.set(addr.slice(dot + 1), intf);
        } else {
          this.addressInterface.set(`${intf}.${addr}`, intf);
        }
      };
      for (const d of devices) {
        if (!d.interface) continue;
        remember(d.address, d.interface);
        for (const c of d.channels) {
          remember(c.address, d.interface);
        }
      }
      this.log.debug("Indexed %d addresses across interfaces", this.addressInterface.size);
    } catch (err) {
      this.log.debug(
        "listDevices for address-interface map failed: %s",
        err.message
      );
    }
  }
  async stop() {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = void 0;
    }
    for (const client of this.rpcClients.values()) {
      await client.unsubscribe();
      await client.close();
    }
    this.rpcClients.clear();
    await this.eventServer.stop();
    this.api.invalidateSession();
  }
  /** All devices and their channels (one JSON-RPC call). */
  listDevices() {
    return this.api.listDevices();
  }
  listVariables() {
    return this.api.listVariables();
  }
  listPrograms() {
    return this.api.listPrograms();
  }
  listRooms() {
    return this.api.listRooms();
  }
  /** Subscribe a callback to a `<interface>.<serial>:<chan>.<datapoint>` address. */
  registerListener(address, listener) {
    let set = this.datapointListeners.get(address);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.datapointListeners.set(address, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.datapointListeners.delete(address);
      }
    };
  }
  /** Returns true if any RPC interface is currently subscribed. */
  isLive() {
    for (const c of this.rpcClients.values()) {
      if (c.isSubscribed()) {
        return true;
      }
    }
    return false;
  }
  /**
   * Set a CCU datapoint via XML-RPC (the event-plane interface client).
   * setValue HAS to go through XML-RPC because that's the path the CCU
   * also pushes events back from — round-trip latency is best there.
   * Falls back to JSON-RPC `Interface.setValue` if no XML-RPC client is
   * subscribed for that interface.
   */
  async setValue(address, datapoint, value) {
    const intf = this.interfaceForAddress(address);
    const client = this.rpcClients.get(intf);
    if (client) {
      await client.setValue(address, datapoint, value);
      return;
    }
    const bareAddress = stripInterfacePrefix(address);
    const type = guessJsonRpcType(value);
    await this.api.setInterfaceValue(intf, bareAddress, datapoint, type, value);
  }
  /**
   * Read a CCU datapoint. Prefers the XML-RPC interface client (single
   * round-trip, no auth overhead) and falls back to JSON-RPC.
   */
  async getValue(address, datapoint) {
    const intf = this.interfaceForAddress(address);
    const client = this.rpcClients.get(intf);
    if (client) {
      return client.getValue(address, datapoint);
    }
    return this.api.getInterfaceValue(intf, stripInterfacePrefix(address), datapoint);
  }
  // --- internals -----------------------------------------------------
  handleEvent(ev) {
    this.lastEventAt = ev.receivedAt;
    const fullAddress = `${ev.channelAddress}.${ev.datapoint}`;
    const set = this.datapointListeners.get(fullAddress);
    if (!set) {
      this.log.debug("Unrouted event %s = %s", fullAddress, String(ev.value));
      return;
    }
    for (const listener of set) {
      try {
        listener(ev.value);
      } catch (err) {
        this.log.error("Listener for %s threw: %s", fullAddress, err.message);
      }
    }
  }
  interfaceForAddress(address) {
    const direct = this.addressInterface.get(address);
    if (direct) {
      return direct;
    }
    const colon = address.indexOf(":");
    if (colon !== -1) {
      const deviceOnly = this.addressInterface.get(address.slice(0, colon));
      if (deviceOnly) return deviceOnly;
    }
    const dot = address.indexOf(".");
    const prefix = dot === -1 ? address : address.slice(0, dot);
    if (prefix === "BidCos-RF" || prefix === "HmIP-RF" || prefix === "BidCos-Wired" || prefix === "VirtualDevices" || prefix === "CUxD") {
      return prefix;
    }
    if (prefix.startsWith("HmIP") || prefix.startsWith("hmip")) {
      return "HmIP-RF";
    }
    if (prefix.startsWith("CUX")) {
      return "CUxD";
    }
    if (prefix.startsWith("BidCos-Wired")) {
      return "BidCos-Wired";
    }
    return "BidCos-RF";
  }
  startWatchdog() {
    const intervalMs = Math.max(3e4, Math.floor(this.config.eventServer.watchdogSeconds * 1e3 / 3));
    this.watchdogTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastEventAt;
      if (elapsed > this.config.eventServer.watchdogSeconds * 1e3) {
        this.log.warn("No events for %d ms, re-subscribing to all interfaces", elapsed);
        for (const client of this.rpcClients.values()) {
          client.subscribe().catch(
            (err) => this.log.warn("Re-subscribe failed for %s: %s", client.interfaceId, err.message)
          );
        }
        this.lastEventAt = Date.now();
      }
    }, intervalMs);
    if (this.watchdogTimer.unref) {
      this.watchdogTimer.unref();
    }
  }
  resolveCallbackHost() {
    if (this.config.eventServer.host !== "0.0.0.0" && this.config.eventServer.host !== "::") {
      return this.config.eventServer.host;
    }
    const ifs = networkInterfaces();
    for (const list of Object.values(ifs)) {
      for (const i of list ?? []) {
        if (i.family === "IPv4" && !i.internal) {
          return i.address;
        }
      }
    }
    return "127.0.0.1";
  }
}
function stripInterfacePrefix(address) {
  const dot = address.indexOf(".");
  return dot === -1 ? address : address.slice(dot + 1);
}
function mapInterfaceName(name) {
  const n = name.trim();
  if (n === "BidCos-RF" || n === "BidCos-Wired" || n === "HmIP-RF" || n === "VirtualDevices" || n === "CUxD") {
    return n;
  }
  const lower = n.toLowerCase();
  if (lower === "bidcos-rf" || lower === "rf") return "BidCos-RF";
  if (lower === "bidcos-wired" || lower === "wired") return "BidCos-Wired";
  if (lower === "hmip-rf" || lower === "hmip" || lower === "hmiprf") return "HmIP-RF";
  if (lower === "virtualdevices" || lower === "virtual") return "VirtualDevices";
  if (lower === "cuxd") return "CUxD";
  return void 0;
}
function guessJsonRpcType(value) {
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "double";
  }
  return "string";
}
export {
  CcuClient
};
//# sourceMappingURL=CcuClient.js.map
