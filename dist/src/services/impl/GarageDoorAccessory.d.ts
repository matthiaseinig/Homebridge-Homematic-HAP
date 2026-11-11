/**
 * Garage door opener (HmIP-MOD-HO and friends).
 *
 * The CCU exposes DOOR_STATE (0=closed / 1=open / 2=ventilation /
 * 3=position-unknown) and DOOR_COMMAND (1=open / 2=stop / 3=close /
 * 4=partial-open). HomeKit's GarageDoorOpener, in contrast, has a
 * five-state CurrentDoorState including OPENING and CLOSING.
 *
 * Upstream hap-homematic accessories collapsed the in-flight states
 * straight to OPEN/CLOSED, which made the Home app jump from "closed"
 * to "open" without an "opening" phase (thkl/hap-homematic#507). We
 * dwell in OPENING / CLOSING for a configurable travel time
 * (`settings.travelSeconds`, default 25 s) before falling back to the
 * CCU's reported state — long enough for the device to push the
 * actual settled state, but short enough that a stuck door surfaces
 * as Stopped instead of dangling forever.
 *
 * Opt-in via the service dropdown — auto-pick stays on the simpler
 * SwitchAccessory for SWITCH channels.
 */
import type { ServiceDefinition } from '../types.js';
export declare const garageDoorService: ServiceDefinition;
