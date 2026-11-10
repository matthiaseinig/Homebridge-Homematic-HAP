/**
 * Defensive value coercion helpers used at every CCU → HomeKit boundary.
 *
 * The CCU returns datapoint values as either typed XML-RPC primitives or,
 * in some firmware revisions, as strings — and occasionally as `NaN`,
 * `Infinity`, or out-of-range numbers. HomeKit reacts badly to invalid
 * `updateCharacteristic` values: an accessory will simply stop responding
 * in the Home app until Homebridge restarts.
 *
 * `normalizeLevelToPercent` in particular guards against a CCU quirk
 * documented by AlexanderSchmutz/homebridge-homematic-asaw (ISC): some
 * Raspberrymatic builds emit `LEVEL` as 0..1 (the documented range),
 * others as 0..100. The naïve `value * 100` produces 10000 % blind
 * positions on the latter, which Homebridge then rejects and HomeKit
 * shows as "Not Responding". We auto-detect the range instead.
 */
/** Coerce arbitrary input to a finite number, or undefined. */
export declare function toFiniteNumber(value: unknown): number | undefined;
export declare function clamp(value: number, min: number, max: number): number;
/**
 * Coerce to a finite, clamped number with a fallback if the input is
 * unusable. Use on every event path that drives `updateCharacteristic`.
 */
export declare function toRanged(value: unknown, min: number, max: number, fallback: number): number;
/**
 * Normalize a CCU LEVEL datapoint to a HomeKit percentage in [0, 100].
 *
 *   |value| ≤ 1   ⇒ assume native 0..1, multiply by 100
 *   |value| ≤ 100 ⇒ already a percentage
 *   otherwise     ⇒ clamp into range
 *
 * Returns undefined when the input cannot be made into a finite number.
 *
 * Adapted from AlexanderSchmutz/homebridge-homematic-asaw (ISC).
 */
export declare function normalizeLevelToPercent(value: unknown): number | undefined;
/**
 * Inverse of normalizeLevelToPercent: convert a HomeKit percentage
 * (0..100) into the CCU's native 0..1 LEVEL representation that the
 * BLIND/DIMMER receiver channels accept on `setValue`.
 */
export declare function percentToLevelFraction(percent: number): number;
