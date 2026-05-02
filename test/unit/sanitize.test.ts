import { describe, it, expect } from 'vitest';
import {
  clamp,
  normalizeLevelToPercent,
  percentToLevelFraction,
  toFiniteNumber,
  toRanged,
} from '../../src/util/sanitize.js';

describe('toFiniteNumber', () => {
  it('passes finite numbers through', () => {
    expect(toFiniteNumber(0)).toBe(0);
    expect(toFiniteNumber(-3.14)).toBe(-3.14);
    expect(toFiniteNumber(42)).toBe(42);
  });

  it('rejects non-finite numbers', () => {
    expect(toFiniteNumber(NaN)).toBeUndefined();
    expect(toFiniteNumber(Infinity)).toBeUndefined();
    expect(toFiniteNumber(-Infinity)).toBeUndefined();
  });

  it('parses numeric strings', () => {
    expect(toFiniteNumber('42')).toBe(42);
    expect(toFiniteNumber('-1.5')).toBe(-1.5);
    expect(toFiniteNumber('0')).toBe(0);
  });

  it('rejects empty / non-numeric strings', () => {
    expect(toFiniteNumber('')).toBeUndefined();
    expect(toFiniteNumber('abc')).toBeUndefined();
    expect(toFiniteNumber('NaN')).toBeUndefined();
  });

  it('coerces booleans to 0/1', () => {
    expect(toFiniteNumber(true)).toBe(1);
    expect(toFiniteNumber(false)).toBe(0);
  });

  it('rejects other types', () => {
    expect(toFiniteNumber(null)).toBeUndefined();
    expect(toFiniteNumber(undefined)).toBeUndefined();
    expect(toFiniteNumber({})).toBeUndefined();
    expect(toFiniteNumber([])).toBeUndefined();
  });
});

describe('clamp', () => {
  it('returns value within range unchanged', () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });
  it('clamps above max', () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });
  it('clamps below min', () => {
    expect(clamp(-10, 0, 100)).toBe(0);
  });
});

describe('toRanged', () => {
  it('returns clamped finite value', () => {
    expect(toRanged(150, 0, 100, 50)).toBe(100);
    expect(toRanged(-10, 0, 100, 50)).toBe(0);
    expect(toRanged(42, 0, 100, 50)).toBe(42);
  });

  it('returns fallback for unusable input', () => {
    expect(toRanged(NaN, 0, 100, 50)).toBe(50);
    expect(toRanged('junk', 0, 100, 50)).toBe(50);
    expect(toRanged(null, 0, 100, 50)).toBe(50);
  });
});

describe('normalizeLevelToPercent', () => {
  it('treats 0..1 as a fraction', () => {
    expect(normalizeLevelToPercent(0)).toBe(0);
    expect(normalizeLevelToPercent(0.5)).toBe(50);
    expect(normalizeLevelToPercent(1)).toBe(100);
  });

  it('treats 0..100 as already a percentage (the asaw fork case)', () => {
    expect(normalizeLevelToPercent(50)).toBe(50);
    expect(normalizeLevelToPercent(100)).toBe(100);
    expect(normalizeLevelToPercent(75.4)).toBe(75);
  });

  it('clamps out-of-range to [0, 100]', () => {
    expect(normalizeLevelToPercent(150)).toBe(100);
    expect(normalizeLevelToPercent(-50)).toBe(0);
  });

  it('handles negative fractions', () => {
    // Negative within fraction range still treated as fraction; clamps to 0.
    expect(normalizeLevelToPercent(-0.5)).toBe(0);
  });

  it('parses numeric strings', () => {
    expect(normalizeLevelToPercent('0.25')).toBe(25);
    expect(normalizeLevelToPercent('80')).toBe(80);
  });

  it('returns undefined for unusable input', () => {
    expect(normalizeLevelToPercent('junk')).toBeUndefined();
    expect(normalizeLevelToPercent(NaN)).toBeUndefined();
    expect(normalizeLevelToPercent(undefined)).toBeUndefined();
  });

  it('rounds to integer percent', () => {
    expect(normalizeLevelToPercent(0.333)).toBe(33);
    expect(normalizeLevelToPercent(0.666)).toBe(67);
  });
});

describe('percentToLevelFraction', () => {
  it('converts percentages to 0..1', () => {
    expect(percentToLevelFraction(0)).toBe(0);
    expect(percentToLevelFraction(50)).toBe(0.5);
    expect(percentToLevelFraction(100)).toBe(1);
  });

  it('clamps out-of-range', () => {
    expect(percentToLevelFraction(150)).toBe(1);
    expect(percentToLevelFraction(-10)).toBe(0);
  });
});
