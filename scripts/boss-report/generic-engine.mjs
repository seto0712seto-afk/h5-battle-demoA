import { average, countBy, percentile, ratio, round, sum, topDistinct } from './common.mjs';
import { matchesEvent, normalizeTraceEvents, unifiedEvent, validateUnifiedEvents } from './unified-events.mjs';

const BEHAVIORS = ['attack', 'protect', 'recover', 'energy', 'swap', 'position'];
export const SUPPORTED_MECHANIC_TYPES = [
  'telegraph_attack', 'vulnerability_window', 'target_lock', 'position_pressure',
  'resource_pressure', 'phase_escalation', 'stacking_growth', 'damage_over_time',
  'summon', 'shield_break', 'healing_check', 'survival_check', 'burst_check', 'custom_window'
];
const RESPONSE_TAGS = ['attack', 'high_cost_attack', 'resource_spend', 'heal', 'shield', 'heal_target', 'shield_target', 'swap', 'swap_target', 'position_change', 'burst_kill'];
const OUTCOME_METRICS = ['life_damage', 'shield_absorb', 'kill', 'replacement', 'boss_damage', 'window_kill', 'resource_delta', 'mechanic_prevented'];

export function validateBossMechanicConfig(config) {
  const issues = [];
  if (!config?.bossId) issues.push('missing:bossId');
  if (!config?.bossName) issues.push('missing:bossName');
  if (!Array.isArray(config?.mechanics)) issues.push('missing:mechanics');
  const ids = new Set();
  for (const mechanic of config?.mechanics ?? []) {
    if (!mechanic.mechanicId) issues.push('mechanic:missing-id');
    if (ids.has(mechanic.mechanicId)) issues.push(`mechanic:duplicate:${mechanic.mechanicId}`);
    ids.add(mechanic.mechanicId);
    if (!SUPPORTED_MECHANIC_TYPES.includes(mechanic.type)) issues.push(`mechanic:type:${mechanic.mechanicId}`);
    if (!mechanic.startEvent?.eventType) issues.push(`mechanic:start:${mechanic.mechanicId}`);
    if (!mechanic.endEvent?.eventType) issues.push(`mechanic:end:${mechanic.mechanicId}`);
    for (const tag of mechanic.responseTags ?? []) if (!RESPONSE_TAGS.includes(tag)) issues.push(`mechanic:response:${mechanic.mechanicId}:${tag}`);
    for (const metric of mechanic.outcomeMetrics ?? []) if (!OUTCOME_METRICS.includes(metric)) issues.push(`mechanic:outcome:${mechanic.mechanicId}:${metric}`);
  }
  for (const cohort of config?.customCohorts ?? []) {
    if (!cohort.id) issues.push('cohort:missing-id');
    if (!['main', 'ai'].includes(cohort.scope)) issues.push(`cohort:scope:${cohort.id}`);
    if (!['random', 'fixed'].includes(cohort.roster)) issues.push(`cohort:roster:${cohort.id}`);
    if (!cohort.policy) issues.push(`cohort:policy:${cohort.id}`);
    if (!Number.isInteger(cohort.runs) || cohort.runs <= 0) issues.push(`cohort:runs:${cohort.id}`);
  }
  return issues;
}

export function analyzeGenericBoss({ bossConfig, defaults, mainGroups, aiGroups = [], tendencyGroups = [] }) {
  const groups = mainGroups.map((group) => analyzeGroup(group, bossConfig, defaults));
  const ai = aiGroups.map((group) => analyzeGroup(group, bossConfig, defaults));
  const tendencies = tendencyGroups.map((group) => analyzeGroup(group, bossConfig, defaults));
  const allGroups = [...groups, ...ai, ...tendencies];
  const allBattles = groups.flatMap((group) => group.battles);
  const random = groups.find((group) => group.id === 'RANDOM') ?? groups[0];
  const audit = auditAnalysis(allGroups, bossConfig);
  const mechanics = aggregateMechanics(allBattles, bossConfig, defaults);
  const skillEcology = aggregateSkillEcology(allBattles, defaults);
  const roster = aggregateRoster(allBattles, groups, defaults);
  const longTail = aggregateLongTail(allBattles, defaults);
  const aiComparison = compareAi(ai, defaults);
  const attribution = buildAttribution({ random, mechanics, longTail, aiComparison, roster, defaults });
  const conclusions = buildConclusions({ random, mechanics, longTail, aiComparison, defaults, audit });
  return {
    bossConfig,
    defaults,
    groups,
    ai,
    tendencies,
    allBattles,
    random,
    audit,
    mechanics,
    skillEcology,
    roster,
    longTail,
    aiComparison,
    attribution,
    conclusions,
    representatives: representativeSeeds(allBattles, mechanics, defaults)
  };
}

function analyzeGroup(group, bossConfig, defaults) {
  const battles = group.traces.map((trace) => analyzeBattle(trace, group, bossConfig, defaults));
  return {
    ...group,
    battles,
    result: battleMetrics(battles, defaults),
    behavior: behaviorRates(battles.flatMap((battle) => battle.actions))
  };
}

