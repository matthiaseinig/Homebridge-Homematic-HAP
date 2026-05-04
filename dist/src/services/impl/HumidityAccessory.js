import { AccessoryBase } from "../AccessoryBase.js";
import { toRanged } from "../../util/sanitize.js";
const HUMIDITY_CHANNEL_TYPES = [
  "WEATHER",
  "WEATHER_TRANSMIT",
  "CLIMATE_TRANSCEIVER",
  "HUMIDITY_SENSOR"
];
class HumidityHandler extends AccessoryBase {
  value = 50;
  attach(channel) {
    const service = this.getOrAddService(this.Service.HumiditySensor, channel.name);
    service.getCharacteristic(this.Characteristic.CurrentRelativeHumidity).onGet(this.wrapGet(() => this.value));
    const apply = (raw) => {
      const before = this.value;
      const v = toRanged(raw, 0, 100, before);
      if (v === before && raw !== before) {
        return;
      }
      this.value = Math.round(v);
      service.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, this.value);
    };
    this.registerListener(channel.address, "HUMIDITY", apply);
    this.ccu.getValue(channel.address, "HUMIDITY").then(apply).catch(() => void 0);
  }
}
const humidityService = {
  key: "HumidityAccessory",
  description: "Humidity sensor",
  channelTypes: HUMIDITY_CHANNEL_TYPES,
  priority: 30,
  build: (ctx) => new HumidityHandler(ctx)
};
export {
  humidityService
};
//# sourceMappingURL=HumidityAccessory.js.map
