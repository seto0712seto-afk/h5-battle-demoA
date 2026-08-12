import { normalizeTraceEvents } from '../boss-report/unified-events.mjs';

export const COMBAT_EVENT_V2_SCHEMA = '2.0.0';

export function toCombatEventsV2(trace, context, metadataRegistry) {
  const battleId = String(trace.battleId ?? `${context.groupId}:${trace.seed}`);
  const normalized = normalizeTraceEvents({ ...trace, battleId });
  const ids = normalized.map((_, index) => `${battleId}:event:${index + 1}`);
  const rootByAction = new Map();
  const causeByAction = new Map();
  normalized.forEach((event, index) => {
    if (event.eventType === 'action_start') rootByAction.set(event.actionIndex, ids[index]);
    if (event.eventType === 'skill_confirm' || event.eventType === 'skill_resolve') {
      if (!causeByAction.has(event.actionIndex) || event.eventType === 'skill_confirm') causeByAction.set(event.actionIndex, ids[index]);
    }
  });
  return normalized.map((event, index) => convertEvent(event, {
    ...context,
    battleId,
    eventId: ids[index],
    eventIndex: index + 1,
    rootEventId: rootByAction.get(event.actionIndex),
    causedByEventId: causeByAction.get(event.actionIndex),
    metadataRegistry
  }));
}

export function validateCombatEventsV2(events) {
  const issues = [];
  const ids = new Set();
  events.forEach((event, index) => {
    for (const key of ['schemaVersion', 'eventId', 'battleId', 'seed', 'rulesetId', 'experimentId', 'groupId', 'round', 'actionIndex', 'eventIndex', 'eventType']) {
      if (event[key] === undefined || event[key] === null || event[key] === '') issues.push({ eventIndex: index + 1, issue: `missing:${key}` });
    }
    if (event.schemaVersion !== COMBAT_EVENT_V2_SCHEMA) issues.push({ eventIndex: index + 1, issue: 'schemaVersion:mismatch' });
    if (event.eventIndex !== index + 1) issues.push({ eventIndex: index + 1, issue: 'eventIndex:not-contiguous' });
    if (ids.has(event.eventId)) issues.push({ eventIndex: index + 1, issue: 'eventId:duplicate' });
    ids.add(event.eventId);
    if (event.parentEventId && !ids.has(event.parentEventId)) issues.push({ eventIndex: index + 1, issue: 'parentEventId:not-prior' });
  });
  return issues;
}

function convertEvent(event, context) {
  const raw = event.metadata ?? {};
  const skill = context.metadataRegistry.skill(event.skillId);
  const sourceSide = raw.sourceSide ?? raw.side ?? inferredSide(event.sourceId, context.metadataRegistry);
  const targetSide = raw.targetSide ?? inferredSide(event.targetId, context.metadataRegistry);
  const resourceBefore = numberOrUndefined(raw.before ?? raw.manaBefore);
  const resourceAfter = numberOrUndefined(raw.after);
  const resourceDelta = event.eventType === 'resource_gain'
    ? Number(raw.gained ?? event.value ?? 0)
    : event.eventType === 'resource_spend'
      ? -Number(raw.spent ?? event.resourceCost ?? event.value ?? 0)
      : resourceBefore !== undefined && resourceAfter !== undefined
        ? resourceAfter - resourceBefore
        : undefined;
  const values = eventValues(event, raw);
  const rootActionId = event.actionIndex > 0 ? `${context.battleId}:action:${event.actionIndex}` : undefined;
  const parentEventId = event.actionIndex > 0 && event.eventType !== 'action_start' ? context.rootEventId : undefined;
  const causedByEventId = outcomeEvent(event.eventType) ? context.causedByEventId : undefined;
  return compact({
    schemaVersion: COMBAT_EVENT_V2_SCHEMA,
    eventId: context.eventId,
    battleId: context.battleId,
    seed: Number(event.seed),
    rulesetId: context.rulesetId,
    experimentId: context.experimentId,
    groupId: context.groupId,
    round: event.round,
    actionIndex: event.actionIndex,
    eventIndex: context.eventIndex,
    eventType: event.eventType,
    sourceId: event.sourceId ?? undefined,
    sourcePosition: raw.sourceRow ?? raw.rowBefore ?? undefined,
    targetId: event.targetId ?? undefined,
    targetPosition: event.targetPosition ?? undefined,
    skillId: event.skillId ?? undefined,
    statusId: event.statusId ?? undefined,
    mechanicId: event.mechanicId ?? undefined,
    phaseId: event.phaseId ?? undefined,
    ...values,
    damageTakenMultiplier: numberOrUndefined(raw.damageTakenMultiplier),
    exposedMultiplier: numberOrUndefined(raw.exposedMultiplier),
    vulnerabilityMultiplier: numberOrUndefined(raw.vulnerabilityMultiplier),
    extraDamageFromExposed: numberOrUndefined(raw.extraDamageFromExposed),
    extraDamageFromVulnerability: numberOrUndefined(raw.extraDamageFromVulnerability),
    resourceBefore,
    resourceAfter,
    resourceDelta,
    parentEventId,
    rootActionId,
    causedByEventId,
    tags: eventTags(event, skill),
    metadata: { ...raw, sourceSide, targetSide, skill, legacyTimestampOrder: event.timestampOrder }
  });
}

