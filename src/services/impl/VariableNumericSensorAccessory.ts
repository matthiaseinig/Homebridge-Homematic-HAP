import { AccessoryBase } from '../AccessoryBase.js';
import type {
  ServiceContext,
  VariableService,
  VariableServiceDefinition,
} from '../types.js';
import type { CcuVariable } from '../../types.js';
import { toFiniteNumber } from '../../util/sanitize.js';

/**
 * Read-only numeric CCU variable rendered as a HomeKit sensor. The HAP
 * service is picked from the variable's `subtype` (set by the user in
 * config) or guessed from the variable's unit:
 *
 *   - subtype 'temperature' or unit °C / °F → TemperatureSensor
 *   - subtype 'humidity'    or unit %       → HumiditySensor
 *   - subtype 'light'       or unit lx      → LightSensor
 *   - default                                → TemperatureSensor
 */

type Variant = 'temperature' | 'humidity' | 'light';

class VariableNumericSensorHandler extends AccessoryBase implements VariableService {
  private value = 0;
  private name = '';
  private variant: Variant = 'temperature';
  private pollHandle: NodeJS.Timeout | undefined;

  attach(variable: CcuVariable): void {
    this.name = variable.name;
    this.variant = this.deriveVariant(variable);
    const initial = toFiniteNumber(variable.value);
    if (initial !== undefined) {
      this.value = initial;
    }

    const service = this.getOrAddService(this.serviceTypeFor(this.variant), this.name);
    const charType = this.characteristicFor(this.variant);

    service.getCharacteristic(charType)
      .onGet(this.wrapGet<number>(() => this.value));

    this.pollHandle = setInterval(() => this.poll(service, charType), 60_000);
    if (this.pollHandle.unref) {
      this.pollHandle.unref();
    }
  }

  private deriveVariant(variable: CcuVariable): Variant {
    const fromContext = (this.accessory.context.subtype ?? '').toLowerCase();
    if (fromContext === 'temperature' || fromContext === 'humidity' || fromContext === 'light') {
      return fromContext;
    }
    const unit = (variable.unit ?? '').toLowerCase();
    if (unit.includes('°c') || unit.includes('°f') || unit === 'c' || unit === 'f') {
      return 'temperature';
    }
    if (unit.includes('%') || unit.includes('rh')) {
      return 'humidity';
    }
    if (unit.includes('lx') || unit.includes('lux')) {
      return 'light';
    }
    return 'temperature';
  }

  private serviceTypeFor(variant: Variant) {
    switch (variant) {
      case 'humidity':
        return this.Service.HumiditySensor;
      case 'light':
        return this.Service.LightSensor;
      case 'temperature':
      default:
        return this.Service.TemperatureSensor;
    }
  }

  private characteristicFor(variant: Variant) {
    switch (variant) {
      case 'humidity':
        return this.Characteristic.CurrentRelativeHumidity;
      case 'light':
        return this.Characteristic.CurrentAmbientLightLevel;
      case 'temperature':
      default:
        return this.Characteristic.CurrentTemperature;
    }
  }

  private async poll(
    service: ReturnType<AccessoryBase['getOrAddService']>,
    charType: ReturnType<VariableNumericSensorHandler['characteristicFor']>,
  ): Promise<void> {
    try {
      const text = await this.ccu.api.getVariable(this.name);
      const v = toFiniteNumber(text);
      if (v !== undefined && v !== this.value) {
        this.value = v;
        service.updateCharacteristic(charType, v);
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

export const variableNumericSensorService: VariableServiceDefinition = {
  key: 'VariableNumericSensorAccessory',
  description: 'Numeric CCU variable as a read-only sensor (Temp / Humidity / Light)',
  forValueType: 4,
  priority: 20,
  build: (ctx: ServiceContext) => new VariableNumericSensorHandler(ctx),
};
