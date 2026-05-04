import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import { parseXml, serializeFault, serializeResponse } from "./xmlRpc.js";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
class EventServer extends EventEmitter {
  host;
  port;
  log;
  server;
  constructor(opts) {
    super();
    this.host = opts.host;
    this.port = opts.port;
    this.log = opts.log;
  }
  on(event, listener) {
    return super.on(event, listener);
  }
  emit(event, ...args) {
    return super.emit(event, ...args);
  }
  async start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      server.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });
      server.listen(this.port, this.host, () => {
        this.server = server;
        this.log.info("Event server listening on %s:%d", this.host, this.port);
        this.emit("listening", { host: this.host, port: this.port });
        resolve();
      });
    });
  }
  async stop() {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = void 0;
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }
  handleRequest(req, res) {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        const parsed = parseXml(body);
        const result = this.dispatch(parsed.method, parsed.params);
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end(serializeResponse(result));
      } catch (err) {
        this.log.error("Event server handler error: %s", err.message);
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end(serializeFault(-1, err.message));
      }
    });
    req.on("error", (err) => {
      this.log.debug("Event server request error: %s", err.message);
    });
  }
  dispatch(method, params) {
    switch (method) {
      case "event": {
        const [callbackId, channelAddress, datapoint, value] = params;
        const ev = {
          callbackId,
          channelAddress,
          datapoint,
          value,
          receivedAt: Date.now()
        };
        this.emit("event", ev);
        return "";
      }
      case "system.multicall": {
        const calls = params[0] ?? [];
        const results = [];
        for (const call of calls) {
          if (call && typeof call.methodName === "string") {
            try {
              results.push(this.dispatch(call.methodName, call.params ?? []));
            } catch (err) {
              this.log.debug("multicall sub-call failed: %s", err.message);
              results.push("");
            }
          } else {
            results.push("");
          }
        }
        return results;
      }
      case "newDevices": {
        const [callbackId] = params;
        this.emit("newDevices", callbackId);
        return "";
      }
      case "listDevices": {
        return [];
      }
      case "system.listMethods": {
        return ["event", "system.multicall", "newDevices", "listDevices", "system.listMethods"];
      }
      default:
        return "";
    }
  }
}
export {
  EventServer
};
//# sourceMappingURL=EventServer.js.map
