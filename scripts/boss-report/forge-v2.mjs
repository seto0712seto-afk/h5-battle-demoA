import { average, countBy, number, percent, percentile, ratio, round, signedPoints, sum, topDistinct } from './common.mjs';

const CHARGE = 'FORGE_BOSS_MOUNTAIN_CHARGE';
const HIGH_HEAT = 'FORGE_BOSS_MOUNTAIN_CLEAVE';

export function buildForgeV2(mainGroups, aiGroups, thresholds) {
  const groups = mainGroups.map(analyzeGroup);
  const ai = aiGroups.map(analyzeGroup);
  const random = groups.find((group) => group.id === 'RANDOM');
  const defense = groups.find((group) => group.id === 'TEAM-DEFENSE');
  const allBattles = groups.flatMap((group) => group.battles);
  const audit = auditData(groups, ai);
  const randomMechanics = mechanismSummary(random.battles);
  const defenseMechanics = mechanismSummary(defense.battles);
  const aiComparison = compareAi(ai);
  const conclusions = makeConclusions(random, groups, randomMechanics, defense, defenseMechanics, aiComparison, thresholds, audit);
  return {
    groups,
    ai,
    random,
    defense,
    allBattles,
    audit,
    randomMechanics,
    defenseMechanics,
    aiComparison,
    conclusions,
    representatives: representativeSeeds(allBattles)
  };
}

function analyzeGroup(group) {
  const battles = group.traces.map((trace) => analyzeBattle(trace, group.id));
  const windows = battles.flatMap((battle) => battle.windows);
  const counterWindows = battles.flatMap((battle) => battle.counterWindows);
  return {
    ...group,
    battles,
    windows,
    counterWindows,
    result: battleMetrics(battles),
    mechanics: mechanismSummary(battles)
  };
}

function analyzeBattle(trace, groupId) {
  const actions = [];
  const windows = [];
  const counterWindows = [];
  let action = null;
  let open = null;
  let counterOpen = null;
  const finishAction = () => {
    if (!action) return;
    actions.push(action);
    if (action.window) action.window.actions.push(action);
    if (action.counterWindow && action.bossExposed) action.counterWindow.actions.push(action);
    action = null;
  };
  const latestHeatDeath = (slotIndex) => [...windows].reverse().find((window) =>
    window.lockedSlotIndex === slotIndex && window.heatKilled && !window.replacementTerminal);

  for (const event of trace.events ?? []) {
    if (event.type === 'action_start') {
      finishAction();
      if (event.side === 'enemy' && counterOpen) {
        finalizeCounterWindow(counterOpen, 'boss-next-action');
        counterOpen = null;
      }
      if (event.side === 'player') action = newAction(event, open, counterOpen);
      continue;
    }
    if (event.type === 'boss_skill' && event.telegraph && event.skillId === CHARGE) {
      finishAction();
      if (open) finalizeWindow(open, 'superseded');
      open = newWindow(trace, groupId, windows.length + 1, event);
      windows.push(open);
      continue;
    }
    if (event.type === 'skill_confirmed' && action) {
      action.skill = event.skill;
      action.skillId = event.skillId;
      action.actualCost = event.actualCost;
      action.manaBeforeSkill = event.manaBefore;
      action.bossExposed = event.bossExposed;
      action.targetId = event.targetId ?? null;
      continue;
    }
    if (event.type === 'damage' && event.sourceSide === 'player' && action) {
      action.damageToBoss += event.actual;
      continue;
    }
    if (event.type === 'healing' && action) {
      action.heals.push(event);
      continue;
    }
    if (event.type === 'shield' && action) {
      action.shields.push(event);
      continue;
    }
    if (event.type === 'switch' && !event.forced && action) {
      action.swap = event;
      continue;
    }
    if (event.type === 'row_switch' && action) {
      action.rowSwitch = event;
      continue;
    }
    if (event.type === 'damage' && event.sourceSide === 'enemy' && event.skillId === HIGH_HEAT && open) {
      open.heat = event;
      continue;
    }
    if (event.type === 'defeated' && event.side === 'player' && event.skillId === HIGH_HEAT && open) {
      open.heatKilled = true;
      open.heatKilledTargetId = event.unitId;
      continue;
    }
    if (event.type === 'defeated' && event.side === 'enemy' && open) {
      open.bossKilledBeforeHeat = true;
      if (action) action.bossKill = true;
      continue;
    }
    if (event.type === 'defeated' && event.side === 'enemy' && action) {
      action.bossKill = true;
      continue;
    }
    if (event.type === 'replacement') {
      const window = open?.lockedSlotIndex === event.slotIndex ? open : latestHeatDeath(event.slotIndex);
      if (window) {
        window.replacements.push(event);
        if (['completed', 'no_reserve', 'battle_ended'].includes(event.status)) window.replacementTerminal = event.status;
      }
      continue;
    }
    if (event.type === 'boss_skill' && !event.telegraph && event.skillId === HIGH_HEAT && open) {
      finishAction();
      open.followup = event;
      finalizeWindow(open, event.targetIds?.length ? 'cast' : event.unresolvedReason ?? 'other');
      counterOpen = newCounterWindow(trace, groupId, counterWindows.length + 1, event, open);
      counterWindows.push(counterOpen);
      open = null;
      continue;
    }
    if (event.type === 'battle_end') {
      finishAction();
      if (open) {
        open.bossKilledBeforeHeat = event.result === 'victory';
        finalizeWindow(open, event.result === 'victory' ? 'boss-defeated-before-cast' : 'battle-ended');
        open = null;
      }
      if (counterOpen) {
        finalizeCounterWindow(counterOpen, 'battle-ended');
        counterOpen = null;
      }
    }
  }
  finishAction();
  if (open) finalizeWindow(open, trace.result === 'victory' ? 'boss-defeated-before-cast' : 'battle-ended');
  if (counterOpen) finalizeCounterWindow(counterOpen, 'battle-ended');
  windows.forEach(finalizeWindowMetrics);
  counterWindows.forEach(finalizeCounterWindowMetrics);
  const validWindows = windows.filter((window) => window.valid);
  const handling = validWindows.length === 0 ? 'no-window'
    : validWindows.every((window) => window.activeHandled) ? 'all-active'
      : validWindows.every((window) => !window.activeHandled) ? 'all-ignored' : 'partial';
  return {
    seed: trace.seed,
    groupId,
    team: [...trace.team],
    victory: trace.result === 'victory',
    rounds: trace.rounds,
    finalHpRatio: trace.finalHpRatio ?? 0,
    survivingSpirits: trace.survivingSpirits ?? 0,
    casualties: Math.max(0, trace.team.length - (trace.survivingSpirits ?? 0)),
    replacements: trace.forcedReplacements ?? 0,
    swaps: trace.tacticalSwaps ?? 0,
    errors: trace.errors ?? [],
    actions,
    windows,
    counterWindows,
    handling,
    perRound: trace.perRound ?? [],
    skillUses: trace.skillUses ?? {},
    maxSkillStreak: trace.maxSkillStreak ?? 0,
    rawEvents: trace.events ?? []
  };
}

function newAction(event, window, counterWindow) {
  return {
    round: event.round,
    actorId: event.unitId,
    manaAtStart: event.mana,
    playerSlots: event.playerSlots ?? [],
    reserveIds: event.reserveIds ?? [],
    window,
    counterWindow,
    skill: null,
    skillId: null,
    actualCost: 0,
    manaBeforeSkill: null,
    bossExposed: false,
    targetId: null,
    damageToBoss: 0,
    heals: [],
    shields: [],
    swap: null,
    rowSwitch: null,
    bossKill: false
  };
}

