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
// CCU virtual heating-group channels ("INT..." addresses) don't expose
// SET_TEMPERATURE at all (that's a real per-device datapoint) — they use
// SET_POINT_TEMPERATURE instead. Resolved lazily from whichever candidate
// actually answers, so both channel kinds work without hardcoding a type.
const SETPOINT_DATAPOINTS = ["SET_TEMPERATURE", "SET_POINT_TEMPERATURE"];
class ThermostatHandler extends AccessoryBase {
  channelAddress = "";
  currentTemp = 20;
  targetTemp = 20;
  mode = HEATING_OFF;
  setpointDp = SETPOINT_DATAPOINTS[0];
  pointMode = void 0;
  boostActive = false;
  attach(channel) {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.Thermostat, channel.name);
    const settings = this.accessory.context.settings ?? {};
    const minTemp = typeof settings.minTemp === "number" && Number.isFinite(settings.minTemp) ? settings.minTemp : 4.5;
    const maxTemp = typeof settings.maxTemp === "number" && Number.isFinite(settings.maxTemp) && settings.maxTemp > minTemp ? settings.maxTemp : 30.5;
    const minStep = typeof settings.minStep === "number" && Number.isFinite(settings.minStep) && settings.minStep > 0 ? settings.minStep : 0.5;
    service.getCharacteristic(this.Characteristic.CurrentTemperature).setProps({ minValue: -50, maxValue: 100, minStep: 0.1 }).onGet(this.wrapGet(() => this.currentTemp));
    service.getCharacteristic(this.Characteristic.TargetTemperature).setProps({ minValue: minTemp, maxValue: maxTemp, minStep }).onGet(this.wrapGet(() => this.targetTemp)).onSet(this.wrapSet(async (value) => {
      this.targetTemp = value;
      await this.ccu.setValue(this.channelAddress, this.setpointDp, value);
    }));
    service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState).onGet(this.wrapGet(() => this.deriveCurrentMode()));
    service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState).setProps({ validValues: [HEATING_OFF, HEATING_HEAT, HEATING_AUTO] }).onGet(this.wrapGet(() => this.mode)).onSet(this.wrapSet(async (value) => {
      this.mode = value;
      if (value === HEATING_OFF) {
        await this.ccu.setValue(this.channelAddress, this.setpointDp, 4.5);
      } else if (value === HEATING_AUTO) {
        if (this.pointMode !== void 0) {
          await this.ccu.setValue(this.channelAddress, "SET_POINT_MODE", 0);
        } else {
          await this.ccu.setValue(this.channelAddress, "AUTO_MODE", true);
        }
      } else if (this.pointMode !== void 0) {
        await this.ccu.setValue(this.channelAddress, "SET_POINT_MODE", 1);
        await this.ccu.setValue(this.channelAddress, this.setpointDp, this.targetTemp);
      } else {
        await this.ccu.setValue(this.channelAddress, "MANU_MODE", this.targetTemp);
      }
    }));
    service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits).onGet(() => this.Characteristic.TemperatureDisplayUnits.CELSIUS);
    const applyTargetMode = () => {
      const derived = this.deriveTargetMode();
      if (derived === void 0) return;
      this.mode = derived;
      service.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.mode);
    };
    const applySetpoint = (dp, raw) => {
      const v = toFiniteNumber(raw);
      if (v === void 0) return;
      this.setpointDp = dp;
      this.targetTemp = v;
      service.updateCharacteristic(this.Characteristic.TargetTemperature, v);
      service.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.deriveCurrentMode());
      applyTargetMode();
    };
    this.registerListener(this.channelAddress, "ACTUAL_TEMPERATURE", (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== void 0) {
        this.currentTemp = v;
        service.updateCharacteristic(this.Characteristic.CurrentTemperature, v);
        service.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.deriveCurrentMode());
      }
    });
    for (const dp of SETPOINT_DATAPOINTS) {
      this.registerListener(this.channelAddress, dp, (raw) => applySetpoint(dp, raw));
    }
    this.registerListener(this.channelAddress, "SET_POINT_MODE", (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== void 0) {
        this.pointMode = v;
        applyTargetMode();
      }
    });
    this.registerListener(this.channelAddress, "BOOST_MODE", (raw) => {
      this.boostActive = raw === true || raw === 1 || raw === "1" || raw === "true";
      applyTargetMode();
    });
    this.registerListener(this.channelAddress, "AUTO_MODE", (raw) => {
      if (this.pointMode !== void 0) return;
      if (raw === true || raw === 1 || raw === "1" || raw === "true") {
        this.mode = HEATING_AUTO;
        service.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.mode);
      }
    });
    this.registerListener(this.channelAddress, "MANU_MODE", (raw) => {
      if (this.pointMode !== void 0) return;
      const v = toFiniteNumber(raw);
      if (v !== void 0) {
        this.mode = v <= 4.5 ? HEATING_OFF : HEATING_HEAT;
        service.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.mode);
      }
    });
    this.ccu.getValue(this.channelAddress, "ACTUAL_TEMPERATURE").then((raw) => {
      const v = toFiniteNumber(raw);
      if (v !== void 0) {
        this.currentTemp = v;
        service.updateCharacteristic(this.Characteristic.CurrentTemperature, v);
      }
    }).catch(() => void 0);
    (async () => {
      for (const dp of SETPOINT_DATAPOINTS) {
        try {
          const raw = await this.ccu.getValue(this.channelAddress, dp);
          if (toFiniteNumber(raw) !== void 0) {
            applySetpoint(dp, raw);
            break;
          }
        } catch {
        }
      }
    })();
    this.ccu.getValue(this.channelAddress, "SET_POINT_MODE").then((raw) => {
      const v = toFiniteNumber(raw);
      if (v !== void 0) {
        this.pointMode = v;
        applyTargetMode();
      }
    }).catch(() => void 0);
    this.ccu.getValue(this.channelAddress, "BOOST_MODE").then((raw) => {
      if (raw === void 0 || raw === "") return;
      this.boostActive = raw === true || raw === 1 || raw === "1" || raw === "true";
      applyTargetMode();
    }).catch(() => void 0);
    this.attachBattery(channel.address);
  }
  deriveCurrentMode() {
    if (this.targetTemp <= 4.5) {
      return HEATING_OFF;
    }
    return this.targetTemp > this.currentTemp ? HEATING_HEAT : HEATING_OFF;
  }
  // Maps the CCU's real regulation state onto HomeKit's Off/Heat/Auto enum.
  // Returns undefined when no live-mode datapoint has resolved yet (e.g. a
  // real per-device channel exposing only AUTO_MODE/MANU_MODE booleans), so
  // callers leave `this.mode` at whatever HomeKit last set.
  deriveTargetMode() {
    if (this.boostActive) {
      return HEATING_HEAT;
    }
    if (this.pointMode === void 0) {
      return void 0;
    }
    if (this.pointMode === 0) {
      return HEATING_AUTO;
    }
    return this.targetTemp <= 4.5 ? HEATING_OFF : HEATING_HEAT;
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
