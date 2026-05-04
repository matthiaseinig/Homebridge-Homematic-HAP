import { createConnection } from "node:net";
import { createRequire } from "node:module";
const PROBE_TIMEOUT_MS = 5e3;
const INTERFACE_PORTS = {
  "BidCos-RF": 2001,
  "HmIP-RF": 2010,
  "BidCos-Wired": 2e3,
  "VirtualDevices": 9292,
  "CUxD": 8701
};
class RpcError extends Error {
  constructor(message, cause) {
    super(message);
    this.cause = cause;
    this.name = "RpcError";
  }
  cause;
}
class RpcClient {
  interfaceId;
  host;
  port;
  callbackUrl;
  callbackId;
  log;
  transport;
  transportFactory;
  subscribed = false;
  constructor(opts) {
    this.interfaceId = opts.interfaceId;
    this.host = opts.host;
    this.port = opts.port ?? INTERFACE_PORTS[opts.interfaceId];
    this.callbackUrl = opts.callbackUrl;
    this.callbackId = opts.callbackId;
    this.log = opts.log;
    this.transportFactory = opts.transport;
  }
  async ensureTransport() {
    if (this.transport) {
      return this.transport;
    }
    if (this.transportFactory) {
      this.transport = this.transportFactory;
      return this.transport;
    }
    const mod = await import("homematic-xmlrpc");
    const createClient = mod.createClient ?? mod.default?.createClient;
    if (typeof createClient !== "function") {
      throw new RpcError("homematic-xmlrpc module did not expose createClient");
    }
    patchDeserializerForUnknownTags();
    const client = createClient({ host: this.host, port: this.port });
    this.transport = {
      call: (method, params) => new Promise((resolve, reject) => {
        client.methodCall(method, params, (err, value) => {
          if (err) {
            const e = err;
            const detail = e.faultString ? `${e.faultString}${e.faultCode !== void 0 ? ` (${e.faultCode})` : ""}` : e.message ?? "unknown error";
            reject(new RpcError(`${method} failed: ${detail}`, err));
          } else {
            resolve(value);
          }
        });
      }),
      close: async () => void 0
    };
    return this.transport;
  }
  /** Subscribe to events. Idempotent. */
  async subscribe() {
    if (!this.transportFactory) {
      await this.probeReachable();
    }
    const t = await this.ensureTransport();
    await t.call("init", [this.callbackUrl, this.callbackId]);
    this.subscribed = true;
    this.log.info("Subscribed (%s -> %s)", this.callbackId, this.callbackUrl);
  }
  async probeReachable() {
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve();
      };
      socket.setTimeout(PROBE_TIMEOUT_MS, () => {
        finish(new RpcError(`init failed: connect ETIMEDOUT ${this.host}:${this.port}`));
      });
      socket.once("connect", () => finish());
      socket.once("error", (err) => {
        const code = err.code ?? "unknown";
        finish(new RpcError(`init failed: connect ${code} ${this.host}:${this.port}`, err));
      });
    });
  }
  /** Unsubscribe — best-effort, swallows errors. */
  async unsubscribe() {
    if (!this.subscribed) {
      return;
    }
    try {
      const t = await this.ensureTransport();
      await t.call("init", [this.callbackUrl, ""]);
    } catch (err) {
      this.log.debug("unsubscribe error (ignored): %s", err.message);
    } finally {
      this.subscribed = false;
    }
  }
  async getValue(channel, datapoint) {
    const t = await this.ensureTransport();
    return t.call("getValue", [channel, datapoint]);
  }
  async setValue(channel, datapoint, value) {
    const t = await this.ensureTransport();
    await t.call("setValue", [channel, datapoint, value]);
  }
  async ping() {
    try {
      const t = await this.ensureTransport();
      await t.call("system.listMethods", []);
      return true;
    } catch (err) {
      this.log.debug("ping failed: %s", err.message);
      return false;
    }
  }
  async close() {
    if (this.transport) {
      await this.transport.close();
      this.transport = void 0;
    }
  }
  isSubscribed() {
    return this.subscribed;
  }
}
const KNOWN_XMLRPC_TAGS = /* @__PURE__ */ new Set([
  "BOOLEAN",
  "INT",
  "I4",
  "I8",
  "DOUBLE",
  "STRING",
  "NAME",
  "ARRAY",
  "STRUCT",
  "BASE64",
  "DATETIME.ISO8601",
  "VALUE",
  "PARAMS",
  "FAULT",
  "METHODRESPONSE",
  "METHODNAME",
  "METHODCALL",
  "NIL",
  "DATA",
  "PARAM",
  "MEMBER"
]);
let deserializerPatched = false;
function patchDeserializerForUnknownTags() {
  if (deserializerPatched) {
    return;
  }
  try {
    const requireFromHere = createRequire(import.meta.url);
    const Deserializer = requireFromHere("homematic-xmlrpc/lib/deserializer");
    if (Deserializer.prototype._patchedForUnknownTags) {
      deserializerPatched = true;
      return;
    }
    const original = Deserializer.prototype.onClosetag;
    Deserializer.prototype.onClosetag = function(el) {
      if (!KNOWN_XMLRPC_TAGS.has(el)) {
        return;
      }
      original.call(this, el);
    };
    Deserializer.prototype._patchedForUnknownTags = true;
    deserializerPatched = true;
  } catch {
  }
}
export {
  INTERFACE_PORTS,
  RpcClient,
  RpcError,
  patchDeserializerForUnknownTags
};
//# sourceMappingURL=RpcClient.js.map
