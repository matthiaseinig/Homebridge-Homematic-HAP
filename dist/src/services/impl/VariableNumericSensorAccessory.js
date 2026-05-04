import { AccessoryBase } from "../AccessoryBase.js";
import { toFiniteNumber } from "../../util/sanitize.js";
class VariableNumericSensorHandler extends AccessoryBase {
  value = 0;
  name = "";
  variant = "temperature";
  pollHandle;
  attach(variable) {
    this.name = variable.name;
    this.variant = this.deriveVariant(variable);
    const initial = toFiniteNumber(variable.value);
    if (initial !== void 0) {
      this.value = initial;
    }
    const service = this.getOrAddService(this.serviceTypeFor(this.variant), this.name);
    const charType = this.characteristicFor(this.variant);
    service.getCharacteristic(charType).onGet(this.wrapGet(() => this.value));
    this.pollHandle = setInterval(() => this.poll(service, charType), 6e4);
    if (this.pollHandle.unref) {
      this.pollHandle.unref();
    }
  }
  deriveVariant(variable) {
    const fromContext = (this.accessory.context.subtype ?? "").toLowerCase();
    if (fromContext === "temperature" || fromContext === "humidity" || fromContext === "light") {
      return fromContext;
    }
    const unit = (variable.unit ?? "").toLowerCase();
    if (unit.includes("\xB0c") || unit.includes("\xB0f") || unit === "c" || unit === "f") {
      return "temperature";
    }
    if (unit.includes("%") || unit.includes("rh")) {
      return "humidity";
    }
    if (unit.includes("lx") || unit.includes("lux")) {
      return "light";
    }
    return "temperature";
  }
  serviceTypeFor(variant) {
    switch (variant) {
      case "humidity":
        return this.Service.HumiditySensor;
      case "light":
        return this.Service.LightSensor;
      case "temperature":
      default:
        return this.Service.TemperatureSensor;
    }
  }
  characteristicFor(variant) {
    switch (variant) {
      case "humidity":
        return this.Characteristic.CurrentRelativeHumidity;
      case "light":
        return this.Characteristic.CurrentAmbientLightLevel;
      case "temperature":
      default:
        return this.Characteristic.CurrentTemperature;
    }
  }
  async poll(service, charType) {
    try {
      const text = await this.ccu.api.getVariable(this.name);
      const v = toFiniteNumber(text);
      if (v !== void 0 && v !== this.value) {
        this.value = v;
        service.updateCharacteristic(charType, v);
      }
    } catch {
    }
  }
  dispose() {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = void 0;
    }
    super.dispose();
  }
}
const variableNumericSensorService = {
  key: "VariableNumericSensorAccessory",
  description: "Numeric CCU variable as a read-only sensor (Temp / Humidity / Light)",
  forValueType: 4,
  priority: 20,
  build: (ctx) => new VariableNumericSensorHandler(ctx)
};
export {
  variableNumericSensorService
};
//# sourceMappingURL=VariableNumericSensorAccessory.js.map