function newCounterWindow(trace, groupId, index, event, lockWindow) {
  return {
    seed: trace.seed,
    groupId,
    team: [...trace.team],
    battleResult: trace.result,
    battleRounds: trace.rounds,
    battleFinalHpRatio: trace.finalHpRatio ?? 0,
    index,
    startRound: event.round,
    sourceLockWindowIndex: lockWindow?.index ?? null,
    actions: [],
    resolution: null
  };
}

function finalizeCounterWindow(window, resolution) {
  window.resolution = resolution;
}

function finalizeCounterWindowMetrics(window) {
  window.valid = window.actions.length > 0;
  window.attackActions = window.actions.filter(isAttack).length;
  window.highCostAttacks = window.actions.filter((action) => isAttack(action) && action.actualCost >= 3).length;
  window.zeroCostActions = window.actions.filter((action) => action.skillId && action.actualCost === 0).length;
  window.cost = sum(window.actions, (action) => action.actualCost);
  window.damage = sum(window.actions, (action) => action.damageToBoss);
  window.bossKill = window.actions.some((action) => action.bossKill);
  window.category = classifyCounterWindow(window);
  window.utilizationScore = utilizationScore(window);
}

function classifyCounterWindow(window) {
  if (!window.valid) return '无行动机会';
  if (window.bossKill) return '窗口击杀';
  if (window.highCostAttacks > 0) return '主动爆发';
  if (window.attackActions > 1) return '多次常规攻击';
  if (window.attackActions === 1) return '单次常规攻击';
  const maxMana = Math.max(0, ...window.actions.map((action) => action.manaBeforeSkill ?? action.manaAtStart));
  if (maxMana < 3) return '资源不足';
  return '未利用破绽';
}

function newWindow(trace, groupId, index, event) {
  const lockedSlot = (event.playerSlots ?? []).find((slot) => slot.slotIndex === event.lockedSlotIndex);
  return {
    seed: trace.seed,
    groupId,
    team: [...trace.team],
    battleResult: trace.result,
    battleRounds: trace.rounds,
    battleFinalHpRatio: trace.finalHpRatio ?? 0,
    index,
    startRound: event.round,
    lockedSlotIndex: event.lockedSlotIndex,
    lockedTargetId: event.targetIds?.[0] ?? null,
    lockedSnapshot: lockedSlot ?? null,
    reserveAtLock: [...(event.reserveIds ?? [])],
    actions: [],
    heat: null,
    heatKilled: false,
    heatKilledTargetId: null,
    bossKilledBeforeHeat: false,
    replacements: [],
    replacementTerminal: null,
    followup: null,
    resolution: null
  };
}

function finalizeWindow(window, resolution) {
  window.resolution = resolution;
}

function finalizeWindowMetrics(window) {
  window.valid = window.actions.length > 0;
  window.attackActions = window.actions.filter(isAttack).length;
  window.highCostAttacks = window.actions.filter((action) => isAttack(action) && action.actualCost >= 3).length;
  window.zeroCostActions = window.actions.filter((action) => action.skillId && action.actualCost === 0).length;
  window.cost = sum(window.actions, (action) => action.actualCost);
  window.damage = sum(window.actions, (action) => action.damageToBoss);
  window.healingToLocked = sum(window.actions.flatMap((action) => action.heals), (event) => event.targetSlotIndex === window.lockedSlotIndex ? event.effective : 0);
  window.healAttempt = window.actions.some((action) => action.heals.some((event) => event.targetSlotIndex === window.lockedSlotIndex));
  window.shieldToLocked = sum(window.actions.flatMap((action) => action.shields), (event) => event.targetSlotIndex === window.lockedSlotIndex ? event.granted : 0);
  window.shieldAttempt = window.actions.some((action) => action.shields.some((event) => event.targetSlotIndex === window.lockedSlotIndex));
  window.swap = window.actions.some((action) => action.swap?.slotIndex === window.lockedSlotIndex);
  window.rowSwitch = window.actions.some((action) => action.rowSwitch?.slotIndex === window.lockedSlotIndex);
  window.bossKill = window.bossKilledBeforeHeat;
  window.surfaceResponse = window.healAttempt || window.shieldAttempt || window.swap || window.highCostAttacks > 0 || window.attackActions > 0;
  window.activeHandled = window.healAttempt || window.shieldAttempt || window.swap || window.bossKill;
  window.heatHpDamage = window.heat?.actual ?? 0;
  window.heatAbsorbed = window.heat?.absorbed ?? 0;
  window.heatOverkill = window.heat?.overkillDamage ?? 0;
  window.heatSettlement = window.heat?.actualSettlementDamage ?? window.heat?.attempted ?? 0;
  window.heatRemainingHpRatio = window.heat?.targetMaxHp ? window.heat.targetHpAfter / window.heat.targetMaxHp : null;
  window.replacementScheduled = window.replacements.some((event) => event.status === 'scheduled');
  window.replacementRequested = window.replacements.some((event) => event.status === 'requested');
  window.replacementCompleted = window.replacements.some((event) => event.status === 'completed');
  window.noReserve = window.replacements.some((event) => event.status === 'no_reserve');
  window.battleEndedBeforeReplacement = window.replacements.some((event) => event.status === 'battle_ended');
  window.replacementOccurredLater = window.replacements.some((event) => event.status === 'completed' && event.round > window.startRound);
  window.outcome = window.bossKilledBeforeHeat ? 'boss-defeated-before-cast'
    : window.resolution === 'battle-ended' ? 'battle-ended'
      : !window.heat ? window.resolution === 'target-row-empty' ? 'target-row-empty' : 'other'
        : window.swap && window.heat.targetId !== window.lockedTargetId ? 'replacement-hit'
          : 'original-target-hit';
  window.category = classifyWindow(window);
  window.protectionCategory = classifyProtection(window);
  window.utilizationScore = utilizationScore(window);
}

function classifyWindow(window) {
  if (!window.valid) return '无行动机会';
  if (window.bossKill) return '窗口击杀';
  if (window.highCostAttacks > 0) return '主动爆发';
  const protectionActions = window.actions.filter((action) => action.heals.length || action.shields.length || action.swap).length;
  if (protectionActions > window.attackActions) return '防守优先';
  if (window.attackActions > 0) return '常规攻击';
  const maxMana = Math.max(0, ...window.actions.map((action) => action.manaBeforeSkill ?? action.manaAtStart));
  if (maxMana < 3) return '资源不足';
  return '未利用破绽';
}

function classifyProtection(window) {
  if (window.bossKill) return '抢杀成功';
  const protectedTarget = window.healAttempt || window.shieldAttempt || window.swap;
  if (!protectedTarget && window.attackActions > 0) return '抢杀失败';
  if (!protectedTarget) return '完全忽略';
  if (window.heatKilled) return '无效保护';
  if (!window.heat) return '有效保护';
  const maxHp = window.heat.targetMaxHp || 1;
  const prevented = window.healingToLocked + Math.min(window.shieldToLocked, window.heatAbsorbed);
  const counterfactualAfter = (window.heat.targetHpAfter ?? 0) - prevented;
  if (counterfactualAfter <= 0) return '有效保护';
  if (counterfactualAfter / maxHp >= 0.15) return '过度保护';
  return '有效保护';
}

function utilizationScore(window) {
  const passivePenalty = window.attackActions === 1 && window.highCostAttacks === 0 && !window.bossKill ? 1.5 : 0;
  return round(window.highCostAttacks * 2 + Math.max(0, window.attackActions - 1) * 1.5 + window.cost / 3 + window.damage / 500 + (window.bossKill ? 3 : 0) - passivePenalty);
}

function isAttack(action) {
  return action.skill?.kind === 'attack';
}

