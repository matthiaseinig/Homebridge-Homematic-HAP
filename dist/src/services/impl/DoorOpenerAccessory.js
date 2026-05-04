import { AccessoryBase } from "../AccessoryBase.js";
const DOOR_OPENER_CHANNEL_TYPES = [
  "SWITCH",
  "SWITCH_VIRTUAL_RECEIVER"
];
const SECURED = 1;
const UNSECURED = 0;
const PULSE_MS = 1500;
class DoorOpenerHandler extends AccessoryBase {
  channelAddress = "";
  resetTimer;
  attach(channel) {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.LockMechanism, channel.name);
    service.getCharacteristic(this.Characteristic.LockCurrentState).onGet(this.wrapGet(() => SECURED));
    service.getCharacteristic(this.Characteristic.LockTargetState).onGet(this.wrapGet(() => SECURED)).onSet(this.wrapSet(async (value) => {
      if (value !== UNSECURED) {
        return;
      }
      try {
        await this.ccu.setValue(this.channelAddress, "STATE", true);
      } catch (err) {
        this.log.warn("door-opener pulse failed: %s", err.message);
      }
      service.updateCharacteristic(this.Characteristic.LockCurrentState, UNSECURED);
      if (this.resetTimer) {
        clearTimeout(this.resetTimer);
      }
      this.resetTimer = setTimeout(() => {
        service.updateCharacteristic(this.Characteristic.LockTargetState, SECURED);
        service.updateCharacteristic(this.Characteristic.LockCurrentState, SECURED);
        this.resetTimer = void 0;
      }, PULSE_MS);
      if (this.resetTimer.unref) {
        this.resetTimer.unref();
      }
    }));
  }
  dispose() {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = void 0;
    }
    super.dispose();
  }
}
const doorOpenerService = {
  key: "DoorOpenerAccessory",
  description: "Door opener / electric strike (HomeKit LockMechanism, momentary)",
  channelTypes: DOOR_OPENER_CHANNEL_TYPES,
  priority: 50,
  build: (ctx) => new DoorOpenerHandler(ctx)
};
export {
  doorOpenerService
};
//# sourceMappingURL=DoorOpenerAccessory.js.map
