# Architecture

This document explains how `homebridge-homematic-with-gui` works at a
level of detail that should be sufficient for a contributor to make
meaningful changes without reading every file first. The companion
[INTEGRATION.md](INTEGRATION.md) covers operational concerns
(networking, configuration); this one is about the code.

## High-level shape

```
┌──────────────────────────┐       LAN, port 8181            ┌─────────────────┐
│ Homebridge process       │ ─── ReGa scripts (HTTP) ──────► │                 │
│                          │                                 │  CCU3 /         │
│  HomematicPlatform       │ ◄── XML-RPC events ─────────────│  Raspberrymatic │
│   ├─ CcuClient           │       LAN, port 9875            │                 │
│   │    ├─ RegaClient     │ ─── XML-RPC setValue ──────────►│  (port 2001 etc)│
│   │    ├─ RpcClient × N  │                                 │                 │
│   │    └─ EventServer    │                                 └─────────────────┘
│   └─ Services × M        │
│        (Switch, Dimmer…) │ ─── HAP characteristic update ─► HomeKit hub / Home app
└──────────────────────────┘
```

Three transports talk to the CCU:

1. **ReGa script** (HTTP POST to `/tclrega.exe` on port 8181) for
   anything declarative: device / channel / variable / program
   discovery, room layout, variable read/write, program execution.
2. **XML-RPC client**, one per CCU "interface" (BidCos-RF, HmIP-RF,
   …), used to send `setValue` and to subscribe via `init`.
3. **Local XML-RPC server** ("EventServer", port 9875 by default) that
   the CCU calls back into when device state changes. We deliberately
   parse the inbound XML with a small in-house parser
   ([src/ccu/xmlRpc.ts](../src/ccu/xmlRpc.ts)) that **rejects
   `<!DOCTYPE>`** and external entity references, so the LAN service
   isn't trivially XXE-able.

## Module map

```
src/
├── index.ts             registers the platform with Homebridge
├── settings.ts          PLATFORM_NAME / PLUGIN_NAME constants
├── platform.ts          HomematicPlatform — DynamicPlatformPlugin
├── types.ts             cross-module types: ResolvedConfig,
│                        AccessoryContext, CcuDevice, CcuVariable, …
├── util/
│   ├── config.ts        resolveConfig() validates & defaults raw config
│   ├── logger.ts        PrefixedLogger with secret-scrubbing
│   ├── address.ts       parse / build CCU addresses
│   └── storage.ts       confines all writes to api.user.storagePath()
├── ccu/
│   ├── CcuClient.ts     facade: owns Rega+Rpc+EventServer, dispatch
│   ├── RegaClient.ts    HTTP POST to /tclrega.exe + parsing
│   ├── RpcClient.ts     wraps homematic-xmlrpc per interface
│   ├── EventServer.ts   inbound HTTP + XML-RPC dispatcher
│   ├── xmlRpc.ts        our own small parser/serializer (no XXE)
│   ├── regaScripts.ts   the literal scripts we POST to the CCU
│   └── regaParse.ts     extract devices/variables/programs from XML
├── services/
│   ├── types.ts         ServiceDefinition / ServiceContext interfaces
│   ├── AccessoryBase.ts shared per-accessory handler base class
│   ├── registry.ts      static SERVICE_DEFINITIONS table
│   └── impl/            one file per HAP service mapping
├── import/
│   └── HapHomematicImporter.ts  reads hap-homematic config / .tar.gz
homebridge-ui/
├── server.js            HomebridgePluginUiServer in its own process
└── public/              HTML + plain JS frontend (Bootstrap 5)
```

## Lifecycle

1. **Homebridge constructs `HomematicPlatform`** with the user's config
   block. `resolveConfig` validates it; if validation fails, the
   platform logs `error` and stays idle (per the verified-plugin
   "must not start unless configured" rule). It does *not* throw,
   because that would crash the bridge.
2. **`configureAccessory`** is called once per cached accessory restored
   from disk. We just remember them; we never re-register.
3. On `didFinishLaunching`:
   1. `CcuClient.start()` boots the EventServer and tries to subscribe
      every enabled interface via `init`. Unreachable interfaces log a
      warning and the rest still come up.
   2. We iterate `config.channels[]`, `config.variables[]`,
      `config.programs[]`. For each:
      - Compute a stable UUID with `api.hap.uuid.generate(...)` — for
        channels that's `channel:<address>`, for variables/programs the
        kind plus name. **Do not** use the display name; users rename
        them.
      - If the UUID is already in the cache, mutate `accessory.context`
        and call `api.updatePlatformAccessories([accessory])`.
      - Otherwise, `new this.api.platformAccessory(name, uuid)`,
        attach a service handler, and call
        `api.registerPlatformAccessories(...)`.
   3. Anything that was cached but isn't in the new config is
      `unregisterPlatformAccessories(...)`'d.
