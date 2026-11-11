/**
 * Helpers for parsing CCU device/channel/datapoint addresses.
 *
 *   <interface>.<serial>:<channel>.<datapoint>
 *
 * All four parts are optional past the interface, so a parsed address
 * may have undefined fields; helpers that need a specific shape assert
 * on it themselves.
 */
export interface ParsedAddress {
    interface?: string;
    serial?: string;
    channel?: number;
    datapoint?: string;
}
export declare function parseAddress(address: string): ParsedAddress;
export declare function buildAddress(parts: ParsedAddress): string;
export declare function deviceAddress(channelAddress: string): string;