function analyzeBattle(trace, group, bossConfig, defaults) {
  const baseEvents = normalizeTraceEvents(trace);
  const actions = buildActions(baseEvents);
  actions.forEach((action) => { action.seed = trace.seed; });
  const mechanicWindows = Object.fromEntries(bossConfig.mechanics.map((mechanic) => [
    mechanic.mechanicId,
    buildMechanicWindows(trace, baseEvents, actions, mechanic, defaults)
  ]));
  const events = materializeMechanicEvents(baseEvents, bossConfig.mechanics, mechanicWindows);
  const schemaIssues = validateUnifiedEvents(events);
  const rounds = trace.rounds ?? Math.max(0, ...events.map((event) => event.round));
  const battle = {
    battleId: String(trace.battleId ?? trace.seed),
    seed: trace.seed,
    groupId: group.id,
    groupLabel: group.label,
    policy: group.policy,
    policyRole: group.policyRole ?? null,
    pairKey: group.pairKey ?? null,
    team: [...(trace.team ?? [])],
    victory: trace.result === 'victory',
    result: trace.result,
    rounds,
    finalHpRatio: trace.finalHpRatio ?? 0,
    bossRemainingHpRatio: trace.bossRemainingHpRatio ?? 0,
    survivingSpirits: trace.survivingSpirits ?? 0,
    casualties: Math.max(0, (trace.team?.length ?? 0) - (trace.survivingSpirits ?? 0)),
    replacements: trace.forcedReplacements ?? 0,
    swaps: trace.tacticalSwaps ?? 0,
    rowSwitches: trace.rowSwitches ?? 0,
    finalMana: trace.finalMana ?? 0,
    errors: trace.errors ?? [],
    actions,
    events,
    baseEvents,
    mechanicWindows,
    perRound: trace.perRound ?? [],
    schemaIssues,
    longTail: rounds >= defaults.longTailRound
  };
  battle.longTailSignals = detectLongTailSignals(battle, defaults);
  battle.longTailType = classifyLongTail(battle.longTailSignals);
  return battle;
}

function buildActions(events) {
  const byIndex = new Map();
  for (const event of events) {
    if (event.eventType === 'action_start' && event.metadata.sourceSide === 'player') {
      byIndex.set(event.actionIndex, {
        actionIndex: event.actionIndex,
        round: event.round,
        startOrder: event.timestampOrder,
        endOrder: event.timestampOrder,
        actorId: event.sourceId,
        skillId: null,
        skillName: null,
        behavior: null,
        cost: 0,
        damageToBoss: 0,
        healing: 0,
        shield: 0,
        resourceGain: 0,
        swap: false,
        positionChange: false,
        bossKill: false,
        events: []
      });
    }
    const action = byIndex.get(event.actionIndex);
    if (!action) continue;
    action.events.push(event);
    action.endOrder = Math.max(action.endOrder, event.timestampOrder);
    if (event.eventType === 'skill_confirm') {
      action.skillId = event.skillId;
      action.skillName = event.metadata.skill?.name ?? event.skillId;
      action.cost = event.resourceCost;
      action.behavior = normalizeBehavior(event.metadata.skill);
    }
    if (event.eventType === 'damage' && event.metadata.sourceSide === 'player' && event.metadata.targetSide === 'enemy') action.damageToBoss += event.value;
    if (event.eventType === 'heal') action.healing += event.value;
    if (event.eventType === 'shield_gain') action.shield += event.value;
    if (event.eventType === 'resource_gain' && event.metadata.source === 'skill') action.resourceGain += event.value;
    if (event.eventType === 'swap' && !event.metadata.forced) action.swap = true;
    if (event.eventType === 'position_change') action.positionChange = true;
    if (event.eventType === 'unit_death' && event.metadata.targetSide === 'enemy') action.bossKill = true;
  }
  return [...byIndex.values()].sort((a, b) => a.startOrder - b.startOrder).map((action) => {
    if (!action.behavior) action.behavior = action.swap ? 'swap' : action.positionChange ? 'position' : 'other';
    return action;
  });
}

function normalizeBehavior(skill) {
  const primary = skill?.primaryBehavior;
  if (BEHAVIORS.includes(primary)) return primary;
  if (primary === 'heal') return 'recover';
  if (primary === 'shield') return 'protect';
  if (skill?.kind === 'attack') return 'attack';
  if (skill?.kind === 'heal') return 'recover';
  if (skill?.kind === 'support') return 'protect';
  return primary ?? 'other';
}

function buildMechanicWindows(trace, events, actions, mechanic, defaults) {
  const windows = [];
  let open = null;
  for (const event of events) {
    if (open && matchesEvent(event, mechanic.resolveEvent) && event.timestampOrder >= open.startOrder) {
      open.resolveEvent = event;
    }
    if (open && matchesEvent(event, mechanic.endEvent) && event.timestampOrder > open.startOrder) {
      closeMechanicWindow(open, event, 'configured-end', actions, events, mechanic, defaults);
      open = null;
    }
    if (matchesEvent(event, mechanic.startEvent)) {
      if (open) closeMechanicWindow(open, event, 'superseded', actions, events, mechanic, defaults);
      const triggerActionStart = mechanic.includeTriggerAction
        ? [...events].reverse().find((candidate) => candidate.eventType === 'action_start' &&
          candidate.actionIndex === event.actionIndex && candidate.timestampOrder <= event.timestampOrder)
        : null;
      open = newMechanicWindow(trace, mechanic, windows.length + 1, event, triggerActionStart);
      windows.push(open);
      if (matchesEvent(event, mechanic.resolveEvent)) open.resolveEvent = event;
    }
    if (event.eventType === 'battle_end' && open) {
      closeMechanicWindow(open, event, 'battle-ended', actions, events, mechanic, defaults);
      open = null;
    }
  }
  if (open) closeMechanicWindow(open, events.at(-1), 'trace-ended', actions, events, mechanic, defaults);
  return windows;
}

function newMechanicWindow(trace, mechanic, index, event, triggerActionStart = null) {
  return {
    mechanicId: mechanic.mechanicId,
    displayName: mechanic.displayName,
    type: mechanic.type,
    seed: trace.seed,
    team: [...(trace.team ?? [])],
    battleResult: trace.result,
    battleRounds: trace.rounds,
    index,
    startEvent: event,
    startOrder: triggerActionStart?.timestampOrder ?? event.timestampOrder,
    startRound: event.round,
    resolveEvent: null,
    endEvent: null,
    endOrder: null,
    resolution: null,
    lockedTargetId: event.targetId ?? event.metadata.lockedTargetId ?? event.metadata.targetIds?.[0] ?? null,
    lockedSlotIndex: event.metadata.lockedSlotIndex ?? event.metadata.lockedOriginSlotIndex ?? null,
    actions: [],
    responseTags: [],
    outcome: {},
    postImpact: {}
  };
}

