/**
 * Constants for plugin registration. PLATFORM_NAME must match the
 * `pluginAlias` field of config.schema.json, and PLUGIN_NAME must match
 * the package.json `name` field — Homebridge uses both as composite key
 * when persisting accessories.
 */

export const PLATFORM_NAME = 'HomematicWithGui';
export const PLUGIN_NAME = 'homebridge-homematic-with-gui';
