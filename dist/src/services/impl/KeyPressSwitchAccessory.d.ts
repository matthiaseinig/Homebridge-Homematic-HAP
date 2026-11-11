import type { ServiceDefinition } from '../types.js';
type PressEvent = 'PRESS_SHORT' | 'PRESS_LONG';
interface SwitchSpec {
    /** HAP subtype (hap-homematic convention); the service name gets ` Short` / ` Long`. */
    suffix: string;
    event: PressEvent;
}
export declare function keyPressSwitchSpecs(settings: Record<string, unknown> | undefined): SwitchSpec[];
export declare const keyPressSwitchService: ServiceDefinition;
export {};
