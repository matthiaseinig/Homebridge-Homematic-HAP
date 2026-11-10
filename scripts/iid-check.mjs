#!/usr/bin/env node
/**
 * Offline IID check for a multi-bridge block: builds every bridge with the
 * plugin's real code (dist/) and HAP-NodeJS, assigns accessory and instance
 * ids against an in-memory copy of each bridge's IdentifierCache, and
 * reports what HomeKit would see:
 *
 *   - every accessory must get the AID it had (same accessory UUID),
 *   - every kept service/characteristic reuses its IID (cache hit),
 *   - added and no-longer-present services/characteristics are listed.
 *
 * Nothing is published or advertised: publish() is replaced by a guard
 * that throws, no HAP server or mDNS responder is created, and no file is
 * written (the caches are read, copied in memory, and discarded).
 *
 *   node scripts/iid-check.mjs --config block.json --persist <dir with IdentifierCache.*.json>
 *        --devices devices.json [--variables variables.json] [--hap <hap-nodejs dir>]
 *        [--enabled-only] [--json out.json]
 *
 * devices.json / variables.json are the files from a hap-homematic backup.
 * Output: names of bridges and HAP service/characteristic types, and counts.
 * No pins, keys or setup ids are read from or written to anywhere.
 * Exit code 0 when there is no mismatch, 1 otherwise.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => pathToFileURL(path.join(here, '..', 'dist', 'src', p)).href;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--config') opts.config = next();
    else if (a === '--persist') opts.persist = next();
    else if (a === '--devices') opts.devices = next();
    else if (a === '--variables') opts.variables = next();
    else if (a === '--hap') opts.hap = next();
    else if (a === '--enabled-only') opts.enabledOnly = true;
    else if (a === '--json') opts.json = next();
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!opts.config || !opts.persist || !opts.devices) {
    throw new Error('need --config, --persist and --devices');
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// --- HAP-NodeJS, with publishing disabled --------------------------------
const req = createRequire(path.join(here, '..', 'package.json'));
const hapDir = opts.hap ? path.resolve(opts.hap) : path.dirname(req.resolve('@homebridge/hap-nodejs/package.json'));
const hapReq = createRequire(path.join(hapDir, 'package.json'));
const hap = hapReq(hapDir);
const { IdentifierCache } = hapReq(path.join(hapDir, 'dist', 'lib', 'model', 'IdentifierCache.js'));
const hapVersion = JSON.parse(fs.readFileSync(path.join(hapDir, 'package.json'), 'utf8')).version;
for (const method of ['publish', 'destroy']) {
  hap.Accessory.prototype[method] = () => {
    throw new Error(`${method}() is disabled in iid-check`);
  };
}
let hapWarnings = 0;
const { console: cons } = globalThis;
const realWarn = cons.warn.bind(cons);
cons.warn = (...args) => {
  if (String(args[0]).startsWith('HAP-NodeJS WARNING')) {
    hapWarnings += 1;
    return;
  }
  realWarn(...args);
};

const { buildBridge, bridgeUuidFor } = await import(dist('multiBridge/bridgeBuilder.js'));
const { resolveConfig } = await import(dist('util/config.js'));
const { PrefixedLogger } = await import(dist('util/logger.js'));
const { PLUGIN_VERSION } = await import(dist('settings.js'));

// --- offline CCU -----------------------------------------------------------
const decode = (s) => {
  try {
    return decodeURIComponent(String(s ?? ''));
  } catch {
    return String(s ?? '');
  }
};
const devicesRaw = JSON.parse(fs.readFileSync(opts.devices, 'utf8'));
const devices = (devicesRaw.devices ?? devicesRaw).map((d) => ({
  address: d.address,
  type: d.type,
  name: decode(d.name),
  interface: 'HmIP-RF',
  channels: (d.channels ?? []).map((c) => ({
    address: c.address,
    index: Number(String(c.address).split(':')[1] ?? 0),
    type: c.type,
    name: decode(c.name),
  })),
}));
const variablesRaw = opts.variables ? JSON.parse(fs.readFileSync(opts.variables, 'utf8')) : { variables: [] };
const variables = (variablesRaw.variables ?? variablesRaw).map((v) => ({
  name: decode(v.name),
  id: String(v.id),
  valuetype: Number(v.valuetype),
  subtype: Number(v.subtype ?? 0),
  value: 0,
}));
const offline = () => Promise.reject(new Error('offline'));
const ccu = {
  registerListener: () => () => undefined,
  getValue: offline,
  setValue: offline,
  api: new Proxy({}, { get: () => offline }),
};

const logLines = [];
const sink = (level) => (msg, ...args) => logLines.push({ level, msg, args });
const log = new PrefixedLogger({ info: sink('info'), success: sink('info'), warn: sink('warn'), error: sink('error'), debug: () => undefined, log: () => undefined }, 'iid-check');

// --- names for HAP UUIDs ---------------------------------------------------
const typeNames = new Map();
for (const registry of [hap.Service, hap.Characteristic]) {
  for (const [name, value] of Object.entries(registry)) {
    if (value && typeof value === 'function' && typeof value.UUID === 'string') {
      typeNames.set(value.UUID, name);
    }
  }
}
const nameOf = (uuid) => typeNames.get(uuid) ?? uuid;

/**
 * Split an IdentifierCache key: acc|service[|subtype][|characteristic].
 * A three-part key is a service with subtype when four-part keys extend it
 * (its characteristics), otherwise a characteristic of a service without
 * subtype. `prefixes` holds every three-part prefix of four-part keys.
 */
