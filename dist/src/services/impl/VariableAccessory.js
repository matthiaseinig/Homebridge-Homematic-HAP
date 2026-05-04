import { AccessoryBase } from "../AccessoryBase.js";
class VariableSwitchHandler extends AccessoryBase {
  value = false;
  name = "";
  pollHandle;
  attach(variable) {
    this.name = variable.name;
    this.value = Boolean(variable.value);
    const service = this.getOrAddService(this.Service.Switch, this.name);
    service.getCharacteristic(this.Characteristic.On).onGet(this.wrapGet(() => this.value)).onSet(this.wrapSet(async (v) => {
      this.value = v;
      await this.ccu.api.setVariable(this.name, v);
    }));
    this.pollHandle = setInterval(() => this.poll(service), 6e4);
    if (this.pollHandle.unref) {
      this.pollHandle.unref();
    }
  }
  async poll(service) {
    try {
      const text = await this.ccu.api.getVariable(this.name);
      const v = text === "true" || text === "1";
      if (v !== this.value) {
        this.value = v;
        service.updateCharacteristic(this.Characteristic.On, v);
      }
    } catch {
    }
  }
  dispose() {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = void 0;
    }
    super.dispose();
  }
}
class VariableLightHandler extends AccessoryBase {
  value = 0;
  name = "";
  min = 0;
  max = 100;
  pollHandle;
  attach(variable) {
    this.name = variable.name;
    this.min = variable.minValue ?? 0;
    this.max = variable.maxValue ?? 100;
    const initial = typeof variable.value === "number" ? variable.value : 0;
    this.value = initial;
    const service = this.getOrAddService(this.Service.Lightbulb, this.name);
    service.getCharacteristic(this.Characteristic.On).onGet(this.wrapGet(() => this.value > this.min));
    service.getCharacteristic(this.Characteristic.Brightness).setProps({ minValue: this.min, maxValue: this.max, minStep: 1 }).onGet(this.wrapGet(() => this.value)).onSet(this.wrapSet(async (v) => {
      const clamped = Math.max(this.min, Math.min(this.max, Math.round(v)));
      this.value = clamped;
      await this.ccu.api.setVariable(this.name, clamped);
    }));
    this.pollHandle = setInterval(() => this.poll(service), 6e4);
    if (this.pollHandle.unref) {
      this.pollHandle.unref();
    }
  }
  async poll(service) {
    try {
      const text = await this.ccu.api.getVariable(this.name);
      const v = parseFloat(text);
      if (Number.isFinite(v) && v !== this.value) {
        this.value = v;
        service.updateCharacteristic(this.Characteristic.On, v > this.min);
        service.updateCharacteristic(this.Characteristic.Brightness, v);
      }
    } catch {
    }
  }
  dispose() {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = void 0;
    }
    super.dispose();
  }
}
const variableSwitchService = {
  key: "VariableSwitchAccessory",
  description: "Boolean CCU variable as Switch",
  forValueType: 2,
  priority: 10,
  build: (ctx) => new VariableSwitchHandler(ctx)
};
const variableLightService = {
  key: "VariableLightAccessory",
  description: "Numeric CCU variable as Lightbulb",
  forValueType: 4,
  priority: 10,
  build: (ctx) => new VariableLightHandler(ctx)
};
export {
  variableLightService,
  variableSwitchService
};
//# sourceMappingURL=VariableAccessory.js.map
