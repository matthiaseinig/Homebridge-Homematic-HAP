/**
 * Pure helpers shared by the platform (Homebridge platform accessories)
 * and the multi-bridge host (its own HAP bridges): the HomeKit display
 * name of a mapping and the channel lookup in a CCU device listing.
 * Both paths must produce the same names, because hap-homematic's
 * accessory UUID seeds and HAP service names derive from them.
 */
function legacySettingsName(settings) {
    return typeof settings?.name === 'string' ? settings.name : undefined;
}
/**
 * The user's HomeKit name (GUI or hap-homematic import), else a name that
 * pre-0.1.5 imports nested under `settings.name`, else the CCU channel name.
 */
export function channelDisplayName(mapping, channel) {
    const settingsName = legacySettingsName(mapping.settings);
    return (mapping.name && mapping.name.length > 0 && mapping.name)
        || (settingsName && settingsName.length > 0 ? settingsName : undefined)
        || channel.name;
}
/** `displayName`, else the nested legacy `settings.name`, else the CCU name. */
export function variableDisplayName(mapping) {
    const dn = mapping.displayName ?? legacySettingsName(mapping.settings);
    return dn && dn.length > 0 ? dn : mapping.name;
}
export function programDisplayName(mapping) {
    const dn = mapping.displayName ?? legacySettingsName(mapping.settings);
    return dn && dn.length > 0 ? dn : mapping.name;
}
/**
 * The channel with this address, or a stub when the CCU does not list it
 * (the accessory still registers; events flow once the CCU sees it).
 */
export function findChannel(devices, address, fallbackName) {
    for (const device of devices) {
        const channel = device.channels.find((c) => c.address === address);
        if (channel) {
            return channel;
        }
    }
    return {
        address,
        index: 0,
        name: fallbackName ?? address,
        type: 'UNKNOWN',
    };
}
//# sourceMappingURL=mappings.js.map