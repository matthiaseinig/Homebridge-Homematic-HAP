import { AccessoryBase } from "../AccessoryBase.js";
const CONTACT_CHANNEL_TYPES = [
  "SHUTTER_CONTACT",
  "ROTARY_HANDLE_SENSOR",
  "CONTACT_INTERFACE_TRANSMITTER",
  "TILT_SENSOR"
];
class ContactHandler extends AccessoryBase {
  state = false;
  attach(channel) {
    const subtype = this.accessory.context.subtype ?? "contact";
    const svcType = subtype === "door" ? this.Service.Door : subtype === "window" ? this.Service.Window : this.Service.ContactSensor;
    const service = this.getOrAddService(svcType, channel.name);
    if (svcType === this.Service.ContactSensor) {
      service.getCharacteristic(this.Characteristic.ContactSensorState).onGet(this.wrapGet(
        () => this.state ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : this.Characteristic.ContactSensorState.CONTACT_DETECTED
      ));
    } else {
      service.getCharacteristic(this.Characteristic.CurrentPosition).onGet(this.wrapGet(() => this.state ? 100 : 0));
      service.getCharacteristic(this.Characteristic.TargetPosition).onGet(this.wrapGet(() => this.state ? 100 : 0));
      service.getCharacteristic(this.Characteristic.PositionState).onGet(this.wrapGet(() => 2));
    }
    const applyState = (s) => {
      this.state = s;
      if (svcType === this.Service.ContactSensor) {
        service.updateCharacteristic(
          this.Characteristic.ContactSensorState,
          s ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : this.Characteristic.ContactSensorState.CONTACT_DETECTED
        );
      } else {
        const pct = s ? 100 : 0;
        service.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
        service.updateCharacteristic(this.Characteristic.TargetPosition, pct);
      }
    };
    this.registerListener(channel.address, "STATE", (raw) => applyState(Boolean(raw)));
    this.ccu.getValue(channel.address, "STATE").then((raw) => applyState(Boolean(raw))).catch(() => void 0);
    this.attachBattery(channel.address);
  }
}
const contactService = {
  key: "ContactAccessory",
  description: "Door / window contact sensor",
  channelTypes: CONTACT_CHANNEL_TYPES,
  priority: 10,
  variants: [
    { id: "contact", label: "Contact sensor", hapServices: ["ContactSensor"] },
    { id: "door", label: "Door", hapServices: ["Door"] },
    { id: "window", label: "Window", hapServices: ["Window"] }
  ],
  build: (ctx) => new ContactHandler(ctx)
};
export {
  contactService
};
//# sourceMappingURL=ContactAccessory.js.map
