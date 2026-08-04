import { createHash } from 'node:crypto';

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

export function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

export function median(values) {
  return percentile(values, 0.5);
}

export function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function mad(values) {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

export function standardDeviation(values) {
  if (!values.length) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

export function slope(values) {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean);
    denominator += (index - xMean) ** 2;
  });
  return denominator ? numerator / denominator : 0;
}

export function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
}

export function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const value = typeof key === 'function' ? key(item) : item[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(item);
  }
  return groups;
}

export function formatValue(value, format = 'number_2') {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  if (format === 'percent_2') return `${(value * 100).toFixed(2)}%`;
  if (format === 'points_2') return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}个百分点`;
  if (format === 'signed_number_2') return `${value >= 0 ? '+' : ''}${Number(value).toFixed(2)}`;
  if (format === 'integer') return String(Math.round(value));
  return Number(value).toFixed(2);
}