function closeMechanicWindow(window, event, resolution, actions, events, mechanic, defaults) {
  window.endEvent = event;
  window.endOrder = event?.timestampOrder ?? window.startOrder;
  window.resolution = resolution;
  window.actions = actions.filter((action) => action.startOrder > window.startOrder && action.startOrder < window.endOrder);
  const scopedEvents = events.filter((item) => item.timestampOrder >= window.startOrder && item.timestampOrder <= window.endOrder);
  window.responseTags = mechanic.responseTags.filter((tag) => responseTagSeen(tag, window, scopedEvents, defaults));
  window.handled = window.responseTags.length > 0;
  window.outcome = outcomeMetrics(mechanic.outcomeMetrics, window, scopedEvents);
  window.postImpact = postImpactMetrics(window, events, mechanic.postImpactRounds ?? defaults.postImpactRounds, defaults);
}

function responseTagSeen(tag, window, events, defaults) {
  const targetMatch = (event) => event.targetId === window.lockedTargetId ||
    (window.lockedSlotIndex !== null && event.metadata.targetSlotIndex === window.lockedSlotIndex) ||
    (window.lockedSlotIndex !== null && event.metadata.slotIndex === window.lockedSlotIndex);
  if (tag === 'attack') return window.actions.some((action) => action.behavior === 'attack');
  if (tag === 'high_cost_attack') return window.actions.some((action) => action.behavior === 'attack' && action.cost >= defaults.highCostThreshold);
  if (tag === 'resource_spend') return window.actions.some((action) => action.cost > 0);
  if (tag === 'heal') return events.some((event) => event.eventType === 'heal');
  if (tag === 'shield') return events.some((event) => event.eventType === 'shield_gain');
  if (tag === 'heal_target') return events.some((event) => event.eventType === 'heal' && targetMatch(event));
  if (tag === 'shield_target') return events.some((event) => event.eventType === 'shield_gain' && targetMatch(event));
  if (tag === 'swap') return events.some((event) => event.eventType === 'swap' && !event.metadata.forced);
  if (tag === 'swap_target') return events.some((event) => event.eventType === 'swap' && !event.metadata.forced && targetMatch(event));
  if (tag === 'position_change') return events.some((event) => event.eventType === 'position_change');
  if (tag === 'burst_kill') return events.some((event) => event.eventType === 'unit_death' && event.metadata.targetSide === 'enemy');
  return false;
}

function outcomeMetrics(metrics, window, events) {
  const result = {};
  for (const metric of metrics) {
    if (metric === 'life_damage') result[metric] = sum(events.filter((event) => event.eventType === 'damage' && event.metadata.sourceSide === 'enemy'), (event) => event.value);
    else if (metric === 'shield_absorb') result[metric] = sum(events.filter((event) => event.eventType === 'shield_absorb' && event.metadata.sourceSide === 'enemy'), (event) => event.value);
    else if (metric === 'kill') result[metric] = events.filter((event) => event.eventType === 'unit_death' && event.metadata.targetSide === 'player').length;
    else if (metric === 'replacement') result[metric] = events.filter((event) => event.eventType === 'replacement_scheduled' || event.eventType === 'replacement_completed').length;
    else if (metric === 'boss_damage') result[metric] = sum(window.actions, (action) => action.damageToBoss);
    else if (metric === 'window_kill') result[metric] = window.actions.some((action) => action.bossKill) ? 1 : 0;
    else if (metric === 'resource_delta') result[metric] = sum(events.filter((event) => event.eventType === 'resource_gain'), (event) => event.value) - sum(events.filter((event) => event.eventType === 'resource_spend'), (event) => event.value);
    else if (metric === 'mechanic_prevented') result[metric] = window.resolveEvent ? 0 : events.some((event) => event.eventType === 'unit_death' && event.metadata.targetSide === 'enemy') ? 1 : 0;
  }
  return result;
}

function postImpactMetrics(window, events, rounds, defaults) {
  const resolveRound = window.resolveEvent?.round ?? window.endEvent?.round ?? window.startRound;
  const scoped = events.filter((event) => event.round > resolveRound && event.round <= resolveRound + rounds);
  return {
    rounds,
    bossDamage: sum(scoped.filter((event) => event.eventType === 'damage' && event.metadata.sourceSide === 'player'), (event) => event.value),
    healing: sum(scoped.filter((event) => event.eventType === 'heal'), (event) => event.value),
    shield: sum(scoped.filter((event) => event.eventType === 'shield_gain'), (event) => event.value),
    casualties: scoped.filter((event) => event.eventType === 'unit_death' && event.metadata.targetSide === 'player').length,
    resourceDelta: sum(scoped.filter((event) => event.eventType === 'resource_gain'), (event) => event.value) - sum(scoped.filter((event) => event.eventType === 'resource_spend'), (event) => event.value),
    enteredLongTail: (window.battleRounds ?? 0) >= defaults.longTailRound ? 1 : 0
  };
}

function materializeMechanicEvents(events, mechanics, windowsByMechanic) {
  const entries = events.map((event) => ({ order: event.timestampOrder, rank: 1, event }));
  mechanics.forEach((mechanic) => {
    for (const window of windowsByMechanic[mechanic.mechanicId]) {
      entries.push({ order: window.startOrder, rank: 2, event: derivedMechanicEvent(window, 'boss_mechanic_trigger', window.startEvent) });
      entries.push({ order: window.startOrder, rank: 3, event: derivedMechanicEvent(window, 'mechanic_window_start', window.startEvent) });
      if (window.endEvent) entries.push({ order: window.endOrder, rank: 4, event: derivedMechanicEvent(window, 'mechanic_window_end', window.endEvent) });
    }
  });
  return entries.sort((a, b) => a.order - b.order || a.rank - b.rank).map((entry, index) => unifiedEvent({ ...entry.event, timestampOrder: index + 1 }));
}

