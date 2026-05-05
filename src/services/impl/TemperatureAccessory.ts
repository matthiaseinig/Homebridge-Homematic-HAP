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

class TemperatureHandler extends AccessoryBase implements ChannelService {
  private value = 20;

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

    this.attachBattery(channel.address);
  }
}

export const temperatureService: ServiceDefinition = {
  key: 'TemperatureAccessory',
  description: 'Temperature sensor',
  channelTypes: TEMP_CHANNEL_TYPES,
  priority: 20,
  build: (ctx: ServiceContext) => new TemperatureHandler(ctx),
};
