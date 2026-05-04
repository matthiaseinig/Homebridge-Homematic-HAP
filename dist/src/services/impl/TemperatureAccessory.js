import { AccessoryBase } from "../AccessoryBase.js";
import { toFiniteNumber } from "../../util/sanitize.js";
const TEMP_CHANNEL_TYPES = [
  "WEATHER",
  "WEATHER_TRANSMIT",
  "CLIMATE_TRANSCEIVER",
  "TEMPERATURE_SENSOR"
];
class TemperatureHandler extends AccessoryBase {
  value = 20;
  attach(channel) {
    const service = this.getOrAddService(this.Service.TemperatureSensor, channel.name);
    service.getCharacteristic(this.Characteristic.CurrentTemperature).setProps({ minValue: -50, maxValue: 100, minStep: 0.1 }).onGet(this.wrapGet(() => this.value));
    const handle = (raw) => {
      const v = toFiniteNumber(raw);
      if (v === void 0) {
        return;
      }
      this.value = v;
      service.updateCharacteristic(this.Characteristic.CurrentTemperature, v);
    };
    this.registerListener(channel.address, "TEMPERATURE", handle);
    this.registerListener(channel.address, "ACTUAL_TEMPERATURE", handle);
    this.ccu.getValue(channel.address, "ACTUAL_TEMPERATURE").then(handle).catch(() => this.ccu.getValue(channel.address, "TEMPERATURE").then(handle).catch(() => void 0));
  }
}
const temperatureService = {
  key: "TemperatureAccessory",
  description: "Temperature sensor",
  channelTypes: TEMP_CHANNEL_TYPES,
  priority: 20,
  build: (ctx) => new TemperatureHandler(ctx)
};
export {
  temperatureService
};
//# sourceMappingURL=TemperatureAccessory.js.map