function battleMetrics(battles) {
  const rounds = battles.map((battle) => battle.rounds);
  return {
    samples: battles.length,
    wins: battles.filter((battle) => battle.victory).length,
    winRate: ratio(battles.filter((battle) => battle.victory).length, battles.length),
    averageRounds: average(rounds),
    medianRounds: percentile(rounds, 0.5),
    p75Rounds: percentile(rounds, 0.75),
    p90Rounds: percentile(rounds, 0.9),
    p95Rounds: percentile(rounds, 0.95),
    over15Rate: ratio(battles.filter((battle) => battle.rounds > 15).length, battles.length),
    over20Rate: ratio(battles.filter((battle) => battle.rounds > 20).length, battles.length),
    finalHpRatio: average(battles.map((battle) => battle.finalHpRatio)),
    casualties: average(battles.map((battle) => battle.casualties)),
    replacements: average(battles.map((battle) => battle.replacements)),
    swaps: average(battles.map((battle) => battle.swaps))
  };
}

function mechanismSummary(battles) {
  const windows = battles.flatMap((battle) => battle.windows);
  const valid = windows.filter((window) => window.valid);
  const counterWindows = battles.flatMap((battle) => battle.counterWindows);
  const validCounterWindows = counterWindows.filter((window) => window.valid);
  const allActions = battles.flatMap((battle) => battle.actions);
  const ordinary = allActions.filter((action) => !action.window && !action.bossExposed);
  const lockActions = allActions.filter((action) => action.window);
  const normalPhase = allActions.filter((action) => !action.bossExposed);
  const exposed = allActions.filter((action) => action.bossExposed);
  const baseline = actionRates(ordinary, null);
  const locked = actionRates(lockActions, valid);
  const lifts = Object.fromEntries(Object.keys(baseline).map((key) => [key, round((locked[key] ?? 0) - (baseline[key] ?? 0))]));
  const active = valid.filter((window) => window.activeHandled);
  const ignored = valid.filter((window) => !window.activeHandled);
  const heatEvents = windows.map((window) => window.heat).filter(Boolean);
  return {
    windows,
    valid,
    counterWindows,
    validCounterWindows,
    ordinary,
    lockActions,
    exposed,
    baseline,
    locked,
    lifts,
    phaseNormal: phaseRates(normalPhase),
    phaseExposed: phaseRates(exposed),
    surfaceResponseRate: ratio(valid.filter((window) => window.surfaceResponse).length, valid.length),
    estimatedNetResponseRate: Math.max(0, round(locked.any - baseline.any)),
    estimatedNetResponseCount: Math.max(0, Math.round(valid.length * (locked.any - baseline.any))),
    active,
    ignored,
    activeWindowOutcome: windowOutcome(active),
    ignoredWindowOutcome: windowOutcome(ignored),
    battleHandling: Object.fromEntries(['all-active', 'partial', 'all-ignored'].map((key) => [key, battleMetrics(battles.filter((battle) => battle.handling === key))])),
    categories: groupedCounterWindowMetrics(validCounterWindows, (window) => window.category),
    protectionCategories: groupedWindowMetrics(valid, (window) => window.protectionCategory),
    protectionInputs: groupedWindowMetrics(valid, protectionInput),
    damagePercentiles: windowDamagePercentiles(validCounterWindows),
    heatOutcomes: countBy(windows, (window) => window.outcome),
    heatDamage: {
      formulaBase: average(heatEvents.map((event) => event.formulaBaseDamage ?? 0)),
      multiplier: average(heatEvents.map((event) => event.damageMultiplier ?? 1)),
      theoretical: average(heatEvents.map((event) => event.theoreticalDamage ?? event.attempted)),
      settlement: average(heatEvents.map((event) => event.actualSettlementDamage ?? event.attempted)),
      absorbed: average(heatEvents.map((event) => event.absorbed)),
      hpDamage: average(heatEvents.map((event) => event.actual)),
      overkill: average(heatEvents.map((event) => event.overkillDamage ?? 0)),
      mitigated: average(heatEvents.map((event) => event.mitigatedDamage ?? 0)),
      ineffective: average(heatEvents.map((event) => event.ineffectiveDamage ?? 0))
    },
    heatLifecycle: {
      highHeatKilledTarget: windows.filter((window) => window.heatKilled).length,
      replacementScheduledByHighHeat: windows.filter((window) => window.heatKilled && window.replacementScheduled).length,
      replacementCompletedByHighHeat: windows.filter((window) => window.heatKilled && window.replacementCompleted).length,
      battleEndedBeforeReplacement: windows.filter((window) => window.heatKilled && window.battleEndedBeforeReplacement).length,
      noReserveAvailable: windows.filter((window) => window.heatKilled && window.noReserve).length,
      replacementOccurredLater: windows.filter((window) => window.heatKilled && window.replacementOccurredLater).length
    }
  };
}

function actionRates(actions, windows) {
  const count = actions.length;
  let lineOpportunities = 0;
  let healLines = 0;
  let shieldLines = 0;
  actions.forEach((action) => {
    if (windows) return;
    const occupied = action.playerSlots.filter((slot) => slot.unitId);
    lineOpportunities += occupied.length;
    healLines += new Set(action.heals.map((event) => event.targetSlotIndex).filter((value) => value !== undefined)).size;
    shieldLines += new Set(action.shields.map((event) => event.targetSlotIndex).filter((value) => value !== undefined)).size;
  });
  if (windows) {
    healLines = sum(windows, (window) => window.actions.filter((action) => action.heals.some((event) => event.targetSlotIndex === window.lockedSlotIndex)).length);
    shieldLines = sum(windows, (window) => window.actions.filter((action) => action.shields.some((event) => event.targetSlotIndex === window.lockedSlotIndex)).length);
    lineOpportunities = count;
  }
  const swap = actions.filter((action) => action.swap && (!windows || action.window?.lockedSlotIndex === action.swap.slotIndex)).length;
  const highCost = actions.filter((action) => isAttack(action) && action.actualCost >= 3).length;
  const attack = actions.filter(isAttack).length;
  const any = actions.filter((action) => isAttack(action) || action.swap || action.heals.length || action.shields.length).length;
  return {
    heal: ratio(healLines, lineOpportunities),
    shield: ratio(shieldLines, lineOpportunities),
    swap: ratio(swap, count),
    highCost: ratio(highCost, count),
    attack: ratio(attack, count),
    any: ratio(any, count)
  };
}

function phaseRates(actions) {
  const count = actions.length;
  const attack = actions.filter(isAttack);
  const behaviorCount = (behavior) => actions.filter((action) => action.skill?.primaryBehavior === behavior).length;
  return {
    actions: count,
    attack: ratio(behaviorCount('attack'), count),
    highCostAll: ratio(attack.filter((action) => action.actualCost >= 3).length, count),
    highCostAttack: ratio(attack.filter((action) => action.actualCost >= 3).length, attack.length),
    averageCost: average(actions.map((action) => action.actualCost)),
    zeroCost: ratio(actions.filter((action) => action.skillId && action.actualCost === 0).length, count),
    protect: ratio(behaviorCount('protect'), count),
    recover: ratio(behaviorCount('recover'), count),
    energy: ratio(behaviorCount('energy'), count),
    damagePerAction: ratio(sum(actions, (action) => action.damageToBoss), count)
  };
}

function windowOutcome(windows) {
  const casts = windows.filter((window) => window.heat);
  return {
    samples: windows.length,
    hpDamage: average(casts.map((window) => window.heatHpDamage)),
    absorbed: average(casts.map((window) => window.heatAbsorbed)),
    killRate: ratio(casts.filter((window) => window.heatKilled).length, casts.length),
    replacementRate: ratio(casts.filter((window) => window.replacementCompleted).length, casts.length)
  };
}

