class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}
const DEFAULT_INTERFACES = {
  bidcosRf: true,
  hmIpRf: true,
  bidcosWired: false,
  virtualDevices: true,
  cuxd: false
};
const DEFAULT_EVENT_SERVER = {
  host: "0.0.0.0",
  port: 9875,
  watchdogSeconds: 300
};
const HOSTNAME_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;
function isValidHost(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) {
    return false;
  }
  return HOSTNAME_RE.test(value) || IPV4_RE.test(value) || IPV6_RE.test(value);
}
function resolveConfig(raw) {
  if (!raw || typeof raw !== "object") {
    throw new ConfigError("Plugin config is empty or invalid");
  }
  const ccuIp = raw.ccuIp;
  if (!isValidHost(ccuIp)) {
    throw new ConfigError("ccuIp is required and must be a valid hostname or IP address");
  }
  const interfaces = {
    ...DEFAULT_INTERFACES,
    ...raw.interfaces ?? {}
  };
  const useTls = Boolean(raw.useTls ?? false);
  const ccuAuth = {
    enabled: Boolean(raw.ccuAuth?.enabled ?? false),
    username: typeof raw.ccuAuth?.username === "string" ? raw.ccuAuth.username : void 0,
    password: typeof raw.ccuAuth?.password === "string" ? raw.ccuAuth.password : void 0
  };
  if (ccuAuth.enabled && (!ccuAuth.username || !ccuAuth.password)) {
    throw new ConfigError("ccuAuth.enabled is true but username/password are missing");
  }
  const evHost = raw.eventServer?.host ?? DEFAULT_EVENT_SERVER.host;
  if (typeof evHost !== "string" || evHost.length === 0) {
    throw new ConfigError("eventServer.host must be a non-empty string");
  }
  const evPort = Number(raw.eventServer?.port ?? DEFAULT_EVENT_SERVER.port);
  if (!Number.isInteger(evPort) || evPort < 1024 || evPort > 65535) {
    throw new ConfigError("eventServer.port must be an integer in [1024, 65535]");
  }
  const evWatchdog = Number(raw.eventServer?.watchdogSeconds ?? DEFAULT_EVENT_SERVER.watchdogSeconds);
  if (!Number.isInteger(evWatchdog) || evWatchdog < 30 || evWatchdog > 3600) {
    throw new ConfigError("eventServer.watchdogSeconds must be an integer in [30, 3600]");
  }
  const channels = Array.isArray(raw.channels) ? raw.channels.filter(Boolean) : [];
  const variables = Array.isArray(raw.variables) ? raw.variables.filter(Boolean) : [];
  const programs = Array.isArray(raw.programs) ? raw.programs.filter(Boolean) : [];
  return {
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : "HomematicHap",
    ccuIp,
    interfaces,
    useTls,
    ccuAuth,
    eventServer: { host: evHost, port: evPort, watchdogSeconds: evWatchdog },
    channels,
    variables,
    programs
  };
}
export {
  ConfigError,
  isValidHost,
  resolveConfig
};
//# sourceMappingURL=config.js.map
