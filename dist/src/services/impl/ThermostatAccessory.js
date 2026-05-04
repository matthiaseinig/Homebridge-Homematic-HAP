import { AccessoryBase } from "../AccessoryBase.js";
import { toFiniteNumber } from "../../util/sanitize.js";
const THERMOSTAT_CHANNEL_TYPES = [
  "CLIMATECONTROL_REGULATOR",
  "CLIMATECONTROL_RT_TRANSCEIVER",
  "HEATING_CLIMATECONTROL_TRANSCEIVER",
  "THERMALCONTROL_TRANSMIT"
];
const HEATING_OFF = 0;
const HEATING_HEAT = 1;
const HEATING_AUTO = 3;
class ThermostatHandler extends AccessoryBase {
  channelAddress = "";
  currentTemp = 20;
  targetTemp = 20;
  mode = HEATING_OFF;
  attach(channel) {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.Thermostat, channel.name);
    service.getCharacteristic(this.Characteristic.CurrentTemperature).setProps({ minValue: -50, maxValue: 100, minStep: 0.1 }).onGet(this.wrapGet(() => this.currentTemp));
    service.getCharacteristic(this.Characteristic.TargetTemperature).setProps({ minValue: 4.5, maxValue: 30.5, minStep: 0.5 }).onGet(this.wrapGet(() => this.targetTemp)).onSet(this.wrapSet(async (value) => {
      this.targetTemp = value;
      await this.ccu.setValue(this.channelAddress, "SET_TEMPERATURE", value);
    }));
    service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState).onGet(this.wrapGet(() => this.deriveCurrentMode()));
    service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState).setProps({ validValues: [HEATING_OFF, HEATING_HEAT, HEATING_AUTO] }).onGet(this.wrapGet(() => this.mode)).onSet(this.wrapSet(async (value) => {
      this.mode = value;
      if (value === HEATING_OFF) {
        await this.ccu.setValue(this.channelAddress, "SET_TEMPERATURE", 4.5);
      } else if (value === HEATING_AUTO) {
        await this.ccu.setValue(this.channelAddress, "AUTO_MODE", true);
      } else {
        await this.ccu.setValue(this.channelAddress, "MANU_MODE", this.targetTemp);
      }
    }));
    service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits).onGet(() => this.Characteristic.TemperatureDisplayUnits.CELSIUS);
    this.registerListener(this.channelAddress, "ACTUAL_TEMPERATURE", (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== void 0) {
        this.currentTemp = v;
        service.updateCharacteristic(this.Characteristic.CurrentTemperature, v);
        service.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.deriveCurrentMode());
      }
    });
    this.registerListener(this.channelAddress, "SET_TEMPERATURE", (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== void 0) {
        this.targetTemp = v;
        service.updateCharacteristic(this.Characteristic.TargetTemperature, v);
      }
    });
  }
  deriveCurrentMode() {
    if (this.targetTemp <= 4.5) {
      return HEATING_OFF;
    }
    return this.targetTemp > this.currentTemp ? HEATING_HEAT : HEATING_OFF;
  }
}
const thermostatService = {
  key: "ThermostatAccessory",
  description: "Heating thermostat",
  channelTypes: THERMOSTAT_CHANNEL_TYPES,
  priority: 10,
  build: (ctx) => new ThermostatHandler(ctx)
};
export {
  thermostatService
};
//# sourceMappingURL=ThermostatAccessory.js.map
