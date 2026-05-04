import { AccessoryBase } from "../AccessoryBase.js";
const PROGRAMMABLE_SWITCH_CHANNEL_TYPES = [
  "KEY",
  "KEY_TRANSCEIVER",
  "PUSH_BUTTON",
  "BLIND_BUTTON"
];
const SINGLE_PRESS = 0;
const DOUBLE_PRESS = 1;
const LONG_PRESS = 2;
class ProgrammableSwitchHandler extends AccessoryBase {
  lastShortAt = 0;
  attach(channel) {
    const service = this.getOrAddService(this.Service.StatelessProgrammableSwitch, channel.name);
    const eventChar = service.getCharacteristic(this.Characteristic.ProgrammableSwitchEvent);
    this.registerListener(channel.address, "PRESS_SHORT", (raw) => {
      if (!raw) {
        return;
      }
      const now = Date.now();
      if (now - this.lastShortAt < 400) {
        eventChar.updateValue(DOUBLE_PRESS);
        this.lastShortAt = 0;
        return;
      }
      this.lastShortAt = now;
      eventChar.updateValue(SINGLE_PRESS);
    });
    this.registerListener(channel.address, "PRESS_LONG", (raw) => {
      if (raw) {
        eventChar.updateValue(LONG_PRESS);
      }
    });
  }
}
const programmableSwitchService = {
  key: "ProgrammableSwitchAccessory",
  description: "Push button / remote (HomeKit Stateless Programmable Switch)",
  channelTypes: PROGRAMMABLE_SWITCH_CHANNEL_TYPES,
  priority: 10,
  build: (ctx) => new ProgrammableSwitchHandler(ctx)
};
export {
  programmableSwitchService
};
//# sourceMappingURL=ProgrammableSwitchAccessory.js.map
