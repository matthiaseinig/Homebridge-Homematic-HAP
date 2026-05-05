import { AccessoryBase } from "../AccessoryBase.js";
import { toFiniteNumber, toRanged } from "../../util/sanitize.js";
const WEATHER_CHANNEL_TYPES = [
  "WEATHER_TRANSMIT",
  // Some firmwares put a separate "WEATHER" channel in addition to
  // the transmit channel — we accept both so the auto-pick lands on
  // the right one regardless.
  "WEATHER"
];
class WeatherStationHandler extends AccessoryBase {
  temp = 20;
  humidity = 50;
  lux = 1;
  raining = false;
  attach(channel) {
    const baseName = channel.name || this.accessory.displayName;
    const tempSvc = this.getOrAddService(this.Service.TemperatureSensor, `${baseName} Temperature`, "weather-temp");
    const humSvc = this.getOrAddService(this.Service.HumiditySensor, `${baseName} Humidity`, "weather-hum");
    const lightSvc = this.getOrAddService(this.Service.LightSensor, `${baseName} Light`, "weather-light");
    const rainSvc = this.getOrAddService(this.Service.LeakSensor, `${baseName} Rain`, "weather-rain");
    tempSvc.getCharacteristic(this.Characteristic.CurrentTemperature).setProps({ minValue: -50, maxValue: 100, minStep: 0.1 }).onGet(this.wrapGet(() => this.temp));
    humSvc.getCharacteristic(this.Characteristic.CurrentRelativeHumidity).onGet(this.wrapGet(() => this.humidity));
    lightSvc.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel).setProps({ minValue: 1e-4, maxValue: 1e5, minStep: 1e-4 }).onGet(this.wrapGet(() => this.lux));
    rainSvc.getCharacteristic(this.Characteristic.LeakDetected).onGet(this.wrapGet(() => this.raining ? this.Characteristic.LeakDetected.LEAK_DETECTED : this.Characteristic.LeakDetected.LEAK_NOT_DETECTED));
    const applyTemp = (raw) => {
      const v = toFiniteNumber(raw);
      if (v === void 0) return;
      this.temp = v;
      tempSvc.updateCharacteristic(this.Characteristic.CurrentTemperature, v);
    };
    const applyHum = (raw) => {
      const before = this.humidity;
      const v = toRanged(raw, 0, 100, before);
      if (v === before && raw !== before) return;
      this.humidity = Math.round(v);
      humSvc.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, this.humidity);
    };
    const applyLux = (raw) => {
      const v = toFiniteNumber(raw);
      if (v === void 0) return;
      this.lux = Math.max(1e-4, Math.min(1e5, v));
      lightSvc.updateCharacteristic(this.Characteristic.CurrentAmbientLightLevel, this.lux);
    };
    const applyRain = (raw) => {
      const v = raw === true || raw === 1 || raw === "1" || raw === "true";
      this.raining = v;
      rainSvc.updateCharacteristic(this.Characteristic.LeakDetected, v ? this.Characteristic.LeakDetected.LEAK_DETECTED : this.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
    };
    this.registerListener(channel.address, "TEMPERATURE", applyTemp);
    this.registerListener(channel.address, "ACTUAL_TEMPERATURE", applyTemp);
    this.registerListener(channel.address, "HUMIDITY", applyHum);
    this.registerListener(channel.address, "ILLUMINATION", applyLux);
    this.registerListener(channel.address, "BRIGHTNESS", applyLux);
    this.registerListener(channel.address, "RAINING", applyRain);
    this.ccu.getValue(channel.address, "TEMPERATURE").then(applyTemp).catch(() => void 0);
    this.ccu.getValue(channel.address, "HUMIDITY").then(applyHum).catch(() => void 0);
    this.ccu.getValue(channel.address, "ILLUMINATION").then(applyLux).catch(() => void 0);
    this.ccu.getValue(channel.address, "RAINING").then(applyRain).catch(() => void 0);
    this.attachBattery(channel.address);
  }
}
const weatherStationService = {
  key: "WeatherStationAccessory",
  description: "Weather station (temperature + humidity + light + rain)",
  channelTypes: WEATHER_CHANNEL_TYPES,
  // Lower priority than TemperatureAccessory (20) so weather stations
  // get this richer mapping by default. Plain temperature sensors that
  // share the WEATHER channel type can still opt back to the simpler
  // TemperatureAccessory via the service dropdown in the UI.
  priority: 5,
  build: (ctx) => new WeatherStationHandler(ctx)
};
export {
  weatherStationService
};
//# sourceMappingURL=WeatherStationAccessory.js.map
