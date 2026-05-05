/**
 * Central service registry. Each service definition declares the CCU
 * channel types it can handle, its priority, and its variants. The
 * registry is queried at platform discovery time to pick a default
 * service for every channel, and at UI rendering time to populate the
 * "service" dropdown.
 *
 * To add a new service:
 *   1. Create src/services/impl/MyAccessory.ts implementing ChannelService.
 *   2. Export a ServiceDefinition from that file.
 *   3. Add the import + push() below.
 *
 * That's it — no auto-discovery. We deliberately avoid fs.readdir-based
 * "magic" loaders so the dependency graph is statically analysable.
 */

import type {
  ProgramServiceDefinition,
  ServiceDefinition,
  VariableServiceDefinition,
} from './types.js';

import { switchService } from './impl/SwitchAccessory.js';
import { dimmerService } from './impl/DimmerAccessory.js';
import { blindService } from './impl/BlindAccessory.js';
import { slatBlindService } from './impl/SlatBlindAccessory.js';
import { thermostatService } from './impl/ThermostatAccessory.js';
import { contactService } from './impl/ContactAccessory.js';
import { motionService } from './impl/MotionAccessory.js';
import { smokeService } from './impl/SmokeAccessory.js';
import { temperatureService } from './impl/TemperatureAccessory.js';
import { humidityService } from './impl/HumidityAccessory.js';
import { weatherStationService } from './impl/WeatherStationAccessory.js';
import { leakService } from './impl/LeakAccessory.js';
import { programmableSwitchService } from './impl/ProgrammableSwitchAccessory.js';
import { doorOpenerService } from './impl/DoorOpenerAccessory.js';
import { garageDoorService } from './impl/GarageDoorAccessory.js';
import { lockService } from './impl/LockAccessory.js';
import { colorTempDimmerService } from './impl/ColorTempDimmerAccessory.js';
import { rgbLightService } from './impl/RgbLightAccessory.js';
import { powerMeterService } from './impl/PowerMeterAccessory.js';
import { variableSwitchService, variableLightService } from './impl/VariableAccessory.js';
import { variableNumericSensorService } from './impl/VariableNumericSensorAccessory.js';
import { programService } from './impl/ProgramAccessory.js';

export const SERVICE_DEFINITIONS: ServiceDefinition[] = [
  switchService,
  dimmerService,
  blindService,
  slatBlindService,
  thermostatService,
  contactService,
  motionService,
  smokeService,
  temperatureService,
  humidityService,
  weatherStationService,
  leakService,
  programmableSwitchService,
  doorOpenerService,
  garageDoorService,
  lockService,
  colorTempDimmerService,
  rgbLightService,
  powerMeterService,
];

export const VARIABLE_SERVICE_DEFINITIONS: VariableServiceDefinition[] = [
  variableSwitchService,
  variableLightService,
  variableNumericSensorService,
];

export const PROGRAM_SERVICE_DEFINITIONS: ProgramServiceDefinition[] = [
  programService,
];

/** Find candidate services for a channel type, sorted by priority asc. */
export function servicesForChannelType(channelType: string): ServiceDefinition[] {
  return SERVICE_DEFINITIONS
    .filter((svc) => svc.channelTypes.includes(channelType))
    .sort((a, b) => a.priority - b.priority);
}

export function findServiceByKey(key: string): ServiceDefinition | undefined {
  return SERVICE_DEFINITIONS.find((s) => s.key === key);
}

export function findVariableServiceByKey(key: string): VariableServiceDefinition | undefined {
  return VARIABLE_SERVICE_DEFINITIONS.find((s) => s.key === key);
}

export function pickVariableService(valueType: number): VariableServiceDefinition {
  const candidate = VARIABLE_SERVICE_DEFINITIONS
    .filter((s) => s.forValueType === undefined || s.forValueType === valueType)
    .sort((a, b) => a.priority - b.priority)[0];
  // VARIABLE_SERVICE_DEFINITIONS is non-empty and contains at least one
  // entry with forValueType === undefined (variableSwitchService).
  return candidate ?? VARIABLE_SERVICE_DEFINITIONS[0]!;
}

export function findProgramServiceByKey(key: string): ProgramServiceDefinition | undefined {
  return PROGRAM_SERVICE_DEFINITIONS.find((s) => s.key === key);
}