4. On shutdown, `CcuClient.stop()` unregisters from every interface,
   then closes the EventServer.

## Service registry

`src/services/registry.ts` keeps a **static** array of
`ServiceDefinition`s. Each definition declares:

- `key` — stable identifier saved in `accessory.context.service`.
- `channelTypes` — list of CCU channel-type strings it can handle
  (e.g. `'SWITCH_VIRTUAL_RECEIVER'`).
- `priority` — lower wins when multiple services match a channel type.
- `variants` — optional sub-types the user can pick (e.g. *Switch* vs
  *Outlet* vs *Lightbulb* for a binary relay).
- `build(ctx)` — constructs the per-accessory handler.

To add a new service type:

1. Create `src/services/impl/MyAccessory.ts` exporting a
   `ServiceDefinition`.
2. Import it in `src/services/registry.ts` and push it into
   `SERVICE_DEFINITIONS`.

There is no auto-discovery (no `fs.readdir`-based loader). A static
list keeps the dependency graph analysable and prevents a malicious
package from sneaking a service in by dropping a file.

## Per-accessory handler contract

A handler is built once per accessory and lives for the process
lifetime. It must:

- Call `getOrAddService(...)` to set up its HAP service and characteristics.
- Use `registerListener(channelAddress, datapoint, callback)` for any
  CCU datapoint it cares about. The base class tracks the disposer so
  `dispose()` can remove the listener cleanly.
- Implement `onGet` handlers that return a **cached** value
  immediately — never block on the network. Push fresh values to
  HomeKit through `service.updateCharacteristic(...)` in the
  EventServer callback.
- For setters, route through `this.ccu.setValue(...)`.
- Throw at most for genuinely-bad input. Normal failures should log
  and let HomeKit see "Not Responding" via a HapStatusError later if we
  decide to surface it.

## Custom UI

`homebridge-config-ui-x` spawns `homebridge-ui/server.js` in its own
Node process. The server receives `onRequest` calls from the iframe and
talks to the CCU itself by spinning up a short-lived `CcuClient`
against the credentials the user just typed (so **Test connection**
works before they save).

Critical security points:

- The iframe is treated as untrusted. Every `onRequest` validates its
  payload (type, length, allowlisted shape).
- Credentials never leave `config.json`; they flow through
  `homebridge.savePluginConfig()` only.
- Tarballs uploaded for hap-homematic import are size-capped (64 MiB)
  and parsed with `tar` filtering by exact filename match
  (`config.json`).
- The xmlRpc parser refuses DOCTYPE / external entities.

## Watchdog

A CCU subscription is fire-and-forget — the CCU happily forgets
clients that don't poke it for a while, and the network can
double-NAT-or-otherwise drop the connection silently. The CcuClient
keeps a `lastEventAt` timestamp. If no events arrive within
`watchdogSeconds` (default 300), every interface re-issues `init`. The
implementation in [src/ccu/CcuClient.ts](../src/ccu/CcuClient.ts) is a
deliberate adaptation of the proven loop in
[thkl/homebridge-homematic#HomeMaticRPC.js](https://github.com/thkl/homebridge-homematic/blob/master/HomeMaticRPC.js).

## Testing strategy

- **Vitest** with v8 coverage. Coverage thresholds: 95 % lines,
  95 % statements, 95 % functions, 90 % branches. The full
  quality gate is `npm run lint && npm run build && npm run coverage
  && npm audit --omit=dev --audit-level=high`.
- All tests live in `test/unit/`. Network code is exercised against
  on-the-fly local HTTP servers (RegaClient, EventServer); HAP types
  are stubbed out by `test/helpers/hapStub.ts` rather than dragging in
  the full hap-nodejs runtime.
- The lazy-loaded `homematic-xmlrpc` import in `RpcClient` is exercised
  via `vi.mock`.

## What we deliberately did *not* port from upstream

- **Multi-instance bridge model.** hap-homematic spins up multiple HAP
  bridges under one server. Homebridge has a native
  [child-bridge mechanism](https://github.com/homebridge/homebridge/wiki/Child-Bridges)
  — users opt into it from the UI by setting `_bridge` on this
  platform's config block. We rely on that instead of replicating the
  multi-instance machinery.
- **Custom HAP pairing storage.** Homebridge owns it; we don't touch.
- **HomematicVariableUpdateEvent** — Homematic doesn't push variable
  changes through the RPC event channel reliably. We poll variables
  every 60 s instead, which mirrors what hap-homematic effectively
  ends up doing too.
