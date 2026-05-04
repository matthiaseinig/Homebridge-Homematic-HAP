function toFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : void 0;
  }
  if (typeof value === "string") {
    if (value.length === 0) {
      return void 0;
    }
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : void 0;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return void 0;
}
function clamp(value, min, max) {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
function toRanged(value, min, max, fallback) {
  const n = toFiniteNumber(value);
  if (n === void 0) {
    return fallback;
  }
  return clamp(n, min, max);
}
function normalizeLevelToPercent(value) {
  const n = toFiniteNumber(value);
  if (n === void 0) {
    return void 0;
  }
  if (n >= -1 && n <= 1) {
    return clamp(Math.round(n * 100), 0, 100);
  }
  return clamp(Math.round(n), 0, 100);
}
function percentToLevelFraction(percent) {
  return clamp(percent, 0, 100) / 100;
}
export {
  clamp,
  normalizeLevelToPercent,
  percentToLevelFraction,
  toFiniteNumber,
  toRanged
};
//# sourceMappingURL=sanitize.js.map
