import { AccessoryBase } from "../AccessoryBase.js";
const MOTION_CHANNEL_TYPES = [
  "MOTIONDETECTOR",
  "MOTION_DETECTOR",
  "MOTIONDETECTOR_TRANSCEIVER",
  "MOTIONDETECTOR_PRECISE"
];
class MotionHandler extends AccessoryBase {
  detected = false;
  attach(channel) {
    const service = this.getOrAddService(this.Service.MotionSensor, channel.name);
    service.getCharacteristic(this.Characteristic.MotionDetected).onGet(this.wrapGet(() => this.detected));
    this.registerListener(channel.address, "MOTION", (raw) => {
      this.detected = Boolean(raw);
      service.updateCharacteristic(this.Characteristic.MotionDetected, this.detected);
    });
  }
}
const motionService = {
  key: "MotionAccessory",
  description: "Motion sensor",
  channelTypes: MOTION_CHANNEL_TYPES,
  priority: 10,
  build: (ctx) => new MotionHandler(ctx)
};
export {
  motionService
};
//# sourceMappingURL=MotionAccessory.js.map
