// homebridge-ui/server.src.js
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// node_modules/@homebridge/plugin-ui-utils/dist/server.js
import process from "node:process";
var HomebridgePluginUiServer = class {
  handlers = {};
  constructor() {
    if (!process.send) {
      console.error("This script can only run as a child process.");
      process.exit(1);
    }
    process.addListener("message", (request) => {
      switch (request.action) {
        case "request": {
          this.processRequest(request);
        }
      }
    });
  }
  get homebridgeStoragePath() {
    return process.env.HOMEBRIDGE_STORAGE_PATH;
  }
  get homebridgeConfigPath() {
    return process.env.HOMEBRIDGE_CONFIG_PATH;
  }
  get homebridgeUiVersion() {
    return process.env.HOMEBRIDGE_UI_VERSION;
  }
  sendResponse(request, data, success = true) {
    if (!process.send) {
      return;
    }
    process.send({
      action: "response",
      payload: {
        requestId: request.requestId,
        success,
        data
      }
    });
  }
  async processRequest(request) {
    if (this.handlers[request.path]) {
      try {
        console.log("Incoming Request:", request.path);
        const resp = await this.handlers[request.path](request.body || {});
        return this.sendResponse(request, resp, true);
      } catch (e) {
        if (e instanceof RequestError) {
          return this.sendResponse(request, { message: e.message, error: e.requestError }, false);
        } else {
          console.error(e);
          return this.sendResponse(request, { message: e.message }, false);
        }
      }
    } else {
      console.error("No Registered Handler:", request.path);
      return this.sendResponse(request, { message: "Not Found", path: request.path }, false);
    }
  }
  /**
   * Let the server and UI know you are ready to receive requests.
   * This method must be called when you are ready to process requests!
   * @example
   * ```ts
   * this.ready();
   * ```
   */
  ready() {
    if (!process.send) {
      return;
    }
    process.send({
      action: "ready",
      payload: {
        server: true
      }
    });
  }
  /**
   * Register a new request handler for a given route.
   * @param path the request route name
   * @param fn the function to handle the request and provide a response
   *
   * @example
   * ```ts
   * this.onRequest('/hello', async (payload) => {
   *  return {hello: 'user'};
   * });
   * ```
   *
   * You can then make requests to this endpoint from the client / ui using `homebridge.request`:
   * @example
   * ```ts
   * homebridge.request('/hello', {some: 'payload data'});
   * ```
   *
   */
  onRequest(path, fn) {
    this.handlers[path] = fn;
  }
  /**
   * Push an event or stream data to the UI.
   * @param event the event name, the plugin UI can listen for this event
   * @param data the data to send
   *
   * @example
   * ```ts
   * this.pushEvent('my-event', {some: 'data'});
   * ```
   *
   * In the client / ui, you would then listen to this event using `homebridge.addEventListener`:
   *
   * @example
   * ```ts
   * homebridge.addEventListener('my-event', (event) => {
   *   // do something with the event
   * });
   * ```
   */
  pushEvent(event, data) {
    if (!process.send) {
      return;
    }
    process.send({
      action: "stream",
      payload: {
        event,
        data
      }
    });
  }
};
var RequestError = class _RequestError extends Error {
  requestError;
  constructor(message, requestError) {
    super(message);
    Object.setPrototypeOf(this, _RequestError.prototype);
    this.requestError = requestError;
  }
};
setInterval(() => {
  if (!process.connected) {
    process.kill(process.pid, "SIGTERM");
  }
}, 1e4);
process.on("disconnect", () => {
  process.kill(process.pid, "SIGTERM");
});