function groupedWindowMetrics(windows, select) {
  const groups = new Map();
  windows.forEach((window) => {
    const key = select(window);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(window);
  });
  return Object.fromEntries([...groups].map(([key, items]) => [key, {
    samples: items.length,
    share: ratio(items.length, windows.length),
    damage: average(items.map((window) => window.damage)),
    heatHpDamage: average(items.filter((window) => window.heat).map((window) => window.heatHpDamage)),
    heatAbsorbed: average(items.filter((window) => window.heat).map((window) => window.heatAbsorbed)),
    heatKillRate: ratio(items.filter((window) => window.heatKilled).length, items.filter((window) => window.heat).length),
    replacementRate: ratio(items.filter((window) => window.replacementCompleted).length, items.filter((window) => window.heat).length),
    associatedBattleWinRate: ratio(items.filter((window) => window.battleResult === 'victory').length, items.length),
    associatedRounds: average(items.map((window) => window.battleRounds))
  }]));
}

function protectionInput(window) {
  if (window.bossKill) return '抢杀';
  if (window.swap) return '换宠';
  if (window.healAttempt && window.shieldAttempt) return '治疗+护盾';
  if (window.healAttempt) return '仅治疗';
  if (window.shieldAttempt) return '仅护盾';
  return '无治疗无护盾';
}

function windowDamagePercentiles(windows) {
  const values = windows.map((window) => window.damage);
  return Object.fromEntries([0.1, 0.25, 0.5, 0.75, 0.9, 0.95].map((point) => [`p${point * 100}`, percentile(values, point)]));
}

function auditData(groups, aiGroups) {
  const cohorts = [...groups, ...aiGroups];
  const battles = cohorts.flatMap((group) => group.battles);
  let illegalState = 0;
  let unclosedDamage = 0;
  let unattributedKill = 0;
  let unattributedReplacement = 0;
  let missingMechanism = 0;
  let duplicateSeeds = 0;
  let exposureTimingMismatch = 0;
  cohorts.forEach((group) => {
    duplicateSeeds += group.battles.length - new Set(group.battles.map((battle) => battle.seed)).size;
  });
  battles.forEach((battle) => {
    let expectedExposed = false;
    battle.rawEvents.forEach((event) => {
      if (event.type === 'action_start' && event.side === 'enemy') expectedExposed = false;
      if (event.type === 'boss_skill' && !event.telegraph && event.skillId === HIGH_HEAT) expectedExposed = true;
      if (event.type === 'skill_confirmed' && Boolean(event.bossExposed) !== expectedExposed) exposureTimingMismatch += 1;
      if (event.type === 'energy' && (event.after < 0 || event.after > 10)) illegalState += 1;
      if (event.targetHpAfter !== undefined && (event.targetHpAfter < 0 || event.targetHpAfter > event.targetMaxHp)) illegalState += 1;
      if (event.type === 'damage' && event.skillId === HIGH_HEAT && event.actualSettlementDamage !== undefined) {
        const closed = event.absorbed + event.actual + (event.overkillDamage ?? 0);
        if (closed !== event.actualSettlementDamage) unclosedDamage += 1;
      }
    });
    battle.windows.forEach((window) => {
      if (!window.resolution) missingMechanism += 1;
      if (window.heatKilled && !window.replacementCompleted && !window.noReserve && !window.battleEndedBeforeReplacement) unattributedKill += 1;
      if (window.replacementCompleted && !window.replacementScheduled) unattributedReplacement += 1;
    });
    battle.counterWindows.forEach((window) => {
      if (!window.resolution) missingMechanism += 1;
    });
  });
  const runtimeErrors = sum(battles, (battle) => battle.errors.length);
  const passed = runtimeErrors + illegalState + unclosedDamage + unattributedKill + unattributedReplacement + missingMechanism + duplicateSeeds + exposureTimingMismatch === 0;
  return {
    totalSamples: battles.length,
    mainSamples: groups.reduce((total, group) => total + group.battles.length, 0),
    randomSamples: groups.find((group) => group.id === 'RANDOM')?.battles.length ?? 0,
    fixedSamples: groups.filter((group) => group.id !== 'RANDOM').reduce((total, group) => total + group.battles.length, 0),
    aiSamples: aiGroups.reduce((total, group) => total + group.battles.length, 0),
    runtimeErrors,
    illegalState,
    unclosedDamage,
    unattributedKill,
    unattributedReplacement,
    duplicateSeeds,
    missingMechanism,
    exposureTimingMismatch,
    passed
  };
}

function compareAi(groups) {
  const find = (id) => groups.find((group) => group.id === id);
  const pairs = [
    ['随机阵容', find('AI-RANDOM-FULL'), find('AI-RANDOM-NEUTRAL')],
    ['高防护队', find('AI-DEFENSE-FULL'), find('AI-DEFENSE-NEUTRAL')]
  ];
  return pairs.map(([label, full, neutral]) => ({
    label,
    full,
    neutral,
    winRateDelta: full.result.winRate - neutral.result.winRate,
    responseDelta: full.mechanics.surfaceResponseRate - neutral.mechanics.surfaceResponseRate,
    netResponseDelta: full.mechanics.estimatedNetResponseRate - neutral.mechanics.estimatedNetResponseRate,
    attackDelta: full.mechanics.phaseExposed.attack - neutral.mechanics.phaseExposed.attack,
    highCostDelta: full.mechanics.phaseExposed.highCostAll - neutral.mechanics.phaseExposed.highCostAll
  }));
}

function groupedCounterWindowMetrics(windows, select) {
  const groups = new Map();
  windows.forEach((window) => {
    const key = select(window);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(window);
  });
  return Object.fromEntries([...groups].map(([key, items]) => [key, {
    samples: items.length,
    share: ratio(items.length, windows.length),
    damage: average(items.map((window) => window.damage)),
    associatedBattleWinRate: ratio(items.filter((window) => window.battleResult === 'victory').length, items.length),
    associatedRounds: average(items.map((window) => window.battleRounds))
  }]));
}

function makeConclusions(random, groups, mechanics, defense, defenseMechanics, aiComparison, thresholds, audit) {
  const strength = random.result.winRate < thresholds.healthyWinRateMin ? '偏难'
    : random.result.winRate > thresholds.healthyWinRateMax ? '偏易' : '处于候选健康区间';
  const pace = random.result.medianRounds >= thresholds.healthyMedianRoundMin &&
    random.result.medianRounds <= thresholds.healthyMedianRoundMax && random.result.over20Rate <= thresholds.longBattlePassRate
    ? '整体健康' : '存在节奏风险';
  const attackLift = mechanics.phaseExposed.attack - mechanics.phaseNormal.attack;
  const highCostLift = mechanics.phaseExposed.highCostAll - mechanics.phaseNormal.highCostAll;
  const decision = attackLift >= thresholds.decisionShiftPercentagePoints || highCostLift >= thresholds.decisionShiftPercentagePoints ||
    mechanics.phaseExposed.averageCost - mechanics.phaseNormal.averageCost >= thresholds.manaSpendShift
    ? '成立' : attackLift >= 0.05 || highCostLift >= 0.05 ? '风险' : '不成立';
  const lockLift = Math.max(mechanics.lifts.heal, mechanics.lifts.shield, mechanics.lifts.swap);
  const lock = lockLift >= thresholds.netResponsePassRate ? '产生明确净新增保护行为'
    : lockLift >= thresholds.netResponseRiskRate ? '存在弱净提升' : '未形成明确净提升';
  const defenseHealth = defenseCycleHealth(defense);
  const aiInfluence = aiComparison.some((pair) => Math.abs(pair.responseDelta) >= 0.05 || Math.abs(pair.attackDelta) >= 0.05)
    ? '明显' : '有限';
  return {
    strength,
    pace,
    decision,
    lock,
    defenseHealth,
    aiInfluence,
    audit: audit.passed ? '通过' : '失败',
    confidence: audit.passed ? '中：具备大样本与同Seed AI中性对照，但没有强制策略因果实验' : '低：数据质量审计失败'
  };
}

