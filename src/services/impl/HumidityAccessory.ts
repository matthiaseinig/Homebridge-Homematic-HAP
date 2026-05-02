import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';

const HUMIDITY_CHANNEL_TYPES = [
  'WEATHER',
  'WEATHER_TRANSMIT',
  'CLIMATE_TRANSCEIVER',
  'HUMIDITY_SENSOR',
];

class HumidityHandler extends AccessoryBase implements ChannelService {
  private value = 50;

  attach(channel: CcuChannel): void {
    const service = this.getOrAddService(this.Service.HumiditySensor, channel.name);

    service.getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
      .onGet(this.wrapGet<number>(() => this.value));

    this.registerListener(channel.address, 'HUMIDITY', (raw) => {
      const v = typeof raw === 'number' ? raw : parseFloat(String(raw));
      if (Number.isFinite(v)) {
        this.value = Math.max(0, Math.min(100, Math.round(v)));
        service.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, this.value);
      }
    });
  }
}

export const humidityService: ServiceDefinition = {
  key: 'HumidityAccessory',
  description: 'Humidity sensor',
  channelTypes: HUMIDITY_CHANNEL_TYPES,
  priority: 30,
  build: (ctx: ServiceContext) => new HumidityHandler(ctx),
};