function derivedMechanicEvent(window, eventType, source) {
  return {
    ...source,
    eventType,
    mechanicId: window.mechanicId,
    metadata: { ...source.metadata, windowIndex: window.index, derived: true, resolution: window.resolution }
  };
}

function aggregateMechanics(battles, bossConfig, defaults) {
  return bossConfig.mechanics.map((config) => {
    const windows = battles.flatMap((battle) => battle.mechanicWindows[config.mechanicId]);
    const valid = windows.filter((window) => window.actions.length > 0);
    const handled = windows.filter((window) => window.handled);
    const ignored = windows.filter((window) => !window.handled);
    const windowActions = valid.flatMap((window) => window.actions);
    const actionKeys = new Set(windowActions.map((action) => `${action.seed}:${action.actionIndex}`));
    const allActions = battles.flatMap((battle) => battle.actions.map((action) => ({ ...action, seed: battle.seed })));
    const baselineActions = allActions.filter((action) => !actionKeys.has(`${action.seed}:${action.actionIndex}`));
    const baseline = behaviorRates(baselineActions);
    const during = behaviorRates(windowActions);
    const responseLifts = configuredResponseLifts(baselineActions, windowActions, config.responseTags, defaults);
    const baselineResponseRate = Math.max(0, ...Object.values(responseLifts).map((item) => item.baseline));
    const duringResponseRate = Math.max(0, ...Object.values(responseLifts).map((item) => item.during));
    const responseCounts = countBy(windows.flatMap((window) => window.responseTags), (tag) => tag);
    return {
      config,
      windows,
      valid,
      handled,
      ignored,
      triggerCount: windows.length,
      legalActionCount: valid.length,
      surfaceResponseCount: handled.length,
      netResponseRate: Math.max(0, round(Math.max(0, ...Object.values(responseLifts).map((item) => item.lift)))),
      resolvedCount: windows.filter((window) => window.resolveEvent).length,
      damageOrKillCount: windows.filter((window) => (window.outcome.life_damage ?? window.outcome.boss_damage ?? 0) > 0 || (window.outcome.kill ?? window.outcome.window_kill ?? 0) > 0).length,
      nextPhaseCount: windows.filter((window) => window.postImpact.enteredLongTail || window.endEvent?.eventType === 'phase_change').length,
      baseline,
      during,
      baselineResponseRate,
      duringResponseRate,
      responseLifts,
      lifts: Object.fromEntries(Object.keys(during).map((key) => [key, typeof during[key] === 'number' ? round(during[key] - (baseline[key] ?? 0)) : 0])),
      responseCounts,
      handling: {
        handled: aggregateWindowOutcomes(handled, config.outcomeMetrics),
        ignored: aggregateWindowOutcomes(ignored, config.outcomeMetrics)
      },
      battleHandling: battleHandlingMetrics(battles, config.mechanicId, defaults),
      postImpact: aggregatePostImpact(windows),
      responseBreakdown: responseBreakdown(windows, config.outcomeMetrics),
      conclusion: mechanicConclusion({ windows, valid, handled, responseLifts, defaults })
    };
  });
}

function configuredResponseLifts(baselineActions, windowActions, responseTags, defaults) {
  return Object.fromEntries(responseTags.map((tag) => {
    const matches = (action) => {
      if (tag === 'attack') return action.behavior === 'attack';
      if (tag === 'burst_kill') return action.bossKill;
      if (tag === 'high_cost_attack') return action.behavior === 'attack' && action.cost >= defaults.highCostThreshold;
      if (tag === 'resource_spend') return action.cost > 0;
      if (['heal', 'heal_target'].includes(tag)) return action.behavior === 'recover' || action.healing > 0;
      if (['shield', 'shield_target'].includes(tag)) return action.behavior === 'protect' || action.shield > 0;
      if (['swap', 'swap_target'].includes(tag)) return action.swap;
      if (tag === 'position_change') return action.positionChange;
      return false;
    };
    const baseline = ratio(baselineActions.filter(matches).length, baselineActions.length);
    const during = ratio(windowActions.filter(matches).length, windowActions.length);
    return [tag, { baseline, during, lift: round(during - baseline) }];
  }));
}

function behaviorRates(actions) {
  const total = actions.length;
  const rates = Object.fromEntries(BEHAVIORS.map((behavior) => [behavior, ratio(actions.filter((action) => action.behavior === behavior).length, total)]));
  return {
    ...rates,
    highCostAttack: ratio(actions.filter((action) => action.behavior === 'attack' && action.cost >= 3).length, total),
    averageResourceCost: average(actions.map((action) => action.cost)) ?? 0,
    any: ratio(actions.filter((action) => action.behavior !== 'other').length, total),
    actions: total
  };
}

function aggregateWindowOutcomes(windows, metrics) {
  return {
    samples: windows.length,
    ...Object.fromEntries(metrics.map((metric) => [metric, average(windows.map((window) => window.outcome[metric] ?? 0)) ?? 0]))
  };
}

function responseBreakdown(windows, metrics) {
  const groups = new Map();
  windows.forEach((window) => {
    const key = window.responseTags.length ? window.responseTags.join('+') : '忽略';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(window);
  });
  return Object.fromEntries([...groups].map(([key, items]) => [key, {
    samples: items.length,
    share: ratio(items.length, windows.length),
    ...Object.fromEntries(metrics.map((metric) => [metric, average(items.map((window) => window.outcome[metric] ?? 0)) ?? 0]))
  }]));
}

