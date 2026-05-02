import { describe, it, expect } from 'vitest';
import {
  findProgramServiceByKey,
  findServiceByKey,
  findVariableServiceByKey,
  pickVariableService,
  servicesForChannelType,
  SERVICE_DEFINITIONS,
  VARIABLE_SERVICE_DEFINITIONS,
} from '../../src/services/registry.js';

describe('servicesForChannelType', () => {
  it('returns matching services sorted by priority', () => {
    const result = servicesForChannelType('SWITCH');
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((s) => s.channelTypes.includes('SWITCH'))).toBe(true);
  });

  it('returns [] for unknown types', () => {
    expect(servicesForChannelType('UNKNOWN_TYPE')).toEqual([]);
  });

  it('sorts by ascending priority', () => {
    const result = servicesForChannelType('WEATHER');
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.priority).toBeGreaterThanOrEqual(result[i - 1]!.priority);
    }
  });
});

describe('findServiceByKey / findVariableServiceByKey / findProgramServiceByKey', () => {
  it('finds known services by key', () => {
    expect(findServiceByKey('SwitchAccessory')?.key).toBe('SwitchAccessory');
    expect(findVariableServiceByKey('VariableSwitchAccessory')?.key).toBe('VariableSwitchAccessory');
    expect(findProgramServiceByKey('ProgramAccessory')?.key).toBe('ProgramAccessory');
  });

  it('returns undefined for missing keys', () => {
    expect(findServiceByKey('NopeAccessory')).toBeUndefined();
    expect(findVariableServiceByKey('NopeAccessory')).toBeUndefined();
    expect(findProgramServiceByKey('NopeAccessory')).toBeUndefined();
  });
});

describe('pickVariableService', () => {
  it('matches valuetype-specific service first', () => {
    expect(pickVariableService(2).key).toBe('VariableSwitchAccessory');
    expect(pickVariableService(4).key).toBe('VariableLightAccessory');
  });

  it('falls back to a defined service when no specific match', () => {
    const r = pickVariableService(99);
    expect(r).toBeDefined();
    expect(typeof r.key).toBe('string');
  });
});

describe('SERVICE_DEFINITIONS shape', () => {
  it('every service has unique key', () => {
    const keys = SERVICE_DEFINITIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every variable service has unique key', () => {
    const keys = VARIABLE_SERVICE_DEFINITIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every channelType maps to at least one service', () => {
    for (const def of SERVICE_DEFINITIONS) {
      expect(def.channelTypes.length).toBeGreaterThan(0);
    }
  });
});
