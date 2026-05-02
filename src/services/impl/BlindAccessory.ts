import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';

const BLIND_CHANNEL_TYPES = [
  'BLIND',
  'BLIND_VIRTUAL_RECEIVER',
  'SHUTTER_VIRTUAL_RECEIVER',
];

const STATE_STOPPED = 2;
const STATE_INCREASING = 1;
const STATE_DECREASING = 0;

class BlindHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private current = 0;
  private target = 0;

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.WindowCovering, channel.name);

    service.getCharacteristic(this.Characteristic.CurrentPosition)
      .onGet(this.wrapGet<number>(() => this.current));

    service.getCharacteristic(this.Characteristic.TargetPosition)
      .onGet(this.wrapGet<number>(() => this.target))
      .onSet(this.wrapSet<number>(async (value) => {
        const clamped = Math.max(0, Math.min(100, Math.round(value)));
        this.target = clamped;
        await this.ccu.setValue(this.channelAddress, 'LEVEL', clamped / 100);
      }));

    service.getCharacteristic(this.Characteristic.PositionState)
      .onGet(this.wrapGet<number>(() => this.derivePositionState()));

    this.registerListener(this.channelAddress, 'LEVEL', (raw) => {
      const v = typeof raw === 'number' ? raw : parseFloat(String(raw));
      if (!Number.isFinite(v)) {
        return;
      }
      const pct = Math.max(0, Math.min(100, Math.round(v * 100)));
      this.current = pct;
      this.target = pct;
      service.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
      service.updateCharacteristic(this.Characteristic.TargetPosition, pct);
      service.updateCharacteristic(this.Characteristic.PositionState, this.derivePositionState());
    });

    this.registerListener(this.channelAddress, 'WORKING', (raw) => {
      const moving = Boolean(raw);
      service.updateCharacteristic(
        this.Characteristic.PositionState,
        moving ? this.derivePositionState() : STATE_STOPPED,
      );
    });
  }

  private derivePositionState(): number {
    if (this.target > this.current) {
      return STATE_INCREASING;
    }
    if (this.target < this.current) {
      return STATE_DECREASING;
    }
    return STATE_STOPPED;
  }
}

export const blindService: ServiceDefinition = {
  key: 'BlindAccessory',
  description: 'Window covering / blind / shutter',
  channelTypes: BLIND_CHANNEL_TYPES,
  priority: 10,
  build: (ctx: ServiceContext) => new BlindHandler(ctx),
};
