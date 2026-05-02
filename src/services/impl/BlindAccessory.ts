import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
import { normalizeLevelToPercent, percentToLevelFraction } from '../../util/sanitize.js';

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
        const pct = normalizeLevelToPercent(value) ?? 0;
        this.target = pct;
        await this.ccu.setValue(this.channelAddress, 'LEVEL', percentToLevelFraction(pct));
      }));

    service.getCharacteristic(this.Characteristic.PositionState)
      .onGet(this.wrapGet<number>(() => this.derivePositionState()));

    this.registerListener(this.channelAddress, 'LEVEL', (raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === undefined) {
        return;
      }
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
