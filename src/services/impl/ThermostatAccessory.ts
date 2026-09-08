import { AccessoryBase } from '../AccessoryBase.js';
import type { ChannelService, ServiceContext, ServiceDefinition } from '../types.js';
import type { CcuChannel } from '../../types.js';
import { toFiniteNumber } from '../../util/sanitize.js';

const THERMOSTAT_CHANNEL_TYPES = [
  'CLIMATECONTROL_REGULATOR',
  'CLIMATECONTROL_RT_TRANSCEIVER',
  'HEATING_CLIMATECONTROL_TRANSCEIVER',
  'THERMALCONTROL_TRANSMIT',
];

const HEATING_OFF = 0;
const HEATING_HEAT = 1;
const HEATING_AUTO = 3;

// CCU virtual heating-group channels (created via the CCU's "System
// Variables/Virtual" heating-group feature) don't expose SET_TEMPERATURE
// at all — that's a real per-device datapoint. They use SET_POINT_TEMPERATURE
// instead. Resolved lazily from whichever candidate actually answers, so
// both channel kinds work without hardcoding a channel type.
const SETPOINT_DATAPOINTS = ['SET_TEMPERATURE', 'SET_POINT_TEMPERATURE'] as const;

class ThermostatHandler extends AccessoryBase implements ChannelService {
  private channelAddress = '';
  private currentTemp = 20;
  private targetTemp = 20;
  private mode = HEATING_OFF;
  private setpointDp: string = SETPOINT_DATAPOINTS[0];
  // Virtual heating-group channels expose their regulation state via
  // SET_POINT_MODE (0=auto/1=manual) instead of the AUTO_MODE/MANU_MODE
  // booleans real device channels use. Stays undefined until a
  // SET_POINT_MODE value is actually seen, so real-device channels keep
  // using the original AUTO_MODE/MANU_MODE listeners unchanged.
  private pointMode: number | undefined = undefined;
  private boostActive = false;

  attach(channel: CcuChannel): void {
    this.channelAddress = channel.address;
    const service = this.getOrAddService(this.Service.Thermostat, channel.name);

    // Read user-pinned target-temperature range; default to the CCU
    // typical 4.5..30.5 °C, which is what RaspberryMatic exposes.
    const settings = (this.accessory.context.settings ?? {}) as {
      minTemp?: number; maxTemp?: number; minStep?: number;
    };
    const minTemp = typeof settings.minTemp === 'number' && Number.isFinite(settings.minTemp)
      ? settings.minTemp : 4.5;
    const maxTemp = typeof settings.maxTemp === 'number' && Number.isFinite(settings.maxTemp) && settings.maxTemp > minTemp
      ? settings.maxTemp : 30.5;
    const minStep = typeof settings.minStep === 'number' && Number.isFinite(settings.minStep) && settings.minStep > 0
      ? settings.minStep : 0.5;

    service.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(this.wrapGet<number>(() => this.currentTemp));

    service.getCharacteristic(this.Characteristic.TargetTemperature)
      .setProps({ minValue: minTemp, maxValue: maxTemp, minStep })
      .onGet(this.wrapGet<number>(() => this.targetTemp))
      .onSet(this.wrapSet<number>(async (value) => {
        this.targetTemp = value;
        await this.ccu.setValue(this.channelAddress, this.setpointDp, value);
      }));

    service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.wrapGet<number>(() => this.deriveCurrentMode()));

