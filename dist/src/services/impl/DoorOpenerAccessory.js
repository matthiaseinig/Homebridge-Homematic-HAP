import { AccessoryBase } from '../AccessoryBase.js';
/**
 * A momentary relay used as a door buzzer / electric strike. In HomeKit
 * the natural service is LockMechanism: the user "unlocks", we switch the
 * relay on for `settings.OnTime` seconds (default 10, like hap-homematic)
 * and after a short delay flip the lock back to Secured so the Home app
 * doesn't show a dangling "Unlocked" state.
 *
 * The relay must switch itself off. We write ON_TIME before STATE so the
 * actuator times out on its own (the hap-homematic behaviour), and we also
 * send STATE=false after the on-time as a safety net in case the CCU
 * rejected ON_TIME or the device ignores it.
 */
const DOOR_OPENER_CHANNEL_TYPES = [
    'SWITCH',
    'SWITCH_VIRTUAL_RECEIVER',
];
const SECURED = 1;
const UNSECURED = 0;
const PULSE_MS = 1500;
const DEFAULT_ON_TIME_S = 10;
const MAX_ON_TIME_S = 60;
export function doorOpenerOnTimeSeconds(settings) {
    const raw = settings?.OnTime;
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
    if (!Number.isFinite(n) || n <= 0) {
        return DEFAULT_ON_TIME_S;
    }
    return Math.min(MAX_ON_TIME_S, n);
}
class DoorOpenerHandler extends AccessoryBase {
    channelAddress = '';
    resetTimer;
    offTimer;
    attach(channel) {
        this.channelAddress = channel.address;
        const service = this.getOrAddService(this.Service.LockMechanism, channel.name);
        service.getCharacteristic(this.Characteristic.LockCurrentState)
            .onGet(this.wrapGet(() => SECURED));
        service.getCharacteristic(this.Characteristic.LockTargetState)
            .onGet(this.wrapGet(() => SECURED))
            .onSet(this.wrapSet(async (value) => {
            if (value !== UNSECURED) {
                return;
            }
            await this.pulse();
            service.updateCharacteristic(this.Characteristic.LockCurrentState, UNSECURED);
            if (this.resetTimer) {
                clearTimeout(this.resetTimer);
            }
            this.resetTimer = setTimeout(() => {
                service.updateCharacteristic(this.Characteristic.LockTargetState, SECURED);
                service.updateCharacteristic(this.Characteristic.LockCurrentState, SECURED);
                this.resetTimer = undefined;
            }, PULSE_MS);
            if (this.resetTimer.unref) {
                this.resetTimer.unref();
            }
        }));
    }
    async pulse() {
        const onTime = doorOpenerOnTimeSeconds(this.accessory.context.settings);
        try {
            await this.ccu.setValue(this.channelAddress, 'ON_TIME', onTime);
        }
        catch (err) {
            this.log.warn('door-opener ON_TIME rejected, relying on explicit off: %s', err.message);
        }
        try {
            await this.ccu.setValue(this.channelAddress, 'STATE', true);
        }
        catch (err) {
            this.log.warn('door-opener pulse failed: %s', err.message);
            return;
        }
        if (this.offTimer) {
            clearTimeout(this.offTimer);
        }
        this.offTimer = setTimeout(() => {
            this.offTimer = undefined;
            this.ccu.setValue(this.channelAddress, 'STATE', false).catch((err) => {
                this.log.warn('door-opener explicit off failed: %s', err.message);
            });
        }, onTime * 1000 + 500);
        if (this.offTimer.unref) {
            this.offTimer.unref();
        }
    }
    dispose() {
        if (this.resetTimer) {
            clearTimeout(this.resetTimer);
            this.resetTimer = undefined;
        }
        if (this.offTimer) {
            clearTimeout(this.offTimer);
            this.offTimer = undefined;
        }
        super.dispose();
    }
}
export const doorOpenerService = {
    key: 'DoorOpenerAccessory',
    description: 'Door opener / electric strike (HomeKit LockMechanism, momentary)',
    channelTypes: DOOR_OPENER_CHANNEL_TYPES,
    priority: 50,
    build: (ctx) => new DoorOpenerHandler(ctx),
};
//# sourceMappingURL=DoorOpenerAccessory.js.map