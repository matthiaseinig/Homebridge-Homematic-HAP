import { AccessoryBase } from '../AccessoryBase.js';
import type {
  ServiceContext,
  VariableService,
  VariableServiceDefinition,
} from '../types.js';
import type { CcuVariable } from '../../types.js';

class VariableSwitchHandler extends AccessoryBase implements VariableService {
  private value = false;
  private name = '';
  private pollHandle: NodeJS.Timeout | undefined;

  attach(variable: CcuVariable): void {
    this.name = variable.name;
    this.value = Boolean(variable.value);
    const service = this.getOrAddService(this.Service.Switch, this.name);

    service.getCharacteristic(this.Characteristic.On)
      .onGet(this.wrapGet<boolean>(() => this.value))
      .onSet(this.wrapSet<boolean>(async (v) => {
        this.value = v;
        await this.ccu.api.setVariable(this.name, v);
      }));

    // Variables don't push events, so we poll. Slow cadence: every 60s.
    this.pollHandle = setInterval(() => this.poll(service), 60_000);
    if (this.pollHandle.unref) {
      this.pollHandle.unref();
    }
  }

  private async poll(service: ReturnType<AccessoryBase['getOrAddService']>): Promise<void> {
    try {
      const text = await this.ccu.api.getVariable(this.name);
      const v = text === 'true' || text === '1';
      if (v !== this.value) {
        this.value = v;
        service.updateCharacteristic(this.Characteristic.On, v);
      }
    } catch {
      // Ignored — next poll will retry.
    }
  }

  override dispose(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
    super.dispose();
  }
}

class VariableLightHandler extends AccessoryBase implements VariableService {
  private value = 0;
  private name = '';
  private min = 0;
  private max = 100;
  private pollHandle: NodeJS.Timeout | undefined;

  attach(variable: CcuVariable): void {
    this.name = variable.name;
    this.min = variable.minValue ?? 0;
    this.max = variable.maxValue ?? 100;
    const initial = typeof variable.value === 'number' ? variable.value : 0;
    this.value = initial;

    const service = this.getOrAddService(this.Service.Lightbulb, this.name);

    service.getCharacteristic(this.Characteristic.On)
      .onGet(this.wrapGet<boolean>(() => this.value > this.min));

    service.getCharacteristic(this.Characteristic.Brightness)
      .setProps({ minValue: this.min, maxValue: this.max, minStep: 1 })
      .onGet(this.wrapGet<number>(() => this.value))
      .onSet(this.wrapSet<number>(async (v) => {
        const clamped = Math.max(this.min, Math.min(this.max, Math.round(v)));
        this.value = clamped;
        await this.ccu.api.setVariable(this.name, clamped);
      }));

    this.pollHandle = setInterval(() => this.poll(service), 60_000);
    if (this.pollHandle.unref) {
      this.pollHandle.unref();
    }
  }

  private async poll(service: ReturnType<AccessoryBase['getOrAddService']>): Promise<void> {
    try {
      const text = await this.ccu.api.getVariable(this.name);
      const v = parseFloat(text);
      if (Number.isFinite(v) && v !== this.value) {
        this.value = v;
        service.updateCharacteristic(this.Characteristic.On, v > this.min);
        service.updateCharacteristic(this.Characteristic.Brightness, v);
      }
    } catch {
      // Ignored.
    }
  }

  override dispose(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
    super.dispose();
  }
}

export const variableSwitchService: VariableServiceDefinition = {
  key: 'VariableSwitchAccessory',
  description: 'Boolean CCU variable as Switch',
  forValueType: 2,
  priority: 10,
  build: (ctx: ServiceContext) => new VariableSwitchHandler(ctx),
};

export const variableLightService: VariableServiceDefinition = {
  key: 'VariableLightAccessory',
  description: 'Numeric CCU variable as Lightbulb',
  forValueType: 4,
  priority: 10,
  build: (ctx: ServiceContext) => new VariableLightHandler(ctx),
};