function aggregatePostImpact(windows) {
  return {
    samples: windows.length,
    bossDamage: average(windows.map((window) => window.postImpact.bossDamage)) ?? 0,
    healing: average(windows.map((window) => window.postImpact.healing)) ?? 0,
    shield: average(windows.map((window) => window.postImpact.shield)) ?? 0,
    casualties: average(windows.map((window) => window.postImpact.casualties)) ?? 0,
    resourceDelta: average(windows.map((window) => window.postImpact.resourceDelta)) ?? 0,
    enteredLongTailRate: ratio(windows.filter((window) => window.postImpact.enteredLongTail).length, windows.length)
  };
}

function battleHandlingMetrics(battles, mechanicId, defaults) {
  const classify = (battle) => {
    const windows = battle.mechanicWindows[mechanicId];
    if (!windows.length) return 'not-seen';
    if (windows.every((window) => window.handled)) return 'all-handled';
    if (windows.every((window) => !window.handled)) return 'all-ignored';
    return 'partial';
  };
  return Object.fromEntries(['all-handled', 'partial', 'all-ignored', 'not-seen'].map((key) => [key, battleMetrics(battles.filter((battle) => classify(battle) === key), defaults)]));
}

function mechanicConclusion({ windows, valid, handled, responseLifts, defaults }) {
  const responseLift = Math.max(0, ...Object.values(responseLifts).map((item) => item.lift));
  const decision = responseLift >= defaults.decisionShift ? '形成明确决策变化'
    : responseLift >= defaults.decisionShift / 2 ? '存在弱决策变化' : '未形成明确决策变化';
  return {
    triggerRate: windows.length,
    responseRate: ratio(handled.length, windows.length),
    decision,
    confidence: windows.length >= defaults.minimumCohortSamples && valid.length >= defaults.minimumCohortSamples ? '中' : '低'
  };
}

function battleMetrics(battles, defaults) {
  const rounds = battles.map((battle) => battle.rounds);
  const victories = battles.filter((battle) => battle.victory);
  const defeats = battles.filter((battle) => !battle.victory);
  return {
    samples: battles.length,
    winRate: ratio(victories.length, battles.length),
    averageRounds: average(rounds),
    medianRounds: percentile(rounds, 0.5),
    p75Rounds: percentile(rounds, 0.75),
    p90Rounds: percentile(rounds, 0.9),
    p95Rounds: percentile(rounds, 0.95),
    over15Rate: ratio(battles.filter((battle) => battle.rounds > 15).length, battles.length),
    over20Rate: ratio(battles.filter((battle) => battle.rounds > 20).length, battles.length),
    over30Rate: ratio(battles.filter((battle) => battle.rounds > 30).length, battles.length),
    longestVictory: Math.max(0, ...victories.map((battle) => battle.rounds)),
    longestDefeat: Math.max(0, ...defeats.map((battle) => battle.rounds)),
    finalHpRatio: average(battles.map((battle) => battle.finalHpRatio)),
    casualties: average(battles.map((battle) => battle.casualties)),
    replacements: average(battles.map((battle) => battle.replacements)),
    swaps: average(battles.map((battle) => battle.swaps)),
    longTailRate: ratio(battles.filter((battle) => battle.rounds >= defaults.longTailRound).length, battles.length)
  };
}

function aggregateSkillEcology(battles, defaults) {
  const allActions = battles.flatMap((battle) => battle.actions.map((action) => ({ ...action, longTail: battle.longTail, battleSeed: battle.seed })));
  const behavior = Object.fromEntries(['all', 'short', 'long'].map((key) => {
    const actions = key === 'all' ? allActions : allActions.filter((action) => key === 'long' ? action.longTail : !action.longTail);
    return [key, behaviorRates(actions)];
  }));
  const skills = new Map();
  battles.forEach((battle) => {
    const previous = new Map();
    const streak = new Map();
    battle.actions.forEach((action) => {
      if (!action.skillId) return;
      if (!skills.has(action.skillId)) skills.set(action.skillId, { skillId: action.skillId, name: action.skillName, uses: 0, damage: 0, healing: 0, shield: 0, resourceGain: 0, repeats: 0, streak3: 0, streak5: 0, streak10: 0, maxStreak: 0 });
      const item = skills.get(action.skillId);
      item.uses += 1;
      item.damage += action.damageToBoss;
      item.healing += action.healing;
      item.shield += action.shield;
      item.resourceGain += action.resourceGain;
      const next = previous.get(action.actorId) === action.skillId ? (streak.get(action.actorId) ?? 1) + 1 : 1;
      if (next > 1) item.repeats += 1;
      if (next === 3) item.streak3 += 1;
      if (next === 5) item.streak5 += 1;
      if (next === 10) item.streak10 += 1;
      item.maxStreak = Math.max(item.maxStreak, next);
      previous.set(action.actorId, action.skillId);
      streak.set(action.actorId, next);
    });
  });
  const total = allActions.filter((action) => action.skillId).length;
  return {
    behavior,
    skills: [...skills.values()].map((item) => ({ ...item, actionShare: ratio(item.uses, total), repeatRate: ratio(item.repeats, item.uses) })).sort((a, b) => b.uses - a.uses),
    maxSkillStreak: Math.max(0, ...[...skills.values()].map((item) => item.maxStreak)),
    longTailRound: defaults.longTailRound
  };
}

