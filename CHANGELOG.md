# Changelog

## 1.4.0

- **Multi-bridge mode.** One platform block can publish several HAP
  bridges itself (`multiBridge.bridges`), sharing one CCU connection and
  one event subscription. Each bridge keeps a transplanted hap-homematic
  identity: username, pin, setupID, bridge UUID (the hap-homematic
  instance id), accessory UUIDs and service subtypes. Meant to replace the
  hap-homematic add-on with one Homebridge child process instead of one
  per bridge.
  - Bridges are listed disabled; a disabled bridge is never built or
    published.
  - No bridge is published before the CCU answered (event subscription
    live, devices and needed variables listed); retries every
    `retrySeconds` (default 30).
  - A transplanted bridge is published only when its AccessoryInfo and
    IdentifierCache files exist in the persist directory and its pin and
    setupID match them; `newIdentity: true` allows a throwaway bridge.
  - Bridges whose port is taken or that have no buildable accessory are
    skipped; shutdown unpublishes (never deletes persist files).
  - Unused instance ids are no longer purged on these bridges, so a
    characteristic that appears after the first CCU read keeps its IID.
- Service handlers now depend on a small `AccessoryHandle` interface
  instead of Homebridge's `PlatformAccessory` (no behaviour change for
  platform accessories).
- `scripts/hap-homematic-to-config.mjs` writes one multi-bridge block by
  default (`--per-bridge-blocks` for the old layout), with `--enable`,
  `--smoke-bridge`, `--persist-bridge`.
- New `scripts/multi-bridge-enable.mjs`: enable or disable named bridges
  in a config file for a batch cutover (atomic write, keeps file mode).
- New `scripts/iid-check.mjs`: offline check that a block reuses every
  AID and IID from the bridges' IdentifierCaches.

## 1.3.0

- Migration-ready import of real hap-homematic backups: identity mode
  (`hapHomematicIdentity`, `uuidSeed`, hap-homematic service subtypes),
  Homematic IP thermostats, door openers that switch off again,
  key-press switches, per-block event ports and callback ids, and the CLI
  `scripts/hap-homematic-to-config.mjs`.