let prefixes = new Set();
function parseKey(key) {
  const [acc, svc, ...rest] = key.split('|');
  if (!svc || svc.startsWith('next')) return { acc, kind: 'counter' };
  if (rest.length === 0) return { acc, svc, kind: 'service' };
  if (rest.length === 2) return { acc, svc, subtype: rest[0], char: rest[1], kind: 'char' };
  return prefixes.has(key)
    ? { acc, svc, subtype: rest[0], kind: 'service' }
    : { acc, svc, char: rest[0], kind: 'char' };
}
const prefixesOf = (keys) => new Set(keys.filter((k) => k.split('|').length === 4).map((k) => k.split('|').slice(0, 3).join('|')));
const describe = (k) => {
  const p = parseKey(k);
  const svc = `${nameOf(p.svc)}${p.subtype ? `[${p.subtype === p.svc ? 'uuid' : p.subtype}]` : ''}`;
  return p.kind === 'char' ? `${svc}.${nameOf(p.char)}` : svc;
};

// --- run -------------------------------------------------------------------
const docRaw = JSON.parse(fs.readFileSync(opts.config, 'utf8'));
const blocks = (Array.isArray(docRaw) ? docRaw : docRaw.platforms ?? [docRaw]).filter((b) => b?.multiBridge);
if (blocks.length !== 1) {
  throw new Error(`expected exactly one multi-bridge block, found ${blocks.length}`);
}
const resolved = resolveConfig(blocks[0]);
const entries = resolved.multiBridge.bridges.filter((b) => !opts.enabledOnly || b.enabled);

