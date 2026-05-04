import {
  APIEvent
} from "homebridge";
import { CcuClient } from "./ccu/CcuClient.js";
import {
  findProgramServiceByKey,
  findServiceByKey,
  findVariableServiceByKey,
  pickVariableService,
  PROGRAM_SERVICE_DEFINITIONS
} from "./services/registry.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { ConfigError, resolveConfig } from "./util/config.js";
import { PrefixedLogger } from "./util/logger.js";
import { PluginStorage } from "./util/storage.js";
class HomematicPlatform {
  Service;
  Characteristic;
  api;
  log;
  storage;
  resolved;
  ccu;
  cachedAccessories = /* @__PURE__ */ new Map();
  managed = /* @__PURE__ */ new Map();
  constructor(log, config, api) {
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.log = new PrefixedLogger(log, PLATFORM_NAME);
    this.storage = new PluginStorage(api);
    try {
      this.resolved = resolveConfig(config);
    } catch (err) {
      if (err instanceof ConfigError) {
        this.log.error("Plugin not configured: %s", err.message);
        return;
      }
      throw err;
    }
    this.ccu = new CcuClient({ config: this.resolved, log: this.log.child("ccu") });
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.didFinishLaunching().catch((err) => {
        this.log.error("Startup failed: %s", err.message);
      });
    });
    this.api.on(APIEvent.SHUTDOWN, () => {
      this.shutdown().catch((err) => {
        this.log.warn("Shutdown error: %s", err.message);
      });
    });
  }
  configureAccessory(accessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
    this.log.debug("Restored accessory %s", accessory.displayName);
  }
  /** Public for the homebridge-ui server to query CCU on demand. */
  getCcu() {
    return this.ccu;
  }
  // --- private -------------------------------------------------------
  async didFinishLaunching() {
    if (!this.resolved || !this.ccu) {
      return;
    }
    await this.storage.ensureRoot();
    await this.ccu.start();
    this.log.success("Connected to CCU at %s", this.resolved.ccuIp);
    const seen = /* @__PURE__ */ new Set();
    for (const mapping of this.resolved.channels) {
      try {
        const uuid = this.api.hap.uuid.generate(`channel:${mapping.address}`);
        seen.add(uuid);
        await this.attachChannel(uuid, mapping.address, mapping);
      } catch (err) {
        this.log.warn("Skipping channel %s: %s", mapping.address, err.message);
      }
    }
    for (const mapping of this.resolved.variables) {
      try {
        const uuid = this.api.hap.uuid.generate(`variable:${mapping.name}`);
        seen.add(uuid);
        await this.attachVariable(uuid, mapping.name, mapping.service, mapping.settings);
      } catch (err) {
        this.log.warn("Skipping variable %s: %s", mapping.name, err.message);
      }
    }
    for (const mapping of this.resolved.programs) {
      try {
        const uuid = this.api.hap.uuid.generate(`program:${mapping.name}`);
        seen.add(uuid);
        await this.attachProgram(uuid, mapping.name);
      } catch (err) {
        this.log.warn("Skipping program %s: %s", mapping.name, err.message);
      }
    }
    const toRemove = [];
    for (const [uuid, acc] of this.cachedAccessories) {
      if (!seen.has(uuid)) {
        toRemove.push(acc);
        this.cachedAccessories.delete(uuid);
      }
    }
    if (toRemove.length > 0) {
      this.log.info("Removing %d stale accessories", toRemove.length);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRemove);
    }
  }
  async shutdown() {
    for (const m of this.managed.values()) {
      try {
        m.handler.dispose?.();
      } catch (err) {
        this.log.debug("dispose error: %s", err.message);
      }
    }
    this.managed.clear();
    if (this.ccu) {
      await this.ccu.stop();
    }
  }
  async attachChannel(uuid, address, mapping) {
    if (!this.ccu) {
      return;
    }
    const def = findServiceByKey(mapping.service);
    if (!def) {
      throw new Error(`Unknown service: ${mapping.service}`);
    }
    const channel = await this.fetchChannel(address, mapping.name);
    const accessory = this.getOrCreateAccessory(uuid, channel.name, {
      kind: "channel",
      id: address,
      service: def.key,
      subtype: mapping.subtype,
      settings: mapping.settings,
      name: channel.name
    });
    const ctx = {
      accessory,
      ccu: this.ccu,
      log: this.log.child(`svc:${def.key}:${channel.address}`),
      Service: this.Service,
      Characteristic: this.Characteristic
    };
    const handler = def.build(ctx);
    handler.attach(channel);
    this.managed.set(uuid, { accessory, handler });
  }
  async attachVariable(uuid, name, serviceKey, _settings) {
    if (!this.ccu) {
      return;
    }
    const variables = await this.ccu.listVariables();
    const variable = variables.find((v) => v.name === name);
    if (!variable) {
      throw new Error(`Variable not found on CCU: ${name}`);
    }
    const explicit = serviceKey ? findVariableServiceByKey(serviceKey) : void 0;
    const def = explicit ?? pickVariableService(variable.valuetype);
    const accessory = this.getOrCreateAccessory(uuid, name, {
      kind: "variable",
      id: name,
      service: def.key,
      name
    });
    const ctx = {
      accessory,
      ccu: this.ccu,
      log: this.log.child(`svc:${def.key}:${name}`),
      Service: this.Service,
      Characteristic: this.Characteristic
    };
    const handler = def.build(ctx);
    handler.attach(variable);
    this.managed.set(uuid, { accessory, handler });
  }
  async attachProgram(uuid, name) {
    if (!this.ccu) {
      return;
    }
    const def = findProgramServiceByKey("ProgramAccessory") ?? PROGRAM_SERVICE_DEFINITIONS[0];
    const accessory = this.getOrCreateAccessory(uuid, name, {
      kind: "program",
      id: name,
      service: def.key,
      name
    });
    const ctx = {
      accessory,
      ccu: this.ccu,
      log: this.log.child(`svc:${def.key}:${name}`),
      Service: this.Service,
      Characteristic: this.Characteristic
    };
    const handler = def.build(ctx);
    handler.attach(name);
    this.managed.set(uuid, { accessory, handler });
  }
  async fetchChannel(address, fallbackName) {
    if (!this.ccu) {
      throw new Error("CCU client not initialized");
    }
    const devices = await this.ccu.listDevices();
    for (const device of devices) {
      const channel = device.channels.find((c) => c.address === address);
      if (channel) {
        return channel;
      }
    }
    return {
      address,
      index: 0,
      name: fallbackName ?? address,
      type: "UNKNOWN"
    };
  }
  getOrCreateAccessory(uuid, displayName, context) {
    const existing = this.cachedAccessories.get(uuid);
    if (existing) {
      Object.assign(existing.context, context);
      this.api.updatePlatformAccessories([existing]);
      return existing;
    }
    const accessory = new this.api.platformAccessory(displayName, uuid);
    accessory.context = context;
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.cachedAccessories.set(uuid, accessory);
    return accessory;
  }
}
export {
  HomematicPlatform
};
//# sourceMappingURL=platform.js.map
