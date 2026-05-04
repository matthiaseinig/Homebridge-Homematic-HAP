import { AccessoryBase } from "../AccessoryBase.js";
import { normalizeLevelToPercent, percentToLevelFraction } from "../../util/sanitize.js";
const RGB_CHANNEL_TYPES = [
  "RGBW_COLOR",
  "DIMMER_VIRTUAL_RECEIVER"
];
const HMIP_BSL_COLOR_TO_HUE = {
  0: 0,
  // BLACK — represented as hue 0 / saturation 0 in HomeKit
  1: 246,
  // BLUE
  2: 111,
  // GREEN
  3: 176,
  // TURQUOISE
  4: 0,
  // RED
  5: 319,
  // PURPLE
  6: 49,
  // YELLOW
  7: 0
  // WHITE — represented as hue 0 / saturation 0
};
function snapHueToBslIndex(hue, sat) {
  if (sat < 10) {
    return 7;
  }
  let bestIdx = 1;
  let bestDist = 360;
  for (const [idx, h] of Object.entries(HMIP_BSL_COLOR_TO_HUE)) {
    const i = Number(idx);
    if (i === 0 || i === 7) continue;
    const d = Math.min(Math.abs(hue - h), 360 - Math.abs(hue - h));
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}
class RgbLightHandler extends AccessoryBase {
  channelAddress = "";
  cachedLevel = 0;
  cachedHue = 0;
  cachedSat = 0;
  discrete = false;
  attach(channel) {
    this.channelAddress = channel.address;
    this.discrete = (this.accessory.context.subtype ?? "continuous") === "discrete";
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
    service.getCharacteristic(this.Characteristic.Hue).onGet(this.wrapGet(() => this.cachedHue)).onSet(this.wrapSet(async (value) => {
      this.cachedHue = value;
      await this.writeColor();
    }));
    service.getCharacteristic(this.Characteristic.Saturation).onGet(this.wrapGet(() => this.cachedSat)).onSet(this.wrapSet(async (value) => {
      this.cachedSat = value;
      await this.writeColor();
    }));
    this.registerListener(this.channelAddress, "LEVEL", (raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === void 0) return;
      this.cachedLevel = pct;
      service.updateCharacteristic(this.Characteristic.On, pct > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, pct);
    });
    this.registerListener(this.channelAddress, "COLOR", (raw) => {
      const num = Number(raw);
      if (!Number.isFinite(num)) return;
      this.applyColorFromCcu(num);
      service.updateCharacteristic(this.Characteristic.Hue, this.cachedHue);
      service.updateCharacteristic(this.Characteristic.Saturation, this.cachedSat);
    });
    this.ccu.getValue(this.channelAddress, "LEVEL").then((raw) => {
      const pct = normalizeLevelToPercent(raw);
      if (pct === void 0) return;
      this.cachedLevel = pct;
      service.updateCharacteristic(this.Characteristic.On, pct > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, pct);
    }).catch(() => void 0);
    this.ccu.getValue(this.channelAddress, "COLOR").then((raw) => {
      const num = Number(raw);
      if (!Number.isFinite(num)) return;
      this.applyColorFromCcu(num);
      service.updateCharacteristic(this.Characteristic.Hue, this.cachedHue);
      service.updateCharacteristic(this.Characteristic.Saturation, this.cachedSat);
    }).catch(() => void 0);
  }
  applyColorFromCcu(num) {
    if (this.discrete) {
      const hue = HMIP_BSL_COLOR_TO_HUE[Math.round(num)] ?? 0;
      this.cachedHue = hue;
      this.cachedSat = Math.round(num) === 0 || Math.round(num) === 7 ? 0 : 100;
    } else {
      if (num >= 200) {
        this.cachedHue = 0;
        this.cachedSat = 0;
      } else {
        this.cachedHue = num / 199 * 360;
        this.cachedSat = 100;
      }
    }
  }
  async writeColor() {
    if (this.discrete) {
      const idx = snapHueToBslIndex(this.cachedHue, this.cachedSat);
      await this.ccu.setValue(this.channelAddress, "COLOR", idx);
    } else {
      const colorVal = this.cachedSat < 10 ? 200 : Math.round(this.cachedHue / 360 * 199);
      await this.ccu.setValue(this.channelAddress, "COLOR", colorVal);
    }
  }
}
const rgbLightService = {
  key: "RgbLightAccessory",
  description: "Coloured light (RGB / HmIP-BSL discrete colours)",
  channelTypes: RGB_CHANNEL_TYPES,
  // Lower priority than the plain dimmer / switch — user opts in.
  priority: 60,
  variants: [
    { id: "continuous", label: "Continuous (HM-LC-RGBW-WM)" },
    { id: "discrete", label: "Discrete 7-colour (HmIP-BSL)" }
  ],
  build: (ctx) => new RgbLightHandler(ctx)
};
const _testing = { snapHueToBslIndex, HMIP_BSL_COLOR_TO_HUE };
export {
  _testing,
  rgbLightService
};
//# sourceMappingURL=RgbLightAccessory.js.map
