/**
 * Hand-rolled stubs for the homebridge api / hap surface — small enough
 * that tests don't pull in the whole hap-nodejs runtime (and its
 * bonjour/bonjour-zeroconf init).
 */

import { vi, type Mock } from 'vitest';
import type {
  API,
  Characteristic,
  Logging,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';

export interface ServiceStub {
  UUID: string;
  displayName: string;
  subtype?: string;
  characteristics: Map<string, CharacteristicStub>;
  getCharacteristic: Mock;
  setCharacteristic: Mock;
  updateCharacteristic: Mock;
  addCharacteristic: Mock;
  testCharacteristic: Mock;
}

export interface CharacteristicStub {
  uuid: string;
  value: unknown;
  props: Record<string, unknown>;
  onGetHandler?: () => unknown | Promise<unknown>;
  onSetHandler?: (v: unknown) => void | Promise<void>;
  onGet: Mock;
  onSet: Mock;
  setProps: Mock;
  updateValue: Mock;
}

export function makeCharacteristicStub(uuid: string): CharacteristicStub {
  const c: CharacteristicStub = {
    uuid,
    value: undefined,
    props: {},
    onGet: vi.fn() as Mock,
    onSet: vi.fn() as Mock,
    setProps: vi.fn() as Mock,
    updateValue: vi.fn() as Mock,
  };
  c.onGet.mockImplementation((handler: () => unknown) => {
    c.onGetHandler = handler;
    return c;
  });
  c.onSet.mockImplementation((handler: (v: unknown) => void) => {
    c.onSetHandler = handler;
    return c;
  });
  c.setProps.mockImplementation((p: Record<string, unknown>) => {
    Object.assign(c.props, p);
    return c;
  });
  c.updateValue.mockImplementation((v: unknown) => {
    c.value = v;
    return c;
  });
  return c;
}

export function makeServiceStub(uuid: string, displayName = '', subtype?: string): ServiceStub {
  const s: ServiceStub = {
    UUID: uuid,
    displayName,
    subtype,
    characteristics: new Map(),
    getCharacteristic: vi.fn() as Mock,
    setCharacteristic: vi.fn() as Mock,
    updateCharacteristic: vi.fn() as Mock,
    addCharacteristic: vi.fn() as Mock,
    testCharacteristic: vi.fn() as Mock,
  };
  s.getCharacteristic.mockImplementation((char: { UUID: string } | (new () => unknown)) => {
    const cuuid = (char as { UUID: string }).UUID ?? (char as { name: string }).name;
    let c = s.characteristics.get(cuuid);
    if (!c) {
      c = makeCharacteristicStub(cuuid);
      s.characteristics.set(cuuid, c);
    }
    return c;
  });
  s.setCharacteristic.mockImplementation((char: { UUID: string }, value: unknown) => {
    const c = s.getCharacteristic(char) as CharacteristicStub;
    c.value = value;
    return s;
  });
  s.updateCharacteristic.mockImplementation((char: { UUID: string }, value: unknown) => {
    const c = s.getCharacteristic(char) as CharacteristicStub;
    c.value = value;
    return s;
  });
  // hap-nodejs Service.addCharacteristic accepts a Characteristic
  // instance (or a constructor). The stub records it under its UUID and
  // also wraps it as a CharacteristicStub for downstream introspection.
  s.addCharacteristic.mockImplementation((char: { UUID?: string } | (new () => unknown)) => {
    const instance = typeof char === 'function'
      ? new (char as new () => { UUID?: string })()
      : char;
    const cuuid = (instance as { UUID?: string }).UUID
      ?? (char as { UUID?: string }).UUID
      ?? '';
    let stub = s.characteristics.get(cuuid);
    if (!stub) {
      stub = makeCharacteristicStub(cuuid);
      // Mirror any displayName / value the caller pre-populated.
      const i = instance as { displayName?: string; value?: unknown };
      if (i.displayName) stub.props.displayName = i.displayName;
      if (i.value !== undefined) stub.value = i.value;
      s.characteristics.set(cuuid, stub);
    }
    return stub;
  });
  s.testCharacteristic.mockImplementation((char: { UUID?: string } | string) => {
    const cuuid = typeof char === 'string' ? char : char.UUID ?? '';
    return s.characteristics.has(cuuid);
  });
  return s;
}

class ServiceCtor {
  static UUID: string;
  UUID: string;
  displayName: string;
  subtype: string | undefined;
  constructor(displayName?: string, subtype?: string) {
    this.UUID = (this.constructor as { UUID: string }).UUID;
    this.displayName = displayName ?? '';
    this.subtype = subtype;
  }
}

function makeServiceClass(name: string): WithUUID<typeof Service> {
  class S extends ServiceCtor {
    static override UUID = `srv:${name}`;
  }
  Object.defineProperty(S, 'name', { value: name });
  return S as unknown as WithUUID<typeof Service>;
}

function makeCharacteristicClass(name: string, extra: Record<string, unknown> = {}): WithUUID<typeof Characteristic> {
  class C {
    static UUID = `char:${name}`;
    UUID = `char:${name}`;
  }
  Object.assign(C, extra);
  Object.defineProperty(C, 'name', { value: name });
  return C as unknown as WithUUID<typeof Characteristic>;
}

export function makeHapStub() {
  return {
    Service: {
      Switch: makeServiceClass('Switch'),
      Outlet: makeServiceClass('Outlet'),
      Lightbulb: makeServiceClass('Lightbulb'),
      Door: makeServiceClass('Door'),
      Window: makeServiceClass('Window'),
      WindowCovering: makeServiceClass('WindowCovering'),
      Thermostat: makeServiceClass('Thermostat'),
      ContactSensor: makeServiceClass('ContactSensor'),
      MotionSensor: makeServiceClass('MotionSensor'),
      SmokeSensor: makeServiceClass('SmokeSensor'),
      LeakSensor: makeServiceClass('LeakSensor'),
      TemperatureSensor: makeServiceClass('TemperatureSensor'),
      HumiditySensor: makeServiceClass('HumiditySensor'),
    } as unknown as typeof Service,
    Characteristic: {
      On: makeCharacteristicClass('On'),
      Brightness: makeCharacteristicClass('Brightness'),
      Name: makeCharacteristicClass('Name'),
      CurrentPosition: makeCharacteristicClass('CurrentPosition'),
      TargetPosition: makeCharacteristicClass('TargetPosition'),
      PositionState: makeCharacteristicClass('PositionState'),
      CurrentTemperature: makeCharacteristicClass('CurrentTemperature'),
      TargetTemperature: makeCharacteristicClass('TargetTemperature'),
      CurrentHeatingCoolingState: makeCharacteristicClass('CurrentHeatingCoolingState'),
      TargetHeatingCoolingState: makeCharacteristicClass('TargetHeatingCoolingState'),
      TemperatureDisplayUnits: makeCharacteristicClass('TemperatureDisplayUnits', { CELSIUS: 0 }),
      MotionDetected: makeCharacteristicClass('MotionDetected'),
      ContactSensorState: makeCharacteristicClass('ContactSensorState', { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 }),
      SmokeDetected: makeCharacteristicClass('SmokeDetected', { SMOKE_NOT_DETECTED: 0, SMOKE_DETECTED: 1 }),
      LeakDetected: makeCharacteristicClass('LeakDetected', { LEAK_NOT_DETECTED: 0, LEAK_DETECTED: 1 }),
      CurrentRelativeHumidity: makeCharacteristicClass('CurrentRelativeHumidity'),
    } as unknown as typeof Characteristic,
  };
}

export function makeLog(): Logging {
  const fn = vi.fn() as unknown as Logging;
  const props = ['info', 'success', 'warn', 'error', 'debug', 'log'] as const;
  for (const p of props) {
    (fn as unknown as Record<string, Mock>)[p] = vi.fn();
  }
  (fn as { prefix: string }).prefix = 'test';
  return fn;
}

export interface AccessoryStub<TContext = unknown> {
  UUID: string;
  displayName: string;
  context: TContext;
  services: ServiceStub[];
  getService: Mock;
  getServiceById: Mock;
  addService: Mock;
}

export function makeAccessory<TContext>(uuid: string, displayName: string, context: TContext): AccessoryStub<TContext> {
  const a: AccessoryStub<TContext> = {
    UUID: uuid,
    displayName,
    context,
    services: [],
    getService: vi.fn() as Mock,
    getServiceById: vi.fn() as Mock,
    addService: vi.fn() as Mock,
  };
  a.getService.mockImplementation((svc: { UUID: string }) =>
    a.services.find((s) => s.UUID === svc.UUID && s.subtype === undefined),
  );
  a.getServiceById.mockImplementation((svc: { UUID: string }, subtype: string) =>
    a.services.find((s) => s.UUID === svc.UUID && s.subtype === subtype),
  );
  a.addService.mockImplementation((s: ServiceStub | { UUID: string }) => {
    const stub = (s as ServiceStub).characteristics
      ? (s as ServiceStub)
      : makeServiceStub((s as { UUID: string }).UUID, displayName);
    if ((s as { displayName?: string }).displayName) {
      stub.displayName = (s as { displayName: string }).displayName;
    }
    if ((s as { subtype?: string }).subtype) {
      stub.subtype = (s as { subtype: string }).subtype;
    }
    a.services.push(stub);
    return stub;
  });
  return a;
}

/** Helper: cast our typed accessory stub into PlatformAccessory<T>. */
export function asPlatformAccessory<T>(stub: AccessoryStub<T>): PlatformAccessory<T> {
  return stub as unknown as PlatformAccessory<T>;
}

export function makeApi(): Pick<API, 'user'> & { user: { storagePath: () => string } } {
  return { user: { storagePath: () => '/tmp/hb-test' } };
}
