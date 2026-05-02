import { AccessoryBase } from '../AccessoryBase.js';
import type {
  ProgramService,
  ProgramServiceDefinition,
  ServiceContext,
} from '../types.js';

class ProgramHandler extends AccessoryBase implements ProgramService {
  attach(programName: string): void {
    const service = this.getOrAddService(this.Service.Switch, programName);

    service.getCharacteristic(this.Characteristic.On)
      .onGet(this.wrapGet<boolean>(() => false))
      .onSet(this.wrapSet<boolean>(async (value) => {
        if (!value) {
          // Programs are stateless triggers; ignore "switch off".
          return;
        }
        await this.ccu.rega.runProgram(programName);
        // Auto-flip back to off after 1s so HomeKit doesn't show "always on".
        setTimeout(() => {
          service.updateCharacteristic(this.Characteristic.On, false);
        }, 1000);
      }));
  }
}

export const programService: ProgramServiceDefinition = {
  key: 'ProgramAccessory',
  description: 'CCU program triggered by HomeKit Switch',
  build: (ctx: ServiceContext) => new ProgramHandler(ctx),
};