function defenseCycleHealth(group) {
  const battles = group.battles;
  const totalRounds = sum(battles, (battle) => battle.rounds);
  const healing = sum(battles.flatMap((battle) => battle.perRound), (roundData) => roundData.effectiveHealing);
  const shield = sum(battles.flatMap((battle) => battle.perRound), (roundData) => roundData.effectiveShield);
  const incoming = sum(battles.flatMap((battle) => battle.perRound), (roundData) => roundData.damageToPlayers);
  const fiveRoundWindows = [];
  battles.forEach((battle) => {
    for (let index = 0; index + 5 <= battle.perRound.length; index += 1) {
      fiveRoundWindows.push(sum(battle.perRound.slice(index, index + 5), (entry) => entry.damageToPlayers - entry.effectiveHealing));
    }
  });
  const metrics = {
    healingPerRound: ratio(healing, totalRounds),
    shieldPerRound: ratio(shield, totalRounds),
    bossHpDamagePerRound: ratio(incoming, totalRounds),
    recoveryMinusDamage: ratio(healing - incoming, totalRounds),
    noNetLossFiveRoundRate: ratio(fiveRoundWindows.filter((value) => value <= 0).length, fiveRoundWindows.length),
    maxSkillStreak: Math.max(0, ...battles.map((battle) => battle.maxSkillStreak)),
    over20Rate: group.result.over20Rate
  };
  const verdict = metrics.over20Rate > 0.30 && metrics.recoveryMinusDamage >= 0 ? '稳定无限维持'
    : metrics.over20Rate > 0.10 || group.result.averageRounds > 16 ? '轻度拖延'
      : '安全但正常';
  return { ...metrics, verdict };
}

function representativeSeeds(battles) {
  const lockWindows = battles.flatMap((battle) => battle.windows);
  const counterWindows = battles.flatMap((battle) => battle.counterWindows);
  const specs = [
    ['主动高费爆发', counterWindows.filter((window) => window.highCostAttacks > 0), (window) => window.utilizationScore],
    ['多次攻击集中', counterWindows.filter((window) => window.attackActions >= 2), (window) => window.attackActions * 10 + window.damage],
    ['窗口击杀', counterWindows.filter((window) => window.bossKill), (window) => window.utilizationScore],
    ['单次常规攻击', counterWindows.filter((window) => window.attackActions === 1 && window.highCostAttacks === 0 && !window.bossKill), (window) => window.damage],
    ['未利用破绽', counterWindows.filter((window) => ['资源不足', '未利用破绽', '无行动机会'].includes(window.category)), (window) => -window.damage],
    ['高温击杀', lockWindows.filter((window) => window.heatKilled), (window) => window.heatHpDamage],
    ['超长战斗', battles.filter((battle) => battle.rounds > 20), (battle) => battle.rounds]
  ];
  return specs.flatMap(([type, items, score]) => topDistinct(items, score, 2).map((item) => ({
    type,
    seed: item.seed,
    team: item.team,
    rounds: item.battleRounds ?? item.rounds,
    result: item.battleResult ?? (item.victory ? 'victory' : 'defeat'),
    reason: type === '高温击杀' ? `高温生命伤害${number(item.heatHpDamage)}` : item.utilizationScore !== undefined ? `利用评分${number(item.utilizationScore)}，窗口伤害${item.damage}` : `战斗持续${item.rounds}回合`
  })));
}

