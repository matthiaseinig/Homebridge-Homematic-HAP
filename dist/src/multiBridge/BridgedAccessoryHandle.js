/**
 * Thin adapter that lets the existing service handlers (written against
 * Homebridge's PlatformAccessory) build on a plain HAP-NodeJS Accessory.
 * Only public HAP-NodeJS API is used, so no Homebridge internals
 * (`_associatedHAPAccessory`) are involved and nothing is registered with
 * Homebridge's own bridge.
 */
export class BridgedAccessoryHandle {
    hapAccessory;
    context;
    constructor(hapAccessory, context) {
        this.hapAccessory = hapAccessory;
        this.context = context;
    }
    get UUID() {
        return this.hapAccessory.UUID;
    }
    get displayName() {
        return this.hapAccessory.displayName;
    }
    set displayName(name) {
        this.hapAccessory.displayName = name;
    }
    getService(name) {
        return this.hapAccessory.getService(name);
    }
    getServiceById(uuid, subType) {
        return this.hapAccessory.getServiceById(uuid, subType);
    }
    addService(service) {
        return this.hapAccessory.addService(service);
    }
}
//# sourceMappingURL=BridgedAccessoryHandle.js.map