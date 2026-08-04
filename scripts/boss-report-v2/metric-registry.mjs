import { readFile } from 'node:fs/promises';
import { contentHash, mean, median, percentile, sum } from './utils.mjs';

export async function loadMetricRegistry(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  return createMetricRegistry(config);
}

export function createMetricRegistry(config) {
  const normalizedMetrics = (config.metrics ?? []).map((metric) => ({ denominator: metric.denominator ?? 'event_sum', ...metric }));
  const metrics = new Map(normalizedMetrics.map((metric) => [metric.metricId, metric]));
  const issues = auditMetrics(normalizedMetrics);
  return {
    schemaVersion: config.schemaVersion,
    registryVersion: config.registryVersion,
    hash: contentHash(config),
    issues,
    has: (id) => metrics.has(id),
    get(id) {
      const metric = metrics.get(id);
      if (!metric) throw new Error(`Metric not registered: ${id}`);
      return metric;
    },
    list: () => [...metrics.values()],
    evaluate(id, events, context = {}) {
      return evaluateMetric(metrics.get(id), events, context);
    },
    aggregate(id, values, aggregation) {
      const metric = metrics.get(id);
      if (!metric) throw new Error(`Metric not registered: ${id}`);
      if (!metric.aggregation.includes(aggregation)) throw new Error(`Metric ${id} does not allow ${aggregation}.`);
      return aggregate(values, aggregation);
    }
  };
}

export function auditMetrics(metrics) {
  const issues = [];
  const ids = new Set();
  for (const metric of metrics) {
    if (!metric.metricId) issues.push('metric:missing-id');
    if (ids.has(metric.metricId)) issues.push(`metric:duplicate:${metric.metricId}`);
    ids.add(metric.metricId);
    for (const key of ['displayName', 'unit', 'aggregation', 'scope', 'missing', 'format', 'evidenceUse']) {
      if (metric[key] === undefined) issues.push(`metric:${metric.metricId}:missing-${key}`);
    }
    if (!metric.external && !metric.derivedFrom && !(metric.sourceEvents?.length)) issues.push(`metric:${metric.metricId}:missing-source`);
  }
  return issues;
}

function evaluateMetric(metric, events, context) {
  if (!metric) throw new Error('Metric definition is required.');
  if (metric.external) {
    if (context.externalValues && metric.metricId in context.externalValues) return context.externalValues[metric.metricId];
    if (metric.missing === 'error') throw new Error(`External metric value missing: ${metric.metricId}`);
    return 0;
  }
  if (metric.derivedFrom) return context.derivedValues?.[metric.metricId] ?? context.derivedValues?.[metric.derivedFrom] ?? 0;
  const selected = events.filter((event) => metric.sourceEvents.includes(event.eventType) && matchesSelector(event, metric.selector));
  if (metric.behavior || metric.behaviors) {
    const behaviors = new Set(metric.behaviors ?? [metric.behavior]);
    const denominator = events.filter((event) => event.eventType === 'skill_confirm' && event.metadata?.sourceSide === 'player').length;
    const numerator = selected.filter((event) => behaviors.has(event.metadata?.skill?.primaryBehavior)).length;
    return denominator ? numerator / denominator : 0;
  }
  return sum(selected.map((event) => eventValue(event, metric.valueField) * Number(context.eventWeights?.get?.(event.eventId) ?? context.eventWeights?.[event.eventId] ?? 1)));
}

function matchesSelector(event, selector = {}) {
  if (selector.tags?.length && selector.tags.some((tag) => !event.tags?.includes(tag))) return false;
  if (selector.metadataEquals && Object.entries(selector.metadataEquals).some(([key, value]) => event.metadata?.[key] !== value)) return false;
  return true;
}

function eventValue(event, field) {
  if (field === 'constant_one') return 1;
  return Number(event[field] ?? 0);
}

function aggregate(values, operation) {
  if (operation === 'sum') return sum(values);
  if (operation === 'mean') return mean(values);
  if (operation === 'median') return median(values);
  if (operation === 'p90') return percentile(values, 0.9);
  throw new Error(`Unsupported metric aggregation: ${operation}`);
}