function detectLongTailSignals(battle, defaults) {
  if (!battle.longTail) return [];
  const early = battle.perRound.filter((entry) => entry.round <= 10);
  const late = battle.perRound.filter((entry) => entry.round >= defaults.longTailRound);
  const perRound = (rows, key) => ratio(sum(rows, (row) => row[key]), rows.length);
  const earlyDamage = perRound(early, 'damageToBoss');
  const lateDamage = perRound(late, 'damageToBoss');
  const earlyHealing = perRound(early, 'effectiveHealing');
  const lateHealing = perRound(late, 'effectiveHealing');
  const earlyShield = perRound(early, 'effectiveShield');
  const lateShield = perRound(late, 'effectiveShield');
  const lateIncoming = perRound(late, 'damageToPlayers');
  const lateMana = battle.events.filter((event) => event.round >= defaults.longTailRound && ['resource_gain', 'resource_spend'].includes(event.eventType)).map((event) => event.metadata.after).filter(Number.isFinite);
  const signals = [];
  if (lateDamage < earlyDamage * 0.55) signals.push('输出衰减');
  if (lateHealing > earlyHealing * 1.35 && lateHealing > 20) signals.push('治疗上升');
  if (lateShield > earlyShield * 1.35 && lateShield > 20) signals.push('护盾上升');
  if (Math.abs(lateIncoming - lateHealing) <= 20) signals.push('净生命损失接近0');
  if ((average(lateMana) ?? 10) <= 2.5) signals.push('资源长期低位');
  if (battle.events.some((event) => event.eventType === 'unit_death' && event.metadata.targetSide === 'player' && event.round <= 12)) signals.push('核心输出死亡候选');
  if (maxBattleStreak(battle.actions) >= 5) signals.push('连续重复技能');
  if (battle.survivingSpirits <= 2) signals.push('残阵维持');
  if (lateDamage < 50) signals.push('Boss生命下降停滞');
  return signals;
}

function classifyLongTail(signals) {
  if (!signals.length) return '无明显单一类型';
  const types = [];
  if (signals.includes('输出衰减') || signals.includes('Boss生命下降停滞')) types.push('低输出维持型');
  if (signals.includes('治疗上升') || signals.includes('护盾上升') || signals.includes('净生命损失接近0')) types.push('高回复僵持型');
  if (signals.includes('资源长期低位')) types.push('资源枯竭型');
  if (signals.includes('残阵维持') || signals.includes('连续重复技能')) types.push('残阵循环型');
  if (types.length === 0) return '高压失败型';
  return types.length === 1 ? types[0] : '混合型';
}

function aggregateLongTail(battles, defaults) {
  const long = battles.filter((battle) => battle.longTail);
  const signalRows = Object.entries(countBy(long.flatMap((battle) => battle.longTailSignals), (signal) => signal)).map(([signal, count]) => {
    const matched = long.filter((battle) => battle.longTailSignals.includes(signal));
    return { signal, battles: count, medianFirstRound: firstSignalRound(signal, matched, defaults), subsequentLongTailRate: ratio(matched.length, battles.length) };
  }).sort((a, b) => b.battles - a.battles);
  return {
    threshold: defaults.longTailRound,
    samples: long.length,
    rate: ratio(long.length, battles.length),
    types: countBy(long, (battle) => battle.longTailType),
    signals: signalRows,
    medianRounds: percentile(long.map((battle) => battle.rounds), 0.5),
    winRate: ratio(long.filter((battle) => battle.victory).length, long.length)
  };
}

function firstSignalRound(signal, battles, defaults) {
  const candidates = battles.map((battle) => {
    if (signal === '核心输出死亡候选') return battle.events.find((event) => event.eventType === 'unit_death' && event.metadata.targetSide === 'player')?.round ?? defaults.longTailRound;
    if (signal === '连续重复技能') return firstStreakRound(battle.actions, 5) ?? defaults.longTailRound;
    return defaults.longTailRound;
  });
  return percentile(candidates, 0.5);
}

function firstStreakRound(actions, threshold) {
  const previous = new Map();
  const streak = new Map();
  for (const action of actions) {
    if (!action.skillId) continue;
    const next = previous.get(action.actorId) === action.skillId ? (streak.get(action.actorId) ?? 1) + 1 : 1;
    previous.set(action.actorId, action.skillId);
    streak.set(action.actorId, next);
    if (next >= threshold) return action.round;
  }
  return null;
}

function maxBattleStreak(actions) {
  const previous = new Map();
  const streak = new Map();
  let max = 0;
  actions.forEach((action) => {
    if (!action.skillId) return;
    const next = previous.get(action.actorId) === action.skillId ? (streak.get(action.actorId) ?? 1) + 1 : 1;
    previous.set(action.actorId, action.skillId);
    streak.set(action.actorId, next);
    max = Math.max(max, next);
  });
  return max;
}

function aggregateRoster(battles, groups, defaults) {
  const spirits = new Map();
  battles.forEach((battle) => battle.team.forEach((id) => {
    if (!spirits.has(id)) spirits.set(id, { id, selected: 0, short: 0, long: 0, wins: 0, rounds: 0 });
    const item = spirits.get(id);
    item.selected += 1;
    item.short += battle.longTail ? 0 : 1;
    item.long += battle.longTail ? 1 : 0;
    item.wins += battle.victory ? 1 : 0;
    item.rounds += battle.rounds;
  }));
  const combos = new Map();
  battles.forEach((battle) => {
    const key = [...battle.team].sort().join('/');
    if (!combos.has(key)) combos.set(key, []);
    combos.get(key).push(battle);
  });
  return {
    spirits: [...spirits.values()].map((item) => ({
      ...item,
      selectionRate: ratio(item.selected, battles.length),
      shortSelectionRate: ratio(item.short, battles.filter((battle) => !battle.longTail).length),
      longSelectionRate: ratio(item.long, battles.filter((battle) => battle.longTail).length),
      winRate: ratio(item.wins, item.selected),
      averageRounds: ratio(item.rounds, item.selected)
    })).sort((a, b) => b.selected - a.selected),
    combinations: [...combos.entries()].map(([team, items]) => ({ team, samples: items.length, winRate: ratio(items.filter((battle) => battle.victory).length, items.length), averageRounds: average(items.map((battle) => battle.rounds)), longTailRate: ratio(items.filter((battle) => battle.rounds >= defaults.longTailRound).length, items.length) })).sort((a, b) => b.samples - a.samples).slice(0, 20),
    fixedGroups: groups.filter((group) => group.roster === 'fixed')
  };
}

