class AccessoryBase {
  accessory;
  ccu;
  log;
  Service;
  Characteristic;
  disposers = [];
  constructor(ctx) {
    this.accessory = ctx.accessory;
    this.ccu = ctx.ccu;
    this.log = ctx.log;
    this.Service = ctx.Service;
    this.Characteristic = ctx.Characteristic;
  }
  getOrAddService(svc, name, subtype) {
    const existing = subtype === void 0 ? this.accessory.getService(svc) : this.accessory.getServiceById(svc, subtype);
    if (existing) {
      if (name !== void 0) {
        existing.setCharacteristic(this.Characteristic.Name, name);
      }
      return existing;
    }
    const instance = subtype === void 0 ? new svc(name ?? this.accessory.displayName) : new svc(
      name ?? this.accessory.displayName,
      subtype
    );
    return this.accessory.addService(instance);
  }
  /**
   * Attach a listener for a CCU datapoint on this accessory. Returns a
   * disposer that is also tracked for automatic cleanup in dispose().
   */
  registerListener(address, datapoint, listener) {
    const key = `${address}.${datapoint}`;
    const off = this.ccu.registerListener(key, listener);
    this.disposers.push(off);
    return off;
  }
  /** Tracked async setter that maps thrown errors to a HAP-friendly fault. */
  wrapSet(handler) {
    return async (value) => {
      try {
        await handler(value);
      } catch (err) {
        this.log.warn("setValue failed: %s", err.message);
        throw err;
      }
    };
  }
  wrapGet(handler) {
    return async () => {
      try {
        const v = await handler();
        return v;
      } catch (err) {
        this.log.debug("getValue cache miss: %s", err.message);
        throw err;
      }
    };
  }
  /**
   * Attach a HAP BatteryService that mirrors the device-level LOW_BAT
   * datapoint (and OPERATING_VOLTAGE / BATTERY_STATE if exposed) into
   * HomeKit's StatusLowBattery + BatteryLevel characteristics.
   *
   * Battery datapoints live on the **device** channel (`:0`), not on
   * any feature channel, so we strip the channel suffix from the
   * address we were given.
   *
   * Best-effort: if the device doesn't actually expose a battery
   * datapoint, the listeners are dormant and the service shows the
   * default "battery OK" state. Mains-powered devices simply shouldn't
   * call this.
   */
  attachBattery(featureChannelAddress) {
    const colon = featureChannelAddress.lastIndexOf(":");
    const deviceAddress = colon === -1 ? `${featureChannelAddress}:0` : `${featureChannelAddress.slice(0, colon)}:0`;
    const service = this.getOrAddService(this.Service.Battery, void 0, "battery");
    let lowBat = false;
    let level = 100;
    service.getCharacteristic(this.Characteristic.StatusLowBattery).onGet(this.wrapGet(() => lowBat ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL));
    service.getCharacteristic(this.Characteristic.BatteryLevel).setProps({ minValue: 0, maxValue: 100, minStep: 1 }).onGet(this.wrapGet(() => level));
    service.getCharacteristic(this.Characteristic.ChargingState).onGet(() => this.Characteristic.ChargingState.NOT_CHARGEABLE);
    const applyLow = (raw) => {
      lowBat = raw === true || raw === 1 || raw === "1" || raw === "true";
      service.updateCharacteristic(
        this.Characteristic.StatusLowBattery,
        lowBat ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );
    };
    const applyVoltage = (raw) => {
      const v = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
      if (!Number.isFinite(v)) return;
      const pct = Math.min(100, Math.max(0, Math.round((v - 2.4) / (3.2 - 2.4) * 100)));
      level = pct;
      service.updateCharacteristic(this.Characteristic.BatteryLevel, pct);
    };
    this.registerListener(deviceAddress, "LOW_BAT", applyLow);
    this.registerListener(deviceAddress, "LOWBAT", applyLow);
    this.registerListener(deviceAddress, "OPERATING_VOLTAGE", applyVoltage);
    this.ccu.getValue(deviceAddress, "LOW_BAT").then(applyLow).catch(() => void 0);
    this.ccu.getValue(deviceAddress, "OPERATING_VOLTAGE").then(applyVoltage).catch(() => void 0);
  }
  dispose() {
    while (this.disposers.length > 0) {
      const fn = this.disposers.pop();
      try {
        fn?.();
      } catch (err) {
        this.log.debug("dispose listener error: %s", err.message);
      }
    }
  }
}
export {
  AccessoryBase
};
//# sourceMappingURL=AccessoryBase.js.map
