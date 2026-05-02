# homebridge-homematic-with-gui

[![CI](https://github.com/matthiaseinig/homebridge-homematic-with-gui/actions/workflows/ci.yml/badge.svg)](https://github.com/matthiaseinig/homebridge-homematic-with-gui/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A modern Homebridge plugin for **HomeMatic** and **HomematicIP** devices,
with a full configuration GUI and a one-click migration path from
[hap-homematic](https://github.com/thkl/hap-homematic).

## Why this exists

[`hap-homematic`](https://github.com/thkl/hap-homematic) — the brilliant
CCU3 / Raspberrymatic add-on by [thkl](https://github.com/thkl) — gives
you fine-grained per-channel HomeKit mappings, multi-bridge support,
and a polished UI. But it runs **on** the CCU, which is the part that
keeps falling over. This plugin lifts the same model up onto Homebridge
so the CCU can stay focused on talking to your radio devices, while
HomeKit lives on a host that you actually own and maintain.

The plugin imports the existing hap-homematic configuration (the
`backup.tar.gz` you already keep) so you can switch hosts without
re-pairing every accessory in the Home app.

## Status

Pre-1.0. The core architecture is in place:

- Dynamic platform plugin, TypeScript, Node 20/22/24
- XML-RPC + ReGa script transport to the CCU, with watchdog reconnect
- 12 service types covering the most common use cases (Switch / Outlet /
  Lightbulb / Dimmer / Window covering / Thermostat / Contact /
  Door / Window / Motion / Smoke / Leak / Temperature / Humidity)
- Variables and Programs exposed as HomeKit Switches / Lightbulbs
- A Bootstrap-5-styled custom UI (no SPA framework) for discovery,
  per-channel service selection, variable / program selection, and
  hap-homematic backup import
- ≥ 95 % line / statement / function test coverage

Not yet shipped:

- The full long-tail of hap-homematic's special-device accessories
  (CCU itself, rain detector, weather stations, etc.)
- CUxD interface (BIN-RPC) — toggle exists in config but transport not
  yet wired
- HomeKit Eve history (fakegato) — disabled until we add the dependency
  back behind a flag

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Install

```bash
npm install -g homebridge-homematic-with-gui
```

Or, in the [Homebridge UI](https://github.com/homebridge/homebridge-config-ui-x),
search for *HomeMatic (with GUI)* in the Plugins tab.

## Quick start

1. Add the plugin in the Homebridge UI. The plugin renders its own
   custom configuration UI — **no JSON editing needed**.
2. Enter the IP / hostname of your CCU3 / Raspberrymatic.
3. Click **Test connection**, then **Discover devices**.
4. Pick the channels, variables, and programs you want HomeKit to see.
   For each channel you can choose the HomeKit service type (e.g.
   *Switch* vs *Outlet* vs *Lightbulb* for a generic relay).
5. Click **Save configuration**. Homebridge restarts the plugin and the
   accessories show up in the Home app within a few seconds.

To migrate from hap-homematic, see
[docs/IMPORT-FROM-HAP-HOMEMATIC.md](docs/IMPORT-FROM-HAP-HOMEMATIC.md).

## Project layout

```
src/
├── ccu/        # CCU client: ReGa scripts, XML-RPC, EventServer
├── services/   # Per-channel HAP service adapters
├── import/     # hap-homematic backup importer
├── util/       # logger, storage, address parser, config validator
├── platform.ts # DynamicPlatformPlugin entry point
└── index.ts    # plugin registration
homebridge-ui/  # Custom UI (Bootstrap 5, plain ES modules)
test/           # Vitest unit tests, ≥ 95 % coverage
docs/           # ARCHITECTURE.md, INTEGRATION.md, …
```

## Documentation

- **[docs/INTEGRATION.md](docs/INTEGRATION.md)** — installing, network
  prerequisites, configuration reference.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the plugin
  talks to the CCU, the service registry pattern, lifecycle.
- **[docs/IMPORT-FROM-HAP-HOMEMATIC.md](docs/IMPORT-FROM-HAP-HOMEMATIC.md)** —
  step-by-step migration from a running hap-homematic install.
- **[SECURITY.md](SECURITY.md)** — threat model and reporting.

## Development

```bash
npm install
npm run build       # TypeScript -> dist/
npm test            # Vitest
npm run coverage    # vitest + v8 coverage; fails below 95 %
npm run lint        # ESLint flat config
npm run audit       # production deps only
```

The whole quality gate (lint + build + test + audit) runs in CI on
Node 20, 22 and 24.

## Credits

This project is a **direct successor**, in spirit and in
configuration-format compatibility, to two excellent works by
[thkl](https://github.com/thkl):

- **[hap-homematic](https://github.com/thkl/hap-homematic)** — the
  CCU3 add-on whose config schema, service-class dispatch design and
  per-bridge instance pattern this plugin replicates so existing users
  can migrate transparently. (Apache-2.0)
- **[homebridge-homematic](https://github.com/thkl/homebridge-homematic)** —
  the original Homebridge plugin whose four-tier channel→service
  fallback and dual-transport (RPC events + ReGa pulls) model
  inspired this implementation. (Apache-2.0)

Both upstream repositories are credited in [NOTICE](NOTICE).

## License

[Apache-2.0](LICENSE) — same as upstream.
