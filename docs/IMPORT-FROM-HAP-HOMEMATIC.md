# Migrating from hap-homematic

This plugin can read your existing
[hap-homematic](https://github.com/thkl/hap-homematic) configuration
and turn it into Homebridge config blocks.

**HomeKit identity.** HomeKit knows a bridged accessory by its bridge
(the HAP username / device id and pairing keys) plus the accessory's
instance ids. A *new* bridge is therefore a new set of accessories: you
pair it in the Home app, put the accessories into rooms again and
rebuild automations and scenes that used the old ones. The default
import (Steps 1 to 5) works that way.

If you want the Home app to keep the existing accessories, names, rooms,
automations and scenes, use the identity-preserving migration described
in [Keeping HomeKit identities](#keeping-homekit-identities) instead: each
hap-homematic bridge moves to a Homebridge child bridge with the *same*
HomeKit identity, so nothing has to be paired again.

## Step 1 — Take a backup from hap-homematic

In the hap-homematic web UI, go to *System → Backup → Export* and
save the resulting `*.tar.gz` file. The archive contains:

- `config.json` — the file we read.
- HAP pairing files in `persist/` — we do **not** read these. The
  Homebridge bridge has its own pairing.
- `*.pstore` files — fakegato (Eve) per-device history. Not migrated;
  Eve history is not yet implemented in this plugin.

## Step 2 — Install this plugin

```bash
npm install -g matthiaseinig/Homebridge-Homematic-HAP
hb-service restart
```

…or install via the Homebridge UI's plugin browser. Once we're on npm,
the install line becomes `npm install -g homebridge-homematic-hap`.

## Step 3 — Open the plugin's custom UI

In the Homebridge UI, click *Settings* on the plugin tile. The plugin
renders its own GUI:

1. Enter your CCU IP address in the *CCU connection* card (or let the
   importer fill it in for you, see step 4).
2. Click *Test connection*.

## Step 4 — Import the backup

Scroll to the *Import from hap-homematic* card. Either:

- **Upload the tarball.** Drag the `backup.tar.gz` you saved earlier
  into the file picker, then click *Import*.
- **Paste the JSON.** If you only have the `config.json` part (e.g.
  you copied it from `/usr/local/etc/config/addons/hap-homematic/`),
  paste it into the textarea and click *Import*.

The importer:

1. Walks `config.channels[]` and looks each address up in
   `config.mappings`. The `Service` field there
   (`HomeMaticSwitchAccessory`, …) is mapped to this plugin's keys
   (`SwitchAccessory`, …). Anything we can't map produces a warning
   so you can fix it manually.
2. Walks `config.variables[]` and `config.programs[]` and re-creates
   them as `VariableSwitchAccessory` / `VariableLightAccessory` /
   `ProgramAccessory` entries.
3. Fills in the CCU IP from the backup if you haven't set one yet.
4. Merges the result into the form on screen — existing entries you
   already added are kept.

After import you'll see a banner with any warnings (typically channels
whose service class isn't yet ported — we list which channels need
attention).

## Step 5 — Save and verify

Click *Save configuration*. Homebridge restarts the plugin. Watch the
Homebridge log:

```
[HomematicHap] Connected to CCU at 192.168.1.10
[HomematicHap:ccu:rpc:HmIP-RF] Subscribed (homebridge-homematic-hap:HmIP-RF -> http://...:9875)
```

Pair the new bridge (or each child bridge) in the Home app, assign rooms,
and rebuild automations that used the old accessories. While both the
old hap-homematic bridge and the new one are paired, every device shows
up twice; remove the old bridge from the Home app once the new one works.

## Step 6 — (Optional) Decommission hap-homematic

Once you've confirmed everything works, you can stop hap-homematic on
the CCU. The CCU itself is unchanged; only the HomeKit bridge layer
moves to your Homebridge host. If you ever want to roll back, the
hap-homematic backup you took in Step 1 is still authoritative.

## Mapping reference

| hap-homematic class | This plugin's `service` key |
| ------------------- | ---------------------------- |
| HomeMaticSwitchAccessory | `SwitchAccessory` |
| HomeMaticDimmerAccessory | `DimmerAccessory` |
| HomeMaticBlindAccessory / HomeMaticBlindIPAccessory | `BlindAccessory` |
| HomeMaticContactSensorAccessory | `ContactAccessory` (`contact`) |
| HomeMaticDoorAccessory | `ContactAccessory` (`door`) |
| HomeMaticWindowAccessory | `ContactAccessory` (`window`) |
| HomeMaticMotionAccessory / HomeMaticIPMotionAccessory / HomeMaticPresenceAccessory | `MotionAccessory` |
| HomeMaticThermostatAccessory / HomeMaticRadiatorThermostatAccessory | `ThermostatAccessory` |
| HomeMaticThermometerAccessory | `TemperatureAccessory` |
| HomeMaticHumidityAccessory | `HumidityAccessory` |
| HomeMaticSmokeDetectorAccessory | `SmokeAccessory` |
| HomeMaticLeakSensorAccessory | `LeakAccessory` |
| HomeMaticVariableAccessory | `VariableSwitchAccessory` |
| HomeMaticProgramAccessory | `ProgramAccessory` |
| HomeMaticPushTheButtonAccessory | `KeyPressSwitchAccessory` (a switch that *sends* a key press) |
| HomeMaticDoorOpenerAccessory | `DoorOpenerAccessory` (honours `OnTime`) |
| HomeMaticVariableNumberSensorAccessory (`Humidity` / `LuxOmeter`) | `VariableNumericSensorAccessory` (`humidity` / `light`) |
| HomeMaticVarBasedThermometerAccessory | `VariableNumericSensorAccessory` (`temperature`) |

Anything not in this table will land in your *Imported with warnings*
banner. Open an issue with the offending class name and we'll prioritise
it.

## What the importer reads

hap-homematic 0.0.63 backups store, per channel, `mappings[address] =
{ name, Service, instance: [<bridge id>], settings: { Type, ... } }` and,
per variable, `mappings["<variable>:0"]`. The importer reads both
shapes, takes `Type` from `settings`, and skips mappings whose bridge no
longer exists (hap-homematic does not publish those either; they are
listed in the import warnings). `devices.json` from the backup supplies
the CCU channel types used for the identity seeds below.

## Keeping HomeKit identities

hap-homematic runs one HAP bridge per instance (often one per room). Each
bridge's pairing lives in `persist/AccessoryInfo.<username>.json` and
its instance ids in `persist/IdentifierCache.<username>.json`, both
inside the backup. hap-homematic derived each accessory's UUID from
`<CCU channel type>:<HomeKit name>` and created most HAP services with
the service UUID as subtype.

With `hapHomematicIdentity: true` on a platform block, this plugin
reproduces that: accessory UUIDs come from each mapping's `uuidSeed`
and services use hap-homematic's subtypes. Run the block as a child
bridge with the old bridge's `username`, `pin` and `setupID`, and put the
two persist files into Homebridge's `persist/` directory before it
starts. HomeKit then sees the same bridge with the same accessories.

`scripts/hap-homematic-to-config.mjs` produces such blocks and extracts
the persist files:

```bash
npm run build
node scripts/hap-homematic-to-config.mjs backup.tar.gz --preserve-identity \
  --bridge "Keller" --base current-block.json --out blocks.json \
  --persist-out persist-files/
```

Rules that keep this safe:

- **Never run both.** The old bridge must be gone from the network
  before the child bridge starts: remove that instance in hap-homematic
  (or stop the add-on). A deactivated instance is *still published* (with
  no accessories) and would make HomeKit drop them.
- **Rollback** is the reverse: stop the child bridge, then bring the
  instance back in hap-homematic (restore the backup taken before).
- Accessory UUIDs no longer change when you rename an accessory here
  (hap-homematic re-created an accessory on rename). Moving a channel to
  another bridge does create a new accessory.
- Characteristics this plugin does not implement disappear from the
  accessory (for example ObstructionDetected and slat tilt on blinds, Eve
  history on window contacts, OutletInUse). Automations that use them
  need adjusting.

### Multi-bridge mode (one process for all bridges)

One child bridge per hap-homematic bridge means one Homebridge process and
one CCU subscription per bridge. Multi-bridge mode (1.4.0) runs them all in
**one** platform block: one process, one CCU connection, one event
subscription, and one HAP bridge per former hap-homematic bridge, each
published by the plugin with its original username, pin, setupID, bridge
UUID (hap-homematic's instance id) and accessory UUIDs. This is the
default output of the CLI:

```bash
npm run build
node scripts/hap-homematic-to-config.mjs backup.tar.gz --base current-block.json \
  --out block.json --persist-out persist-files/ --persist-bridge "Carport"
node scripts/multi-bridge-enable.mjs block.json --bridge "HomeMatic Carport"
```

```json
{
  "platform": "HomematicHap",
  "name": "HomeMatic Bridges",
  "ccuIp": "...",
  "eventServer": { "port": 9875 },
  "_bridge": { "username": "...", "port": 9255 },
  "multiBridge": {
    "advertiser": "ciao",
    "bridges": [
      { "name": "HomeMatic Carport", "enabled": false, "username": "...", "pincode": "...",
        "setupID": "...", "port": 12345, "bridgeUuid": "<hap-homematic instance id>",
        "channels": [ ... ], "variables": [ ... ], "programs": [ ... ] }
    ]
  }
}
```

- Every bridge is listed with `enabled: false`. A disabled bridge is not
  built or published at all, so an identity that still runs on the CCU is
  never advertised twice. Enable bridges batch by batch.
- Nothing is published until the CCU is reachable (event subscription
  up, devices listed). An unreachable bridge keeps its accessories in
  HomeKit; one that came back with fewer accessories would lose them.
- A bridge is published only when its `AccessoryInfo` and
  `IdentifierCache` files are in Homebridge's `persist/` directory and its
  pin and setupID match them. Otherwise it is skipped with an error, never
  re-created under the old username. `newIdentity: true` lifts this for a
  throwaway smoke-test bridge (`--smoke-bridge <channel>`).
- A bridge whose HAP port is in use, or that would have no accessory, is
  skipped; the others start.
- Instance ids of characteristics that appear only after the first CCU
  read (thermostat humidity) are kept, so they get their old IID back.
- Shutdown unpublishes the bridges; it never deletes their persist files.
- The block's own `_bridge` is a Homebridge child bridge with no
  accessories. Homebridge advertises it like any child bridge; do not pair
  it.
- Do not edit this block in the plugin's config UI: adding a channel at
  block level stops the whole block (mappings belong to a bridge).

`scripts/iid-check.mjs` checks a block offline before any cutover: it
builds every bridge with the plugin code against a copy of its
IdentifierCache (no publishing, no network) and reports kept, added and
lost accessory and instance ids; it exits 1 on any mismatch.

## What the importer does NOT do

- It does **not** copy HAP pairing data by itself. The CLI's
  `--persist-out` extracts it for the identity-preserving migration.
- It does **not** copy fakegato history (`*.pstore`). The Eve app's
  graphs will start fresh.
- It does **not** delete or modify the source backup file.

## Troubleshooting

**"No config.json found in backup"**: Most likely you uploaded a
non-hap-homematic tar (e.g. an OS backup). Double-check it's the file
produced by hap-homematic's *Export* button.

**"Could not map service X for channel Y"**: The hap-homematic backup
references a service class this plugin hasn't ported yet. The channel
is skipped; the rest of the import still applies. Open an issue.

**Channels appear but the service variant looks wrong** (e.g. a relay
came across as Switch when you had it set as Outlet): The importer
reads the hap-homematic `Type` field, but custom variants you added by
manually editing the JSON may not carry across. Edit the channel in
the plugin UI and pick the correct subtype.