function inferredSide(id, registry) {
  if (!id) return undefined;
  if (registry.unit(id)) return 'player';
  if (registry.boss(id) || String(id).includes('@')) return 'enemy';
  return undefined;
}

function eventValues(event, raw) {
  if (event.eventType === 'damage') {
    const theoretical = Number(raw.theoreticalDamage ?? raw.attempted ?? event.value ?? 0);
    const effective = Number(raw.actual ?? event.value ?? 0);
    const absorbed = Number(raw.absorbed ?? 0);
    const mitigated = Number(raw.mitigatedDamage ?? 0);
    const explicitOver = Number(raw.overkillDamage ?? 0) + Number(raw.ineffectiveDamage ?? 0);
    const over = explicitOver || Math.max(0, theoretical - effective - absorbed - mitigated);
    return { value: effective, theoreticalValue: theoretical, effectiveValue: effective, overValue: over };
  }
  if (event.eventType === 'heal') return {
    value: Number(raw.attempted ?? event.value ?? 0),
    theoreticalValue: Number(raw.attempted ?? event.value ?? 0),
    effectiveValue: Number(raw.effective ?? event.value ?? 0),
    overValue: Number(raw.overheal ?? 0)
  };
  if (event.eventType === 'shield_gain') return {
    value: Number(raw.attempted ?? event.value ?? 0),
    theoreticalValue: Number(raw.attempted ?? event.value ?? 0),
    effectiveValue: Number(raw.granted ?? event.value ?? 0),
    overValue: Math.max(0, Number(raw.attempted ?? event.value ?? 0) - Number(raw.granted ?? event.value ?? 0))
  };
  if (event.eventType === 'shield_absorb') return { value: event.value, effectiveValue: event.value };
  if (event.eventType === 'shield_consume') return { value: event.value, effectiveValue: event.value };
  if (event.eventType === 'resource_gain' || event.eventType === 'resource_spend') return { value: Math.abs(Number(event.value ?? 0)), effectiveValue: Math.abs(Number(event.value ?? 0)) };
  return event.value ? { value: Number(event.value) } : {};
}

function eventTags(event, skill) {
  const tags = new Set([event.eventType]);
  const sourceSide = event.metadata?.sourceSide ?? event.metadata?.side;
  const targetSide = event.metadata?.targetSide;
  if (sourceSide) tags.add(`source:${sourceSide}`);
  if (targetSide) tags.add(`target:${targetSide}`);
  for (const tag of skill?.functionalTags ?? []) tags.add(tag);
  for (const category of skill?.actionCategories ?? []) tags.add(`action:${category}`);
  if (event.eventType === 'swap') tags.add(event.metadata?.forced ? 'forced_swap' : 'tactical_swap');
  if (event.eventType === 'unit_death') tags.add('kill');
  if (event.eventType === 'replacement_completed') tags.add('replacement');
  if (event.eventType === 'ai_decision') tags.add('ai_score_snapshot');
  return [...tags];
}

function outcomeEvent(type) {
  return ['damage', 'heal', 'shield_gain', 'shield_absorb', 'shield_consume', 'resource_gain', 'resource_spend', 'unit_death', 'replacement_scheduled', 'replacement_completed', 'status_apply', 'status_remove'].includes(type);
}

function numberOrUndefined(value) {
  return value === undefined || value === null || value === '' ? undefined : Number(value);
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}