function compareAi(groups, defaults) {
  const pairs = new Map();
  groups.forEach((group) => {
    const key = group.pairKey ?? group.id.replace(/-(FULL|NEUTRAL)$/i, '');
    if (!pairs.has(key)) pairs.set(key, {});
    pairs.get(key)[group.policyRole ?? (group.id.includes('NEUTRAL') ? 'neutral' : 'full')] = group;
  });
  return [...pairs.entries()].filter(([, pair]) => pair.full && pair.neutral).map(([pairKey, pair]) => {
    const winDelta = pair.full.result.winRate - pair.neutral.result.winRate;
    const roundDelta = (pair.full.result.averageRounds ?? 0) - (pair.neutral.result.averageRounds ?? 0);
    const behaviorDelta = Math.max(...BEHAVIORS.map((key) => Math.abs((pair.full.behavior[key] ?? 0) - (pair.neutral.behavior[key] ?? 0))));
    const effect = Math.max(Math.abs(winDelta), Math.abs(pair.full.result.longTailRate - pair.neutral.result.longTailRate), behaviorDelta);
    return {
      pairKey,
      full: pair.full,
      neutral: pair.neutral,
      winDelta,
      roundDelta,
      effect,
      verdict: effect >= defaults.aiInfluenceThreshold * 2 ? 'Boss专属AI权重影响明显' : effect >= defaults.aiInfluenceThreshold ? '有一定影响但不是根因' : '移除专属权重后问题仍存在'
    };
  });
}

function buildAttribution({ random, mechanics, longTail, aiComparison, roster, defaults }) {
  const r = random.result;
  const lowOutput = longTail.signals.find((item) => item.signal === '输出衰减' || item.signal === 'Boss生命下降停滞');
  const defense = longTail.signals.find((item) => ['治疗上升', '护盾上升', '净生命损失接近0'].includes(item.signal));
  const resource = longTail.signals.find((item) => item.signal === '资源长期低位');
  const mechanicDecision = mechanics.some((item) => item.conclusion.decision === '形成明确决策变化');
  const aiEffect = Math.max(0, ...aiComparison.map((item) => item.effect));
  const rows = [
    row('Boss生命', r.longTailRate > defaults.longTailRateRisk && lowOutput ? '长尾伴随输出衰减' : '未见直接证据', '未进行Boss生命A/B', r.longTailRate > defaults.longTailRateRisk && lowOutput ? '候选原因' : '证据不足', '低'),
    row('Boss伤害', r.winRate < defaults.healthyWinRateMin ? '随机胜率偏低' : '胜率未低于健康下界', '未进行伤害A/B', r.winRate < defaults.healthyWinRateMin ? '候选原因' : '非首要', '低'),
    row('Boss技能频率', mechanics.map((item) => `${item.config.displayName}${item.triggerCount}次`).join('、'), '未进行频率A/B', '仅记录', '低'),
    row('Boss机制结构', mechanicDecision ? '至少一个机制改变行为' : '机制行为变化有限', '观察数据不构成因果', mechanicDecision ? '存在有效机制' : '需要复核', '中'),
    row('目标选择', mechanics.some((item) => item.config.targetScope === 'locked_target') ? '存在锁定目标机制' : '无锁定目标配置', '未做人为目标选择对照', '证据不足', '低'),
    row('玩家资源不足', resource ? `${resource.battles}场长尾出现资源低位` : '未检出显著资源低位', '资源低位可能是结果而非原因', resource ? '候选原因' : '非首要', '中'),
    row('玩家阵容缺少输出', lowOutput ? `${lowOutput.battles}场关联输出衰减` : '未检出显著输出衰减', '精灵职能标签未进入事件层', lowOutput ? '候选原因' : '证据不足', '中'),
    row('防守循环', defense ? `${defense.battles}场关联回复或护盾` : '未检出明显防守循环', '仅为关联', defense ? '候选原因' : '非首要', '中'),
    row('AI专属权重', aiComparison.map((item) => `${item.pairKey}:${item.verdict}`).join('；') || '无AI配对', '不等同真人行为', aiEffect >= defaults.aiInfluenceThreshold ? '需要关注' : '影响有限', aiComparison.length ? '中' : '低'),
    row('某精灵或组合', roster.combinations[0] ? `最高频组合${roster.combinations[0].samples}场` : '无', '高频不代表因果', '仅记录关联', '低'),
    row('UI提示', '自动战斗无法验证理解', '无真人样本', '无法确认', '低')
  ];
  return rows;
}

function row(cause, evidence, counterEvidence, conclusion, confidence) {
  return { cause, evidence, counterEvidence, conclusion, confidence };
}

