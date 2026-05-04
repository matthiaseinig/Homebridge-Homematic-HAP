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
