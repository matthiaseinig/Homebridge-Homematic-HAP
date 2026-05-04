import { AccessoryBase } from "../AccessoryBase.js";
const LEAK_CHANNEL_TYPES = [
  "WATERDETECTIONSENSOR",
  "TILT_SENSOR"
];
class LeakHandler extends AccessoryBase {
  detected = false;
  attach(channel) {
    const service = this.getOrAddService(this.Service.LeakSensor, channel.name);
    service.getCharacteristic(this.Characteristic.LeakDetected).onGet(this.wrapGet(() => this.toHapValue()));
    this.registerListener(channel.address, "STATE", (raw) => {
      this.detected = Boolean(raw);
      service.updateCharacteristic(this.Characteristic.LeakDetected, this.toHapValue());
    });
  }
  toHapValue() {
    return this.detected ? this.Characteristic.LeakDetected.LEAK_DETECTED : this.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
  }
}
const leakService = {
  key: "LeakAccessory",
  description: "Water / leak sensor",
  channelTypes: LEAK_CHANNEL_TYPES,
  priority: 15,
  build: (ctx) => new LeakHandler(ctx)
};
export {
  leakService
};
//# sourceMappingURL=LeakAccessory.js.map
