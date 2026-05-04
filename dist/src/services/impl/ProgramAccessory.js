import { AccessoryBase } from "../AccessoryBase.js";
class ProgramHandler extends AccessoryBase {
  attach(programName) {
    const service = this.getOrAddService(this.Service.Switch, programName);
    service.getCharacteristic(this.Characteristic.On).onGet(this.wrapGet(() => false)).onSet(this.wrapSet(async (value) => {
      if (!value) {
        return;
      }
      await this.ccu.api.runProgram(programName);
      setTimeout(() => {
        service.updateCharacteristic(this.Characteristic.On, false);
      }, 1e3);
    }));
  }
}
const programService = {
  key: "ProgramAccessory",
  description: "CCU program triggered by HomeKit Switch",
  build: (ctx) => new ProgramHandler(ctx)
};
export {
  programService
};
//# sourceMappingURL=ProgramAccessory.js.map
