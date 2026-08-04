export function ratio(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator) : 0;
}

export function average(values) {
  return values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

export function percentile(values, point) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * point;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
}

export function sum(items, select = (value) => value) {
  return items.reduce((total, item) => total + (Number(select(item)) || 0), 0);
}

export function percent(value) {
  return value === null || value === undefined ? '-' : `${(value * 100).toFixed(2)}%`;
}

export function signedPoints(value) {
  if (value === null || value === undefined) return '-';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}个百分点`;
}

export function number(value, digits = 2) {
  return value === null || value === undefined ? '-' : Number(value).toFixed(digits);
}

export function round(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

export function countBy(items, select) {
  const result = {};
  items.forEach((item) => {
    const key = select(item);
    result[key] = (result[key] ?? 0) + 1;
  });
  return result;
}

export function topDistinct(items, score, limit = 3) {
  const seen = new Set();
  return [...items].sort((a, b) => score(b) - score(a)).filter((item) => {
    if (seen.has(item.seed)) return false;
    seen.add(item.seed);
    return true;
  }).slice(0, limit);
}
