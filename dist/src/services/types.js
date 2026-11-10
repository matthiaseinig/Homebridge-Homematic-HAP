/**
 * Shared types for service classes. A service is a small adapter that
 * binds one CCU channel/variable/program to one or more HAP services.
 *
 * Services are registered in `registry.ts` and selected by:
 *   1. The user's `subtype` in config.channels[i].subtype, if any.
 *   2. Otherwise the highest-priority service whose `channelTypes`
 *      includes the device's channel type.
 */
export {};
//# sourceMappingURL=types.js.map