const results = [];
for (const entry of entries) {
  const id = entry.username.replace(/:/g, '').toUpperCase();
  const cacheFile = path.join(opts.persist, `IdentifierCache.${id}.json`);
  const r = { bridge: entry.name, accessories: 0, skipped: [], aidKept: 0, aidNew: [], bridgeUuidKnown: false,
    keptServices: 0, keptChars: 0, addedServices: [], addedChars: [], lostServices: [], lostChars: [], lostAccessories: [], mismatches: [] };
  results.push(r);
  if (!fs.existsSync(cacheFile)) {
    r.mismatches.push(entry.newIdentity ? 'new identity (no cache expected)' : 'IdentifierCache file missing');
    if (entry.newIdentity) r.mismatches.length = 0;
    continue;
  }
  const original = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).cache;
  const built = buildBridge({ hap, ccu, log, version: PLUGIN_VERSION }, entry, { devices, variables });
  r.accessories = built.accessories.length;
  r.skipped = built.skipped.map((s) => `${s.kind} ${s.id}: ${s.reason}`);
  // What Accessory.publish() adds before assigning ids.
  if (!built.bridge.getService(hap.Service.ProtocolInformation)) {
    built.bridge.addService(hap.Service.ProtocolInformation);
  }
  const cache = new IdentifierCache(entry.username);
  cache._cache = JSON.parse(JSON.stringify(original));
  cache.startTrackingUsage();
  built.bridge._assignIDs(cache);
  const used = cache._usedCache ?? {};
  built.handlers.forEach((h) => h.dispose?.());

  const bridgeUuid = bridgeUuidFor(hap, entry);
  r.bridgeUuidKnown = Object.keys(original).some((k) => k.startsWith(`${bridgeUuid}|`));
  if (!r.bridgeUuidKnown) r.mismatches.push('bridge UUID not in the cache (bridge-level IIDs change)');

  for (const a of built.accessories) {
    if (typeof original[a.uuid] === 'number') r.aidKept += 1;
    else {
      r.aidNew.push(a.name);
      r.mismatches.push(`new AID for accessory "${a.name}" (HomeKit sees a new accessory)`);
    }
  }
  const accUuids = new Set(Object.keys(original).filter((k) => !k.includes('|')));
  for (const u of accUuids) {
    if (!(u in used)) r.lostAccessories.push(u);
  }
  if (r.lostAccessories.length) r.mismatches.push(`${r.lostAccessories.length} accessory(ies) in the cache not built (HomeKit drops them)`);

  prefixes = prefixesOf([...Object.keys(original), ...Object.keys(cache._cache)]);
  const accName = new Map(built.accessories.map((a) => [a.uuid, a.name]));
  accName.set(bridgeUuid, '(bridge)');
  const added = Object.keys(cache._cache).filter((k) => !(k in original));
  const lost = Object.keys(original).filter((k) => !(k in used) && k.includes('|') && !k.startsWith('|'));
  const label = (k) => `${accName.get(k.split('|')[0]) ?? k.split('|')[0]}: ${describe(k)}`;
  for (const k of Object.keys(original)) {
    if (!(k in used)) continue;
    const p = parseKey(k);
    if (p.kind === 'service') r.keptServices += 1;
    if (p.kind === 'char') r.keptChars += 1;
  }
  for (const k of added) {
    const p = parseKey(k);
    if (p.kind === 'counter' || p.acc === '' || !k.includes('|')) continue;
    if (p.kind === 'service') {
      r.addedServices.push(label(k));
      // Same service type kept under another subtype in the old cache: a layout mismatch.
      const other = Object.keys(original).some((o) => {
        const q = parseKey(o);
        return q.kind === 'service' && q.acc === p.acc && q.svc === p.svc && q.subtype !== p.subtype;
      });
      if (other) r.mismatches.push(`subtype differs for ${label(k)}`);
    } else if (p.kind === 'char') {
      const serviceKey = [p.acc, p.svc, p.subtype].filter(Boolean).join('|');
      if (serviceKey in original || p.svc === hap.Service.AccessoryInformation.UUID) r.addedChars.push(label(k));
    }
  }
  for (const k of lost) {
    const p = parseKey(k);
    if (p.kind === 'service') r.lostServices.push(label(k));
    else if (p.kind === 'char') r.lostChars.push(label(k));
  }
}

const sum = (f) => results.reduce((n, r) => n + f(r), 0);
const totals = {
  hapNodejs: hapVersion,
  bridges: results.length,
  accessories: sum((r) => r.accessories),
  aidKept: sum((r) => r.aidKept),
  aidNew: sum((r) => r.aidNew.length),
  bridgeUuidKnown: sum((r) => (r.bridgeUuidKnown ? 1 : 0)),
  keptServiceIids: sum((r) => r.keptServices),
  keptCharacteristicIids: sum((r) => r.keptChars),
  addedServices: sum((r) => r.addedServices.length),
  addedCharacteristicsInKeptServices: sum((r) => r.addedChars.length),
  lostServices: sum((r) => r.lostServices.length),
  lostCharacteristics: sum((r) => r.lostChars.length),
  lostAccessories: sum((r) => r.lostAccessories.length),
  skippedMappings: sum((r) => r.skipped.length),
  mismatches: sum((r) => r.mismatches.length),
  hapNameWarnings: hapWarnings,
  pluginErrors: logLines.filter((l) => l.level === 'error').length,
};

if (opts.json) {
  fs.writeFileSync(opts.json, `${JSON.stringify({ totals, results }, null, 2)}\n`, { mode: 0o600 });
}
for (const r of results) {
  process.stdout.write(`${r.mismatches.length ? 'MISMATCH' : 'ok      '} ${r.bridge}: ${r.accessories} acc, AID kept ${r.aidKept}`
    + `, IIDs kept ${r.keptServices} svc/${r.keptChars} char, added ${r.addedServices.length} svc/${r.addedChars.length} char`
    + `, lost ${r.lostServices.length} svc/${r.lostChars.length} char, skipped ${r.skipped.length}\n`);
  for (const m of r.mismatches) process.stdout.write(`    ! ${m}\n`);
}
process.stdout.write(`${JSON.stringify(totals)}\n`);
process.exit(totals.mismatches > 0 ? 1 : 0);
