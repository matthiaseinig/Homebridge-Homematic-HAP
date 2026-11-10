/**
 * Multi-bridge host ("A1"): one platform block, one CCU connection and one
 * event subscription, publishing one HAP bridge per former hap-homematic
 * bridge, each with its original identity (username, pin, setupID,
 * AccessoryInfo and IdentifierCache in the persist directory).
 *
 * Publication rules, each guarding against HomeKit dropping accessories:
 *   - A disabled bridge is never built or published (its identity may still
 *     be live on the CCU; two hosts must never advertise one identity).
 *   - Nothing is published until the CCU answered (event subscription live,
 *     devices and variables listed). An unreachable bridge keeps its
 *     accessories in HomeKit; a bridge published with fewer accessories
 *     because of a transient CCU error would lose them.
 *   - A transplanted bridge is published only when its persist files are
 *     present and its pin/setupID match them (never a new identity under
 *     an old username).
 *   - Shutdown only unpublishes. `Accessory.destroy()` would delete the
 *     pairing keys from the persist directory.
 */
import { buildBridge } from './bridgeBuilder.js';
import { identityProblem } from './identityStore.js';
import { isTcpPortFree } from './portProbe.js';
/** The real thing. Never calls destroy(). */
export const hapPublisher = {
    publish: async (bridge, info) => {
        await bridge.publish(info, false);
    },
    unpublish: async (bridge) => {
        await bridge.unpublish();
    },
};
export class MultiBridgeHost {
    opts;
    publisher;
    portProbe;
    published = [];
    stopped = false;
    wake;
    constructor(opts) {
        this.opts = opts;
        this.publisher = opts.publisher ?? hapPublisher;
        this.portProbe = opts.portProbe ?? isTcpPortFree;
    }
    /** Names of the bridges currently published. */
    publishedBridges() {
        return this.published.map((b) => b.entry.name);
    }
    async start() {
        const { config, log } = this.opts;
        const enabled = config.bridges.filter((b) => b.enabled);
        const disabled = config.bridges.length - enabled.length;
        log.info('Multi-bridge mode: %d of %d bridges enabled (%d disabled, not published)', enabled.length, config.bridges.length, disabled);
        if (enabled.length === 0) {
            return;
        }
        const needsVariables = enabled.some((b) => b.variables.length > 0);
        const snapshot = await this.waitForCcu(needsVariables);
        if (!snapshot) {
            return;
        }
        for (const entry of enabled) {
            if (this.stopped) {
                return;
            }
            await this.publishOne(entry, snapshot);
        }
        log.info('Multi-bridge mode: %d bridge(s) published', this.published.length);
    }
    async stop() {
        this.stopped = true;
        this.wake?.();
        const bridges = this.published.splice(0);
        const timeout = this.opts.shutdownTimeoutMs ?? 4000;
        await Promise.allSettled(bridges.map((b) => withTimeout(this.publisher.unpublish(b.bridge), timeout)
            .catch((err) => this.opts.log.warn('Unpublish %s failed: %s', b.entry.name, err.message))));
        bridges.forEach((b) => this.disposeHandlers(b));
        try {
            await this.opts.ccu.stop();
        }
        catch (err) {
            this.opts.log.warn('CCU stop failed: %s', err.message);
        }
    }
    // --- internals -----------------------------------------------------
    async waitForCcu(needsVariables) {
        const { ccu, log, config } = this.opts;
        for (let attempt = 1; !this.stopped; attempt++) {
            try {
                await ccu.start();
                if (!ccu.isLive()) {
                    throw new Error('no event subscription to the CCU');
                }
                const devices = await ccu.listDevices();
                if (devices.length === 0) {
                    throw new Error('the CCU listed no devices');
                }
                const variables = needsVariables ? await ccu.listVariables() : [];
                log.success('Connected to CCU at attempt %d', attempt);
                return { devices, variables };
            }
            catch (err) {
                log.warn('CCU not ready (attempt %d): %s. No bridge is published until it is; retrying in %d s', attempt, err.message, config.retrySeconds);
                await ccu.stop().catch((e) => log.debug('CCU stop after failed start: %s', e.message));
                await this.sleep(config.retrySeconds * 1000);
            }
        }
        return undefined;
    }
    sleep(ms) {
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                this.wake = undefined;
                resolve();
            };
            const timer = setTimeout(done, ms);
            timer.unref?.();
            this.wake = done;
        });
    }
    async publishOne(entry, snapshot) {
        const { hap, ccu, log, version, identityStore, config } = this.opts;
        let built;
        try {
            built = buildBridge({ hap, ccu, log, version }, entry, snapshot);
        }
        catch (err) {
            log.error('Bridge %s not published: build failed: %s', entry.name, err.message);
            return;
        }
        const refuse = (reason) => {
            log.error('Bridge %s not published: %s', entry.name, reason);
            this.disposeHandlers(built);
        };
        if (built.accessories.length === 0) {
            refuse('no accessory could be built (HomeKit would drop all of its accessories)');
            return;
        }
        if (!entry.newIdentity) {
            const problem = identityProblem(identityStore.check(entry));
            if (problem) {
                refuse(`transplanted identity not usable: ${problem}`);
                return;
            }
        }
        if (!(await this.portProbe(entry.port))) {
            refuse(`port ${entry.port} is in use`);
            return;
        }
        if (this.stopped) {
            this.disposeHandlers(built);
            return;
        }
        const info = {
            username: entry.username,
            pincode: entry.pincode,
            port: entry.port,
            category: entry.category,
            advertiser: config.advertiser,
            addIdentifyingMaterial: false,
        };
        if (entry.setupID) {
            info.setupID = entry.setupID;
        }
        if (config.bind !== undefined) {
            info.bind = config.bind;
        }
        try {
            await this.publisher.publish(built.bridge, info);
        }
        catch (err) {
            refuse(`publish failed: ${err.message}`);
            await this.publisher.unpublish(built.bridge).catch(() => undefined);
            return;
        }
        if (this.stopped) {
            // Shutdown began while this bridge was being published.
            await this.publisher.unpublish(built.bridge).catch(() => undefined);
            this.disposeHandlers(built);
            return;
        }
        this.published.push(built);
        log.success('Published bridge %s on port %d with %d accessories%s', entry.name, entry.port, built.accessories.length, built.skipped.length ? ` (${built.skipped.length} mapping(s) skipped)` : '');
    }
    disposeHandlers(built) {
        for (const h of built.handlers) {
            try {
                h.dispose?.();
            }
            catch (err) {
                this.opts.log.debug('dispose error: %s', err.message);
            }
        }
    }
}
function withTimeout(p, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
        timer.unref?.();
        p.then((v) => {
            clearTimeout(timer);
            resolve(v);
        }, (e) => {
            clearTimeout(timer);
            reject(e);
        });
    });
}
//# sourceMappingURL=MultiBridgeHost.js.map