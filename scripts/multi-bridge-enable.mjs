#!/usr/bin/env node
/**
 * Enable (or disable) named bridges of a multi-bridge platform block, for
 * a batch-by-batch cutover. Works on a Homebridge config.json, on the
 * generator's output (a list of blocks) or on a single block.
 *
 *   node scripts/multi-bridge-enable.mjs <file.json> --bridge "HomeMatic Carport" [--bridge ...]
 *   node scripts/multi-bridge-enable.mjs <file.json> --disable --bridge "HomeMatic Carport"
 *   node scripts/multi-bridge-enable.mjs <file.json> --list
 *
 * Options
 *   --bridge <name>        Bridge name as listed (e.g. "HomeMatic Carport"); repeatable.
 *   --disable              Disable the named bridges instead.
 *   --list                 Only print the bridges and their state.
 *   --block <name>         The platform block, when the file has several multi-bridge blocks.
 *   --persist-dir <dir>    Refuse to enable a transplanted bridge whose AccessoryInfo or
 *                          IdentifierCache file is not in this directory.
 *   --dry-run              Print what would change; write nothing.
 *
 * The file is rewritten atomically with its previous mode. Only names and
 * states are printed, never pins or keys. Enabling a bridge here does not
 * make it safe to start: its hap-homematic bridge must already be removed
 * from the CCU (see the migration plan).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const opts = { bridges: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--bridge') opts.bridges.push(next());
    else if (a === '--disable') opts.disable = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--block') opts.block = next();
    else if (a === '--persist-dir') opts.persistDir = next();
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else rest.push(a);
  }
  opts.file = rest[0];
  return opts;
}

function blocksOf(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc.platforms)) return doc.platforms;
  if (doc && typeof doc === 'object') return [doc];
  return [];
}

function persistName(kind, username) {
  return `${kind}.${String(username).replace(/:/g, '').toUpperCase()}.json`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.file || (!opts.list && opts.bridges.length === 0)) {
  process.stderr.write('usage: multi-bridge-enable.mjs <file.json> (--bridge <name>)... [--disable] [--block <name>] '
    + '[--persist-dir <dir>] [--dry-run] | --list\n');
  process.exit(opts.help ? 0 : 2);
}

const text = fs.readFileSync(opts.file, 'utf8');
const doc = JSON.parse(text);
const candidates = blocksOf(doc).filter((b) => b && b.platform === 'HomematicHap' && b.multiBridge
  && Array.isArray(b.multiBridge.bridges) && (!opts.block || b.name === opts.block));
if (candidates.length === 0) fail('No HomematicHap multi-bridge block found');
if (candidates.length > 1) fail(`Several multi-bridge blocks; pick one with --block: ${candidates.map((b) => b.name).join(', ')}`);
const block = candidates[0];
const bridges = block.multiBridge.bridges;

const print = () => {
  for (const b of bridges) {
    process.stdout.write(`${b.enabled === true ? 'enabled ' : 'disabled'}  ${b.name}${b.newIdentity ? '  (new identity)' : ''}\n`);
  }
};

if (opts.list) {
  print();
  process.exit(0);
}

const byName = new Map(bridges.map((b) => [b.name, b]));
const unknown = opts.bridges.filter((n) => !byName.has(n));
if (unknown.length > 0) fail(`Unknown bridge(s): ${unknown.join(', ')}`);

const target = !opts.disable;
if (target && opts.persistDir) {
  const lacking = opts.bridges
    .map((n) => byName.get(n))
    .filter((b) => !b.newIdentity)
    .filter((b) => ['AccessoryInfo', 'IdentifierCache'].some((k) => !fs.existsSync(path.join(opts.persistDir, persistName(k, b.username)))));
  if (lacking.length > 0) fail(`Persist files missing for: ${lacking.map((b) => b.name).join(', ')}; nothing changed`);
}

const changed = [];
for (const name of opts.bridges) {
  const b = byName.get(name);
  if ((b.enabled === true) !== target) {
    b.enabled = target;
    changed.push(name);
  }
}

if (changed.length === 0) {
  process.stdout.write('No change.\n');
} else if (opts.dryRun) {
  process.stdout.write(`Would ${target ? 'enable' : 'disable'}: ${changed.join(', ')}\n`);
} else {
  const mode = fs.statSync(opts.file).mode & 0o777;
  const tmp = path.join(path.dirname(opts.file), `.${path.basename(opts.file)}.${process.pid}.tmp`);
  const indent = /\n( +)\S/.exec(text)?.[1].length ?? 4;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, indent)}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, opts.file);
  process.stdout.write(`${target ? 'Enabled' : 'Disabled'}: ${changed.join(', ')}\n`);
}
print();
