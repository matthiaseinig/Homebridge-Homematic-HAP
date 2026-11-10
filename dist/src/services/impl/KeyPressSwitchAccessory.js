import { AccessoryBase } from '../AccessoryBase.js';
/**
 * Port of hap-homematic's `HomeMaticPushTheButtonAccessory`: a HomeKit
 * switch that *sends* a key press to the CCU (PRESS_SHORT / PRESS_LONG on
 * a key or input channel) and turns itself off again after half a second.
 *
 * This is an output, not a sensor: HomeKit (scenes, automations, Siri)
 * triggers a CCU key, which in turn runs whatever the CCU links or
 * programs attach to that key. For reacting to physical presses use
 * `ProgrammableSwitchAccessory` instead.
 *
 * `settings.evntType` (hap-homematic spelling) or the UI variant selects PRESS_SHORT
 * (default), PRESS_LONG or BOTH. BOTH creates two switches with the
 * hap-homematic subtypes `_Short` and `_Long`.
 */
const KEY_PRESS_CHANNEL_TYPES = [
    'KEY',
    'VIRTUAL_KEY',
    'KEY_TRANSCEIVER',
    'MULTI_MODE_INPUT_TRANSMITTER',
];
const RESET_MS = 500;
export function keyPressSwitchSpecs(settings) {
    const type = String(settings?.evntType ?? 'PRESS_SHORT');
    if (type === 'BOTH') {
        return [
            { suffix: '_Short', event: 'PRESS_SHORT' },
            { suffix: '_Long', event: 'PRESS_LONG' },
        ];
    }
    return [{ suffix: '', event: type === 'PRESS_LONG' ? 'PRESS_LONG' : 'PRESS_SHORT' }];
}
class KeyPressSwitchHandler extends AccessoryBase {
    timers = new Set();
    attach(channel) {
        const ctx = this.accessory.context;
        const evntType = ctx.settings?.evntType ?? ctx.subtype;
        for (const spec of keyPressSwitchSpecs({ evntType })) {
            const subtype = spec.suffix === '' ? undefined : spec.suffix;
            // Same subtype in both layouts; hap-homematic used none for a single switch.
            // HomeKit names allow letters, digits, spaces and apostrophes only.
            const label = spec.suffix === '' ? channel.name : `${channel.name} ${spec.suffix.slice(1)}`;
            const service = this.getOrAddService(this.Service.Switch, label, subtype, subtype ?? null);
            const on = service.getCharacteristic(this.Characteristic.On);
            on.onGet(() => false);
            on.onSet(this.wrapSet(async (value) => {
                if (value !== true) {
                    return;
                }
                try {
                    await this.ccu.setValue(channel.address, spec.event, true);
                }
                finally {
                    const t = setTimeout(() => {
                        this.timers.delete(t);
                        service.updateCharacteristic(this.Characteristic.On, false);
                    }, RESET_MS);
                    if (t.unref) {
                        t.unref();
                    }
                    this.timers.add(t);
                }
            }));
        }
    }
    dispose() {
        for (const t of this.timers) {
            clearTimeout(t);
        }
        this.timers.clear();
        super.dispose();
    }
}
export const keyPressSwitchService = {
    key: 'KeyPressSwitchAccessory',
    description: 'Switch that sends a key press (PRESS_SHORT / PRESS_LONG) to the CCU',
    channelTypes: KEY_PRESS_CHANNEL_TYPES,
    // Never the automatic default for a key channel; chosen explicitly
    // (hap-homematic import or the UI).
    priority: 90,
    variants: [
        { id: 'PRESS_SHORT', label: 'Short press' },
        { id: 'PRESS_LONG', label: 'Long press' },
        { id: 'BOTH', label: 'Short and long press (two switches)' },
    ],
    build: (ctx) => new KeyPressSwitchHandler(ctx),
};
//# sourceMappingURL=KeyPressSwitchAccessory.js.map