#!/usr/bin/env node
/**
 * Turn a hap-homematic backup (.tar.gz from its Backup menu) into
 * Homebridge platform blocks for this plugin, one child bridge per
 * hap-homematic bridge, without going through the config UI.
 *
 *   node scripts/hap-homematic-to-config.mjs <backup.tar.gz> [options]
 *
 * Options
 *   --preserve-identity       Reuse each hap-homematic bridge's HomeKit identity
 *                             (username, pin, setupID, accessory UUIDs). Requires
 *                             copying the bridge's persist files, see
 *                             --persist-out and docs/IMPORT-FROM-HAP-HOMEMATIC.md.
 *   --bridge <name>           Only this hap-homematic bridge (instance name, e.g.
 *                             "Keller"); repeatable. Default: all non-empty bridges.
 *   --event-port-base <port>  First XML-RPC callback port; block i gets base+i
 *                             in the order of the full bridge list. Default 9875.
 *   --base <file.json>        Copy ccuIp, useTls, ccuAuth, interfaces and
 *                             interfacePorts from this JSON object (e.g. the
 *                             current platform block) into every block.
 *   --ccu-ip <host>           CCU address (when --base is not given).
 *   --out <file.json>         Write the blocks here (mode 0600) instead of stdout.
 *   --persist-out <dir>       With --preserve-identity: copy each selected
 *                             bridge's AccessoryInfo.*.json and
 *                             IdentifierCache.*.json here (mode 0600).
 *
 * The output contains pairing pins and, with --base, CCU credentials.
 * Treat it like a password file.
 */

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { list as tarList } from 'tar';

const here = path.dirname(fileURLToPath(import.meta.url));
const { importBackupTarball, splitReportIntoBridges } = await import(
  path.join(here, '..', 'dist', 'src', 'import', 'HapHomematicImporter.js')
);

function parseArgs(argv) {
  const opts = { bridges: [], eventPortBase: 9875 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--preserve-identity') opts.preserveIdentity = true;
    else if (a === '--bridge') opts.bridges.push(next());
    else if (a === '--event-port-base') opts.eventPortBase = Number(next());
    else if (a === '--base') opts.base = next();
    else if (a === '--ccu-ip') opts.ccuIp = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--persist-out') opts.persistOut = next();
    else if (a === '-h' || a === '--help') opts.help = true;
    else rest.push(a);
  }
  opts.backup = rest[0];
  return opts;
}

async function readPersistFiles(tarball, wanted) {
  const found = new Map();
  await new Promise((resolve, reject) => {
    const parser = tarList({
      filter: (p) => wanted.has(p.replace(/^\.\//, '')),
      onReadEntry: (entry) => {
        const chunks = [];
        entry.on('data', (c) => chunks.push(c));
        entry.on('end', () => found.set(entry.path.replace(/^\.\//, ''), Buffer.concat(chunks)));
      },
    });
    parser.on('end', resolve);
    parser.on('error', reject);
    Readable.from(tarball).pipe(parser);
  });
  return found;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.backup) {
  process.stderr.write('usage: hap-homematic-to-config.mjs <backup.tar.gz> [--preserve-identity] [--bridge <name>]... '
    + '[--event-port-base 9875] [--base block.json | --ccu-ip host] [--out file] [--persist-out dir]\n');
  process.exit(opts.help ? 0 : 2);
}
if (!Number.isInteger(opts.eventPortBase) || opts.eventPortBase < 1024 || opts.eventPortBase > 65000) {
  throw new Error('--event-port-base must be an integer in [1024, 65000]');
}

const tarball = fs.readFileSync(opts.backup);
const report = await importBackupTarball(tarball);
const all = splitReportIntoBridges(report, { preserveIdentity: opts.preserveIdentity === true });
const instances = report.meta.instances;
const wantedNames = new Set(opts.bridges);
const unknown = [...wantedNames].filter((n) => !all.some((b) => instances[b.instanceUuid]?.name === n));
if (unknown.length > 0) {
  throw new Error(`No non-empty hap-homematic bridge named: ${unknown.join(', ')}`);
}

const base = opts.base ? JSON.parse(fs.readFileSync(opts.base, 'utf8')) : {};
const pick = (k) => (base[k] !== undefined ? { [k]: base[k] } : {});
const ccuIp = base.ccuIp ?? opts.ccuIp;
if (!ccuIp) {
  throw new Error('Give --base (with ccuIp) or --ccu-ip');
}

const blocks = [];
all.forEach((b, index) => {
  const instanceName = instances[b.instanceUuid]?.name;
  if (wantedNames.size > 0 && !wantedNames.has(instanceName)) {
    return;
  }
  const block = {
    platform: 'HomematicHap',
    name: b.name,
    ccuIp,
    ...pick('useTls'),
    ...pick('ccuAuth'),
    ...pick('interfaces'),
    ...pick('interfacePorts'),
    eventServer: { host: base.eventServer?.host ?? '0.0.0.0', port: opts.eventPortBase + index, watchdogSeconds: base.eventServer?.watchdogSeconds ?? 300 },
    hapHomematicIdentity: b.hapHomematicIdentity,
    _bridge: { name: b.name, ...b.bridge },
    channels: b.channels,
    variables: b.variables,
    programs: b.programs,
  };
  blocks.push(block);
});

const json = `${JSON.stringify(blocks, null, 2)}\n`;
if (opts.out) {
  fs.writeFileSync(opts.out, json, { mode: 0o600 });
  fs.chmodSync(opts.out, 0o600);
} else {
  process.stdout.write(json);
}

if (opts.persistOut) {
  if (!opts.preserveIdentity) {
    throw new Error('--persist-out only makes sense with --preserve-identity');
  }
  fs.mkdirSync(opts.persistOut, { recursive: true, mode: 0o700 });
  const wanted = new Set();
  for (const block of blocks) {
    const id = block._bridge.username.replace(/:/g, '').toUpperCase();
    wanted.add(`persist/AccessoryInfo.${id}.json`);
    wanted.add(`persist/IdentifierCache.${id}.json`);
  }
  const files = await readPersistFiles(tarball, wanted);
  const missing = [...wanted].filter((w) => !files.has(w));
  if (missing.length > 0) {
    throw new Error(`Backup lacks: ${missing.join(', ')}`);
  }
  for (const [name, buf] of files) {
    const target = path.join(opts.persistOut, path.basename(name));
    fs.writeFileSync(target, buf, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
  }
}

process.stderr.write(`${blocks.length} block(s), ${blocks.reduce((n, b) => n + b.channels.length + b.variables.length + b.programs.length, 0)} mapping(s)`
  + `${report.warnings.length ? `, ${report.warnings.length} import warning(s):\n  ${report.warnings.join('\n  ')}` : ''}\n`);
