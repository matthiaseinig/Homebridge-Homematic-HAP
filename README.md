# Homebridge-Homematic-HAP

[![CI](https://github.com/matthiaseinig/Homebridge-Homematic-HAP/actions/workflows/ci.yml/badge.svg)](https://github.com/matthiaseinig/Homebridge-Homematic-HAP/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/matthiaseinig/Homebridge-Homematic-HAP?display_name=tag&sort=semver)](https://github.com/matthiaseinig/Homebridge-Homematic-HAP/releases)
[![GitHub downloads](https://img.shields.io/github/downloads/matthiaseinig/Homebridge-Homematic-HAP/total)](https://github.com/matthiaseinig/Homebridge-Homematic-HAP/releases)
[![GitHub stars](https://img.shields.io/github/stars/matthiaseinig/Homebridge-Homematic-HAP?style=flat)](https://github.com/matthiaseinig/Homebridge-Homematic-HAP/stargazers)
[![Homebridge plugin](https://img.shields.io/badge/homebridge-plugin-blueviolet)](https://homebridge.io)
[![npm](https://img.shields.io/npm/v/homebridge-homematic-hap)](https://www.npmjs.com/package/homebridge-homematic-hap)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-homematic-hap)](https://www.npmjs.com/package/homebridge-homematic-hap)

A modern Homebridge plugin for **HomeMatic** and **HomematicIP** devices,
with a full configuration GUI and a one-click migration path from
[hap-homematic](https://github.com/thkl/hap-homematic).

> ## Credits & lineage
>
> **This project would not exist without the years of work that
> [@thkl](https://github.com/thkl) put into the original HomeMatic ↔
> HomeKit ecosystem.** It is a direct successor — in spirit, in
> architecture and in configuration-format compatibility — to two of
> his projects:
>
> - **[thkl/hap-homematic](https://github.com/thkl/hap-homematic)**
>   — the standalone CCU3 / Raspberrymatic add-on. Its configuration
>   model, channel-to-service dispatch design, multi-bridge instance
>   pattern, and overall architecture are the primary specification
>   this plugin re-implements as a Homebridge dynamic platform plugin.
>   The hap-homematic backup format is consumed verbatim so existing
>   users can migrate without re-pairing. *(Apache-2.0)*
>
> - **[thkl/homebridge-homematic](https://github.com/thkl/homebridge-homematic)**
>   — the original (now unmaintained) Homebridge plugin. The four-tier
>   channel-service dispatch (address → device:channel → channel →
>   device) and the EventServer watchdog reconnection logic informed
>   the modernised TypeScript implementation here. *(Apache-2.0)*
>
> Plus value-sanitization and LEVEL-range auto-detection ideas adopted
> from
> **[AlexanderSchmutz/homebridge-homematic-asaw](https://github.com/AlexanderSchmutz/homebridge-homematic-asaw)**
> (ISC), the maintained fork of homebridge-homematic.
>
> Please ⭐️ all three upstream repositories — they're the foundation.
> Attribution is also recorded in [NOTICE](NOTICE).

## Why this exists

[`hap-homematic`](https://github.com/thkl/hap-homematic) gives you
fine-grained per-channel HomeKit mappings, multi-bridge support, and a
polished UI — but it runs **on** the CCU, which is the part that keeps
falling over. This plugin lifts the same model up onto Homebridge so
the CCU can stay focused on talking to your radio devices, while
HomeKit lives on a host that you actually own and maintain.

The plugin imports the existing hap-homematic configuration (the
`backup.tar.gz` you already keep) so you can switch hosts without
re-pairing every accessory in the Home app.

## Status

Pre-1.0. The core architecture is in place:

- Dynamic platform plugin, TypeScript ESM, Node 20 / 22 / 24
- **JSON-RPC** control plane against the CCU's `/api/homematic.cgi`
  endpoint (Session.login + `_session_id_` per call). XML-RPC for the
  per-interface event subscription only. *We are the first plugin in
  this lineage to use the modern API* — the predecessors all used the
  legacy `/tclrega.exe` ReGa-script endpoint, which has a per-user ACL
  hole that returns empty device lists on RaspberryMatic.
- 14 service types covering common use cases:
  Switch / Outlet / Lightbulb · Dimmer · WindowCovering (blind) ·
  Thermostat · Contact / Door / Window · MotionSensor · SmokeSensor ·
  LeakSensor · TemperatureSensor · HumiditySensor ·
  StatelessProgrammableSwitch (push button) · LockMechanism (door
  opener, momentary) · Variable as Switch / Lightbulb / numeric Sensor ·
  Program as triggerable Switch
- Multi-bridge import: each `instance` in your hap-homematic config
  becomes its own Homebridge child bridge with a deterministic
  `_bridge: { username, port }` derived from the source UUID
- A Bootstrap-5-styled custom UI (no SPA framework) for connection
  testing, device discovery, per-channel service selection, variable /
  program selection, and hap-homematic backup import
- ≥ 95 % line / statement / function test coverage; defensive value
  sanitization (NaN / Infinity / out-of-range guarded at every CCU →
  HomeKit boundary); auto-detect for the CCU `LEVEL` 0..1 vs 0..100
  firmware quirk

Not yet shipped:

- The full long-tail of hap-homematic's special-device accessories
  (RGB lights, dual-white dimmer, weather stations, alarm system,
  power meter, blind-with-slats, keymatic locks, …)
- CUxD interface (BIN-RPC) — config toggle exists but transport not
  yet wired
- HomeKit Eve history (fakegato)

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Install

Until the plugin is published on npm, install straight from this repo
(precompiled `dist/` is checked in for exactly this reason):

```bash
npm install -g matthiaseinig/Homebridge-Homematic-HAP
hb-service restart
```

Once we publish to npm:

```bash
npm install -g homebridge-homematic-hap
```

> Run these on the Homebridge host. The Homebridge user already has
> the privileges it needs — no `sudo` necessary on a default
> Homebridge install.

## Quick start

Before you start: **create a dedicated CCU user with the *Admin* role**
(not Auto-Login — see [INTEGRATION.md](docs/INTEGRATION.md)). The
plugin authenticates via JSON-RPC `Session.login`; an Auto-Login user
typically has no password hash to validate against, and a non-Admin
user can't run the discovery / setValue methods we need.

1. Add the plugin in the Homebridge UI. The plugin renders its own
   custom configuration UI — **no JSON editing needed**.
2. Enter the IP / hostname of your CCU3 / Raspberrymatic.
3. Tick **CCU authentication** and enter the username + password of
   your dedicated Admin user.
4. Click **Test connection**, then **Discover devices**.
5. Pick the channels, variables, and programs you want HomeKit to see.
   For each channel you can choose the HomeKit service type (e.g.
   *Switch* vs *Outlet* vs *Lightbulb* for a generic relay).
6. Click **Save configuration**. Homebridge restarts the plugin and the
   accessories show up in the Home app within a few seconds.

To migrate from hap-homematic, see
[docs/IMPORT-FROM-HAP-HOMEMATIC.md](docs/IMPORT-FROM-HAP-HOMEMATIC.md).

## Project layout

```
src/
├── ccu/                        # CCU client: control + event planes
│   ├── CcuJsonRpcClient.ts     # JSON-RPC at /api/homematic.cgi (control)
│   ├── RpcClient.ts            # XML-RPC per interface (event subscribe)
│   ├── EventServer.ts          # local HTTP/XML-RPC for inbound events
│   ├── xmlRpc.ts               # in-house XML-RPC parser (XXE-safe)
│   └── CcuClient.ts            # facade owning all of the above
├── services/                   # per-channel HAP service adapters
├── import/                     # hap-homematic backup importer
├── util/                       # logger, storage, address parser, sanitize
├── platform.ts                 # DynamicPlatformPlugin entry point
└── index.ts                    # plugin registration
homebridge-ui/                  # Custom UI (Bootstrap 5, plain ES modules)
test/                           # Vitest unit tests
docs/                           # ARCHITECTURE.md, INTEGRATION.md, …
```

## Documentation

- **[docs/INTEGRATION.md](docs/INTEGRATION.md)** — installation
  prerequisites, CCU user requirements, network ports, configuration
  reference.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the plugin
  talks to the CCU (JSON-RPC for control plane, XML-RPC for events),
  the service registry pattern, lifecycle.
- **[docs/IMPORT-FROM-HAP-HOMEMATIC.md](docs/IMPORT-FROM-HAP-HOMEMATIC.md)** —
  step-by-step migration from a running hap-homematic install.
- **[SECURITY.md](SECURITY.md)** — threat model and reporting.

## Development

```bash
npm install
npm run build       # TypeScript -> dist/
npm test            # Vitest
npm run coverage    # vitest + v8 coverage; fails below 95 % lines / 90 % branches
npm run lint        # ESLint flat config
npm run audit       # production deps only
```

The full quality gate (lint + build + test + audit) runs in CI on
Node 20, 22 and 24 (`.github/workflows/ci.yml`).

## Acknowledgements

Original architecture, configuration model, and migration compatibility
are all owed to [@thkl](https://github.com/thkl)'s
[hap-homematic](https://github.com/thkl/hap-homematic) and
[homebridge-homematic](https://github.com/thkl/homebridge-homematic).
The maintained fork
[homebridge-homematic-asaw](https://github.com/AlexanderSchmutz/homebridge-homematic-asaw)
contributed the value-sanitization patterns and LEVEL-range auto-detect
adopted in `src/util/sanitize.ts`. This plugin would have started from
a blank page without all of them. Any bugs in the port are mine.
Full attribution: [NOTICE](NOTICE).

## License

[Apache-2.0](LICENSE) — same as both upstream projects.
