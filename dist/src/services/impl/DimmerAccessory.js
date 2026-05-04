import { AccessoryBase } from "../AccessoryBase.js";
import { normalizeLevelToPercent, percentToLevelFraction } from "../../util/sanitize.js";
const DIMMER_CHANNEL_TYPES = [
  "DIMMER",
  "DIMMER_VIRTUAL_RECEIVER"
];
class DimmerHandler extends AccessoryBase {
  channelAddress = "";
  cachedLevel = 0;
  attach(channel) {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.Lightbulb, channel.name);
    service.getCharacteristic(this.Characteristic.On).onGet(this.wrapGet(() => this.cachedLevel > 0)).onSet(this.wrapSet(async (value) => {
      const pct = value ? Math.max(this.cachedLevel, 1) : 0;
      await this.ccu.setValue(this.channelAddress, "LEVEL", percentToLevelFraction(pct));
    }));
    service.getCharacteristic(this.Characteristic.Brightness).onGet(this.wrapGet(() => this.cachedLevel)).onSet(this.wrapSet(async (value) => {
      const pct = normalizeLevelToPercent(value) ?? 0;
      this.cachedLevel = pct;
      await this.ccu.setValue(this.channelAddress, "LEVEL", percentToLevelFraction(pct));
    }));
    this.registerListener(this.channelAddress, "LEVEL", (raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === void 0) {
        return;
      }
      this.cachedLevel = pct;
      service.updateCharacteristic(this.Characteristic.On, pct > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, pct);
    });
    this.ccu.getValue(this.channelAddress, "LEVEL").then((raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === void 0) {
        return;
      }
      this.cachedLevel = pct;
      service.updateCharacteristic(this.Characteristic.On, pct > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, pct);
    }).catch(() => void 0);
  }
}
const dimmerService = {
  key: "DimmerAccessory",
  description: "Dimmable light",
  channelTypes: DIMMER_CHANNEL_TYPES,
  priority: 10,
  build: (ctx) => new DimmerHandler(ctx)
};
export {
  dimmerService
};
//# sourceMappingURL=DimmerAccessory.js.map
