import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';

const DIMMER_CHANNEL_TYPES = [
  'DIMMER',
  'DIMMER_VIRTUAL_RECEIVER',
];

class DimmerHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private cachedLevel = 0;

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.Lightbulb, channel.name);

    service.getCharacteristic(this.Characteristic.On)
      .onGet(this.wrapGet<boolean>(() => this.cachedLevel > 0))
      .onSet(this.wrapSet<boolean>(async (value) => {
        const level = value ? Math.max(this.cachedLevel, 1) : 0;
        await this.ccu.setValue(this.channelAddress, 'LEVEL', level / 100);
      }));

    service.getCharacteristic(this.Characteristic.Brightness)
      .onGet(this.wrapGet<number>(() => this.cachedLevel))
      .onSet(this.wrapSet<number>(async (value) => {
        const clamped = Math.max(0, Math.min(100, Math.round(value)));
        this.cachedLevel = clamped;
        await this.ccu.setValue(this.channelAddress, 'LEVEL', clamped / 100);
      }));

    this.registerListener(this.channelAddress, 'LEVEL', (raw) => {
      const v = typeof raw === 'number' ? raw : parseFloat(String(raw));
      if (!Number.isFinite(v)) {
        return;
      }
      this.cachedLevel = Math.max(0, Math.min(100, Math.round(v * 100)));
      service.updateCharacteristic(this.Characteristic.On, this.cachedLevel > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, this.cachedLevel);
    });

    this.ccu.getValue(this.channelAddress, 'LEVEL').then((raw) => {
      const v = typeof raw === 'number' ? raw : parseFloat(String(raw));
      if (Number.isFinite(v)) {
        this.cachedLevel = Math.max(0, Math.min(100, Math.round(v * 100)));
        service.updateCharacteristic(this.Characteristic.On, this.cachedLevel > 0);
        service.updateCharacteristic(this.Characteristic.Brightness, this.cachedLevel);
      }
    }).catch(() => undefined);
  }
}

export const dimmerService: ServiceDefinition = {
  key: 'DimmerAccessory',
  description: 'Dimmable light',
  channelTypes: DIMMER_CHANNEL_TYPES,
  priority: 10,
  build: (ctx: ServiceContext) => new DimmerHandler(ctx),
};
