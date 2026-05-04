import { AccessoryBase } from "../AccessoryBase.js";
const SMOKE_CHANNEL_TYPES = [
  "SMOKE_DETECTOR",
  "SMOKE_DETECTOR_COMMUNICATION"
];
class SmokeHandler extends AccessoryBase {
  detected = false;
  attach(channel) {
    const service = this.getOrAddService(this.Service.SmokeSensor, channel.name);
    service.getCharacteristic(this.Characteristic.SmokeDetected).onGet(this.wrapGet(() => this.toHapValue()));
    this.registerListener(channel.address, "STATE", (raw) => {
      this.detected = Boolean(raw);
      service.updateCharacteristic(this.Characteristic.SmokeDetected, this.toHapValue());
    });
    this.ccu.getValue(channel.address, "STATE").then((raw) => {
      this.detected = Boolean(raw);
      service.updateCharacteristic(this.Characteristic.SmokeDetected, this.toHapValue());
    }).catch(() => void 0);
  }
  toHapValue() {
    return this.detected ? this.Characteristic.SmokeDetected.SMOKE_DETECTED : this.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
  }
}
const smokeService = {
  key: "SmokeAccessory",
  description: "Smoke detector",
  channelTypes: SMOKE_CHANNEL_TYPES,
  priority: 10,
  build: (ctx) => new SmokeHandler(ctx)
};
export {
  smokeService
};
//# sourceMappingURL=SmokeAccessory.js.map
