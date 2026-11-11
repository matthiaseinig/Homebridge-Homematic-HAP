/**
 * Plugin-wide type declarations for the validated runtime config and
 * the persisted homebridge accessory context. These are the only shapes
 * that cross the boundary between the platform, CCU client, services,
 * and the custom-UI server, so they live in one place.
 */

import type { PlatformConfig } from 'homebridge';

export type CcuInterfaceId =
  | 'BidCos-RF'
  | 'HmIP-RF'
  | 'BidCos-Wired'
  | 'VirtualDevices'
  | 'CUxD';

export interface InterfaceToggles {
  bidcosRf: boolean;
  hmIpRf: boolean;
  bidcosWired: boolean;
  virtualDevices: boolean;
  cuxd: boolean;
}

export interface CcuAuthConfig {
  enabled: boolean;
  username?: string;
  password?: string;
}

export interface EventServerConfig {
  host: string;
  port: number;
  watchdogSeconds: number;
}

/** Concrete, validated config used by everything below the platform. */
export interface ResolvedConfig {
  name: string;
  ccuIp: string;
  interfaces: InterfaceToggles;
  /** Manual XML-RPC port overrides per interface; takes precedence over discovery. */
  interfacePorts: Partial<Record<CcuInterfaceId, number>>;
  useTls: boolean;
  ccuAuth: CcuAuthConfig;
  eventServer: EventServerConfig;
  channels: ChannelMapping[];
  variables: VariableMapping[];
  programs: ProgramMapping[];
  /**
   * Reuse hap-homematic HomeKit identities: accessory UUIDs come from each
   * mapping's `uuidSeed` and HAP services use hap-homematic's subtypes.
   * Off by default. See docs/IMPORT-FROM-HAP-HOMEMATIC.md.
   */
  hapHomematicIdentity: boolean;
  /**
   * Multi-bridge mode: this block publishes several HAP bridges itself
   * (one per former hap-homematic bridge) instead of registering platform
   * accessories. `channels`/`variables`/`programs` above then hold the
   * union of the *enabled* bridges' mappings (for interface pruning only).
   */
  multiBridge?: MultiBridgeConfig;
}

export type MdnsAdvertiser = 'ciao' | 'bonjour-hap' | 'avahi' | 'resolved';

/** One HAP bridge published by the multi-bridge host. */
export interface MultiBridgeEntry {
  /** Bridge name (mDNS and HomeKit), e.g. `HomeMatic Carport`. */
  name: string;
  /** Publish this bridge. A listed but disabled bridge is not published at all. */
  enabled: boolean;
  /** HAP username (bridge MAC), upper case. */
  username: string;
  pincode: string;
  setupID?: string;
  /** HAP TCP port of this bridge. */
  port: number;
  /** HAP accessory UUID of the bridge itself (hap-homematic: its instance id). */
  bridgeUuid?: string;
  /** HAP category; 2 (bridge) unless given. */
  category: number;
  /**
   * Allow publishing without transplanted persist files (a new identity is
   * created). Only for a throwaway smoke-test bridge; transplanted bridges
   * must find their AccessoryInfo and IdentifierCache or are not published.
   */
  newIdentity: boolean;
  /** Reuse hap-homematic accessory UUIDs and service subtypes. Default true. */
  hapHomematicIdentity: boolean;
  channels: ChannelMapping[];
  variables: VariableMapping[];
  programs: ProgramMapping[];
}

export interface MultiBridgeConfig {
  advertiser: MdnsAdvertiser;
  bind?: string | string[];
  /** Wait between attempts to reach the CCU before publishing. */
  retrySeconds: number;
  bridges: MultiBridgeEntry[];
}

/** Shape of an entry in `config.channels[]`, keyed in the UI by address. */
export interface ChannelMapping {
  /** CCU address — `<interface>.<serial>:<channel>`, e.g. `HmIP.000123:1`. */
  address: string;
  name?: string;
  /** Class name in the service registry, e.g. `SwitchAccessory`. */
  service: string;
  /** Variant within a service, e.g. `Outlet` vs `Switch` for SwitchAccessory. */
  subtype?: string;
  settings?: Record<string, unknown>;
  /** hap-homematic instance UUID this channel belonged to, when imported. */
  instance?: string;
  /**
   * Seed of the HomeKit accessory UUID as hap-homematic computed it
   * (`<CCU channel type>:<HomeKit name>`). Only used when the platform
   * block sets `hapHomematicIdentity: true`.
   */
  uuidSeed?: string;
}

export interface VariableMapping {
  /** CCU variable name (the identifier used to look it up). */
  name: string;
  /** Optional HomeKit display name override — defaults to the CCU name. */
  displayName?: string;
  service?: string;
  subtype?: string;
  settings?: Record<string, unknown>;
  instance?: string;
  /** See ChannelMapping.uuidSeed; hap-homematic used `undefined:<HomeKit name>`. */
  uuidSeed?: string;
}

export interface ProgramMapping {
  /** CCU program name (the identifier used to look it up). */
  name: string;
  /** Optional HomeKit display name override — defaults to the CCU name. */
  displayName?: string;
  settings?: Record<string, unknown>;
  instance?: string;
}

/** Shape persisted on `accessory.context`, restored on Homebridge restart. */
export interface AccessoryContext {
  kind: 'channel' | 'variable' | 'program';
  /** Stable identifier (channel address, variable name, or program name). */
  id: string;
  /** Service registry key chosen for this accessory. */
  service: string;
  /** Optional user-chosen variant within the service. */
  subtype?: string;
  /** Service-specific persisted settings. */
  settings?: Record<string, unknown>;
  /** Last-known display name (used to detect renames). */
  name?: string;
  /**
   * True when this accessory reuses a hap-homematic HomeKit identity. HAP
   * services then use hap-homematic's subtypes so a transplanted
   * IdentifierCache yields the same instance ids (automations survive).
   */
  legacyLayout?: boolean;
}

/** What the platform expects in `homebridge.config.json` for this plugin. */
export interface RawConfig extends PlatformConfig {
  ccuIp?: string;
  interfaces?: Partial<InterfaceToggles>;
  interfacePorts?: Partial<Record<CcuInterfaceId, number>>;
  useTls?: boolean;
  ccuAuth?: Partial<CcuAuthConfig>;
  eventServer?: Partial<EventServerConfig>;
  hapHomematicIdentity?: boolean;
  channels?: ChannelMapping[];
  variables?: VariableMapping[];
  programs?: ProgramMapping[];
  multiBridge?: RawMultiBridgeConfig;
}

export interface RawMultiBridgeConfig {
  advertiser?: string;
  bind?: string | string[];
  retrySeconds?: number;
  bridges?: Array<Partial<Omit<MultiBridgeEntry, 'port' | 'category'>> & { port?: number | string; category?: number | string }>;
}

/** Discovery result from the CCU. */
export interface CcuDevice {
  address: string;     // e.g. HmIP.000123
  type: string;        // e.g. HmIP-PSM
  name: string;
  interface: CcuInterfaceId;
  channels: CcuChannel[];
}

export interface CcuChannel {
  address: string;     // e.g. HmIP.000123:1
  index: number;
  type: string;        // e.g. SWITCH_VIRTUAL_RECEIVER
  name: string;
}

export interface CcuVariable {
  name: string;
  id: string;
  valuetype: number;   // 2=bool, 4=number, 16=string, 20=enum
  subtype: number;     // 2=alarm, 6=presence
  minValue?: number;
  maxValue?: number;
  unit?: string;
  enumValues?: string[];
  value: boolean | number | string;
}

export interface CcuProgram {
  name: string;
  id: string;
}
