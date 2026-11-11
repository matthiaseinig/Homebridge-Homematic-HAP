import type { ServiceDefinition } from '../types.js';
/**
 * Datapoint names differ between classic BidCos thermostats and
 * Homematic IP (`HEATING_CLIMATECONTROL_TRANSCEIVER`, e.g. HmIP-eTRV,
 * HmIP-WTH-2). HmIP has no SET_TEMPERATURE / AUTO_MODE / MANU_MODE; it uses
 * SET_POINT_TEMPERATURE, writes the mode through CONTROL_MODE (0 = auto,
 * 1 = manual) and reports it through SET_POINT_MODE.
 */
interface DatapointProfile {
    setPoint: string;
    /** Datapoint that reports the active mode (0 = auto, 1 = manual), if any. */
    modeReport?: string;
    hmip: boolean;
}
export declare function thermostatProfileFor(channelType: string): DatapointProfile;
export declare const thermostatService: ServiceDefinition;
export {};
