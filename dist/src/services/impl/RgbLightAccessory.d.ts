import type { ServiceDefinition } from '../types.js';
declare function snapHueToBslIndex(hue: number, sat: number): number;
export declare const rgbLightService: ServiceDefinition;
export declare const _testing: {
    snapHueToBslIndex: typeof snapHueToBslIndex;
    HMIP_BSL_COLOR_TO_HUE: Record<number, number>;
};
export {};