// homebridge-ui/server.src.js
import { CcuClient } from "../dist/src/ccu/CcuClient.js";
import { resolveConfig, ConfigError } from "../dist/src/util/config.js";
import { PrefixedLogger } from "../dist/src/util/logger.js";
import {
  importBackupTarball,
  importConfigJson,
  ImportError,
  mergeIntoConfig,
  splitReportIntoBridges
} from "../dist/src/import/HapHomematicImporter.js";
import {
  SERVICE_DEFINITIONS,
  VARIABLE_SERVICE_DEFINITIONS,
  servicesForChannelType
} from "../dist/src/services/registry.js";
{
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolvePath(here, "..", "package.json");
  let version = "unknown";
  try {
    if (existsSync(pkgPath)) {
      version = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "unknown";
    }
  } catch {
  }
  const distRoot = resolvePath(here, "..", "dist", "src");
  const distPresent = existsSync(distRoot);
  console.log(`[homebridge-homematic-hap UI] v${version} booting from ${here}; dist present: ${distPresent}`);
  if (!distPresent) {
    console.error(`[homebridge-homematic-hap UI] FATAL: ${distRoot} does not exist. The custom UI cannot start without the compiled dist/ folder. Re-install the plugin (npm install --install-links /path/to/clone) and restart Homebridge.`);
  }
}
var MAX_BASE64_BYTES = 96 * 1024 * 1024;
var UiLogger = class {
  info(...args) {
    console.log("[ui]", ...args);
  }
  success(...args) {
    console.log("[ui]", ...args);
  }
  warn(...args) {
    console.warn("[ui]", ...args);
  }
  error(...args) {
    console.error("[ui]", ...args);
  }
  debug() {
  }
  log(_level, ...args) {
    console.log("[ui]", ...args);
  }
  prefix = "ui";
};
var HomematicHapUiServer = class extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest("/services", () => this.handleServices());
    this.onRequest("/test-connection", (payload) => this.handleTestConnection(payload));
    this.onRequest("/discover", (payload) => this.handleDiscover(payload));
    this.onRequest("/import-backup", (payload) => this.handleImportBackup(payload));
    this.onRequest("/import-config-json", (payload) => this.handleImportConfigJson(payload));
    this.onRequest("/split-into-bridges", (payload) => this.handleSplitIntoBridges(payload));
    this.ready();
    console.log("[homebridge-homematic-hap UI] handlers registered, ready signaled");
  }
  // --- handlers ----------------------------------------------------
  handleServices() {
    return {
      channelServices: SERVICE_DEFINITIONS.map((s) => ({
        key: s.key,
        description: s.description,
        channelTypes: s.channelTypes,
        priority: s.priority,
        variants: s.variants ?? []
      })),
      variableServices: VARIABLE_SERVICE_DEFINITIONS.map((s) => ({
        key: s.key,
        description: s.description,
        forValueType: s.forValueType
      }))
    };
  }
  async handleTestConnection(payload) {
    const config = this.coerceConfig(payload);
    const log = new PrefixedLogger(new UiLogger(), "ui:test");
    const ccu = new CcuClient({ config, log });
    try {
      const intfs = await ccu.api.call("Interface.listInterfaces");
      return {
        ok: true,
        message: `CCU reachable (${Array.isArray(intfs) ? intfs.length : "?"} interfaces)`
      };
    } catch (err) {
      throw new RequestError(`CCU unreachable: ${err.message}`, { status: 502 });
    } finally {
      try {
        await ccu.stop();
      } catch {
      }
    }
  }
  async handleDiscover(payload) {
    const config = this.coerceConfig(payload);
    const log = new PrefixedLogger(new UiLogger(), "ui:discover");
    const ccu = new CcuClient({ config, log });
    try {
      const [devices, variables, programs, rooms] = await Promise.all([
        ccu.listDevices(),
        ccu.listVariables(),
        ccu.listPrograms(),
        ccu.listRooms()
      ]);
      const enrichedDevices = devices.map((d) => ({
        ...d,
        channels: d.channels.map((c) => ({
          ...c,
          suggestedServices: servicesForChannelType(c.type).map((s) => s.key)
        }))
      }));
      return { devices: enrichedDevices, variables, programs, rooms };
    } catch (err) {
      throw new RequestError(`Discovery failed: ${err.message}`, { status: 502 });
    } finally {
      try {
        await ccu.stop();
      } catch {
      }
    }
  }
  async handleImportBackup(payload) {
    if (!payload || typeof payload !== "object") {
      throw new RequestError("Empty payload", { status: 400 });
    }
    const { tarballBase64 } = payload;
    if (typeof tarballBase64 !== "string" || tarballBase64.length === 0) {
      throw new RequestError("Missing tarballBase64", { status: 400 });
    }
    if (tarballBase64.length > MAX_BASE64_BYTES) {
      throw new RequestError("Backup too large", { status: 413 });
    }
    let buf;
    try {
      buf = Buffer.from(tarballBase64, "base64");
    } catch (err) {
      throw new RequestError(`Invalid base64: ${err.message}`, { status: 400 });
    }
    try {
      const report = await importBackupTarball(buf);
      return report;
    } catch (err) {
      if (err instanceof ImportError) {
        throw new RequestError(err.message, { status: 400 });
      }
      throw new RequestError(`Import failed: ${err.message}`, { status: 500 });
    }
  }
  handleSplitIntoBridges(payload) {
    if (!payload || typeof payload !== "object" || !payload.report) {
      throw new RequestError("Missing report", { status: 400 });
    }
    try {
      return splitReportIntoBridges(payload.report);
    } catch (err) {
      throw new RequestError(`Split failed: ${err.message}`, { status: 500 });
    }
  }
  handleImportConfigJson(payload) {
    if (!payload || typeof payload !== "object") {
      throw new RequestError("Empty payload", { status: 400 });
    }
    const { configJson } = payload;
    if (typeof configJson !== "string" || configJson.length === 0) {
      throw new RequestError("Missing configJson", { status: 400 });
    }
    if (configJson.length > 16 * 1024 * 1024) {
      throw new RequestError("configJson too large", { status: 413 });
    }
    try {
      return importConfigJson(configJson);
    } catch (err) {
      if (err instanceof ImportError) {
        throw new RequestError(err.message, { status: 400 });
      }
      throw new RequestError(`Import failed: ${err.message}`, { status: 500 });
    }
  }
  // --- helpers -----------------------------------------------------
  coerceConfig(payload) {
    if (!payload || typeof payload !== "object") {
      throw new RequestError("Missing config payload", { status: 400 });
    }
    try {
      return resolveConfig({
        platform: "HomematicHap",
        name: typeof payload.name === "string" ? payload.name : "HomematicHap",
        ccuIp: payload.ccuIp,
        useTls: payload.useTls,
        interfaces: payload.interfaces,
        interfacePorts: payload.interfacePorts,
        ccuAuth: payload.ccuAuth,
        eventServer: payload.eventServer
      });
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new RequestError(err.message, { status: 400 });
      }
      throw err;
    }
  }
};
var server_src_default = new HomematicHapUiServer();
export {
  HomematicHapUiServer,
  server_src_default as default,
  mergeIntoConfig
};
