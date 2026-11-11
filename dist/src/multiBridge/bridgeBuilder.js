/**
 * Builds one HAP-NodeJS Bridge for a multi-bridge entry: the bridge
 * accessory with the hap-homematic bridge UUID, and one bridged accessory
 * per mapping, built by the same service handlers as platform accessories.
 * Building has no network side effects; publishing is the host's job.
 * The offline IID check (scripts/iid-check.mjs) uses this directly.
 */
import { findProgramServiceByKey, findServiceByKey, findVariableServiceByKey, pickVariableService, PROGRAM_SERVICE_DEFINITIONS } from '../services/registry.js';
import { PLUGIN_NAME } from '../settings.js';
import { channelDisplayName, findChannel, programDisplayName, variableDisplayName } from '../util/mappings.js';
import { BridgedAccessoryHandle } from './BridgedAccessoryHandle.js';
/** hap-homematic created its bridges as `new Bridge(name, <instance id>)`. */
export function bridgeUuidFor(hap, entry) {
    return entry.bridgeUuid ?? hap.uuid.generate(`${PLUGIN_NAME}:bridge:${entry.username}`);
}
export function buildBridge(deps, entry, snapshot) {
    const { hap } = deps;
    const bridge = new hap.Bridge(entry.name, bridgeUuidFor(hap, entry));
    // Keep ids of characteristics that are not there at publish time. HAP-NodeJS
    // otherwise expires them on every id assignment, so a characteristic added
    // after the first CCU read (thermostat humidity) or one that comes back
    // later would get a new IID, and HomeKit automations using it break.
    bridge.disableUnusedIDPurge();
    const info = bridge.getService(hap.Service.AccessoryInformation);
    info?.setCharacteristic(hap.Characteristic.Manufacturer, PLUGIN_NAME)
        .setCharacteristic(hap.Characteristic.Model, 'HAPHomematic')
        .setCharacteristic(hap.Characteristic.SerialNumber, entry.name)
        .setCharacteristic(hap.Characteristic.FirmwareRevision, deps.version);
    const log = deps.log.child(entry.name);
    bridge.on('characteristic-warning', ((warning) => {
        const quiet = warning.type === 'slow-read' || warning.type === 'slow-write' || warning.type === 'debug-message';
        (quiet ? log.debug : log.warn).call(log, 'HAP %s: %s', warning.type ?? 'warning', warning.message ?? '');
    }));
    const built = { entry, bridge, accessories: [], skipped: [], handlers: [] };
    const builder = new AccessoryFactory(deps, entry, snapshot, built, log);
    entry.channels.forEach((m) => builder.tryAdd('channel', m.address, () => builder.channel(m)));
    entry.variables.forEach((m) => builder.tryAdd('variable', m.name, () => builder.variable(m)));
    entry.programs.forEach((m) => builder.tryAdd('program', m.name, () => builder.program(m)));
    return built;
}
/** Run `step`; on failure release the handler's CCU listeners before rethrowing. */
function attachOrDispose(handler, step) {
    try {
        step(handler);
    }
    catch (err) {
        handler.dispose?.();
        throw err;
    }
    return handler;
}
class AccessoryFactory {
    deps;
    entry;
    snapshot;
    built;
    log;
    uuids = new Set();
    constructor(deps, entry, snapshot, built, log) {
        this.deps = deps;
        this.entry = entry;
        this.snapshot = snapshot;
        this.built = built;
        this.log = log;
    }
    tryAdd(kind, id, prepare) {
        try {
            this.add(kind, id, prepare());
        }
        catch (err) {
            const reason = err.message;
            this.built.skipped.push({ kind, id, reason });
            this.log.warn('Skipping %s %s: %s', kind, id, reason);
        }
    }
    channel(m) {
        const def = findServiceByKey(m.service);
        if (!def) {
            throw new Error(`Unknown service: ${m.service}`);
        }
        const channel = findChannel(this.snapshot.devices, m.address, m.name);
        const name = channelDisplayName(m, channel);
        const legacy = this.legacy(m.uuidSeed);
        return {
            name,
            seed: legacy ? m.uuidSeed : `channel:${m.address}`,
            legacy,
            context: { kind: 'channel', id: m.address, service: def.key, subtype: m.subtype, settings: m.settings, name, legacyLayout: legacy },
            attach: (ctx) => attachOrDispose(def.build(ctx), (h) => h.attach({ ...channel, name })),
        };
    }
    variable(m) {
        const variable = this.snapshot.variables.find((v) => v.name === m.name);
        if (!variable) {
            throw new Error('variable not found on the CCU');
        }
        const explicit = m.service ? findVariableServiceByKey(m.service) : undefined;
        const def = explicit ?? pickVariableService(variable.valuetype);
        const name = variableDisplayName(m);
        const legacy = this.legacy(m.uuidSeed);
        return {
            name,
            seed: legacy ? m.uuidSeed : `variable:${m.name}`,
            legacy,
            context: { kind: 'variable', id: m.name, service: def.key, subtype: m.subtype, settings: m.settings, name, legacyLayout: legacy },
            attach: (ctx) => attachOrDispose(def.build(ctx), (h) => h.attach(variable)),
        };
    }
    program(m) {
        const def = findProgramServiceByKey('ProgramAccessory') ?? PROGRAM_SERVICE_DEFINITIONS[0];
        const name = programDisplayName(m);
        return {
            name,
            seed: `program:${m.name}`,
            legacy: false,
            context: { kind: 'program', id: m.name, service: def.key, name },
            attach: (ctx) => attachOrDispose(def.build(ctx), (h) => h.attach(m.name)),
        };
    }
    legacy(seed) {
        return this.entry.hapHomematicIdentity && typeof seed === 'string' && seed.length > 0;
    }
    add(kind, id, p) {
        const { hap, ccu } = this.deps;
        const uuid = hap.uuid.generate(p.seed);
        if (this.uuids.has(uuid)) {
            throw new Error(`accessory UUID already used on this bridge (${p.name})`);
        }
        const accessory = new hap.Accessory(p.name, uuid);
        const handle = new BridgedAccessoryHandle(accessory, p.context);
        const handler = p.attach({
            accessory: handle,
            ccu,
            log: this.log.child(`svc:${p.context.service}:${id}`),
            Service: hap.Service,
            Characteristic: hap.Characteristic,
        });
        attachOrDispose(handler, () => this.built.bridge.addBridgedAccessory(accessory));
        this.uuids.add(uuid);
        this.built.handlers.push(handler);
        this.built.accessories.push({ kind, id, name: p.name, uuid, legacyIdentity: p.legacy });
    }
}
//# sourceMappingURL=bridgeBuilder.js.map