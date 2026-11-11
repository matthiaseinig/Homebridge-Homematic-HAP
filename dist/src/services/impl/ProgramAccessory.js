import { AccessoryBase } from '../AccessoryBase.js';
class ProgramHandler extends AccessoryBase {
    attach(programName) {
        const service = this.getOrAddService(this.Service.Switch, this.accessory.displayName || programName);
        service.getCharacteristic(this.Characteristic.On)
            .onGet(this.wrapGet(() => false))
            .onSet(this.wrapSet(async (value) => {
            if (!value) {
                // Programs are stateless triggers; ignore "switch off".
                return;
            }
            await this.ccu.api.runProgram(programName);
            // Auto-flip back to off after 1s so HomeKit doesn't show "always on".
            setTimeout(() => {
                service.updateCharacteristic(this.Characteristic.On, false);
            }, 1000);
        }));
    }
}
export const programService = {
    key: 'ProgramAccessory',
    description: 'CCU program triggered by HomeKit Switch',
    build: (ctx) => new ProgramHandler(ctx),
};
//# sourceMappingURL=ProgramAccessory.js.map