import { Buffer } from "node:buffer";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
const API_PORT_HTTP = 80;
const API_PORT_HTTPS = 443;
const DEFAULT_TIMEOUT_MS = 3e4;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SAFE_NAME_RE = /^[A-Za-z0-9_\-. äöüÄÖÜß]{1,200}$/;
class JsonRpcError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "JsonRpcError";
  }
  code;
  cause;
}
class CcuJsonRpcClient {
  host;
  useTls;
  portOverride;
  timeoutMs;
  auth;
  log;
  sessionId;
  constructor(opts) {
    this.host = opts.host;
    this.useTls = Boolean(opts.useTls);
    this.portOverride = opts.port;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.auth = opts.auth;
    this.log = opts.log;
  }
  /** Drop the cached session id; the next authenticated call will re-login. */
  invalidateSession() {
    this.sessionId = void 0;
  }
  /**
   * Invoke a JSON-RPC method, automatically attaching `_session_id_` if
   * authentication is configured. Renews the session once on a 401-style
   * "session expired" response and retries the call.
   */
  async call(method, params = {}) {
    return this.callOnce(method, params, false);
  }
  async callOnce(method, params, retried) {
    const sid = await this.ensureSession();
    const body = Buffer.from(JSON.stringify({
      version: "1.1",
      method,
      params: sid ? { ...params, _session_id_: sid } : params
    }), "utf8");
    const raw = await this.postJson(body);
    const text = raw.toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new JsonRpcError(`malformed JSON-RPC response from ${method}`);
    }
    if (parsed.error) {
      const code = parsed.error.code;
      const message = parsed.error.message ?? "unknown error";
      const looksLikeSessionExpiry = code === 401 || code === 403 || /session/i.test(message);
      if (looksLikeSessionExpiry && this.auth && !retried) {
        this.log.debug("JSON-RPC session expired, re-logging in");
        this.invalidateSession();
        return this.callOnce(method, params, true);
      }
      throw new JsonRpcError(`${method}: ${message}`, code);
    }
    return parsed.result;
  }
  // --- session ------------------------------------------------------
  async ensureSession() {
    if (!this.auth) {
      return void 0;
    }
    if (this.sessionId) {
      return this.sessionId;
    }
    const body = Buffer.from(JSON.stringify({
      version: "1.1",
      method: "Session.login",
      params: { username: this.auth.username, password: this.auth.password }
    }), "utf8");
    const raw = await this.postJson(body);
    const text = raw.toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new JsonRpcError("CCU auth: malformed JSON response");
    }
    if (parsed.error) {
      throw new JsonRpcError(`CCU auth failed: ${parsed.error.message ?? "unknown"}`, parsed.error.code);
    }
    if (typeof parsed.result !== "string" || parsed.result.length === 0) {
      throw new JsonRpcError("CCU auth: empty session id");
    }
    this.sessionId = parsed.result.replace(/^@+|@+$/g, "");
    this.log.debug("Acquired CCU session (length=%d)", this.sessionId.length);
    return this.sessionId;
  }
  // --- high-level helpers -------------------------------------------
  /**
   * One-shot CCU device tree: every device with its channels embedded.
   * Maps RaspberryMatic's `Device.listAllDetail` into our internal shape.
   */
  async listDevices() {
    const result = await this.call("Device.listAllDetail");
    return result.map((d) => ({
      address: d.address ?? "",
      name: d.name ?? "",
      type: d.type ?? "",
      interface: asInterfaceId(d.interface ?? ""),
      channels: (d.channels ?? []).map((c) => ({
        address: c.address ?? "",
        name: c.name ?? "",
        index: typeof c.index === "number" ? c.index : parseInt(String(c.index ?? 0), 10) || 0,
        type: c.channelType ?? ""
      }))
    }));
  }
  async listVariables() {
    const raw = await this.call("SysVar.getAll");
    return raw.map((v) => {
      const valuetype = mapVariableValueType(v.type);
      const numericValue = typeof v.value === "number" ? v.value : Number.parseFloat(String(v.value ?? ""));
      let value;
      if (valuetype === 2) {
        value = String(v.value).toLowerCase() === "true" || v.value === true || v.value === 1 || v.value === "1";
      } else if (valuetype === 4) {
        value = Number.isFinite(numericValue) ? numericValue : 0;
      } else {
        value = String(v.value ?? "");
      }
      return {
        id: v.id ?? "",
        name: v.name ?? "",
        valuetype,
        subtype: typeof v.subtype === "number" ? v.subtype : Number.parseInt(String(v.subtype ?? 0), 10) || 0,
        minValue: numberOrUndef(v.minValue),
        maxValue: numberOrUndef(v.maxValue),
        unit: v.unit || void 0,
        enumValues: v.valueList,
        value
      };
    });
  }
  async listPrograms() {
    const raw = await this.call("Program.getAll");
    return raw.map((p) => ({ id: p.id ?? "", name: p.name ?? "" }));
  }
  async listRooms() {
    const raw = await this.call("Room.getAll");
    return raw.map((r) => ({
      id: String(r.id ?? ""),
      name: r.name ?? "",
      channelIds: (r.channelIds ?? []).map((c) => String(c))
    }));
  }
  async getInterfaceValue(interfaceName, address, valueKey) {
    return this.call("Interface.getValue", { interface: interfaceName, address, valueKey });
  }
  async setInterfaceValue(interfaceName, address, valueKey, type, value) {
    await this.call("Interface.setValue", { interface: interfaceName, address, valueKey, type, value });
  }
  async getVariable(name) {
    if (!isSafeIdentifier(name)) {
      throw new JsonRpcError(`unsafe variable name: ${name}`);
    }
    const raw = await this.call("SysVar.getValueByName", { name });
    return String(raw);
  }
  async setVariable(name, value) {
    if (!isSafeIdentifier(name)) {
      throw new JsonRpcError(`unsafe variable name: ${name}`);
    }
    const all = await this.call("SysVar.getAll");
    const found = all.find((v) => v.name === name);
    if (!found?.id) {
      throw new JsonRpcError(`SysVar not found: ${name}`);
    }
    const t = (found.type ?? "").toUpperCase();
    if (t === "BOOL") {
      await this.call("SysVar.setBool", { id: found.id, value: Boolean(value) });
    } else if (t === "FLOAT") {
      const n = typeof value === "number" ? value : Number.parseFloat(String(value));
      if (!Number.isFinite(n)) {
        throw new JsonRpcError("Cannot store non-finite number in SysVar");
      }
      await this.call("SysVar.setFloat", { id: found.id, value: n });
    } else if (t === "ENUM") {
      await this.call("SysVar.setEnum", { id: found.id, value });
    } else {
      await this.call("SysVar.setFloat", { id: found.id, value });
    }
  }
  async runProgram(name) {
    if (!isSafeIdentifier(name)) {
      throw new JsonRpcError(`unsafe program name: ${name}`);
    }
    const all = await this.call("Program.getAll");
    const found = all.find((p) => p.name === name);
    if (!found?.id) {
      throw new JsonRpcError(`Program not found: ${name}`);
    }
    await this.call("Program.execute", { id: found.id });
  }
  // --- HTTP plumbing ------------------------------------------------
  postJson(body) {
    const port = this.portOverride ?? (this.useTls ? API_PORT_HTTPS : API_PORT_HTTP);
    const reqFn = this.useTls ? httpsRequest : httpRequest;
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": String(body.length)
    };
    const opts = {
      host: this.host,
      port,
      method: "POST",
      path: "/api/homematic.cgi",
      headers,
      timeout: this.timeoutMs
    };
    if (this.useTls) {
      opts.rejectUnauthorized = false;
    }
    return new Promise((resolve, reject) => {
      const req = reqFn(opts, (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new JsonRpcError(`HTTP ${res.statusCode ?? "unknown"}`));
          return;
        }
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            res.destroy(new JsonRpcError("JSON-RPC response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", (err) => reject(new JsonRpcError("JSON-RPC response error", void 0, err)));
      });
      req.on("timeout", () => {
        req.destroy(new JsonRpcError(`JSON-RPC timeout after ${this.timeoutMs} ms`));
      });
      req.on("error", (err) => reject(new JsonRpcError("JSON-RPC request failed", void 0, err)));
      req.write(body);
      req.end();
    });
  }
}
function isSafeIdentifier(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (!SAFE_NAME_RE.test(value)) {
    return false;
  }
  return !/["\\\r\n;]/.test(value);
}
function numberOrUndef(v) {
  if (v === void 0 || v === null || v === "") {
    return void 0;
  }
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : void 0;
}
function mapVariableValueType(type) {
  switch ((type ?? "").toUpperCase()) {
    case "BOOL":
      return 2;
    case "FLOAT":
      return 4;
    case "STRING":
      return 16;
    case "ENUM":
      return 20;
    default:
      return 0;
  }
}
function asInterfaceId(name) {
  if (name === "BidCos-RF" || name === "HmIP-RF" || name === "BidCos-Wired" || name === "VirtualDevices" || name === "CUxD") {
    return name;
  }
  if (/hmip/i.test(name)) {
    return "HmIP-RF";
  }
  if (/cux/i.test(name)) {
    return "CUxD";
  }
  if (/virt/i.test(name)) {
    return "VirtualDevices";
  }
  if (/wired/i.test(name)) {
    return "BidCos-Wired";
  }
  return "BidCos-RF";
}
export {
  CcuJsonRpcClient,
  JsonRpcError,
  isSafeIdentifier
};
//# sourceMappingURL=CcuJsonRpcClient.js.map
