# Migrating from hap-homematic

This plugin can read your existing
[hap-homematic](https://github.com/thkl/hap-homematic) configuration
and turn it into Homebridge config blocks. No accessory has to be
re-paired in the Home app: HomeKit identifies accessories by their
*HomeKit setup info*, not by which bridge they live behind, so
**after migration the Home app sees the same accessories at the same
names**.

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
npm install -g homebridge-homematic-hap
```

…or install via the Homebridge UI's plugin browser. Restart Homebridge
once.

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

Open the Home app. Your accessories should appear within a few
seconds. If you'd like to keep the old bridge around as a safety net,
just unpair it from HomeKit when you're confident — pairing is
independent of the underlying CCU.

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
| HomeMaticVariableAccessory (boolean) | `VariableSwitchAccessory` |
| HomeMaticVariableAccessory (numeric) | `VariableLightAccessory` |
| HomeMaticProgramAccessory | `ProgramAccessory` |

Anything not in this table will land in your *Imported with warnings*
banner. Open an issue with the offending class name and we'll prioritise
it.

## What the importer does NOT do

- It does **not** copy HAP pairing data. Bridge pairing always belongs
  to whichever Homebridge instance owns it.
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
