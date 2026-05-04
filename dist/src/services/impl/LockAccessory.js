import { AccessoryBase } from "../AccessoryBase.js";
const LOCK_CHANNEL_TYPES = [
  "KEYMATIC",
  "LOCK_VIRTUAL_RECEIVER"
];
class LockHandler extends AccessoryBase {
  channelAddress = "";
  current;
  target;
  constructor(ctx) {
    super(ctx);
    this.current = this.Characteristic.LockCurrentState.UNKNOWN;
    this.target = this.Characteristic.LockTargetState.SECURED;
  }
  attach(channel) {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.LockMechanism, channel.name);
    service.getCharacteristic(this.Characteristic.LockCurrentState).onGet(this.wrapGet(() => this.current));
    service.getCharacteristic(this.Characteristic.LockTargetState).onGet(this.wrapGet(() => this.target)).onSet(this.wrapSet(async (value) => {
      this.target = value;
      const stateLocked = value === this.Characteristic.LockTargetState.SECURED;
      await this.ccu.setValue(this.channelAddress, "STATE", !stateLocked);
    }));
    this.registerListener(this.channelAddress, "STATE", (raw) => {
      const unlocked = Boolean(raw);
      this.current = unlocked ? this.Characteristic.LockCurrentState.UNSECURED : this.Characteristic.LockCurrentState.SECURED;
      this.target = unlocked ? this.Characteristic.LockTargetState.UNSECURED : this.Characteristic.LockTargetState.SECURED;
      service.updateCharacteristic(this.Characteristic.LockCurrentState, this.current);
      service.updateCharacteristic(this.Characteristic.LockTargetState, this.target);
    });
    this.registerListener(this.channelAddress, "ERROR", (raw) => {
      const code = Number(raw);
      if (Number.isFinite(code) && code > 0) {
        this.current = this.Characteristic.LockCurrentState.JAMMED;
        service.updateCharacteristic(this.Characteristic.LockCurrentState, this.current);
      }
    });
    this.ccu.getValue(this.channelAddress, "STATE").then((raw) => {
      const unlocked = Boolean(raw);
      this.current = unlocked ? this.Characteristic.LockCurrentState.UNSECURED : this.Characteristic.LockCurrentState.SECURED;
      this.target = unlocked ? this.Characteristic.LockTargetState.UNSECURED : this.Characteristic.LockTargetState.SECURED;
      service.updateCharacteristic(this.Characteristic.LockCurrentState, this.current);
      service.updateCharacteristic(this.Characteristic.LockTargetState, this.target);
    }).catch(() => void 0);
  }
}
const lockService = {
  key: "LockAccessory",
  description: "Door lock (Keymatic / electronic lock)",
  channelTypes: LOCK_CHANNEL_TYPES,
  priority: 10,
  build: (ctx) => new LockHandler(ctx)
};
export {
  lockService
};
//# sourceMappingURL=LockAccessory.js.map
