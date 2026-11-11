/**
 * Wraps homematic-xmlrpc into a Promise-based, per-interface client. We
 * keep one RpcClient per CCU interface (BidCos-RF, HmIP-RF, …) — each one
 * connects to a different CCU port and registers a callback URL so the
 * EventServer receives push events.
 */
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
/** Default timeout for the pre-init TCP reachability probe. */
const PROBE_TIMEOUT_MS = 5_000;
export const INTERFACE_PORTS = {
    'BidCos-RF': 2001,
    'HmIP-RF': 2010,
    'BidCos-Wired': 2000,
    'VirtualDevices': 9292,
    'CUxD': 8701,
};
export class RpcError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'RpcError';
    }
}
export class RpcClient {
    interfaceId;
    host;
    port;
    callbackUrl;
    callbackId;
    log;
    transport;
    transportFactory;
    skipProbe;
    subscribed = false;
    constructor(opts) {
        this.interfaceId = opts.interfaceId;
        this.host = opts.host;
        this.port = opts.port ?? INTERFACE_PORTS[opts.interfaceId];
        this.callbackUrl = opts.callbackUrl;
        this.callbackId = opts.callbackId;
        this.log = opts.log;
        this.transportFactory = opts.transport;
        this.skipProbe = opts.skipProbe ?? false;
    }
    async ensureTransport() {
        if (this.transport) {
            return this.transport;
        }
        if (this.transportFactory) {
            this.transport = this.transportFactory;
            return this.transport;
        }
        const mod = (await import('homematic-xmlrpc'));
        const createClient = mod.createClient ?? mod.default?.createClient;
        if (typeof createClient !== 'function') {
            throw new RpcError('homematic-xmlrpc module did not expose createClient');
        }
        // RaspberryMatic responses occasionally wrap data in non-spec
        // elements like <META>...</META>. The bundled deserializer rejects
        // any unknown tag with `Unknown XML-RPC tag '...'`, breaking init.
        // Patch its onClosetag once to silently swallow unknown wrapping
        // tags so legitimate non-spec metadata doesn't poison the response.
        patchDeserializerForUnknownTags();
        const client = createClient({ host: this.host, port: this.port });
        this.transport = {
            call: (method, params) => new Promise((resolve, reject) => {
                client.methodCall(method, params, (err, value) => {
                    if (err) {
                        const e = err;
                        const detail = e.faultString
                            ? `${e.faultString}${e.faultCode !== undefined ? ` (${e.faultCode})` : ''}`
                            : e.message ?? 'unknown error';
                        reject(new RpcError(`${method} failed: ${detail}`, err));
                    }
                    else {
                        resolve(value);
                    }
                });
            }),
            close: async () => undefined,
        };
        return this.transport;
    }
    /** Subscribe to events. Idempotent. */
    async subscribe() {
        // Probe TCP reachability with a short timeout BEFORE the XML-RPC init,
        // because the homematic-xmlrpc client uses the kernel default connect
        // timeout (~2 min on Linux). A locked-down CCU firewall would otherwise
        // hang the platform start for two minutes per interface.
        // The probe is skipped when a transport was injected for tests, or
        // when the caller explicitly opted out (skipProbe=true) — used by
        // unit tests that mock homematic-xmlrpc via vi.mock.
        if (!this.transportFactory && !this.skipProbe) {
            await this.probeReachable();
        }
        const t = await this.ensureTransport();
        await t.call('init', [this.callbackUrl, this.callbackId]);
        this.subscribed = true;
        this.log.info('Subscribed (%s -> %s)', this.callbackId, this.callbackUrl);
    }
    async probeReachable() {
        await new Promise((resolve, reject) => {
            const socket = createConnection({ host: this.host, port: this.port });
            let settled = false;
            const finish = (err) => {
                if (settled)
                    return;
                settled = true;
                socket.destroy();
                if (err)
                    reject(err);
                else
                    resolve();
            };
            socket.setTimeout(PROBE_TIMEOUT_MS, () => {
                finish(new RpcError(`init failed: connect ETIMEDOUT ${this.host}:${this.port}`));
            });
            socket.once('connect', () => finish());
            socket.once('error', (err) => {
                const code = err.code ?? 'unknown';
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
            // CCU convention: empty interfaceId removes the subscription.
            await t.call('init', [this.callbackUrl, '']);
        }
        catch (err) {
            this.log.debug('unsubscribe error (ignored): %s', err.message);
        }
        finally {
            this.subscribed = false;
        }
    }
    async getValue(channel, datapoint) {
        const t = await this.ensureTransport();
        return t.call('getValue', [channel, datapoint]);
    }
    async setValue(channel, datapoint, value) {
        const t = await this.ensureTransport();
        await t.call('setValue', [channel, datapoint, value]);
    }
    async ping() {
        try {
            const t = await this.ensureTransport();
            // listMethods is a cheap no-op for liveness probing.
            await t.call('system.listMethods', []);
            return true;
        }
        catch (err) {
            this.log.debug('ping failed: %s', err.message);
            return false;
        }
    }
    async close() {
        if (this.transport) {
            await this.transport.close();
            this.transport = undefined;
        }
    }
    isSubscribed() {
        return this.subscribed;
    }
}
const KNOWN_XMLRPC_TAGS = new Set([
    'BOOLEAN', 'INT', 'I4', 'I8', 'DOUBLE', 'STRING', 'NAME',
    'ARRAY', 'STRUCT', 'BASE64', 'DATETIME.ISO8601',
    'VALUE', 'PARAMS', 'FAULT', 'METHODRESPONSE', 'METHODNAME',
    'METHODCALL', 'NIL', 'DATA', 'PARAM', 'MEMBER',
]);
let deserializerPatched = false;
/**
 * Monkey-patch homematic-xmlrpc's Deserializer to ignore non-spec wrapping
 * elements such as `<META>`. The default behaviour is to error out with
 * `Unknown XML-RPC tag 'META'`, which RaspberryMatic's HmIP server can
 * trigger on `init`. Idempotent — safe to call multiple times.
 *
 * Exported only for tests.
 */
export function patchDeserializerForUnknownTags() {
    if (deserializerPatched) {
        return;
    }
    try {
        const requireFromHere = createRequire(import.meta.url);
        const Deserializer = requireFromHere('homematic-xmlrpc/lib/deserializer');
        if (Deserializer.prototype._patchedForUnknownTags) {
            deserializerPatched = true;
            return;
        }
        const original = Deserializer.prototype.onClosetag;
        Deserializer.prototype.onClosetag = function (el) {
            if (!KNOWN_XMLRPC_TAGS.has(el)) {
                return;
            }
            original.call(this, el);
        };
        Deserializer.prototype._patchedForUnknownTags = true;
        deserializerPatched = true;
    }
    catch {
        // If the module path changed, fall through silently. The original
        // error will surface on the next init() and we'll know to revisit.
    }
}
//# sourceMappingURL=RpcClient.js.map