export function renderForgeV2(data, metadata) {
  const { groups, random, defense, audit, randomMechanics: mech, defenseMechanics: defenseMech, aiComparison, conclusions } = data;
  const phaseRows = [
    ['攻击占比', 'attack', true], ['高费攻击/全部行动', 'highCostAll', true], ['高费攻击/攻击行动', 'highCostAttack', true],
    ['平均妖力支付', 'averageCost', false], ['0费技能占比', 'zeroCost', true], ['防护占比', 'protect', true],
    ['治疗占比', 'recover', true], ['回能占比', 'energy', true]
  ];
  const auditWarning = audit.passed ? '' : '\n> **数据审计失败：本报告仅供排查，不允许用于正式平衡裁定。**\n';
  return `# 熔核守卫单 Boss 自动测试总结

- 日期：${metadata.date}
- 主策略：balanced-v3
- 主样本Seed：${metadata.seed}
- AI对照Seed：${metadata.aiSeed}
- 总测试样本：${audit.totalSamples}场（主报告${audit.mainSamples}场，AI同Seed对照${audit.aiSamples}场）
- 正式战斗规则改动：熔核破绽由“熔核蓄力后”调整为“高温爆发完整结算后”施加；其余规则与数值不变。
- 统计边界：锁定窗口统计蓄力至高温爆发前的玩家应对；破绽窗口统计高温爆发结算后至Boss下一次行动开始前的反击。窗口所属战斗胜率仅表示关联，不作为因果证据。
- 候选阈值：随机胜率70%–90%、中位回合9–14、21+回合不高于5%；净响应提升≥10个百分点为成立、5%–10%为风险、<5%为不成立。
${auditWarning}
## 一页结论

- 整体强度：随机阵容胜率${percent(random.result.winRate)}，${conclusions.strength}。
- 整体节奏：中位${number(random.result.medianRounds)}回合，21+占${percent(random.result.over20Rate)}，${conclusions.pace}。
- 破绽机制：决策性${conclusions.decision}；收益与决策变化分开评价。
- 锁定机制：${conclusions.lock}。
- 高温爆发：成功兑现${sum(mech.windows, (window) => window.heat ? 1 : 0)}次，击杀${mech.heatLifecycle.highHeatKilledTarget}次。
- 高防队表现：${conclusions.defenseHealth.verdict}，胜率${percent(defense.result.winRate)}，平均${number(defense.result.averageRounds)}回合。
- 当前主要风险：高防队拖延、破绽可能偏被动，以及自动策略专属权重造成的${conclusions.aiInfluence}影响。
- 是否建议修改正式数值：暂不建议；先依据机制和AI拆分结果决定修改对象。
- 建议下一步：真人验证提示理解；需要因果结论时再进行FORCE-HANDLE/FORCE-IGNORE配对实验。
- 结论置信度：${conclusions.confidence}。

## 数据质量审计

| 检查项 | 结果 |
|---|---:|
| 总样本数 | ${audit.totalSamples} |
| 主报告随机样本数 | ${audit.randomSamples} |
| 主报告固定阵容样本数 | ${audit.fixedSamples} |
| AI偏差对照样本数 | ${audit.aiSamples} |
| 运行异常 | ${audit.runtimeErrors} |
| 非法生命/妖力 | ${audit.illegalState} |
| 未闭合伤害事件 | ${audit.unclosedDamage} |
| 无法归因击杀 | ${audit.unattributedKill} |
| 无法归因替补 | ${audit.unattributedReplacement} |
| 同一测试组内重复Seed | ${audit.duplicateSeeds} |
| 缺失机制终点事件 | ${audit.missingMechanism} |
| 破绽触发时机不一致 | ${audit.exposureTimingMismatch} |
| 审计结论 | ${audit.passed ? '通过' : '失败'} |

跨组复用相同Seed属于同Seed对照设计，不计作重复；仅检查同一测试组内部重复。

## 整体强度与节奏（随机阵容${random.result.samples}场）

| 指标 | 结果 |
|---|---:|
| 胜率 | ${percent(random.result.winRate)} |
| 平均回合 | ${number(random.result.averageRounds)} |
| 中位回合 | ${number(random.result.medianRounds)} |
| P75 | ${number(random.result.p75Rounds)} |
| P90 | ${number(random.result.p90Rounds)} |
| P95 | ${number(random.result.p95Rounds)} |
| >15回合 | ${percent(random.result.over15Rate)} |
| >20回合 | ${percent(random.result.over20Rate)} |

| 回合区间 | 战斗数 | 占比 | 胜率 |
|---|---:|---:|---:|
${roundBands(random.battles)}

## 固定阵容完整对比

| 阵容 | 胜率 | 平均回合 | P90 | 剩余生命 | 减员 | 替补 | 换宠 | 破绽利用率 | 锁定净响应率 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${groups.filter((group) => group.id !== 'RANDOM').map(groupRow).join('\n')}

${groups.filter((group) => group.id !== 'RANDOM').map(groupNarrative).join('\n\n')}

## 机制流程漏斗（随机阵容）

| 环节 | 次数 | 转化率 |
|---|---:|---:|
${funnelRows(mech)}

“净新增响应数”为扣除普通阶段基准后的统计估算，不代表可以指认某个具体窗口由机制新增。

## 破绽机制完整分析

### 行为变化

| 指标 | 普通阶段 | 破绽窗口 | 绝对变化 | 相对变化 |
|---|---:|---:|---:|---:|
${phaseRows.map(([label, key, asPercent]) => phaseRow(label, key, asPercent, mech)).join('\n')}

### 破绽伤害分布

| 分位 | 数值 |
|---|---:|
${Object.entries(mech.damagePercentiles).map(([key, value]) => `| ${key.toUpperCase()} | ${number(value)} |`).join('\n')}

| 固定阵容 | P50 | P75 | P90 |
|---|---:|---:|---:|
${groups.filter((group) => group.id !== 'RANDOM').map((group) => `| ${group.label} | ${number(group.mechanics.damagePercentiles.p50)} | ${number(group.mechanics.damagePercentiles.p75)} | ${number(group.mechanics.damagePercentiles.p90)} |`).join('\n')}

### 破绽窗口分类

| 类型 | 次数 | 占比 | 窗口伤害 | 所属战斗胜率（关联） |
|---|---:|---:|---:|---:|
${metricRows(mech.categories, ['samples', 'share', 'damage', 'associatedBattleWinRate'])}

- 破绽收益强度：单次行动伤害由${number(mech.phaseNormal.damagePerAction)}提高至${number(mech.phaseExposed.damagePerAction)}。
- 破绽决策性：${conclusions.decision}。
- 破绽提示性：自动测试无法确认。
- 破绽与高温关系：高温爆发先完成伤害结算，再开启独立反击窗口，两者不再共享同一行动窗口。

## 锁定响应完整分析

### 响应净提升

| 行为 | 普通阶段概率 | 锁定后概率 | 净提升 |
|---|---:|---:|---:|
${responseLiftRows(mech)}

- 表面响应率：${percent(mech.surfaceResponseRate)}。
- 估算净新增响应率：${percent(mech.estimatedNetResponseRate)}。
- 自动结论优先采用净提升：${conclusions.lock}。
- 前后排切换不能规避同一目标行锁定，不计入有效响应。

### 响应质量分类

| 类型 | 次数 | 高温生命伤害 | 高温击杀率 | 所属战斗胜率（关联） | 所属战斗平均回合 |
|---|---:|---:|---:|---:|---:|
${metricRows(mech.protectionCategories, ['samples', 'heatHpDamage', 'heatKillRate', 'associatedBattleWinRate', 'associatedRounds'])}

## 高温爆发完整分析

### 结算分类

| 结果 | 次数 |
|---|---:|
${Object.entries(mech.heatOutcomes).map(([key, value]) => `| ${heatOutcomeName(key)} | ${value} |`).join('\n')}

### 伤害闭合与替补生命周期

| 指标 | 结果 |
|---|---:|
| 属性公式基础伤害 | ${number(mech.heatDamage.formulaBase)} |
| 平均伤害倍率 | ${number(mech.heatDamage.multiplier)} |
| 技能理论伤害（倍率后） | ${number(mech.heatDamage.theoretical)} |
| 实际结算伤害 | ${number(mech.heatDamage.settlement)} |
| 护盾吸收 | ${number(mech.heatDamage.absorbed)} |
| 生命扣除 | ${number(mech.heatDamage.hpDamage)} |
| 过量击杀伤害 | ${number(mech.heatDamage.overkill)} |
| 公式后额外减免 | ${number(mech.heatDamage.mitigated)} |
| 无效伤害 | ${number(mech.heatDamage.ineffective)} |
| 高温击杀目标 | ${mech.heatLifecycle.highHeatKilledTarget} |
| 因高温计划替补 | ${mech.heatLifecycle.replacementScheduledByHighHeat} |
| 因高温完成替补 | ${mech.heatLifecycle.replacementCompletedByHighHeat} |
| 替补前战斗结束 | ${mech.heatLifecycle.battleEndedBeforeReplacement} |
| 没有可用后备 | ${mech.heatLifecycle.noReserveAvailable} |
| 后续回合才完成替补 | ${mech.heatLifecycle.replacementOccurredLater} |
| 未闭合高温伤害 | ${audit.unclosedDamage} |

闭合公式：实际结算伤害 = 护盾吸收 + 生命扣除 + 过量击杀伤害。当前减免已进入公式基础伤害，额外无效伤害单独记为0。

### 防护方式效果

| 防护投入 | 样本 | 护盾吸收 | 生命伤害 | 击杀率 | 替补率 |
|---|---:|---:|---:|---:|---:|
${metricRows(mech.protectionInputs, ['samples', 'heatAbsorbed', 'heatHpDamage', 'heatKillRate', 'replacementRate'])}

## 忽略机制代价

### 窗口级

| 分组 | 样本 | 高温生命伤害 | 击杀率 | 护盾吸收 | 替补率 |
|---|---:|---:|---:|---:|---:|
| 主动处理 | ${mech.activeWindowOutcome.samples} | ${number(mech.activeWindowOutcome.hpDamage)} | ${percent(mech.activeWindowOutcome.killRate)} | ${number(mech.activeWindowOutcome.absorbed)} | ${percent(mech.activeWindowOutcome.replacementRate)} |
| 完全忽略 | ${mech.ignoredWindowOutcome.samples} | ${number(mech.ignoredWindowOutcome.hpDamage)} | ${percent(mech.ignoredWindowOutcome.killRate)} | ${number(mech.ignoredWindowOutcome.absorbed)} | ${percent(mech.ignoredWindowOutcome.replacementRate)} |

### 战斗级（每场去重）

| 分组 | 战斗数 | 胜率 | 剩余生命 | 减员 | 替补 | 回合 |
|---|---:|---:|---:|---:|---:|---:|
${battleHandlingRows(mech.battleHandling)}

全程忽略少于30场时只报告方向，不作因果裁定；本轮仍未执行强制处理/强制忽略实验。

## 高防队专项

### 破绽窗口行为变化

| 行为 | 普通阶段 | 破绽窗口 | 变化 |
|---|---:|---:|---:|
| 攻击 | ${percent(defenseMech.phaseNormal.attack)} | ${percent(defenseMech.phaseExposed.attack)} | ${signedPoints(defenseMech.phaseExposed.attack - defenseMech.phaseNormal.attack)} |
| 防护 | ${percent(defenseMech.phaseNormal.protect)} | ${percent(defenseMech.phaseExposed.protect)} | ${signedPoints(defenseMech.phaseExposed.protect - defenseMech.phaseNormal.protect)} |
| 治疗 | ${percent(defenseMech.phaseNormal.recover)} | ${percent(defenseMech.phaseExposed.recover)} | ${signedPoints(defenseMech.phaseExposed.recover - defenseMech.phaseNormal.recover)} |

### 高防队防护方式

| 防护投入 | 样本 | 护盾吸收 | 生命伤害 | 击杀率 | 替补率 |
|---|---:|---:|---:|---:|---:|
${metricRows(defenseMech.protectionInputs, ['samples', 'heatAbsorbed', 'heatHpDamage', 'heatKillRate', 'replacementRate'])}

全程忽略战斗：${defenseMech.battleHandling['all-ignored'].samples}场；少于30场时不裁定高防队可以无视机制。

| 高防队高温替补归因 | 次数 |
|---|---:|
| 高温击杀目标 | ${defenseMech.heatLifecycle.highHeatKilledTarget} |
| 计划替补 | ${defenseMech.heatLifecycle.replacementScheduledByHighHeat} |
| 完成替补 | ${defenseMech.heatLifecycle.replacementCompletedByHighHeat} |
| 替补前战斗结束 | ${defenseMech.heatLifecycle.battleEndedBeforeReplacement} |
| 没有可用后备 | ${defenseMech.heatLifecycle.noReserveAvailable} |

| 循环健康度指标 | 结果 |
|---|---:|
| 玩家每回合有效治疗 | ${number(conclusions.defenseHealth.healingPerRound)} |
| 玩家每回合有效护盾 | ${number(conclusions.defenseHealth.shieldPerRound)} |
| Boss每回合生命伤害 | ${number(conclusions.defenseHealth.bossHpDamagePerRound)} |
| 玩家净恢复-承伤 | ${number(conclusions.defenseHealth.recoveryMinusDamage)} |
| 连续5回合Boss未造成净生命损失占比 | ${percent(conclusions.defenseHealth.noNetLossFiveRoundRate)} |
| 同一技能连续使用最高次数 | ${conclusions.defenseHealth.maxSkillStreak} |
| >20回合占比 | ${percent(conclusions.defenseHealth.over20Rate)} |
| 自动判断 | ${conclusions.defenseHealth.verdict} |

高防队锁定净响应：治疗${signedPoints(defenseMech.lifts.heal)}、护盾${signedPoints(defenseMech.lifts.shield)}、换宠${signedPoints(defenseMech.lifts.swap)}。

20回合以上高防队最常用技能：${longDefenseSkills(defense.battles)}。

## AI策略偏差检查

| AI检查项 | 结果 |
|---|---|
| balanced-v3是否写入破绽加权 | 是：破绽时攻击按预期伤害和高费投入加分 |
| 是否写入锁定保护加权 | 是：锁定目标治疗、护盾、换宠和抢杀均有专属加权 |
| neutral版本移除内容 | 只移除熔核守卫破绽/锁定专属加权，保留低血治疗、通用伤害、资源和防拖延逻辑 |
| 是否存在规则硬编码导致虚假响应 | 存在专属策略加权，但不改变合法行动与战斗规则；需用下表量化影响 |

| 队伍 | 策略 | 胜率 | 表面响应 | 净响应 | 破绽攻击占比 | 破绽高费占比 |
|---|---|---:|---:|---:|---:|---:|
${aiRows(aiComparison)}

AI专属权重影响判断：${conclusions.aiInfluence}。这项对照能识别AI偏差，但仍不是强制策略因果实验。

## 代表Seed

| 类型 | Seed | 阵容 | 回合 | 结果 | 选择理由 |
|---|---:|---|---:|---|---|
${data.representatives.map((item) => `| ${item.type} | ${item.seed} | ${item.team.join('/')} | ${item.rounds} | ${item.result === 'victory' ? '胜利' : '失败'} | ${item.reason} |`).join('\n')}

## 最终12问

1. **整体胜率是否合适？** 随机阵容${percent(random.result.winRate)}，按70%–90%候选区间判定为“${conclusions.strength}”。该区间是测试阈值，不是正式设计目标。
2. **战斗长度是否健康？** ${conclusions.pace}；中位${number(random.result.medianRounds)}，21+占${percent(random.result.over20Rate)}。
3. **哪类阵容最强、最弱？** ${strongestWeakest(groups)}
4. **破绽是否增加攻击投入？** 攻击占比净变化${signedPoints(mech.phaseExposed.attack - mech.phaseNormal.attack)}，高费攻击净变化${signedPoints(mech.phaseExposed.highCostAll - mech.phaseNormal.highCostAll)}，判定${conclusions.decision}。
5. **破绽是否只是被动增伤？** 单次行动伤害由${number(mech.phaseNormal.damagePerAction)}变为${number(mech.phaseExposed.damagePerAction)}，攻击占比变化${signedPoints(mech.phaseExposed.attack - mech.phaseNormal.attack)}，高费攻击变化${signedPoints(mech.phaseExposed.highCostAll - mech.phaseNormal.highCostAll)}；是否只是被动增伤以本轮决策性判定“${conclusions.decision}”为准。
6. **锁定是否产生净新增保护行为？** ${conclusions.lock}；治疗${signedPoints(mech.lifts.heal)}、护盾${signedPoints(mech.lifts.shield)}、换宠${signedPoints(mech.lifts.swap)}。
7. **哪种应对最有效？** ${bestProtectionStatement(mech.protectionInputs)}
8. **完全忽略有什么代价？** 窗口级击杀率${percent(mech.ignoredWindowOutcome.killRate)}，战斗级全程忽略${mech.battleHandling['all-ignored'].samples}场。
9. **高防队能否无视机制？** 不能裁定。高防队全程忽略样本为${defenseMech.battleHandling['all-ignored'].samples}场，未达到30场门槛；高胜率不能直接解释为能够无视机制。
10. **长战斗是否来自防守循环？** 高防队结论为“${conclusions.defenseHealth.verdict}”，依据逐回合治疗、护盾、承伤与技能重复统计。
11. **结论受AI专属权重影响多少？** ${conclusions.aiInfluence}；full/neutral同Seed对照见AI章节。
12. **应该修改什么？** 暂不修改整体数值、锁定规则或高温爆发；优先检查AI专属加权是否造成过度防护，再评估破绽的主动投入回报。UI理解仍需真人测试。

## 修改建议

### 整体数值
- 生命：本轮不修改。
- 普通攻击：本轮不修改。
- 高温爆发：先依据闭合伤害、忽略代价和替补归因判断，不因单一击杀率直接调整。
- 当前建议：保持正式数值，先处理可明确归因的机制或AI问题。

### 破绽
- 当前问题：决策性判定为${conclusions.decision}。
- 是否需要修改：若neutral下仍只有伤害提升而无投入变化，再考虑修改。
- 修改方向：优先提高可识别的投入回报，不直接追加倍率。

### 锁定
- 当前问题：${conclusions.lock}。
- 是否需要修改：先看净提升和真人可读性，不以表面响应率判断。
- 修改方向：规则本身保持；必要时调整提示或AI权重。

### 高防队
- 当前问题：${conclusions.defenseHealth.verdict}。
- 是否需要针对：只有形成稳定无限维持时才建议直接针对。
- 修改方向：优先处理重复循环收益，不直接削弱全部防护技能。

### 证据等级
- 高：同Seed强制策略因果配对，本轮未执行。
- 中：主报告大样本观察性对照、AI full/neutral同Seed对照。
- 低：少于30场的全程忽略分组、UI理解推断。

## 仍不能确认

- 真人玩家能否看懂破绽、锁定和高温爆发提示；
- 主动处理是否因果性地提高胜率，本轮没有FORCE-HANDLE/FORCE-IGNORE实验；
- 70%–90%胜率和9–14中位回合是否就是最终产品目标，当前仅作为候选测试阈值。
`;
}