    service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [HEATING_OFF, HEATING_HEAT, HEATING_AUTO] })
      .onGet(this.wrapGet<number>(() => this.mode))
      .onSet(this.wrapSet<number>(async (value) => {
        this.mode = value;
        // Auto: set CONTROL_MODE=0; Manual heat: CONTROL_MODE=1; Off: SET_TEMPERATURE=4.5
        if (value === HEATING_OFF) {
          await this.ccu.setValue(this.channelAddress, this.setpointDp, 4.5);
        } else if (value === HEATING_AUTO) {
          if (this.pointMode !== undefined) {
            await this.ccu.setValue(this.channelAddress, 'SET_POINT_MODE', 0);
          } else {
            await this.ccu.setValue(this.channelAddress, 'AUTO_MODE', true);
          }
        } else if (this.pointMode !== undefined) {
          await this.ccu.setValue(this.channelAddress, 'SET_POINT_MODE', 1);
          await this.ccu.setValue(this.channelAddress, this.setpointDp, this.targetTemp);
        } else {
          await this.ccu.setValue(this.channelAddress, 'MANU_MODE', this.targetTemp);
        }
      }));

    service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
      .onGet(() => this.Characteristic.TemperatureDisplayUnits.CELSIUS);

    // Recomputes TargetHeatingCoolingState from whatever live-mode signal
    // has resolved so far (BOOST_MODE / SET_POINT_MODE). No-ops (leaves
    // `mode` at whatever HomeKit last set) until one of those datapoints
    // has actually been seen — real-device channels that only expose
    // AUTO_MODE/MANU_MODE never populate `pointMode` and fall through to
    // their own listeners below, unchanged from before this fix.
    const applyTargetMode = () => {
      const derived = this.deriveTargetMode();
      if (derived === undefined) return;
      this.mode = derived;
      service.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.mode);
    };

    const applySetpoint = (dp: string, raw: unknown) => {
      const v = toFiniteNumber(raw);
      if (v === undefined) return;
      this.setpointDp = dp;
      this.targetTemp = v;
      service.updateCharacteristic(this.Characteristic.TargetTemperature, v);
      service.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.deriveCurrentMode());
      applyTargetMode();
    };

    this.registerListener(this.channelAddress, 'ACTUAL_TEMPERATURE', (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        this.currentTemp = v;
        service.updateCharacteristic(this.Characteristic.CurrentTemperature, v);
        service.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.deriveCurrentMode());
      }
    });

    for (const dp of SETPOINT_DATAPOINTS) {
      this.registerListener(this.channelAddress, dp, (raw) => applySetpoint(dp, raw));
    }

    this.registerListener(this.channelAddress, 'SET_POINT_MODE', (raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        this.pointMode = v;
        applyTargetMode();
      }
    });

    this.registerListener(this.channelAddress, 'BOOST_MODE', (raw) => {
      this.boostActive = raw === true || raw === 1 || raw === '1' || raw === 'true';
      applyTargetMode();
    });

    // Original real-device mode listeners — only act while no SET_POINT_MODE
    // has been seen for this channel, so virtual heating-group channels
    // (which do report SET_POINT_MODE) are governed solely by applyTargetMode.
    this.registerListener(this.channelAddress, 'AUTO_MODE', (raw) => {
      if (this.pointMode !== undefined) return;
      if (raw === true || raw === 1 || raw === '1' || raw === 'true') {
        this.mode = HEATING_AUTO;
        service.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.mode);
      }
    });
    this.registerListener(this.channelAddress, 'MANU_MODE', (raw) => {
      if (this.pointMode !== undefined) return;
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        this.mode = v <= 4.5 ? HEATING_OFF : HEATING_HEAT;
        service.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.mode);
      }
    });

    // Pull initial state so the accessory reflects current values
    // immediately rather than waiting for the next push event.
    this.ccu.getValue(this.channelAddress, 'ACTUAL_TEMPERATURE').then((raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        this.currentTemp = v;
        service.updateCharacteristic(this.Characteristic.CurrentTemperature, v);
      }
    }).catch(() => undefined);

    (async () => {
      for (const dp of SETPOINT_DATAPOINTS) {
        try {
          const raw = await this.ccu.getValue(this.channelAddress, dp);
          if (toFiniteNumber(raw) !== undefined) {
            applySetpoint(dp, raw);
            break;
          }
        } catch {
          // try the next candidate datapoint
        }
      }
    })();

    this.ccu.getValue(this.channelAddress, 'SET_POINT_MODE').then((raw) => {
      const v = toFiniteNumber(raw);
      if (v !== undefined) {
        this.pointMode = v;
        applyTargetMode();
      }
    }).catch(() => undefined);
    this.ccu.getValue(this.channelAddress, 'BOOST_MODE').then((raw) => {
      if (raw === undefined || raw === '') return;
      this.boostActive = raw === true || raw === 1 || raw === '1' || raw === 'true';
      applyTargetMode();
    }).catch(() => undefined);

    // Thermostats are battery-powered (HmIP-eTRV-*, HmIP-WTH-*, etc.).
    // Surface LOW_BAT as a HomeKit BatteryService.
    this.attachBattery(channel.address);
  }

  private deriveCurrentMode(): number {
    if (this.targetTemp <= 4.5) {
      return HEATING_OFF;
    }
    return this.targetTemp > this.currentTemp ? HEATING_HEAT : HEATING_OFF;
  }

  // Maps the CCU's real regulation state onto HomeKit's Off/Heat/Auto enum.
  // Returns undefined when no live-mode datapoint has resolved yet (e.g. a
  // real per-device channel exposing only AUTO_MODE/MANU_MODE booleans), so
  // callers leave `this.mode` at whatever HomeKit last set.
  private deriveTargetMode(): number | undefined {
    if (this.boostActive) {
      return HEATING_HEAT;
    }
    if (this.pointMode === undefined) {
      return undefined;
    }
    if (this.pointMode === 0) {
      return HEATING_AUTO;
    }
    return this.targetTemp <= 4.5 ? HEATING_OFF : HEATING_HEAT;
  }
}

export const thermostatService: ServiceDefinition = {
  key: 'ThermostatAccessory',
  description: 'Heating thermostat',
  channelTypes: THERMOSTAT_CHANNEL_TYPES,
  priority: 10,
  build: (ctx: ServiceContext) => new ThermostatHandler(ctx),
};
