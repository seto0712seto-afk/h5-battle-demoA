import { validateCombatEventsV2 } from './event-v2.mjs';

export function runQualityGates({ battles, metadataRegistry, metricRegistry, mechanicConfig, mechanicDslIssues = [], experimentRegistryIssues = [], experimentValidation = null }) {
  const gates = [
    gate('event_order', 'P0', eventOrderIssues(battles)),
    gate('battle_boundary', 'P0', boundaryIssues(battles)),
    gate('damage_closure', 'P0', damageClosureIssues(battles)),
    gate('shield_closure', 'P0', shieldClosureIssues(battles)),
    gate('replacement_lifecycle', 'P0', replacementIssues(battles)),
    gate('mechanic_window_closure', 'P0', windowIssues(battles)),
    gate('metadata_registry', 'P0', metadataRegistry.issues),
    gate('metric_registry', 'P0', metricRegistry.issues),
    gate('mechanic_dsl', 'P0', mechanicDslIssues),
    gate('experiment_registry', 'P0', experimentRegistryIssues),
    gate('overlap_attribution', 'P0', mechanicConfig?.attribution ? [] : ['attribution:missing-config']),
    gate('experiment_comparability', 'P0', experimentValidation?.status === 'failed' ? experimentValidation.issues : []),
    gate('seed_uniqueness', 'P0', duplicateSeedIssues(battles)),
    gate('team_pool', 'P0', teamIssues(battles, metadataRegistry)),
    gate('ai_policy_version', 'P0', policyIssues(battles))
  ];
  const p0Failures = gates.filter((item) => item.severity === 'P0' && item.status === 'failed');
  return {
    gates,
    passed: p0Failures.length === 0,
    automaticConclusionsAllowed: p0Failures.length === 0,
    p0Failures: p0Failures.map((item) => item.id)
  };
}

function shieldClosureIssues(battles) {
  const tolerance = 1e-6;
  return battles.flatMap((battle) => battle.events.filter((event) => event.eventType === 'shield_gain').flatMap((event) => {
    const attempted = Number(event.theoreticalValue);
    const effective = Number(event.effectiveValue);
    const excess = Number(event.overValue ?? 0);
    if (![attempted, effective, excess].every(Number.isFinite)) return [`${event.eventId}:shield:missing-values`];
    return Math.abs(attempted - effective - excess) <= tolerance ? [] : [`${event.eventId}:shield:${attempted}!=${effective}+${excess}`];
  }));
}

function gate(id, severity, issues) {
  return { id, severity, status: issues.length ? 'failed' : 'passed', issueCount: issues.length, issues: issues.slice(0, 100) };
}

function eventOrderIssues(battles) {
  return battles.flatMap((battle) => validateCombatEventsV2(battle.events).map((issue) => `${battle.battleId}:${issue.eventIndex}:${issue.issue}`));
}

function boundaryIssues(battles) {
  return battles.flatMap((battle) => {
    const starts = battle.events.filter((event) => event.eventType === 'battle_start').length;
    const ends = battle.events.filter((event) => event.eventType === 'battle_end').length;
    return starts === 1 && ends === 1 ? [] : [`${battle.battleId}:battle-boundary:${starts}/${ends}`];
  });
}

function damageClosureIssues(battles) {
  const tolerance = 1e-6;
  return battles.flatMap((battle) => battle.events.filter((event) => event.eventType === 'damage').flatMap((event) => {
    const attempted = Number(event.theoreticalValue);
    const actual = Number(event.effectiveValue);
    const absorbed = Number(event.metadata?.absorbed ?? 0);
    const overkill = Number(event.overValue ?? 0);
    const mitigated = Number(event.metadata?.mitigatedDamage ?? 0);
    const ineffective = 0;
    if (![attempted, actual, absorbed, overkill, mitigated, ineffective].every(Number.isFinite)) return [];
    const settlement = actual + absorbed + overkill + mitigated + ineffective;
    return Math.abs(attempted - settlement) <= tolerance ? [] : [`${event.eventId}:damage:${attempted}!=${actual}+${absorbed}+${overkill}+${mitigated}+${ineffective}`];
  }));
}

function replacementIssues(battles) {
  return battles.flatMap((battle) => {
    const scheduled = battle.events.filter((event) => event.eventType === 'replacement_scheduled').length;
    const completed = battle.events.filter((event) => event.eventType === 'replacement_completed').length;
    return completed <= scheduled ? [] : [`${battle.battleId}:replacement:${completed}>${scheduled}`];
  });
}

function windowIssues(battles) {
  return battles.flatMap((battle) => (battle.mechanicWindows ?? []).filter((window) => !window.endEventId).map((window) => `${battle.battleId}:${window.windowId}:unclosed`));
}

function duplicateSeedIssues(battles) {
  const groups = new Map();
  for (const battle of battles) {
    if (!groups.has(battle.groupId)) groups.set(battle.groupId, new Set());
    const seeds = groups.get(battle.groupId);
    if (seeds.has(battle.seed)) return [`${battle.groupId}:duplicate-seed:${battle.seed}`];
    seeds.add(battle.seed);
  }
  return [];
}

function teamIssues(battles, metadataRegistry) {
  return battles.flatMap((battle) => {
    if (!battle.team?.length) return [`${battle.battleId}:team:empty`];
    return battle.team.filter((id) => !metadataRegistry.unit(id)).map((id) => `${battle.battleId}:team:unknown:${id}`);
  });
}

function policyIssues(battles) {
  return battles.filter((battle) => !battle.aiPolicyId).map((battle) => `${battle.battleId}:ai-policy:missing`);
}