function roundBands(battles) {
  const bands = [['1–8', 1, 8], ['9–12', 9, 12], ['13–16', 13, 16], ['17–20', 17, 20], ['21+', 21, Infinity]];
  return bands.map(([label, min, max]) => {
    const items = battles.filter((battle) => battle.rounds >= min && battle.rounds <= max);
    return `| ${label} | ${items.length} | ${percent(ratio(items.length, battles.length))} | ${percent(ratio(items.filter((battle) => battle.victory).length, items.length))} |`;
  }).join('\n');
}

function groupRow(group) {
  const utilized = group.counterWindows.filter((window) => window.utilizationScore >= 2).length;
  return `| ${group.label} | ${percent(group.result.winRate)} | ${number(group.result.averageRounds)} | ${number(group.result.p90Rounds)} | ${percent(group.result.finalHpRatio)} | ${number(group.result.casualties)} | ${number(group.result.replacements)} | ${number(group.result.swaps)} | ${percent(ratio(utilized, group.counterWindows.length))} | ${percent(group.mechanics.estimatedNetResponseRate)} |`;
}

function groupNarrative(group) {
  const topProtection = Object.entries(group.mechanics.protectionInputs).sort((a, b) => b[1].samples - a[1].samples)[0]?.[0] ?? '无';
  const long = group.result.over20Rate > 0.1;
  const reason = group.result.winRate < 0.7
    ? `主要风险是平均减员${number(group.result.casualties)}且剩余生命仅${percent(group.result.finalHpRatio)}`
    : group.result.averageRounds > 16
      ? `依靠较高生存稳定取胜，但平均${number(group.result.averageRounds)}回合显示输出兑现偏慢`
      : group.result.winRate > 0.85 && group.result.averageRounds < 11
        ? `短回合内完成输出兑现，平均${number(group.result.averageRounds)}回合`
        : `胜率与生存处于中间水平，需要结合机制利用判断`;
  return `### ${group.label}\n- 赢/输主要关联：${reason}。\n- 最常见应对路线：${topProtection}。\n- 重复循环：${long ? `存在风险，>20回合${percent(group.result.over20Rate)}` : '未见明显超长循环'}。`;
}

