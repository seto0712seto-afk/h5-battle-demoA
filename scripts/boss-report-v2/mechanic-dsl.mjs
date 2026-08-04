import { readFile } from 'node:fs/promises';
import { contentHash } from './utils.mjs';

export const SUPPORTED_MECHANIC_TYPES_V2 = [
  'telegraph_attack', 'vulnerability_window', 'target_lock', 'position_pressure',
  'resource_pressure', 'phase_escalation', 'stacking_growth', 'damage_over_time',
  'summon', 'shield_break', 'healing_check', 'survival_check', 'burst_check', 'custom_window'
];

export async function loadMechanicDsl(path, metricRegistry) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  const issues = validateMechanicDsl(config, metricRegistry);
  return {
    ...config,
    hash: contentHash(config),
    issues,
    forBoss(bossId) {
      const boss = config.bosses?.[bossId];
      if (!boss) throw new Error(`Boss mechanic DSL not registered: ${bossId}`);
      return { ...boss, attribution: config.attribution, dslVersion: config.dslVersion };
    }
  };
}

export function validateMechanicDsl(config, metricRegistry) {
  const issues = [];
  if (config.schemaVersion !== '2.0.0') issues.push('dsl:schema-version');
  if (!config.dslVersion) issues.push('dsl:missing-version');
  if (!['exclusive'].includes(config.attribution?.directOutcomeMode)) issues.push('dsl:direct-attribution-must-be-exclusive');
  if (!['multi_label'].includes(config.attribution?.responseMode)) issues.push('dsl:response-attribution-must-be-multi-label');
  if (!['weighted'].includes(config.attribution?.postImpactMode)) issues.push('dsl:post-impact-attribution-must-be-weighted');
  for (const [bossId, boss] of Object.entries(config.bosses ?? {})) {
    if (boss.bossId !== bossId) issues.push(`dsl:${bossId}:id-mismatch`);
    const ids = new Set();
    for (const mechanic of boss.mechanics ?? []) {
      if (ids.has(mechanic.mechanicId)) issues.push(`dsl:${bossId}:duplicate:${mechanic.mechanicId}`);
      ids.add(mechanic.mechanicId);
      if (!SUPPORTED_MECHANIC_TYPES_V2.includes(mechanic.mechanicType)) issues.push(`dsl:${bossId}:type:${mechanic.mechanicId}`);
      if (!mechanic.trigger?.eventType || !mechanic.resolve?.eventType) issues.push(`dsl:${bossId}:selector:${mechanic.mechanicId}`);
      for (const metric of [...(mechanic.outcomeMetrics ?? []), ...(mechanic.postImpact?.metrics ?? [])]) {
        if (!metricRegistry.has(metric)) issues.push(`dsl:${bossId}:unknown-metric:${mechanic.mechanicId}:${metric}`);
      }
      for (const response of mechanic.validResponses ?? []) {
        if (!response.responseId || !response.requiredTags?.length) issues.push(`dsl:${bossId}:response:${mechanic.mechanicId}`);
      }
    }
  }
  return issues;
}

export function matchesV2Event(event, selector) {
  if (!selector) return false;
  if (selector.eventType && event.eventType !== selector.eventType) return false;
  if (selector.skillIds?.length && !selector.skillIds.includes(event.skillId)) return false;
  if (selector.sourceSide && event.metadata?.sourceSide !== selector.sourceSide && event.metadata?.side !== selector.sourceSide) return false;
  if (selector.targetSide && event.metadata?.targetSide !== selector.targetSide) return false;
  if (selector.statusIds?.length && !selector.statusIds.includes(event.statusId)) return false;
  if (selector.phaseIds?.length && !selector.phaseIds.includes(event.phaseId)) return false;
  if (selector.tags?.length && selector.tags.some((tag) => !event.tags?.includes(tag))) return false;
  if (selector.metadataEquals && Object.entries(selector.metadataEquals).some(([key, value]) => event.metadata?.[key] !== value)) return false;
  return true;
}
