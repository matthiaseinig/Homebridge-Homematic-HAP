/**
 * Resolves and validates the raw plugin config from Homebridge into the
 * strongly-typed ResolvedConfig the rest of the code depends on. Bad
 * input produces a thrown ConfigError with a human-readable explanation;
 * the platform turns that into a single user-visible log line and
 * refuses to start (per the verified-plugin rule "must not start unless
 * configured").
 */
import { resolveMultiBridgeConfig } from '../multiBridge/config.js';
export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}
const DEFAULT_INTERFACES = {
    bidcosRf: true,
    hmIpRf: true,
    bidcosWired: false,
    virtualDevices: true,
    cuxd: false,
};
const DEFAULT_EVENT_SERVER = {
    host: '0.0.0.0',
    port: 9875,
    watchdogSeconds: 300,
};
const HOSTNAME_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;
export function isValidHost(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
        return false;
    }
    return HOSTNAME_RE.test(value) || IPV4_RE.test(value) || IPV6_RE.test(value);
}
export function resolveConfig(raw) {
    if (!raw || typeof raw !== 'object') {
        throw new ConfigError('Plugin config is empty or invalid');
    }
    const ccuIp = raw.ccuIp;
    if (!isValidHost(ccuIp)) {
        throw new ConfigError('ccuIp is required and must be a valid hostname or IP address');
    }
    const interfaces = {
        ...DEFAULT_INTERFACES,
        ...(raw.interfaces ?? {}),
    };
    const useTls = Boolean(raw.useTls ?? false);
    const ccuAuth = {
        enabled: Boolean(raw.ccuAuth?.enabled ?? false),
        username: typeof raw.ccuAuth?.username === 'string' ? raw.ccuAuth.username : undefined,
        password: typeof raw.ccuAuth?.password === 'string' ? raw.ccuAuth.password : undefined,
    };
    if (ccuAuth.enabled && (!ccuAuth.username || !ccuAuth.password)) {
        throw new ConfigError('ccuAuth.enabled is true but username/password are missing');
    }
    const evHost = raw.eventServer?.host ?? DEFAULT_EVENT_SERVER.host;
    if (typeof evHost !== 'string' || evHost.length === 0) {
        throw new ConfigError('eventServer.host must be a non-empty string');
    }
    const evPort = Number(raw.eventServer?.port ?? DEFAULT_EVENT_SERVER.port);
    if (!Number.isInteger(evPort) || evPort < 1024 || evPort > 65535) {
        throw new ConfigError('eventServer.port must be an integer in [1024, 65535]');
    }
    const evWatchdog = Number(raw.eventServer?.watchdogSeconds ?? DEFAULT_EVENT_SERVER.watchdogSeconds);
    if (!Number.isInteger(evWatchdog) || evWatchdog < 30 || evWatchdog > 3600) {
        throw new ConfigError('eventServer.watchdogSeconds must be an integer in [30, 3600]');
    }
    const channels = Array.isArray(raw.channels) ? raw.channels.filter(Boolean) : [];
    const variables = Array.isArray(raw.variables) ? raw.variables.filter(Boolean) : [];
    const programs = Array.isArray(raw.programs) ? raw.programs.filter(Boolean) : [];
    const validInterfaceIds = new Set([
        'BidCos-RF', 'HmIP-RF', 'BidCos-Wired', 'VirtualDevices', 'CUxD',
    ]);
    const interfacePorts = {};
    if (raw.interfacePorts && typeof raw.interfacePorts === 'object') {
        for (const [k, v] of Object.entries(raw.interfacePorts)) {
            if (!validInterfaceIds.has(k)) {
                throw new ConfigError(`interfacePorts: unknown interface "${k}"`);
            }
            const port = Number(v);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                throw new ConfigError(`interfacePorts.${k} must be an integer in [1, 65535]`);
            }
            interfacePorts[k] = port;
        }
    }
    const base = {
        name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : 'HomematicHap',
        ccuIp,
        interfaces,
        interfacePorts,
        useTls,
        ccuAuth,
        eventServer: { host: evHost, port: evPort, watchdogSeconds: evWatchdog },
        channels,
        variables,
        programs,
        hapHomematicIdentity: raw.hapHomematicIdentity === true,
    };
    if (raw.multiBridge === undefined) {
        return base;
    }
    return withMultiBridge(base, raw);
}
/**
 * Multi-bridge mode: the block's own mapping lists must be empty (every
 * mapping belongs to one of the bridges); the resolved lists become the
 * union of the enabled bridges' mappings, which is what the CCU client
 * needs to decide which interfaces to subscribe.
 */
function withMultiBridge(base, raw) {
    if (base.channels.length + base.variables.length + base.programs.length > 0) {
        throw new ConfigError('multiBridge: put channels, variables and programs into the bridges, not into the block');
    }
    const hostBridge = raw._bridge;
    const multiBridge = resolveMultiBridgeConfig(raw.multiBridge, {
        eventServerPort: base.eventServer.port,
        host: {
            username: typeof hostBridge?.username === 'string' ? hostBridge.username : undefined,
            port: typeof hostBridge?.port === 'number' ? hostBridge.port : undefined,
        },
    });
    const enabled = multiBridge.bridges.filter((b) => b.enabled);
    return {
        ...base,
        channels: enabled.flatMap((b) => b.channels),
        variables: enabled.flatMap((b) => b.variables),
        programs: enabled.flatMap((b) => b.programs),
        hapHomematicIdentity: true,
        multiBridge,
    };
}
//# sourceMappingURL=config.js.map