import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { list as tarList } from "tar";
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_CONFIG_JSON_BYTES = 16 * 1024 * 1024;
const SERVICE_ALIASES = {
  HomeMaticSwitchAccessory: "SwitchAccessory",
  HomeMaticDimmerAccessory: "DimmerAccessory",
  HomeMaticBlindAccessory: "BlindAccessory",
  HomeMaticBlindIPAccessory: "BlindAccessory",
  HomeMaticContactSensorAccessory: "ContactAccessory",
  HomeMaticWindowAccessory: "ContactAccessory",
  HomeMaticDoorAccessory: "ContactAccessory",
  HomeMaticMotionAccessory: "MotionAccessory",
  HomeMaticIPMotionAccessory: "MotionAccessory",
  HomeMaticPresenceAccessory: "MotionAccessory",
  HomeMaticThermostatAccessory: "ThermostatAccessory",
  HomeMaticRadiatorThermostatAccessory: "ThermostatAccessory",
  HomeMaticThermometerAccessory: "TemperatureAccessory",
  HomeMaticHumidityAccessory: "HumidityAccessory",
  HomeMaticSmokeDetectorAccessory: "SmokeAccessory",
  HomeMaticLeakSensorAccessory: "LeakAccessory",
  HomeMaticVariableAccessory: "VariableSwitchAccessory",
  HomeMaticVariableNumberSensorAccessory: "VariableNumericSensorAccessory",
  HomeMaticVarBasedThermometerAccessory: "VariableNumericSensorAccessory",
  HomeMaticPushTheButtonAccessory: "ProgrammableSwitchAccessory",
  HomeMaticDoorOpenerAccessory: "DoorOpenerAccessory",
  HomeMaticProgramAccessory: "ProgramAccessory"
};
const SERVICE_DEFAULT_SUBTYPE = {
  HomeMaticWindowAccessory: "window",
  HomeMaticDoorAccessory: "door",
  HomeMaticContactSensorAccessory: "contact",
  HomeMaticVarBasedThermometerAccessory: "temperature"
};
const SUBTYPE_ALIASES = {
  Switch: "switch",
  Outlet: "outlet",
  Lightbulb: "lightbulb",
  Door: "door",
  Window: "window"
};
class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportError";
  }
}
async function importBackupTarball(tarball) {
  if (!Buffer.isBuffer(tarball) || tarball.length === 0) {
    throw new ImportError("Empty or invalid tarball");
  }
  if (tarball.length > MAX_TARBALL_BYTES) {
    throw new ImportError(`Tarball larger than ${MAX_TARBALL_BYTES / (1024 * 1024)} MiB`);
  }
  const configJson = await extractConfigJson(tarball);
  return importConfigJson(configJson);
}
function importConfigJson(raw) {
  const config = typeof raw === "string" ? safeParse(raw) : raw;
  if (!config || typeof config !== "object") {
    throw new ImportError("Invalid config payload");
  }
  const warnings = [];
  const channels = [];
  const variables = [];
  const programs = [];
  for (const address of config.channels ?? []) {
    if (typeof address !== "string" || address.length === 0) {
      continue;
    }
    const mapping = config.mappings?.[address] ?? {};
    const sourceService = mapping.Service ?? "";
    const service = SERVICE_ALIASES[sourceService];
    if (!service) {
      warnings.push(`Could not map service "${sourceService || "?"}" for channel ${address} \u2014 skipped`);
      continue;
    }
    const subtype = mapping.Type ? SUBTYPE_ALIASES[mapping.Type] ?? SERVICE_DEFAULT_SUBTYPE[sourceService] : SERVICE_DEFAULT_SUBTYPE[sourceService];
    const customName = typeof mapping.name === "string" && mapping.name.length > 0 ? mapping.name : void 0;
    channels.push({
      address,
      name: customName,
      service,
      subtype,
      instance: typeof mapping.instance === "string" ? mapping.instance : void 0,
      settings: dropKnownKeys(mapping, ["Service", "Type", "instance", "name"])
    });
  }
  for (const name of config.variables ?? []) {
    if (typeof name !== "string" || name.length === 0) {
      continue;
    }
    const mapping = config.mappings?.[name] ?? {};
    const sourceService = mapping.Service ?? "";
    const service = SERVICE_ALIASES[sourceService];
    if (sourceService && !service) {
      warnings.push(`Could not map variable service "${sourceService}" for "${name}" \u2014 kept with default mapping`);
    }
    const customName = typeof mapping.name === "string" && mapping.name.length > 0 ? mapping.name : void 0;
    variables.push({
      name,
      displayName: customName,
      service,
      subtype: SERVICE_DEFAULT_SUBTYPE[sourceService],
      instance: typeof mapping.instance === "string" ? mapping.instance : void 0,
      settings: dropKnownKeys(mapping, ["Service", "Type", "instance", "name"])
    });
  }
  for (const name of config.programs ?? []) {
    if (typeof name !== "string" || name.length === 0) {
      continue;
    }
    const mapping = config.mappings?.[name] ?? {};
    const customName = typeof mapping.name === "string" && mapping.name.length > 0 ? mapping.name : void 0;
    programs.push({
      name,
      displayName: customName,
      instance: typeof mapping.instance === "string" ? mapping.instance : void 0
    });
  }
  return {
    channels,
    variables,
    programs,
    warnings,
    meta: {
      instanceCount: Object.keys(config.instances ?? {}).length,
      sourceVersion: config.version,
      ccuIp: config.ccuIP,
      instances: config.instances ?? {}
    }
  };
}
function mergeIntoConfig(target, report) {
  const existingChannels = new Map((target.channels ?? []).map((m) => [m.address, m]));
  for (const m of report.channels) {
    existingChannels.set(m.address, m);
  }
  const existingVars = new Map((target.variables ?? []).map((m) => [m.name, m]));
  for (const m of report.variables) {
    existingVars.set(m.name, m);
  }
  const existingProgs = new Map((target.programs ?? []).map((m) => [m.name, m]));
  for (const m of report.programs) {
    existingProgs.set(m.name, m);
  }
  return {
    ...target,
    ccuIp: target.ccuIp ?? report.meta.ccuIp,
    channels: Array.from(existingChannels.values()),
    variables: Array.from(existingVars.values()),
    programs: Array.from(existingProgs.values())
  };
}
function splitReportIntoBridges(report) {
  const instances = report.meta.instances ?? {};
  const uuids = Object.keys(instances);
  if (uuids.length === 0) {
    return [{
      instanceUuid: "default",
      name: "HomematicHap",
      bridge: bridgeIdentityFor("default"),
      channels: [...report.channels],
      variables: [...report.variables],
      programs: [...report.programs]
    }];
  }
  const blocks = /* @__PURE__ */ new Map();
  for (const uuid of uuids) {
    blocks.set(uuid, {
      instanceUuid: uuid,
      name: instances[uuid]?.name ?? `HomematicHap-${uuid.slice(0, 8)}`,
      bridge: bridgeIdentityFor(uuid),
      channels: [],
      variables: [],
      programs: []
    });
  }
  const fallbackUuid = uuids[0];
  const targetFor = (instance) => {
    const direct = instance ? blocks.get(instance) : void 0;
    return direct ?? blocks.get(fallbackUuid);
  };
  const placeChannel = (m) => {
    targetFor(m.instance).channels.push(m);
  };
  const placeVariable = (m) => {
    targetFor(m.instance).variables.push(m);
  };
  const placeProgram = (m) => {
    targetFor(m.instance).programs.push(m);
  };
  report.channels.forEach(placeChannel);
  report.variables.forEach(placeVariable);
  report.programs.forEach(placeProgram);
  return Array.from(blocks.values());
}
function bridgeIdentityFor(seed) {
  const hash = createHash("sha256").update(seed).digest();
  const bytes = [];
  for (let i = 0; i < 6; i++) {
    let b = hash[i];
    if (i === 0) {
      b = b & 254 | 2;
    }
    bytes.push(b.toString(16).toUpperCase().padStart(2, "0"));
  }
  const port = 9e3 + hash.readUInt16BE(6) % 6e3;
  return { username: bytes.join(":"), port };
}
async function extractConfigJson(tarball) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const stream = Readable.from(tarball);
    const parser = tarList({
      filter: (path) => path.endsWith("config.json"),
      onReadEntry: (entry) => {
        if (resolved) {
          entry.resume();
          return;
        }
        const chunks = [];
        let total = 0;
        entry.on("data", (chunk) => {
          total += chunk.length;
          if (total > MAX_CONFIG_JSON_BYTES) {
            entry.destroy(new ImportError("config.json too large"));
            return;
          }
          chunks.push(chunk);
        });
        entry.on("end", () => {
          if (resolved) {
            return;
          }
          resolved = true;
          try {
            const parsed = safeParse(Buffer.concat(chunks).toString("utf8"));
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
        entry.on("error", (err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
      }
    });
    parser.on("end", () => {
      if (!resolved) {
        reject(new ImportError("No config.json found in backup"));
      }
    });
    parser.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    stream.pipe(parser);
  });
}
function safeParse(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ImportError("Backup config.json is not a JSON object");
    }
    return parsed;
  } catch (err) {
    if (err instanceof ImportError) {
      throw err;
    }
    throw new ImportError(`Invalid JSON: ${err.message}`);
  }
}
function dropKnownKeys(obj, keys) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k)) {
      out[k] = v;
    }
  }
  return out;
}
export {
  ImportError,
  bridgeIdentityFor,
  importBackupTarball,
  importConfigJson,
  mergeIntoConfig,
  splitReportIntoBridges
};
//# sourceMappingURL=HapHomematicImporter.js.map
