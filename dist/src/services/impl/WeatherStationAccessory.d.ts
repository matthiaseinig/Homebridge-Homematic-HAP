/**
 * Weather station accessory: combines TemperatureSensor +
 * HumiditySensor + LightSensor + LeakSensor (rain) on a single
 * HomeKit accessory. Targets HmIP-SWO-PR (Pro), HmIP-SWO-PL+ and
 * HmIP-SWO-B which all expose a WEATHER_TRANSMIT channel with a
 * superset of the relevant datapoints. Each sub-service updates only
 * if the corresponding datapoint is actually pushed by the device,
 * so the simpler PL/B variants don't show stale "0 lux" or "no rain"
 * readings — they get the default and stay there until an event
 * arrives.
 *
 * Maps to upstream issues #519, #548, #565, #653 in thkl/hap-homematic.
 */
import type { ServiceDefinition } from '../types.js';
export declare const weatherStationService: ServiceDefinition;
