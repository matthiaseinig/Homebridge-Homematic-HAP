/**
 * Imports a hap-homematic configuration into our config schema.
 *
 * Two entry points:
 *   - importBackupTarball(buffer)  — stream a .tar.gz from the UI
 *   - importConfigJson(rawConfig)  — for users who only have config.json
 *
 * The mapping logic is the only place where we name-translate from the
 * old plugin's service classes to ours. New name aliases go in
 * `SERVICE_ALIASES`. Anything we can't map produces a warning in the
 * `ImportReport` rather than failing the whole import.
 *
 * For users who configured one HAP bridge per hap-homematic *instance*
 * (typically one bridge per room), `splitReportIntoBridges` converts the
 * flat report into one Homebridge platform-config block per instance,
 * each with a deterministic `_bridge: { username, port }` so child-bridge
 * identity is stable across re-runs of the import.
 */
import { Buffer } from 'node:buffer';
import type { ChannelMapping, ProgramMapping, ResolvedConfig, VariableMapping } from '../types.js';
/** hap-homematic's default instance id: HAP uuid.generate('0'). */
export declare const HAP_HOMEMATIC_DEFAULT_INSTANCE: string;
export interface HapHomematicInstance {
    name?: string;
    /** HAP username (bridge MAC) of this hap-homematic bridge. */
    user?: string;
    pincode?: string;
    pin?: string;
    setupID?: string;
    roomId?: number | string;
    publishDevices?: boolean;
}
export interface ImportOptions {
    /**
     * CCU channel address -> channel type (e.g. `BLIND_VIRTUAL_RECEIVER`),
     * from the backup's `devices.json`. Needed to compute hap-homematic's
     * accessory UUID seeds (`<type>:<name>`). Filled automatically by
     * `importBackupTarball`.
     */
    channelTypes?: Record<string, string>;
}
export interface ImportReport {
    channels: ChannelMapping[];
    variables: VariableMapping[];
    programs: ProgramMapping[];
    warnings: string[];
    meta: {
        instanceCount: number;
        sourceVersion?: string;
        ccuIp?: string;
        instances: Record<string, HapHomematicInstance>;
        /** Mappings hap-homematic does not publish (their instance no longer exists). */
        skipped?: Array<{
            kind: 'channel' | 'variable' | 'program';
            id: string;
            instance: string;
        }>;
    };
}
/** A single Homebridge platform-config block emitted by multi-bridge import. */
export interface BridgeImportBlock {
    /** Source instance UUID, kept for traceability. */
    instanceUuid: string;
    /** Display name shown in the Home app. */
    name: string;
    /**
     * `_bridge` identity for the child-bridge feature. With
     * `preserveIdentity` it carries the hap-homematic bridge's username,
     * pin and setupID so a transplanted pairing stays valid.
     */
    bridge: {
        username: string;
        port: number;
        pin?: string;
        setupID?: string;
        name?: string;
    };
    /** True when mappings carry hap-homematic `uuidSeed`s (see ResolvedConfig). */
    hapHomematicIdentity: boolean;
    channels: ChannelMapping[];
    variables: VariableMapping[];
    programs: ProgramMapping[];
}
export interface SplitOptions {
    /**
     * Reuse each hap-homematic bridge's HomeKit identity (username, pin,
     * setupID, accessory UUIDs). Only useful together with copying that
     * bridge's `persist/AccessoryInfo.*.json` and `IdentifierCache.*.json`
     * into Homebridge's persist directory; see the migration doc.
     */
    preserveIdentity?: boolean;
}
export interface HapHomematicConfigShape {
    ccuIP?: string;
    channels?: string[];
    variables?: string[];
    programs?: string[];
    mappings?: Record<string, {
        Service?: string;
        Type?: string;
        /** hap-homematic stores a list of instance ids; older/hand-made configs a string. */
        instance?: string | string[];
        name?: string;
        /** hap-homematic keeps per-service settings (incl. `Type`) nested here. */
        settings?: Record<string, unknown>;
        [k: string]: unknown;
    }>;
    instances?: Record<string, HapHomematicInstance>;
    version?: string;
}
export declare class ImportError extends Error {
    constructor(message: string);
}
export declare function importBackupTarball(tarball: Buffer): Promise<ImportReport>;
/** `devices.json` (hap-homematic's CCU cache) -> channel address -> channel type. */
export declare function channelTypesFromDevicesJson(raw: unknown): Record<string, string>;
export declare function importConfigJson(raw: HapHomematicConfigShape | string, options?: ImportOptions): ImportReport;
/** Merge an ImportReport into an existing ResolvedConfig (channels, variables, programs). */
export declare function mergeIntoConfig(target: Partial<ResolvedConfig>, report: ImportReport): Partial<ResolvedConfig>;
/**
 * Split a flat ImportReport into one Homebridge platform block per
 * hap-homematic instance. Items whose `instance` field is missing or
 * unknown are folded into the first block (so nothing is silently
 * dropped). Each block gets a deterministic `_bridge.username` and
 * `_bridge.port` derived from the instance UUID — re-imports produce
 * the same identities, which preserves Homebridge child-bridge pairing
 * across runs.
 */
export declare function splitReportIntoBridges(report: ImportReport, options?: SplitOptions): BridgeImportBlock[];
/** hap-homematic's bridge name: `HomeMatic <instance name>` with `.:#_()-` blanked. */
export declare function hapHomematicBridgeName(instanceName: string | undefined): string | undefined;
/**
 * Deterministic, locally-administered MAC + port pair from an instance
 * identifier. The MAC sets the locally-administered + unicast bits so
 * it never collides with real OUI-assigned NICs. The port is in
 * 9000..14999 — well clear of the default Homebridge range and unlikely
 * to clash with common services.
 */
export declare function bridgeIdentityFor(seed: string): {
    username: string;
    port: number;
};
/**
 * HAP-NodeJS `uuid.generate`: SHA-1 hex digits poured into the template
 * `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` (the literal 4 consumes no digit,
 * `y` gets the RFC 4122 variant bits).
 */
export declare function hapUuid(seed: string): string;
