import { AccessoryBase } from '../AccessoryBase.js';
import { normalizeLevelToPercent, percentToLevelFraction, toFiniteNumber } from '../../util/sanitize.js';
/**
 * Window covering with adjustable slat angle (venetian blind / HmIP-BBL).
 * Adds CurrentHorizontalTiltAngle / TargetHorizontalTiltAngle to the
 * standard WindowCovering service. Slat angle lives in the CCU `LEVEL_2`
 * datapoint (0..1 fraction; 0 = horizontal/open, 1 = fully tilted shut).
 */
const SLAT_BLIND_CHANNEL_TYPES = [
    'BLIND_VIRTUAL_RECEIVER',
    'BLIND_TRANSMITTER',
];
const STATE_STOPPED = 2;
const STATE_INCREASING = 1;
const STATE_DECREASING = 0;
const HK_TILT_MIN = -90;
const HK_TILT_MAX = 90;
const HK_TILT_RANGE = HK_TILT_MAX - HK_TILT_MIN;
class SlatBlindHandler extends AccessoryBase {
    channelAddress = '';
    current = 0;
    target = 0;
    currentTilt = 0;
    targetTilt = 0;
    attach(channel) {
        this.channelAddress = channel.address;
        const service = this.getOrAddService(this.Service.WindowCovering, channel.name);
        service.getCharacteristic(this.Characteristic.CurrentPosition)
            .onGet(this.wrapGet(() => this.current));
        service.getCharacteristic(this.Characteristic.TargetPosition)
            .onGet(this.wrapGet(() => this.target))
            .onSet(this.wrapSet(async (value) => {
            const pct = normalizeLevelToPercent(value) ?? 0;
            this.target = pct;
            await this.ccu.setValue(this.channelAddress, 'LEVEL', percentToLevelFraction(pct));
        }));
        service.getCharacteristic(this.Characteristic.PositionState)
            .onGet(this.wrapGet(() => this.derivePositionState()));
        service.getCharacteristic(this.Characteristic.CurrentHorizontalTiltAngle)
            .setProps({ minValue: HK_TILT_MIN, maxValue: HK_TILT_MAX, minStep: 1 })
            .onGet(this.wrapGet(() => this.currentTilt));
        service.getCharacteristic(this.Characteristic.TargetHorizontalTiltAngle)
            .setProps({ minValue: HK_TILT_MIN, maxValue: HK_TILT_MAX, minStep: 1 })
            .onGet(this.wrapGet(() => this.targetTilt))
            .onSet(this.wrapSet(async (value) => {
            this.targetTilt = value;
            const fraction = (value - HK_TILT_MIN) / HK_TILT_RANGE;
            await this.ccu.setValue(this.channelAddress, 'LEVEL_2', fraction);
        }));
        this.registerListener(this.channelAddress, 'LEVEL', (raw) => {
            const pct = normalizeLevelToPercent(raw);
            if (pct === undefined)
                return;
            this.current = pct;
            this.target = pct;
            service.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
            service.updateCharacteristic(this.Characteristic.TargetPosition, pct);
            service.updateCharacteristic(this.Characteristic.PositionState, this.derivePositionState());
        });
        this.registerListener(this.channelAddress, 'LEVEL_2', (raw) => {
            const f = toFiniteNumber(raw);
            if (f === undefined)
                return;
            const angle = HK_TILT_MIN + Math.max(0, Math.min(1, f)) * HK_TILT_RANGE;
            this.currentTilt = Math.round(angle);
            this.targetTilt = this.currentTilt;
            service.updateCharacteristic(this.Characteristic.CurrentHorizontalTiltAngle, this.currentTilt);
            service.updateCharacteristic(this.Characteristic.TargetHorizontalTiltAngle, this.targetTilt);
        });
        this.registerListener(this.channelAddress, 'WORKING', (raw) => {
            const moving = Boolean(raw);
            service.updateCharacteristic(this.Characteristic.PositionState, moving ? this.derivePositionState() : STATE_STOPPED);
        });
        // Best-effort initial pulls — same apply paths as the LEVEL /
        // LEVEL_2 listeners above; tested via fireEvent there.
        /* v8 ignore start */
        this.ccu.getValue(this.channelAddress, 'LEVEL').then((raw) => {
            const pct = normalizeLevelToPercent(raw);
            if (pct === undefined)
                return;
            this.current = pct;
            this.target = pct;
            service.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
            service.updateCharacteristic(this.Characteristic.TargetPosition, pct);
            service.updateCharacteristic(this.Characteristic.PositionState, STATE_STOPPED);
        }).catch(() => undefined);
        this.ccu.getValue(this.channelAddress, 'LEVEL_2').then((raw) => {
            const f = toFiniteNumber(raw);
            if (f === undefined)
                return;
            const angle = HK_TILT_MIN + Math.max(0, Math.min(1, f)) * HK_TILT_RANGE;
            this.currentTilt = Math.round(angle);
            this.targetTilt = this.currentTilt;
            service.updateCharacteristic(this.Characteristic.CurrentHorizontalTiltAngle, this.currentTilt);
            service.updateCharacteristic(this.Characteristic.TargetHorizontalTiltAngle, this.targetTilt);
        }).catch(() => undefined);
        /* v8 ignore stop */
    }
    derivePositionState() {
        if (this.target > this.current) {
            return STATE_INCREASING;
        }
        if (this.target < this.current) {
            return STATE_DECREASING;
        }
        return STATE_STOPPED;
    }
}
export const slatBlindService = {
    key: 'SlatBlindAccessory',
    description: 'Window covering with slat angle (HmIP-BBL)',
    channelTypes: SLAT_BLIND_CHANNEL_TYPES,
    // Lower priority than plain BlindAccessory — opt-in.
    priority: 50,
    build: (ctx) => new SlatBlindHandler(ctx),
};
//# sourceMappingURL=SlatBlindAccessory.js.map