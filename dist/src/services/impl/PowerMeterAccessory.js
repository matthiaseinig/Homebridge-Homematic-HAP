import { AccessoryBase } from "../AccessoryBase.js";
import { toFiniteNumber } from "../../util/sanitize.js";
const POWER_METER_CHANNEL_TYPES = [
  "ENERGIE_METER_TRANSMITTER",
  "POWERMETER",
  "POWERMETER_IGL"
];
const EVE_VOLTAGE_UUID = "E863F10A-079E-48FF-8F27-9C2605A29F52";
const EVE_ELECTRIC_CURRENT_UUID = "E863F126-079E-48FF-8F27-9C2605A29F52";
const EVE_ELECTRIC_POWER_UUID = "E863F10D-079E-48FF-8F27-9C2605A29F52";
const EVE_TOTAL_CONSUMPTION_UUID = "E863F10C-079E-48FF-8F27-9C2605A29F52";
class PowerMeterHandler extends AccessoryBase {
  channelAddress = "";
  attach(channel) {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.Outlet, channel.name);
    const voltage = this.ensureCustomCharacteristic(
      service,
      EVE_VOLTAGE_UUID,
      "Voltage",
      "V",
      400,
      0.1
    );
    const current = this.ensureCustomCharacteristic(
      service,
      EVE_ELECTRIC_CURRENT_UUID,
      "Electric Current",
      "A",
      100,
      1e-3
    );
    const power = this.ensureCustomCharacteristic(
      service,
      EVE_ELECTRIC_POWER_UUID,
      "Consumption",
      "W",
      3500,
      0.1
    );
    const total = this.ensureCustomCharacteristic(
      service,
      EVE_TOTAL_CONSUMPTION_UUID,
      "Total Consumption",
      "kWh",
      1e6,
      1e-3
    );
    let lastPowerW = 0;
    service.getCharacteristic(this.Characteristic.On).onGet(this.wrapGet(() => lastPowerW > 0));
    service.getCharacteristic(this.Characteristic.OutletInUse).onGet(this.wrapGet(() => lastPowerW > 0.1));
    const subscribe = (datapoint, apply) => {
      this.registerListener(this.channelAddress, datapoint, (raw) => {
        const v = toFiniteNumber(raw);
        if (v !== void 0) apply(v);
      });
      this.ccu.getValue(this.channelAddress, datapoint).then((raw) => {
        const v = toFiniteNumber(raw);
        if (v !== void 0) apply(v);
      }).catch(() => void 0);
    };
    subscribe("VOLTAGE", (v) => voltage.updateValue(round(v, 1)));
    subscribe("CURRENT", (raw) => {
      current.updateValue(round(raw / 1e3, 3));
    });
    subscribe("POWER", (raw) => {
      lastPowerW = raw;
      power.updateValue(round(raw, 1));
      service.updateCharacteristic(this.Characteristic.On, lastPowerW > 0);
      service.updateCharacteristic(this.Characteristic.OutletInUse, lastPowerW > 0.1);
    });
    subscribe("ENERGY_COUNTER", (raw) => {
      total.updateValue(round(raw / 1e3, 3));
    });
  }
  ensureCustomCharacteristic(service, uuid, displayName, unit, maxValue, minStep) {
    const existing = findCharacteristicByUuid(service, uuid);
    if (existing) {
      return existing;
    }
    const props = {
      format: "float",
      perms: [
        "pr",
        "ev"
      ],
      unit,
      minValue: 0,
      maxValue,
      minStep
    };
    const Ctor = this.Characteristic;
    const instance = new Ctor(displayName, uuid, props);
    service.addCharacteristic(instance);
    return instance;
  }
}
function findCharacteristicByUuid(service, uuid) {
  const chars = service.characteristics;
  if (!chars || typeof chars[Symbol.iterator] !== "function") {
    return void 0;
  }
  for (const entry of chars) {
    const ch = Array.isArray(entry) ? entry[1] : entry;
    if (ch && typeof ch === "object" && ch.UUID === uuid) {
      return ch;
    }
  }
  return void 0;
}
function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
const powerMeterService = {
  key: "PowerMeterAccessory",
  description: "Energy meter (Voltage / Current / Power / Total)",
  channelTypes: POWER_METER_CHANNEL_TYPES,
  priority: 10,
  build: (ctx) => new PowerMeterHandler(ctx)
};
export {
  powerMeterService
};
//# sourceMappingURL=PowerMeterAccessory.js.map
