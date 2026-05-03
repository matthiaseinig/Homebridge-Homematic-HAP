import { describe, it, expect } from 'vitest';
import {
  bridgeIdentityFor,
  importConfigJson,
  splitReportIntoBridges,
} from '../../src/import/HapHomematicImporter.js';

describe('bridgeIdentityFor', () => {
  it('produces a locally-administered MAC + port in the safe range', () => {
    const id = bridgeIdentityFor('uuid-a');
    expect(id.username).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/);
    // First octet must have the locally-administered bit set (0x02) and unicast cleared.
    const firstOctet = parseInt(id.username.split(':')[0]!, 16);
    expect((firstOctet & 0x02)).toBe(0x02);
    expect((firstOctet & 0x01)).toBe(0x00);
    expect(id.port).toBeGreaterThanOrEqual(9000);
    expect(id.port).toBeLessThan(15000);
  });

  it('is deterministic across runs', () => {
    const a = bridgeIdentityFor('uuid-a');
    const b = bridgeIdentityFor('uuid-a');
    expect(a).toEqual(b);
  });

  it('differs by seed', () => {
    const a = bridgeIdentityFor('uuid-a');
    const b = bridgeIdentityFor('uuid-b');
    expect(a.username).not.toBe(b.username);
  });
});

describe('splitReportIntoBridges', () => {
  it('emits one block per instance and routes mappings by instance UUID', () => {
    const report = importConfigJson({
      ccuIP: '10.0.0.1',
      channels: ['HmIP.AAA:1', 'HmIP.BBB:1'],
      variables: ['Var1'],
      programs: ['Prog1'],
      mappings: {
        'HmIP.AAA:1': { Service: 'HomeMaticSwitchAccessory', instance: 'i-living' },
        'HmIP.BBB:1': { Service: 'HomeMaticSwitchAccessory', instance: 'i-bedroom' },
        'Var1':       { Service: 'HomeMaticVariableAccessory', instance: 'i-living' },
        'Prog1':      { instance: 'i-bedroom' },
      },
      instances: {
        'i-living':  { name: 'Living Room' },
        'i-bedroom': { name: 'Bedroom' },
      },
    });

    const blocks = splitReportIntoBridges(report);
    expect(blocks).toHaveLength(2);
    const living = blocks.find((b) => b.instanceUuid === 'i-living')!;
    const bedroom = blocks.find((b) => b.instanceUuid === 'i-bedroom')!;
    expect(living.channels).toHaveLength(1);
    expect(living.variables).toHaveLength(1);
    expect(living.programs).toHaveLength(0);
    expect(bedroom.channels).toHaveLength(1);
    expect(bedroom.programs).toHaveLength(1);
    expect(living.bridge.username).not.toBe(bedroom.bridge.username);
  });

  it('puts mappings without an instance into the first block (fallback)', () => {
    const report = importConfigJson({
      channels: ['HmIP.X:1'],
      mappings: { 'HmIP.X:1': { Service: 'HomeMaticSwitchAccessory' } },
      instances: { 'only-one': { name: 'Only' } },
    });
    const blocks = splitReportIntoBridges(report);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.channels).toHaveLength(1);
  });

  it('emits a single default block when no instances are declared', () => {
    const report = importConfigJson({
      channels: ['HmIP.X:1'],
      mappings: { 'HmIP.X:1': { Service: 'HomeMaticSwitchAccessory' } },
    });
    const blocks = splitReportIntoBridges(report);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.instanceUuid).toBe('default');
  });

  it('preserves uuid-derived bridge port stability across reruns', () => {
    const report = importConfigJson({
      channels: [],
      instances: { 'i-room': { name: 'X' } },
    });
    const a = splitReportIntoBridges(report);
    const b = splitReportIntoBridges(report);
    expect(a[0]!.bridge).toEqual(b[0]!.bridge);
  });
});

describe('importConfigJson — newly aliased services', () => {
  it('maps PushTheButton to ProgrammableSwitchAccessory', () => {
    const r = importConfigJson({
      channels: ['HmIP.K:1'],
      mappings: { 'HmIP.K:1': { Service: 'HomeMaticPushTheButtonAccessory' } },
    });
    expect(r.channels[0]?.service).toBe('ProgrammableSwitchAccessory');
  });

  it('maps DoorOpener to DoorOpenerAccessory', () => {
    const r = importConfigJson({
      channels: ['HmIP.D:1'],
      mappings: { 'HmIP.D:1': { Service: 'HomeMaticDoorOpenerAccessory' } },
    });
    expect(r.channels[0]?.service).toBe('DoorOpenerAccessory');
  });

  it('maps VariableNumberSensor to VariableNumericSensorAccessory', () => {
    const r = importConfigJson({
      variables: ['Temperature'],
      mappings: { 'Temperature': { Service: 'HomeMaticVariableNumberSensorAccessory' } },
    });
    expect(r.variables[0]?.service).toBe('VariableNumericSensorAccessory');
  });

  it('maps VarBasedThermometer to VariableNumericSensorAccessory + temperature subtype', () => {
    const r = importConfigJson({
      variables: ['Outdoor'],
      mappings: { 'Outdoor': { Service: 'HomeMaticVarBasedThermometerAccessory' } },
    });
    expect(r.variables[0]?.service).toBe('VariableNumericSensorAccessory');
    expect(r.variables[0]?.subtype).toBe('temperature');
  });

  it('preserves instance metadata on every mapping', () => {
    const r = importConfigJson({
      channels: ['HmIP.A:1'],
      variables: ['V'],
      programs: ['P'],
      mappings: {
        'HmIP.A:1': { Service: 'HomeMaticSwitchAccessory', instance: 'living' },
        'V':        { Service: 'HomeMaticVariableAccessory', instance: 'living' },
        'P':        { instance: 'bedroom' },
      },
      instances: { living: {}, bedroom: {} },
    });
    expect(r.channels[0]?.instance).toBe('living');
    expect(r.variables[0]?.instance).toBe('living');
    expect(r.programs[0]?.instance).toBe('bedroom');
  });
});
