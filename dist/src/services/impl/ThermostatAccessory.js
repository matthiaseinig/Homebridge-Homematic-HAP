import { AccessoryBase } from '../AccessoryBase.js';
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
const OFF_TEMPERATURE = 4.5;
const BIDCOS_PROFILE = { setPoint: 'SET_TEMPERATURE', modeReport: 'CONTROL_MODE', hmip: false };
const HMIP_PROFILE = { setPoint: 'SET_POINT_TEMPERATURE', modeReport: 'SET_POINT_MODE', hmip: true };
export function thermostatProfileFor(channelType) {
    return channelType === 'HEATING_CLIMATECONTROL_TRANSCEIVER' ? HMIP_PROFILE : BIDCOS_PROFILE;
}
class ThermostatHandler extends AccessoryBase {
    channelAddress = '';
    currentTemp = 20;
    targetTemp = 20;
    lastHeatTemp = 20;
    mode = HEATING_OFF;
    profile = BIDCOS_PROFILE;
    attach(channel) {
        this.channelAddress = channel.address;
        this.profile = thermostatProfileFor(channel.type);
        // hap-homematic created its Thermostat service without a subtype.
        const service = this.getOrAddService(this.Service.Thermostat, channel.name, undefined, null);
        // Read user-pinned target-temperature range; default to the CCU
        // typical 4.5..30.5 °C, which is what RaspberryMatic exposes.
        const settings = (this.accessory.context.settings ?? {});
        const minTemp = typeof settings.minTemp === 'number' && Number.isFinite(settings.minTemp)
            ? settings.minTemp : OFF_TEMPERATURE;
        const maxTemp = typeof settings.maxTemp === 'number' && Number.isFinite(settings.maxTemp) && settings.maxTemp > minTemp
            ? settings.maxTemp : 30.5;
        const minStep = typeof settings.minStep === 'number' && Number.isFinite(settings.minStep) && settings.minStep > 0
            ? settings.minStep : 0.5;
        service.getCharacteristic(this.Characteristic.CurrentTemperature)
            .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
            .onGet(this.wrapGet(() => this.currentTemp));
        service.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: minTemp, maxValue: maxTemp, minStep })
            .onGet(this.wrapGet(() => this.targetTemp))
            .onSet(this.wrapSet(async (value) => {
            this.targetTemp = value;
            if (value > OFF_TEMPERATURE) {
                this.lastHeatTemp = value;
            }
            await this.ccu.setValue(this.channelAddress, this.profile.setPoint, value);
        }));
        service.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(this.wrapGet(() => this.deriveCurrentMode()));
        service.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [HEATING_OFF, HEATING_HEAT, HEATING_AUTO] })
            .onGet(this.wrapGet(() => this.mode))
            .onSet(this.wrapSet(async (value) => {
            this.mode = value;
            await this.applyMode(value);
        }));
        service.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
            .onGet(() => this.Characteristic.TemperatureDisplayUnits.CELSIUS);
        const applyActual = (raw) => {
            const v = toFiniteNumber(raw);
            if (v !== undefined) {
                this.currentTemp = v;
                service.updateCharacteristic(this.Characteristic.CurrentTemperature, v);
                service.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.deriveCurrentMode());
            }
        };
        const applySetPoint = (raw) => {
            const v = toFiniteNumber(raw);
            if (v !== undefined) {
                this.targetTemp = v;
                if (v <= OFF_TEMPERATURE) {
                    this.mode = HEATING_OFF;
                }
                else {
                    this.lastHeatTemp = v;
                }
                service.updateCharacteristic(this.Characteristic.TargetTemperature, v);
                service.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.deriveCurrentMode());
                service.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.mode);
            }
        };
        const applyModeReport = (raw) => {
            const v = toFiniteNumber(raw);
            if (v === undefined) {
                return;
            }
            if (this.targetTemp <= OFF_TEMPERATURE) {
                this.mode = HEATING_OFF;
            }
            else {
                this.mode = v === 0 ? HEATING_AUTO : HEATING_HEAT;
            }
            service.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.mode);
        };
        this.registerListener(this.channelAddress, 'ACTUAL_TEMPERATURE', applyActual);
        this.registerListener(this.channelAddress, this.profile.setPoint, applySetPoint);
        if (this.profile.modeReport) {
            this.registerListener(this.channelAddress, this.profile.modeReport, applyModeReport);
        }
        this.ccu.getValue(this.channelAddress, 'ACTUAL_TEMPERATURE').then(applyActual).catch(() => undefined);
        this.ccu.getValue(this.channelAddress, this.profile.setPoint).then((raw) => {
            applySetPoint(raw);
            if (this.profile.modeReport) {
                return this.ccu.getValue(this.channelAddress, this.profile.modeReport).then(applyModeReport);
            }
            return undefined;
        }).catch(() => undefined);
        if (this.profile.hmip) {
            this.attachHumidityIfPresent(service);
        }
        this.attachBattery(channel.address);
    }
    /**
     * HmIP wall thermostats (HmIP-WTH-2) report HUMIDITY on the same channel;
     * radiator valves do not. Add the characteristic only once the CCU
     * returns a real value so valves don't show a fake 0 %.
     */
    attachHumidityIfPresent(service) {
        const apply = (raw) => {
            const v = toFiniteNumber(raw);
            if (v === undefined) {
                return;
            }
            service.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, v);
        };
        this.ccu.getValue(this.channelAddress, 'HUMIDITY').then((raw) => {
            if (toFiniteNumber(raw) === undefined) {
                return;
            }
            apply(raw);
            this.registerListener(this.channelAddress, 'HUMIDITY', apply);
        }).catch(() => undefined);
    }
    async applyMode(value) {
        if (this.profile.hmip) {
            if (value === HEATING_OFF) {
                this.targetTemp = OFF_TEMPERATURE;
                await this.ccu.setValue(this.channelAddress, 'CONTROL_MODE', 1);
                await this.ccu.setValue(this.channelAddress, 'SET_POINT_TEMPERATURE', OFF_TEMPERATURE);
            }
            else if (value === HEATING_AUTO) {
                await this.ccu.setValue(this.channelAddress, 'CONTROL_MODE', 0);
            }
            else {
                await this.ccu.setValue(this.channelAddress, 'CONTROL_MODE', 1);
                if (this.targetTemp <= OFF_TEMPERATURE) {
                    await this.ccu.setValue(this.channelAddress, 'SET_POINT_TEMPERATURE', this.lastHeatTemp);
                }
            }
            return;
        }
        if (value === HEATING_OFF) {
            this.targetTemp = OFF_TEMPERATURE;
            await this.ccu.setValue(this.channelAddress, 'SET_TEMPERATURE', OFF_TEMPERATURE);
        }
        else if (value === HEATING_AUTO) {
            await this.ccu.setValue(this.channelAddress, 'AUTO_MODE', true);
        }
        else {
            await this.ccu.setValue(this.channelAddress, 'MANU_MODE', this.targetTemp);
        }
    }
    deriveCurrentMode() {
        if (this.targetTemp <= OFF_TEMPERATURE) {
            return HEATING_OFF;
        }
        return this.targetTemp > this.currentTemp ? HEATING_HEAT : HEATING_OFF;
    }
}
export const thermostatService = {
    key: 'ThermostatAccessory',
    description: 'Heating thermostat',
    channelTypes: THERMOSTAT_CHANNEL_TYPES,
    priority: 10,
    build: (ctx) => new ThermostatHandler(ctx),
};
//# sourceMappingURL=ThermostatAccessory.js.map