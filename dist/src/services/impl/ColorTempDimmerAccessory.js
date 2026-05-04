import { AccessoryBase } from "../AccessoryBase.js";
import { normalizeLevelToPercent, percentToLevelFraction } from "../../util/sanitize.js";
const COLOR_TEMP_CHANNEL_TYPES = [
  "DIMMER_VIRTUAL_RECEIVER",
  "DUAL_WHITE_BRIGHTNESS"
];
const HK_MIRED_MIN = 140;
const HK_MIRED_MAX = 500;
const HK_MIRED_RANGE = HK_MIRED_MAX - HK_MIRED_MIN;
function deriveColortempAddress(brightnessAddress) {
  const colon = brightnessAddress.lastIndexOf(":");
  if (colon === -1) {
    return void 0;
  }
  const idx = Number.parseInt(brightnessAddress.slice(colon + 1), 10);
  if (!Number.isFinite(idx)) {
    return void 0;
  }
  return `${brightnessAddress.slice(0, colon)}:${idx + 1}`;
}
class ColorTempDimmerHandler extends AccessoryBase {
  brightnessAddress = "";
  coltempAddress = "";
  cachedLevel = 0;
  cachedMired = HK_MIRED_MIN;
  attach(channel) {
    this.brightnessAddress = channel.address;
    const settings = this.accessory.context.settings ?? {};
    const explicit = typeof settings.coltempAddress === "string" ? settings.coltempAddress : void 0;
    this.coltempAddress = explicit ?? deriveColortempAddress(channel.address) ?? "";
    const service = this.getOrAddService(this.Service.Lightbulb, channel.name);
    service.getCharacteristic(this.Characteristic.On).onGet(this.wrapGet(() => this.cachedLevel > 0)).onSet(this.wrapSet(async (value) => {
      const pct = value ? Math.max(this.cachedLevel, 1) : 0;
      await this.ccu.setValue(this.brightnessAddress, "LEVEL", percentToLevelFraction(pct));
    }));
    service.getCharacteristic(this.Characteristic.Brightness).onGet(this.wrapGet(() => this.cachedLevel)).onSet(this.wrapSet(async (value) => {
      const pct = normalizeLevelToPercent(value) ?? 0;
      this.cachedLevel = pct;
      await this.ccu.setValue(this.brightnessAddress, "LEVEL", percentToLevelFraction(pct));
    }));
    if (this.coltempAddress) {
      service.getCharacteristic(this.Characteristic.ColorTemperature).setProps({ minValue: HK_MIRED_MIN, maxValue: HK_MIRED_MAX, minStep: 1 }).onGet(this.wrapGet(() => this.cachedMired)).onSet(this.wrapSet(async (value) => {
        this.cachedMired = value;
        const fraction = (value - HK_MIRED_MIN) / HK_MIRED_RANGE;
        await this.ccu.setValue(this.coltempAddress, "LEVEL", fraction);
      }));
      this.registerListener(this.coltempAddress, "LEVEL", (raw) => {
        const fraction = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
        if (!Number.isFinite(fraction)) {
          return;
        }
        const clamped = Math.max(0, Math.min(1, fraction));
        this.cachedMired = HK_MIRED_MIN + clamped * HK_MIRED_RANGE;
        service.updateCharacteristic(this.Characteristic.ColorTemperature, this.cachedMired);
      });
      this.ccu.getValue(this.coltempAddress, "LEVEL").then((raw) => {
        const fraction = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
        if (!Number.isFinite(fraction)) return;
        const clamped = Math.max(0, Math.min(1, fraction));
        this.cachedMired = HK_MIRED_MIN + clamped * HK_MIRED_RANGE;
        service.updateCharacteristic(this.Characteristic.ColorTemperature, this.cachedMired);
      }).catch(() => void 0);
    }
    this.registerListener(this.brightnessAddress, "LEVEL", (raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === void 0) {
        return;
      }
      this.cachedLevel = pct;
      service.updateCharacteristic(this.Characteristic.On, pct > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, pct);
    });
    this.ccu.getValue(this.brightnessAddress, "LEVEL").then((raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === void 0) return;
      this.cachedLevel = pct;
      service.updateCharacteristic(this.Characteristic.On, pct > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, pct);
    }).catch(() => void 0);
  }
}
const colorTempDimmerService = {
  key: "ColorTempDimmerAccessory",
  description: "Tunable-white dimmer (brightness + color temperature)",
  channelTypes: COLOR_TEMP_CHANNEL_TYPES,
  // Lower priority than the plain dimmer — the user opts in by picking
  // this service explicitly in the UI.
  priority: 50,
  build: (ctx) => new ColorTempDimmerHandler(ctx)
};
const _testing = { deriveColortempAddress };
export {
  _testing,
  colorTempDimmerService
};
//# sourceMappingURL=ColorTempDimmerAccessory.js.map
