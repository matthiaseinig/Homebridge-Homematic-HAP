import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
import { toFiniteNumber } from '../../util/sanitize.js';

const TEMP_CHANNEL_TYPES = [
  'WEATHER',
  'WEATHER_TRANSMIT',
  'CLIMATE_TRANSCEIVER',
  'TEMPERATURE_SENSOR',
];

/**
 * Channel types whose devices report HUMIDITY next to the temperature
 * (HmIP-STH/STHO/STHD climate sensors, HmIP-WTH wall thermostats, weather
 * stations). hap-homematic's thermometer exposed a HumiditySensor for these.
 */
const HUMIDITY_CHANNEL_TYPES = new Set([
  'CLIMATE_TRANSCEIVER',
  'HEATING_CLIMATECONTROL_TRANSCEIVER',
  'WEATHER',
  'WEATHER_TRANSMIT',
]);

class TemperatureHandler extends AccessoryBase implements ChannelService {
  private value = 20;
  private humidity = 50;

  attach(channel: CcuChannel): void {
    const service = this.getOrAddService(this.Service.TemperatureSensor, channel.name);

    service.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(this.wrapGet<number>(() => this.value));

    const handle = (raw: unknown): void => {
      const v = toFiniteNumber(raw);
      if (v === undefined) {
        return;
      }
      this.value = v;
      service.updateCharacteristic(this.Characteristic.CurrentTemperature, v);
    };

    this.registerListener(channel.address, 'TEMPERATURE', handle);
    this.registerListener(channel.address, 'ACTUAL_TEMPERATURE', handle);

    // Try ACTUAL_TEMPERATURE first (climate-control devices), fall back to
    // TEMPERATURE (weather sensors). Best-effort: if both fail, the
    // accessory just stays at its default until the first push event.
    this.ccu.getValue(channel.address, 'ACTUAL_TEMPERATURE')
      .then(handle)
      .catch(() => this.ccu.getValue(channel.address, 'TEMPERATURE')
        .then(handle)
        .catch(() => undefined));

    const settings = this.accessory.context.settings ?? {};
    if (HUMIDITY_CHANNEL_TYPES.has(channel.type) && settings.ignoreHumidity !== true) {
      this.attachHumidity(channel);
    }

    this.attachBattery(channel.address);
  }

  private attachHumidity(channel: CcuChannel): void {
    const service = this.getOrAddService(this.Service.HumiditySensor, channel.name, 'humidity');
    service.getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
      .onGet(this.wrapGet<number>(() => this.humidity));
    const handle = (raw: unknown): void => {
      const v = toFiniteNumber(raw);
      if (v === undefined) {
        return;
      }
      this.humidity = Math.min(100, Math.max(0, v));
      service.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, this.humidity);
    };
    this.registerListener(channel.address, 'HUMIDITY', handle);
    this.ccu.getValue(channel.address, 'HUMIDITY').then(handle).catch(() => undefined);
  }
}

export const temperatureService: ServiceDefinition = {
  key: 'TemperatureAccessory',
  description: 'Temperature sensor',
  channelTypes: TEMP_CHANNEL_TYPES,
  priority: 20,
  build: (ctx: ServiceContext) => new TemperatureHandler(ctx),
};
