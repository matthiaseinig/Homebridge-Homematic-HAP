import { switchService } from "./impl/SwitchAccessory.js";
import { dimmerService } from "./impl/DimmerAccessory.js";
import { blindService } from "./impl/BlindAccessory.js";
import { slatBlindService } from "./impl/SlatBlindAccessory.js";
import { thermostatService } from "./impl/ThermostatAccessory.js";
import { contactService } from "./impl/ContactAccessory.js";
import { motionService } from "./impl/MotionAccessory.js";
import { smokeService } from "./impl/SmokeAccessory.js";
import { temperatureService } from "./impl/TemperatureAccessory.js";
import { humidityService } from "./impl/HumidityAccessory.js";
import { leakService } from "./impl/LeakAccessory.js";
import { programmableSwitchService } from "./impl/ProgrammableSwitchAccessory.js";
import { doorOpenerService } from "./impl/DoorOpenerAccessory.js";
import { lockService } from "./impl/LockAccessory.js";
import { colorTempDimmerService } from "./impl/ColorTempDimmerAccessory.js";
import { rgbLightService } from "./impl/RgbLightAccessory.js";
import { powerMeterService } from "./impl/PowerMeterAccessory.js";
import { variableSwitchService, variableLightService } from "./impl/VariableAccessory.js";
import { variableNumericSensorService } from "./impl/VariableNumericSensorAccessory.js";
import { programService } from "./impl/ProgramAccessory.js";
const SERVICE_DEFINITIONS = [
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
  leakService,
  programmableSwitchService,
  doorOpenerService,
  lockService,
  colorTempDimmerService,
  rgbLightService,
  powerMeterService
];
const VARIABLE_SERVICE_DEFINITIONS = [
  variableSwitchService,
  variableLightService,
  variableNumericSensorService
];
const PROGRAM_SERVICE_DEFINITIONS = [
  programService
];
function servicesForChannelType(channelType) {
  return SERVICE_DEFINITIONS.filter((svc) => svc.channelTypes.includes(channelType)).sort((a, b) => a.priority - b.priority);
}
function findServiceByKey(key) {
  return SERVICE_DEFINITIONS.find((s) => s.key === key);
}
function findVariableServiceByKey(key) {
  return VARIABLE_SERVICE_DEFINITIONS.find((s) => s.key === key);
}
function pickVariableService(valueType) {
  const candidate = VARIABLE_SERVICE_DEFINITIONS.filter((s) => s.forValueType === void 0 || s.forValueType === valueType).sort((a, b) => a.priority - b.priority)[0];
  return candidate ?? VARIABLE_SERVICE_DEFINITIONS[0];
}
function findProgramServiceByKey(key) {
  return PROGRAM_SERVICE_DEFINITIONS.find((s) => s.key === key);
}
export {
  PROGRAM_SERVICE_DEFINITIONS,
  SERVICE_DEFINITIONS,
  VARIABLE_SERVICE_DEFINITIONS,
  findProgramServiceByKey,
  findServiceByKey,
  findVariableServiceByKey,
  pickVariableService,
  servicesForChannelType
};
//# sourceMappingURL=registry.js.map