function funnelRows(mech) {
  const total = mech.windows.length;
  const rows = [
    ['蓄力出现', total],
    ['锁定后玩家至少有一次合法行动', mech.valid.length],
    ['锁定后出现表面响应', mech.valid.filter((window) => window.surfaceResponse).length],
    ['估算净新增响应', mech.estimatedNetResponseCount],
    ['高温成功兑现', mech.windows.filter((window) => window.heat).length],
    ['高温造成击杀', mech.windows.filter((window) => window.heatKilled).length],
    ['高温触发并完成替补', mech.windows.filter((window) => window.replacementCompleted).length],
    ['高温后开启破绽', mech.counterWindows.length],
    ['破绽内玩家至少有一次行动', mech.validCounterWindows.length],
    ['破绽内使用高费攻击', mech.validCounterWindows.filter((window) => window.highCostAttacks > 0).length],
    ['破绽内击杀Boss', mech.validCounterWindows.filter((window) => window.bossKill).length]
  ];
  return rows.map(([label, count]) => `| ${label} | ${count} | ${percent(ratio(count, total))} |`).join('\n');
}

function phaseRow(label, key, asPercent, mech) {
  const normal = mech.phaseNormal[key] ?? 0;
  const exposed = mech.phaseExposed[key] ?? 0;
  const absolute = exposed - normal;
  const relative = normal ? absolute / normal : null;
  return `| ${label} | ${asPercent ? percent(normal) : number(normal)} | ${asPercent ? percent(exposed) : number(exposed)} | ${asPercent ? signedPoints(absolute) : number(absolute)} | ${relative === null ? '-' : percent(relative)} |`;
}

function responseLiftRows(mech) {
  const rows = [['治疗锁定行', 'heal'], ['护盾锁定行', 'shield'], ['主动换宠', 'swap'], ['高费攻击', 'highCost'], ['集中攻击Boss', 'attack']];
  return rows.map(([label, key]) => `| ${label} | ${percent(mech.baseline[key])} | ${percent(mech.locked[key])} | ${signedPoints(mech.lifts[key])} |`).join('\n');
}

function metricRows(metrics, fields) {
  return Object.entries(metrics).map(([label, item]) => `| ${label} | ${fields.map((field) => field === 'samples' ? item[field] : field.includes('Rate') || field === 'share' ? percent(item[field]) : number(item[field])).join(' | ')} |`).join('\n');
}

function battleHandlingRows(groups) {
  const labels = { 'all-active': '全程积极处理', partial: '部分处理', 'all-ignored': '全程忽略' };
  return Object.entries(groups).map(([key, item]) => `| ${labels[key]} | ${item.samples} | ${percent(item.winRate)} | ${percent(item.finalHpRatio)} | ${number(item.casualties)} | ${number(item.replacements)} | ${number(item.averageRounds)} |`).join('\n');
}

function heatOutcomeName(key) {
  return ({ 'original-target-hit': '命中原锁定单位', 'replacement-hit': '换宠后命中新单位', 'target-row-empty': '目标行为空', 'boss-defeated-before-cast': 'Boss提前死亡', 'battle-ended': '战斗提前结束', other: '其他/程序异常' })[key] ?? key;
}

function aiRows(comparisons) {
  return comparisons.flatMap((pair) => [
    `| ${pair.label} | full | ${percent(pair.full.result.winRate)} | ${percent(pair.full.mechanics.surfaceResponseRate)} | ${percent(pair.full.mechanics.estimatedNetResponseRate)} | ${percent(pair.full.mechanics.phaseExposed.attack)} | ${percent(pair.full.mechanics.phaseExposed.highCostAll)} |`,
    `| ${pair.label} | neutral | ${percent(pair.neutral.result.winRate)} | ${percent(pair.neutral.mechanics.surfaceResponseRate)} | ${percent(pair.neutral.mechanics.estimatedNetResponseRate)} | ${percent(pair.neutral.mechanics.phaseExposed.attack)} | ${percent(pair.neutral.mechanics.phaseExposed.highCostAll)} |`
  ]).join('\n');
}

function longDefenseSkills(battles) {
  const counts = {};
  const names = {};
  battles.filter((battle) => battle.rounds > 20).forEach((battle) => battle.rawEvents.filter((event) => event.type === 'skill_confirmed').forEach((event) => {
    counts[event.skillId] = (counts[event.skillId] ?? 0) + 1;
    names[event.skillId] = event.skill?.name ?? event.skillId;
  }));
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, count]) => `${names[id]} ${count}次`).join('、') || '无21+回合样本';
}

function strongestWeakest(groups) {
  const fixed = groups.filter((group) => group.id !== 'RANDOM').sort((a, b) => b.result.winRate - a.result.winRate);
  const strongest = fixed[0];
  const weakest = fixed.at(-1);
  return `最强为${strongest.label}（${percent(strongest.result.winRate)}），最弱为${weakest.label}（${percent(weakest.result.winRate)}）；原因需结合回合、减员、破绽利用和防护路线，不只看单一胜率。`;
}

function bestProtectionStatement(inputs) {
  const candidates = Object.entries(inputs)
    .filter(([label, metric]) => !['抢杀', '无治疗无护盾'].includes(label) && metric.samples >= 30)
    .sort((a, b) => a[1].heatKillRate - b[1].heatKillRate || a[1].heatHpDamage - b[1].heatHpDamage);
  const best = candidates[0];
  const burst = inputs['抢杀'];
  if (!best) return '保护类样本不足，无法比较；抢杀成功可以完全避免高温，但不代表每个窗口都具备抢杀条件。';
  return `抢杀成功可以完全避免高温，但只适用于能够完成击杀的窗口。常规保护中${best[0]}的高温击杀率最低（${percent(best[1].heatKillRate)}），生命伤害${number(best[1].heatHpDamage)}；该结论为观察性关联。${burst ? `本轮抢杀成功${burst.samples}次。` : ''}`;
}
