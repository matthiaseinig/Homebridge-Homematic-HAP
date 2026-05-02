import { AccessoryBase } from '../AccessoryBase.js';
import type {
  ChannelService,
  ServiceContext,
  ServiceDefinition,
} from '../types.js';
import type { CcuChannel } from '../../types.js';

const SWITCH_CHANNEL_TYPES = [
  'SWITCH',
  'SWITCH_VIRTUAL_RECEIVER',
  'VIRTUAL_DEVICES_SWITCH',
];

class SwitchHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const subtype = this.accessory.context.subtype ?? 'switch';
    const svcType = subtype === 'outlet'
      ? this.Service.Outlet
      : subtype === 'lightbulb'
        ? this.Service.Lightbulb
        : this.Service.Switch;

    const service = this.getOrAddService(svcType, channel.name);

    let cachedOn = false;
    service.getCharacteristic(this.Characteristic.On)
      .onGet(this.wrapGet<boolean>(() => cachedOn))
      .onSet(this.wrapSet<boolean>(async (value) => {
        cachedOn = value;
        await this.ccu.setValue(this.channelAddress, 'STATE', value);
      }));

    this.registerListener(this.channelAddress, 'STATE', (raw) => {
      const v = Boolean(raw);
      cachedOn = v;
      service.updateCharacteristic(this.Characteristic.On, v);
    });

    // Best-effort initial value pull. Ignored if it fails.
    this.ccu.getValue(this.channelAddress, 'STATE').then((v) => {
      cachedOn = Boolean(v);
      service.updateCharacteristic(this.Characteristic.On, cachedOn);
    }).catch(() => undefined);
  }
}

export const switchService: ServiceDefinition = {
  key: 'SwitchAccessory',
  description: 'Binary switch (Switch / Outlet / Lightbulb)',
  channelTypes: SWITCH_CHANNEL_TYPES,
  priority: 10,
  variants: [
    { id: 'switch', label: 'Switch', hapServices: ['Switch'] },
    { id: 'outlet', label: 'Outlet', hapServices: ['Outlet'] },
    { id: 'lightbulb', label: 'Lightbulb', hapServices: ['Lightbulb'] },
  ],
  build: (ctx: ServiceContext) => new SwitchHandler(ctx),
};
