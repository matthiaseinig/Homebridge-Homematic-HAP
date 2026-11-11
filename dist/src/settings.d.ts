/**
 * Constants for plugin registration. PLATFORM_NAME must match the
 * `pluginAlias` field of config.schema.json, and PLUGIN_NAME must match
 * the package.json `name` field — Homebridge uses both as composite key
 * when persisting accessories.
 */
export declare const PLATFORM_NAME = "HomematicHap";
export declare const PLUGIN_NAME = "homebridge-homematic-hap";
/** Kept equal to package.json `version` (unit-tested). */
export declare const PLUGIN_VERSION = "1.4.0";