function buildConclusions({ random, mechanics, longTail, aiComparison, defaults, audit }) {
  const result = random.result;
  const strength = result.winRate < defaults.healthyWinRateMin ? '偏难' : result.winRate > defaults.healthyWinRateMax ? '偏易' : '处于候选健康区间';
  const pace = result.medianRounds >= defaults.healthyMedianRoundMin && result.medianRounds <= defaults.healthyMedianRoundMax && result.longTailRate <= defaults.longTailRateRisk ? '整体健康' : '存在节奏风险';
  const ai = aiComparison.some((item) => item.effect >= defaults.aiInfluenceThreshold * 2) ? '影响明显' : aiComparison.some((item) => item.effect >= defaults.aiInfluenceThreshold) ? '有一定影响' : '影响有限或无配对';
  return {
    strength: { fact: `胜率${result.winRate}，样本${result.samples}`, judgment: strength, confidence: audit.passed ? '中' : '低' },
    pace: { fact: `中位${result.medianRounds}回合，长尾率${result.longTailRate}`, judgment: pace, confidence: audit.passed ? '中' : '低' },
    mechanics: mechanics.map((item) => ({ mechanicId: item.config.mechanicId, displayName: item.config.displayName, triggerRate: item.triggerCount, responseChange: Math.max(0, ...Object.values(item.responseLifts).map((entry) => entry.lift)), handlingEffect: compareHandling(item.handling), decision: item.conclusion.decision, issue: item.conclusion.decision === '未形成明确决策变化' ? '机制可能缺少决策性' : '未见明确结构问题', confidence: item.conclusion.confidence })),
    longTail: { exists: longTail.rate > defaults.longTailRateRisk, rate: longTail.rate, primaryType: Object.entries(longTail.types).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '无', confidence: longTail.samples >= defaults.minimumCohortSamples ? '中' : '低' },
    ai: { judgment: ai, confidence: aiComparison.length ? '中' : '低' },
    recommendation: {
      modifyNumbers: strength === '处于候选健康区间' ? '暂不优先修改' : '进入候选验证',
      modifyMechanics: mechanics.some((item) => item.conclusion.decision === '未形成明确决策变化') ? '优先复核缺少决策变化的机制' : '暂不修改',
      adjustAi: ai === '影响明显' ? '需要拆分专属权重继续验证' : '暂不优先',
      extraSamples: audit.passed ? '需要因果结论时追加强制处理/忽略配对' : '先修复数据审计'
    }
  };
}

function compareHandling(handling) {
  const handled = handling.handled;
  const ignored = handling.ignored;
  if (!handled.samples || !ignored.samples) return '处理或忽略样本不足';
  const keys = Object.keys(handled).filter((key) => key !== 'samples');
  return keys.map((key) => `${key}:${round((handled[key] ?? 0) - (ignored[key] ?? 0))}`).join('，');
}

function auditAnalysis(groups, bossConfig) {
  const battles = groups.flatMap((group) => group.battles);
  const schemaIssues = sum(battles, (battle) => battle.schemaIssues.length);
  const runtimeErrors = sum(battles, (battle) => battle.errors.length);
  const missingBattleBoundary = battles.filter((battle) => !battle.events.some((event) => event.eventType === 'battle_start') || !battle.events.some((event) => event.eventType === 'battle_end')).length;
  const unclosedMechanism = sum(battles, (battle) => sum(Object.values(battle.mechanicWindows), (windows) => windows.filter((window) => !window.endEvent).length));
  let duplicateSeeds = 0;
  groups.forEach((group) => { duplicateSeeds += group.battles.length - new Set(group.battles.map((battle) => battle.seed)).size; });
  const unseenMechanics = bossConfig.mechanics.filter((mechanic) => !battles.some((battle) => battle.mechanicWindows[mechanic.mechanicId].length > 0)).map((mechanic) => mechanic.mechanicId);
  return {
    samples: battles.length,
    schemaIssues,
    runtimeErrors,
    missingBattleBoundary,
    unclosedMechanism,
    duplicateSeeds,
    unseenMechanics,
    passed: schemaIssues + runtimeErrors + missingBattleBoundary + unclosedMechanism + duplicateSeeds === 0
  };
}

function representativeSeeds(battles, mechanics, defaults) {
  const specs = [
    ['典型短局胜利', battles.filter((battle) => battle.victory && battle.rounds <= 10), (battle) => -Math.abs(battle.rounds - 8)],
    ['典型短局失败', battles.filter((battle) => !battle.victory && battle.rounds <= 10), (battle) => battle.rounds],
    ['典型长尾胜利', battles.filter((battle) => battle.victory && battle.longTail), (battle) => battle.rounds],
    ['典型长尾失败', battles.filter((battle) => !battle.victory && battle.longTail), (battle) => battle.rounds],
    ['资源枯竭', battles.filter((battle) => battle.longTailSignals.includes('资源长期低位')), (battle) => battle.rounds],
    ['防守循环', battles.filter((battle) => battle.longTailSignals.some((signal) => ['治疗上升', '护盾上升', '净生命损失接近0'].includes(signal))), (battle) => battle.rounds],
    ['核心输出死亡', battles.filter((battle) => battle.longTailSignals.includes('核心输出死亡候选')), (battle) => battle.rounds]
  ];
  mechanics.forEach((mechanic) => {
    const handledSeeds = new Set(mechanic.handled.map((window) => window.seed));
    const ignoredSeeds = new Set(mechanic.ignored.map((window) => window.seed));
    specs.push([`${mechanic.config.displayName}正确处理`, battles.filter((battle) => handledSeeds.has(battle.seed)), (battle) => battle.victory ? 2 : 1]);
    specs.push([`${mechanic.config.displayName}完全忽略`, battles.filter((battle) => ignoredSeeds.has(battle.seed)), (battle) => battle.rounds]);
  });
  return specs.flatMap(([type, items, score]) => topDistinct(items, score, 1).map((battle) => ({
    type,
    seed: battle.seed,
    team: battle.team,
    rounds: battle.rounds,
    result: battle.result,
    mechanic: type.includes('正确处理') || type.includes('完全忽略') ? type.replace(/正确处理|完全忽略/, '') : '-',
    reason: battle.longTail ? `${battle.longTailType}，信号：${battle.longTailSignals.join('、') || '无'}` : `回合${battle.rounds}，剩余生命${round(battle.finalHpRatio)}`
  })));
}

export function roundBands(battles) {
  const bands = [['1–10', 1, 10], ['11–15', 11, 15], ['16–20', 16, 20], ['21–30', 21, 30], ['31+', 31, Infinity]];
  return bands.map(([label, min, max]) => {
    const rows = battles.filter((battle) => battle.rounds >= min && battle.rounds <= max);
    return {
      label,
      samples: rows.length,
      share: ratio(rows.length, battles.length),
      winRate: ratio(rows.filter((battle) => battle.victory).length, rows.length),
      finalHpRatio: average(rows.map((battle) => battle.finalHpRatio)),
      casualties: average(rows.map((battle) => battle.casualties))
    };
  });
}
