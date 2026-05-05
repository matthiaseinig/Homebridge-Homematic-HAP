import { AccessoryBase } from "../AccessoryBase.js";
const GARAGE_DOOR_CHANNEL_TYPES = [
  "DOOR",
  "DOOR_OPENER",
  "GARAGE_DOOR",
  // HmIP-MOD-HO exposes a SWITCH-style receiver too; users opt in via
  // the service dropdown on those channels.
  "SWITCH_VIRTUAL_RECEIVER"
];
const CCU_CLOSED = 0;
const CCU_OPEN = 1;
const CCU_VENTILATION = 2;
const CMD_OPEN = 1;
const CMD_CLOSE = 3;
class GarageDoorHandler extends AccessoryBase {
  channelAddress = "";
  current = 1;
  // HAP CLOSED
  target = 1;
  // HAP CLOSED
  travelTimer;
  attach(channel) {
    this.channelAddress = channel.address;
    const settings = this.accessory.context.settings ?? {};
    const travelSeconds = typeof settings.travelSeconds === "number" && Number.isFinite(settings.travelSeconds) && settings.travelSeconds > 0 ? settings.travelSeconds : 25;
    const service = this.getOrAddService(this.Service.GarageDoorOpener, channel.name);
    service.getCharacteristic(this.Characteristic.CurrentDoorState).onGet(this.wrapGet(() => this.current));
    service.getCharacteristic(this.Characteristic.TargetDoorState).onGet(this.wrapGet(() => this.target)).onSet(this.wrapSet(async (value) => {
      const targetOpen = value === this.Characteristic.TargetDoorState.OPEN;
      this.target = value;
      this.current = targetOpen ? this.Characteristic.CurrentDoorState.OPENING : this.Characteristic.CurrentDoorState.CLOSING;
      service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.current);
      if (this.travelTimer) clearTimeout(this.travelTimer);
      this.travelTimer = setTimeout(() => {
        this.current = this.Characteristic.CurrentDoorState.STOPPED;
        service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.current);
        this.travelTimer = void 0;
      }, travelSeconds * 1e3);
      if (this.travelTimer.unref) this.travelTimer.unref();
      try {
        await this.ccu.setValue(this.channelAddress, "DOOR_COMMAND", targetOpen ? CMD_OPEN : CMD_CLOSE);
      } catch (err) {
        this.log.warn("garage-door command failed: %s", err.message);
      }
    }));
    service.getCharacteristic(this.Characteristic.ObstructionDetected).onGet(() => false);
    this.registerListener(this.channelAddress, "DOOR_STATE", (raw) => {
      const v = typeof raw === "number" ? raw : parseInt(String(raw ?? "-1"), 10);
      const next = this.mapCcuToHap(v);
      if (next === void 0) return;
      this.current = next;
      this.target = next === this.Characteristic.CurrentDoorState.CLOSED ? this.Characteristic.TargetDoorState.CLOSED : this.Characteristic.TargetDoorState.OPEN;
      if (this.travelTimer) {
        clearTimeout(this.travelTimer);
        this.travelTimer = void 0;
      }
      service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.current);
      service.updateCharacteristic(this.Characteristic.TargetDoorState, this.target);
    });
    this.ccu.getValue(this.channelAddress, "DOOR_STATE").then((raw) => {
      const v = typeof raw === "number" ? raw : parseInt(String(raw ?? "-1"), 10);
      const next = this.mapCcuToHap(v);
      if (next !== void 0) {
        this.current = next;
        this.target = next === this.Characteristic.CurrentDoorState.CLOSED ? this.Characteristic.TargetDoorState.CLOSED : this.Characteristic.TargetDoorState.OPEN;
        service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.current);
        service.updateCharacteristic(this.Characteristic.TargetDoorState, this.target);
      }
    }).catch(() => void 0);
  }
  /** Translate CCU DOOR_STATE → HAP CurrentDoorState; undefined means "skip". */
  mapCcuToHap(ccu) {
    switch (ccu) {
      case CCU_CLOSED:
        return this.Characteristic.CurrentDoorState.CLOSED;
      case CCU_OPEN:
        return this.Characteristic.CurrentDoorState.OPEN;
      case CCU_VENTILATION:
        return this.Characteristic.CurrentDoorState.OPEN;
      default:
        return void 0;
    }
  }
  dispose() {
    if (this.travelTimer) {
      clearTimeout(this.travelTimer);
      this.travelTimer = void 0;
    }
    super.dispose();
  }
}
const garageDoorService = {
  key: "GarageDoorAccessory",
  description: "Garage door (HomeKit GarageDoorOpener, with travel-time dwell)",
  channelTypes: GARAGE_DOOR_CHANNEL_TYPES,
  // Higher number than SwitchAccessory (10) so a bare SWITCH channel
  // doesn't auto-pick this. Users opt in via the service dropdown.
  priority: 90,
  build: (ctx) => new GarageDoorHandler(ctx)
};
export {
  garageDoorService
};
//# sourceMappingURL=GarageDoorAccessory.js.map
