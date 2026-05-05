import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';

const SMOKE_CHANNEL_TYPES = [
  'SMOKE_DETECTOR',
  'SMOKE_DETECTOR_COMMUNICATION',
];

class SmokeHandler extends AccessoryBase implements ChannelService {
  private detected = false;

  attach(channel: CcuChannel): void {
    const service = this.getOrAddService(this.Service.SmokeSensor, channel.name);

    service.getCharacteristic(this.Characteristic.SmokeDetected)
      .onGet(this.wrapGet<number>(() => this.toHapValue()));

    this.registerListener(channel.address, 'STATE', (raw) => {
      this.detected = Boolean(raw);
      service.updateCharacteristic(this.Characteristic.SmokeDetected, this.toHapValue());
    });

    this.ccu.getValue(channel.address, 'STATE').then((raw) => {
      this.detected = Boolean(raw);
      service.updateCharacteristic(this.Characteristic.SmokeDetected, this.toHapValue());
    }).catch(() => undefined);

    this.attachBattery(channel.address);
  }

  private toHapValue(): number {
    return this.detected
      ? this.Characteristic.SmokeDetected.SMOKE_DETECTED
      : this.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
  }
}

export const smokeService: ServiceDefinition = {
  key: 'SmokeAccessory',
  description: 'Smoke detector',
  channelTypes: SMOKE_CHANNEL_TYPES,
  priority: 10,
  build: (ctx: ServiceContext) => new SmokeHandler(ctx),
};
