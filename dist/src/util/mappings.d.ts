/**
 * Pure helpers shared by the platform (Homebridge platform accessories)
 * and the multi-bridge host (its own HAP bridges): the HomeKit display
 * name of a mapping and the channel lookup in a CCU device listing.
 * Both paths must produce the same names, because hap-homematic's
 * accessory UUID seeds and HAP service names derive from them.
 */
import type { CcuChannel, CcuDevice, ChannelMapping, ProgramMapping, VariableMapping } from '../types.js';
/**
 * The user's HomeKit name (GUI or hap-homematic import), else a name that
 * pre-0.1.5 imports nested under `settings.name`, else the CCU channel name.
 */
export declare function channelDisplayName(mapping: Pick<ChannelMapping, 'name' | 'settings'>, channel: CcuChannel): string;
/** `displayName`, else the nested legacy `settings.name`, else the CCU name. */
export declare function variableDisplayName(mapping: Pick<VariableMapping, 'name' | 'displayName' | 'settings'>): string;
export declare function programDisplayName(mapping: Pick<ProgramMapping, 'name' | 'displayName' | 'settings'>): string;
/**
 * The channel with this address, or a stub when the CCU does not list it
 * (the accessory still registers; events flow once the CCU sees it).
 */
export declare function findChannel(devices: CcuDevice[], address: string, fallbackName: string | undefined): CcuChannel;
