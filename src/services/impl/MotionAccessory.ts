import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';

const MOTION_CHANNEL_TYPES = [
  'MOTIONDETECTOR',
  'MOTION_DETECTOR',
  'MOTIONDETECTOR_TRANSCEIVER',
  'MOTIONDETECTOR_PRECISE',
];

class MotionHandler extends AccessoryBase implements ChannelService {
  private detected = false;

  attach(channel: CcuChannel): void {
    const service = this.getOrAddService(this.Service.MotionSensor, channel.name);

    service.getCharacteristic(this.Characteristic.MotionDetected)
      .onGet(this.wrapGet<boolean>(() => this.detected));

    this.registerListener(channel.address, 'MOTION', (raw) => {
      this.detected = Boolean(raw);
      service.updateCharacteristic(this.Characteristic.MotionDetected, this.detected);
    });
  }
}

export const motionService: ServiceDefinition = {
  key: 'MotionAccessory',
  description: 'Motion sensor',
  channelTypes: MOTION_CHANNEL_TYPES,
  priority: 10,
  build: (ctx: ServiceContext) => new MotionHandler(ctx),
};
