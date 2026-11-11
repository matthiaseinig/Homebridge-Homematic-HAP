import { AccessoryBase } from '../AccessoryBase.js';
import { normalizeLevelToPercent, percentToLevelFraction } from '../../util/sanitize.js';
const BLIND_CHANNEL_TYPES = [
    'BLIND',
    'BLIND_VIRTUAL_RECEIVER',
    'SHUTTER_VIRTUAL_RECEIVER',
];
const STATE_STOPPED = 2;
const STATE_INCREASING = 1;
const STATE_DECREASING = 0;
/** No LEVEL change and no explicit stop within this window: treat as stopped. */
const SETTLE_MS = 5000;
/** Safety net while the CCU itself says "moving" (WORKING / ACTIVITY_STATE). */
const FAILSAFE_MS = 120000;
/**
 * Window covering with live movement reporting.
 *
 * - Classic BLIND: WORKING (bool) and DIRECTION (1 up, 2 down) mark movement.
 * - HmIP (BLIND_/SHUTTER_VIRTUAL_RECEIVER): ACTIVITY_STATE (1 up, 2 down,
 *   3 stable); HmIP has no WORKING datapoint.
 * - Every intermediate LEVEL is pushed as CurrentPosition; the direction of
 *   successive LEVELs and of target vs current right after a command also
 *   drive PositionState.
 * - TargetPosition stays the commanded target until the move is finished
 *   (target reached, CCU reports stable, or the level stops changing); a
 *   move stopped midway then sets target = current. Moves started outside
 *   HomeKit (wall button) have no known target, so target follows current.
 * HomeKit 100 equals CCU LEVEL 1.0 (open); no inversion is applied.
 */
class BlindHandler extends AccessoryBase {
    channelAddress = '';
    current = 0;
    target = 0;
    commanded = false;
    moving = false;
    direction = 0;
    explicitMoving = false;
    explicitStable = false;
    timer;
    service;
    attach(channel) {
        this.channelAddress = channel.address;
        const service = this.getOrAddService(this.Service.WindowCovering, channel.name);
        this.service = service;
        service.getCharacteristic(this.Characteristic.CurrentPosition)
            .onGet(this.wrapGet(() => this.current));
        service.getCharacteristic(this.Characteristic.TargetPosition)
            .onGet(this.wrapGet(() => this.target))
            .onSet(this.wrapSet(async (value) => {
            const pct = normalizeLevelToPercent(value) ?? 0;
            this.onCommand(pct);
            await this.ccu.setValue(this.channelAddress, 'LEVEL', percentToLevelFraction(pct));
        }));
        service.getCharacteristic(this.Characteristic.PositionState)
            .onGet(this.wrapGet(() => this.positionState()));
        this.registerListener(this.channelAddress, 'LEVEL', (raw) => {
            const pct = normalizeLevelToPercent(raw);
            if (pct !== undefined) {
                this.onLevel(pct);
            }
        });
        this.registerListener(this.channelAddress, 'WORKING', (raw) => {
            if (raw) {
                this.onExplicitMoving(this.direction);
            }
            else {
                this.finish();
            }
        });
        // HmIP: 0 unknown, 1 up, 2 down, 3 stable.
        this.registerListener(this.channelAddress, 'ACTIVITY_STATE', (raw) => {
            const n = Number(raw);
            if (n === 1) {
                this.onExplicitMoving(1);
            }
            else if (n === 2) {
                this.onExplicitMoving(-1);
            }
            else if (n === 3) {
                this.explicitStable = true;
                this.finish();
            }
        });
        // Classic: 0 none, 1 up, 2 down, 3 undefined.
        this.registerListener(this.channelAddress, 'DIRECTION', (raw) => {
            const n = Number(raw);
            if (n === 1 || n === 2) {
                this.direction = n === 1 ? 1 : -1;
                if (this.moving) {
                    this.pushState();
                }
            }
        });
        // Pull initial position. Without this, the accessory shows 0 (closed)
        // until the next CCU push event arrives, which for blinds may be
        // hours away. Best-effort; we ignore errors so a missing-channel
        // doesn't poison startup.
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
    }
    dispose() {
        this.clearTimer();
        super.dispose();
    }
    onCommand(pct) {
        this.target = pct;
        this.commanded = true;
        this.explicitStable = false;
        if (pct === this.current) {
            this.finish();
            return;
        }
        this.moving = true;
        this.direction = pct > this.current ? 1 : -1;
        this.pushState();
        this.arm(SETTLE_MS);
    }
    onLevel(pct) {
        const previous = this.current;
        this.current = pct;
        this.service?.updateCharacteristic(this.Characteristic.CurrentPosition, pct);
        if (pct !== previous) {
            this.direction = pct > previous ? 1 : -1;
            // A LEVEL arriving after the CCU said "stable" is the final value.
            if (!this.explicitStable) {
                this.moving = true;
            }
        }
        if (this.commanded && pct === this.target) {
            this.finish();
            return;
        }
        if (!this.commanded) {
            this.target = pct;
            this.service?.updateCharacteristic(this.Characteristic.TargetPosition, pct);
        }
        if (this.moving) {
            this.arm(this.explicitMoving ? FAILSAFE_MS : SETTLE_MS);
        }
        this.pushState();
    }
    onExplicitMoving(direction) {
        this.explicitMoving = true;
        this.explicitStable = false;
        this.moving = true;
        if (direction !== 0) {
            this.direction = direction;
        }
        else if (this.commanded && this.target !== this.current) {
            this.direction = this.target > this.current ? 1 : -1;
        }
        this.arm(FAILSAFE_MS);
        this.pushState();
    }
    /** Move is over: report STOPPED and settle TargetPosition on where it ended. */
    finish() {
        this.clearTimer();
        this.moving = false;
        this.explicitMoving = false;
        this.commanded = false;
        this.direction = 0;
        this.target = this.current;
        this.service?.updateCharacteristic(this.Characteristic.TargetPosition, this.current);
        this.pushState();
    }
    arm(ms) {
        this.clearTimer();
        this.timer = setTimeout(() => this.finish(), ms);
        this.timer.unref?.();
    }
    clearTimer() {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
    pushState() {
        this.service?.updateCharacteristic(this.Characteristic.PositionState, this.positionState());
    }
    positionState() {
        if (!this.moving || this.direction === 0) {
            return STATE_STOPPED;
        }
        return this.direction > 0 ? STATE_INCREASING : STATE_DECREASING;
    }
}
export const blindService = {
    key: 'BlindAccessory',
    description: 'Window covering / blind / shutter',
    channelTypes: BLIND_CHANNEL_TYPES,
    priority: 10,
    build: (ctx) => new BlindHandler(ctx),
};
//# sourceMappingURL=BlindAccessory.js.map