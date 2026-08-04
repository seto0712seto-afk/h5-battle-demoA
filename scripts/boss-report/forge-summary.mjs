import { average, countBy, number, percent, percentile, ratio, signedPoints, sum, topDistinct } from './common.mjs';

const FORGE_CHARGE = 'FORGE_BOSS_MOUNTAIN_CHARGE';
const FORGE_HEAT = 'FORGE_BOSS_MOUNTAIN_CLEAVE';

export function buildForgeAnalysis(groups, thresholds) {
  const analyzedGroups = groups.map((group) => analyzeGroup(group));
  const allBattles = analyzedGroups.flatMap((group) => group.battles);
  const randomGroup = analyzedGroups.find((group) => group.id === 'RANDOM') ?? analyzedGroups[0];
  const allWindows = allBattles.flatMap((battle) => battle.windows);
  const randomWindows = randomGroup.battles.flatMap((battle) => battle.windows);
  const phase = phaseComparison(randomGroup.battles);
  const responses = responseSummary(randomWindows);
  const activeOutcome = outcomeSummary(randomWindows.filter((window) => window.activeHandled));
  const ignoredOutcome = outcomeSummary(randomWindows.filter((window) => window.completelyIgnored));
  const battleOutcome = battleGroupComparison(randomGroup.battles);
  const defenseGroup = analyzedGroups.find((group) => group.id === 'TEAM-DEFENSE');
  const defenseWindows = defenseGroup?.battles.flatMap((battle) => battle.windows) ?? [];
  const defenseActive = outcomeSummary(defenseWindows.filter((window) => window.activeHandled));
  const defenseIgnored = outcomeSummary(defenseWindows.filter((window) => window.completelyIgnored));
  const heat = heatSummary(randomWindows);
  const verdicts = buildVerdicts({
    phase,
    responses,
    activeOutcome,
    ignoredOutcome,
    defenseActive,
    defenseIgnored,
    heat,
    randomGroup,
    thresholds
  });
  return {
    groups: analyzedGroups,
    randomGroup,
    allBattles,
    allWindows,
    randomWindows,
    phase,
    responses,
    activeOutcome,
    ignoredOutcome,
    battleOutcome,
    defenseActive,
    defenseIgnored,
    heat,
    verdicts,
    representativeSeeds: representativeSeeds(allBattles, allWindows)
  };
}

function analyzeGroup(group) {
  const battles = group.traces.map((trace) => analyzeBattle(trace, group.id));
  return {
    ...group,
    battles,
    result: {
      samples: battles.length,
      wins: battles.filter((battle) => battle.victory).length,
      winRate: ratio(battles.filter((battle) => battle.victory).length, battles.length),
      averageRounds: average(battles.map((battle) => battle.rounds)),
      medianRounds: percentile(battles.map((battle) => battle.rounds), 0.5),
      p90Rounds: percentile(battles.map((battle) => battle.rounds), 0.9),
      p95Rounds: percentile(battles.map((battle) => battle.rounds), 0.95),
      over15Rate: ratio(battles.filter((battle) => battle.rounds > 15).length, battles.length),
      over20Rate: ratio(battles.filter((battle) => battle.rounds > 20).length, battles.length),
      finalHpRatio: average(battles.map((battle) => battle.finalHpRatio)),
      averageCasualties: average(battles.map((battle) => Math.max(0, battle.team.length - battle.survivingSpirits))),
      tacticalSwaps: average(battles.map((battle) => battle.tacticalSwaps)),
      anomalies: sum(battles, (battle) => battle.errors.length)
    }
  };
}

function analyzeBattle(trace, teamId) {
  const windows = [];
  let open = null;
  let lastResolved = null;
  const normal = emptyPhase();
  const exposed = emptyPhase();

  for (const event of trace.events ?? []) {
    if (event.type === 'boss_skill' && event.telegraph && event.skillId === FORGE_CHARGE) {
      if (open) finishWindow(open, 'superseded');
      open = createWindow(trace, teamId, windows.length + 1, event);
      windows.push(open);
      continue;
    }
    if (event.type === 'action_start' && event.side === 'player' && open) open.legalPlayerActions += 1;
    if (event.type === 'skill_confirmed') {
      const phase = event.bossExposed ? exposed : normal;
      addSkillAction(phase, event);
      if (open && event.bossExposed) addWindowSkill(open, event);
      continue;
    }
    if (event.type === 'damage' && event.sourceSide === 'player') {
      const phase = event.targetExposed ? exposed : normal;
      phase.damage += event.actual;
      if (open && event.targetExposed) open.damage += event.actual;
      continue;
    }
    if (event.type === 'healing' && open && event.targetSlotIndex === open.lockedSlotIndex) {
      open.healLocked = true;
      open.healingToLocked += event.effective;
      continue;
    }
    if (event.type === 'shield' && open && event.targetSlotIndex === open.lockedSlotIndex) {
      open.shieldLocked = true;
      open.shieldToLocked += event.granted;
      continue;
    }
    if (event.type === 'switch' && !event.forced && open && event.slotIndex === open.lockedSlotIndex) {
      open.swap = true;
      open.swapIncomingId = event.incomingId;
      continue;
    }
    if (event.type === 'row_switch' && open && event.slotIndex === open.lockedSlotIndex) {
      open.rowSwitchAttempt = true;
      continue;
    }
    if (event.type === 'damage' && event.sourceSide === 'enemy' && event.skillId === FORGE_HEAT && open) {
      open.heatAttempted += event.attempted;
      open.heatAbsorbed += event.absorbed;
      open.heatHpDamage += event.actual;
      open.heatTargetId = event.targetId;
      open.heatTargetHpRatio = event.targetMaxHp ? event.targetHpAfter / event.targetMaxHp : null;
      open.heatHit = true;
      continue;
    }
    if (event.type === 'defeated' && open) {
      if (event.side === 'enemy') open.bossKilledBeforeCast = true;
      if (event.side === 'player' && event.skillId === FORGE_HEAT) {
        open.heatKilled = true;
        open.heatKilledTargetId = event.unitId;
      }
      continue;
    }
    if (event.type === 'boss_skill' && !event.telegraph && event.skillId === FORGE_HEAT && open) {
      open.followupTargetIds = [...event.targetIds];
      open.unresolvedReason = event.unresolvedReason ?? null;
      finishWindow(open, event.targetIds.length > 0 ? 'cast' : event.unresolvedReason ?? 'other');
      lastResolved = open;
      open = null;
      continue;
    }
    if (event.type === 'switch' && event.forced && lastResolved?.heatKilled && event.slotIndex === lastResolved.lockedSlotIndex) {
      lastResolved.forcedReplacement = true;
      continue;
    }
    if (event.type === 'battle_end' && open) {
      finishWindow(open, event.result === 'victory' ? 'boss-defeated-before-cast' : 'battle-ended');
      open.bossKilledBeforeCast = event.result === 'victory';
      lastResolved = open;
      open = null;
    }
  }

  if (open) finishWindow(open, trace.result === 'victory' ? 'boss-defeated-before-cast' : 'battle-ended');
  const normalAttackShare = ratio(normal.behaviors.attack, normal.skillActions);
  windows.forEach((window) => finalizeWindow(window, normalAttackShare));
  return {
    seed: trace.seed,
    teamId,
    team: [...trace.team],
    victory: trace.result === 'victory',
    rounds: trace.rounds,
    finalHpRatio: trace.finalHpRatio ?? 0,
    survivingSpirits: trace.survivingSpirits ?? 0,
    forcedReplacements: trace.forcedReplacements ?? 0,
    tacticalSwaps: trace.tacticalSwaps ?? 0,
    errors: trace.errors ?? [],
    normal,
    exposed,
    windows
  };
}

function emptyPhase() {
  return { skillActions: 0, attackActions: 0, highCostAttacks: 0, cost: 0, damage: 0, behaviors: { attack: 0, protect: 0, recover: 0, energy: 0 } };
}

function addSkillAction(phase, event) {
  phase.skillActions += 1;
  phase.cost += event.actualCost;
  const behavior = event.skill?.primaryBehavior;
  if (behavior && phase.behaviors[behavior] !== undefined) phase.behaviors[behavior] += 1;
  if (event.skill?.kind === 'attack') {
    phase.attackActions += 1;
    if (event.actualCost >= 3) phase.highCostAttacks += 1;
  }
}

function createWindow(trace, teamId, index, event) {
  return {
    seed: trace.seed,
    teamId,
    team: [...trace.team],
    battleResult: trace.result,
    battleRounds: trace.rounds,
    finalHpRatio: trace.finalHpRatio ?? 0,
    index,
    startRound: event.round,
    lockedInitialTargetId: event.targetIds?.[0] ?? null,
    lockedSlotIndex: event.lockedSlotIndex,
    legalPlayerActions: 0,
    skillActions: 0,
    attackActions: 0,
    highCostAttacks: 0,
    burstAttacks: 0,
    cost: 0,
    damage: 0,
    behaviors: { attack: 0, protect: 0, recover: 0, energy: 0 },
    swap: false,
    swapIncomingId: null,
    rowSwitchAttempt: false,
    healLocked: false,
    healingToLocked: 0,
    shieldLocked: false,
    shieldToLocked: 0,
    bossKilledBeforeCast: false,
    heatHit: false,
    heatAttempted: 0,
    heatAbsorbed: 0,
    heatHpDamage: 0,
    heatTargetId: null,
    heatTargetHpRatio: null,
    heatKilled: false,
    forcedReplacement: false,
    unresolvedReason: null,
    resolution: null
  };
}

function addWindowSkill(window, event) {
  window.skillActions += 1;
  window.cost += event.actualCost;
  const behavior = event.skill?.primaryBehavior;
  if (behavior && window.behaviors[behavior] !== undefined) window.behaviors[behavior] += 1;
  if (event.skill?.kind === 'attack') {
    window.attackActions += 1;
    if (event.actualCost >= 3) window.highCostAttacks += 1;
    if (event.skill?.burst) window.burstAttacks += 1;
  }
}

function finishWindow(window, resolution) {
  window.resolution = resolution;
}

function finalizeWindow(window, normalAttackShare) {
  window.valid = window.legalPlayerActions > 0;
  window.attackShare = ratio(window.behaviors.attack, window.skillActions);
  window.highCostAttackShare = ratio(window.highCostAttacks, window.skillActions);
  window.averageCost = ratio(window.cost, window.skillActions);
  window.effectiveBurstKill = window.bossKilledBeforeCast && (
    window.highCostAttacks > 0 || window.burstAttacks > 0 || window.attackShare > normalAttackShare
  );
  window.responseCount = [window.swap, window.healLocked, window.shieldLocked, window.effectiveBurstKill].filter(Boolean).length;
  window.activeHandled = window.valid && window.responseCount > 0;
  window.completelyIgnored = window.valid && window.responseCount === 0;
  if (window.bossKilledBeforeCast) window.outcomeType = 'boss-defeated-before-cast';
  else if (!window.heatHit) window.outcomeType = window.resolution === 'battle-ended' ? 'battle-ended' : window.resolution === 'target-row-empty' ? 'target-row-empty' : 'other';
  else if (window.swap && window.heatTargetId !== window.lockedInitialTargetId) window.outcomeType = 'replacement-hit';
  else if (window.rowSwitchAttempt) window.outcomeType = 'row-switch-continued-hit';
  else window.outcomeType = 'original-target-hit';
}

function phaseComparison(battles) {
  const normal = mergePhases(battles.map((battle) => battle.normal));
  const exposed = mergePhases(battles.map((battle) => battle.exposed));
  return { normal: phaseMetrics(normal), exposed: phaseMetrics(exposed) };
}

function mergePhases(phases) {
  const merged = emptyPhase();
  phases.forEach((phase) => {
    merged.skillActions += phase.skillActions;
    merged.attackActions += phase.attackActions;
    merged.highCostAttacks += phase.highCostAttacks;
    merged.cost += phase.cost;
    merged.damage += phase.damage;
    Object.keys(merged.behaviors).forEach((key) => { merged.behaviors[key] += phase.behaviors[key]; });
  });
  return merged;
}

function phaseMetrics(phase) {
  return {
    skillActions: phase.skillActions,
    attackShare: ratio(phase.behaviors.attack, phase.skillActions),
    highCostAttackShare: ratio(phase.highCostAttacks, phase.skillActions),
    averageCost: ratio(phase.cost, phase.skillActions),
    averageDamagePerAction: ratio(phase.damage, phase.skillActions),
    recoverShare: ratio(phase.behaviors.recover, phase.skillActions),
    protectShare: ratio(phase.behaviors.protect, phase.skillActions),
    energyShare: ratio(phase.behaviors.energy, phase.skillActions),
    damage: phase.damage
  };
}

function responseSummary(windows) {
  const valid = windows.filter((window) => window.valid);
  const count = (select) => valid.filter(select).length;
  return {
    valid: valid.length,
    swap: count((window) => window.swap),
    rowSwitchAttempt: count((window) => window.rowSwitchAttempt),
    heal: count((window) => window.healLocked),
    shield: count((window) => window.shieldLocked),
    burstKill: count((window) => window.effectiveBurstKill),
    multi: count((window) => window.responseCount >= 2),
    ignored: count((window) => window.completelyIgnored),
    active: count((window) => window.activeHandled),
    activeRate: ratio(count((window) => window.activeHandled), valid.length)
  };
}

function heatSummary(windows) {
  const outcomeCounts = countBy(windows, (window) => window.outcomeType);
  const casts = windows.filter((window) => window.heatHit);
  const nonStrategicMisses = windows.filter((window) => ['target-row-empty', 'other'].includes(window.outcomeType) && !window.bossKilledBeforeCast);
  return {
    windows: windows.length,
    outcomeCounts,
    castCount: casts.length,
    averageAttempted: average(casts.map((window) => window.heatAttempted)),
    averageAbsorbed: average(casts.map((window) => window.heatAbsorbed)),
    averageHpDamage: average(casts.map((window) => window.heatHpDamage)),
    killRate: ratio(casts.filter((window) => window.heatKilled).length, casts.length),
    averageRemainingHpRatio: average(casts.filter((window) => window.heatTargetHpRatio !== null).map((window) => window.heatTargetHpRatio)),
    forcedReplacementRate: ratio(casts.filter((window) => window.forcedReplacement).length, casts.length),
    nonStrategicMisses: nonStrategicMisses.length,
    nonStrategicMissRate: ratio(nonStrategicMisses.length, windows.length)
  };
}

function outcomeSummary(windows) {
  return {
    windows: windows.length,
    winRate: ratio(windows.filter((window) => window.battleResult === 'victory').length, windows.length),
    averageHeatHpDamage: average(windows.map((window) => window.heatHpDamage)),
    heatKillRate: ratio(windows.filter((window) => window.heatKilled).length, windows.length),
    averageForcedReplacement: average(windows.map((window) => window.forcedReplacement ? 1 : 0)),
    finalHpRatio: average(windows.map((window) => window.finalHpRatio)),
    averageRounds: average(windows.map((window) => window.battleRounds)),
    averageAbsorbed: average(windows.map((window) => window.heatAbsorbed))
  };
}

function battleGroupComparison(battles) {
  const withWindows = battles.filter((battle) => battle.windows.some((window) => window.valid));
  const ignored = withWindows.filter((battle) => battle.windows.filter((window) => window.valid).every((window) => window.completelyIgnored));
  const active = withWindows.filter((battle) => battle.windows.some((window) => window.activeHandled));
  return { active: battleSummary(active), ignored: battleSummary(ignored) };
}

function battleSummary(battles) {
  return {
    battles: battles.length,
    winRate: ratio(battles.filter((battle) => battle.victory).length, battles.length),
    finalHpRatio: average(battles.map((battle) => battle.finalHpRatio)),
    forcedReplacements: average(battles.map((battle) => battle.forcedReplacements)),
    averageRounds: average(battles.map((battle) => battle.rounds))
  };
}

function buildVerdicts({ phase, responses, activeOutcome, ignoredOutcome, defenseActive, defenseIgnored, heat, randomGroup, thresholds }) {
  const attackShift = phase.exposed.attackShare - phase.normal.attackShare;
  const highCostShift = phase.exposed.highCostAttackShare - phase.normal.highCostAttackShare;
  const manaShift = phase.exposed.averageCost - phase.normal.averageCost;
  const damageRatio = phase.normal.averageDamagePerAction > 0 ? phase.exposed.averageDamagePerAction / phase.normal.averageDamagePerAction - 1 : 0;
  const exposedDamageShare = ratio(phase.exposed.damage, phase.exposed.damage + phase.normal.damage);
  let exposedVerdict = '破绽未形成有效体验';
  if (attackShift >= thresholds.decisionShiftPercentagePoints || highCostShift >= thresholds.decisionShiftPercentagePoints || manaShift >= thresholds.manaSpendShift) {
    exposedVerdict = '破绽有效推动自动策略增加攻击或资源投入';
  } else if (damageRatio >= thresholds.damageIncreaseRatio && exposedDamageShare >= thresholds.lowExposedDamageShare) {
    exposedVerdict = '破绽主要表现为被动增伤，技能选择变化有限';
  }
  const responseCheck = responses.activeRate >= thresholds.activeResponsePassRate ? '通过' : responses.activeRate >= thresholds.activeResponseRiskRate ? '风险' : '失败';
  const ignoreCosts = {
    winRate: activeOutcome.winRate - ignoredOutcome.winRate,
    remainingHp: activeOutcome.finalHpRatio - ignoredOutcome.finalHpRatio,
    killRate: ignoredOutcome.heatKillRate - activeOutcome.heatKillRate,
    forcedReplacement: ignoredOutcome.averageForcedReplacement - activeOutcome.averageForcedReplacement
  };
  const ignorePass = ignoreCosts.winRate >= thresholds.ignoreWinRatePenalty || ignoreCosts.remainingHp >= thresholds.ignoreRemainingHpPenalty ||
    ignoreCosts.killRate >= thresholds.ignoreKillRateIncrease || ignoreCosts.forcedReplacement >= thresholds.ignoreForcedReplacementIncrease;
  let defenseVerdict = '样本不足，不裁定';
  if (defenseActive.windows >= thresholds.minimumGroupWindows && defenseIgnored.windows >= thresholds.minimumGroupWindows) {
    const clearCost = defenseActive.winRate - defenseIgnored.winRate;
    const hpCost = defenseActive.finalHpRatio - defenseIgnored.finalHpRatio;
    const killCost = defenseIgnored.heatKillRate - defenseActive.heatKillRate;
    const replacementCost = defenseIgnored.averageForcedReplacement - defenseActive.averageForcedReplacement;
    const canIgnore = clearCost < thresholds.defenseSmallWinRateDifference &&
      hpCost < thresholds.defenseSmallRemainingHpDifference &&
      killCost < thresholds.ignoreKillRateIncrease &&
      replacementCost < thresholds.defenseSmallForcedReplacementDifference;
    defenseVerdict = canIgnore
      ? '高防队可以在几乎不响应预告时稳定作战'
      : '高防队忽略预告会付出明显代价';
  }
  const missCheck = heat.nonStrategicMissRate >= thresholds.nonStrategicMissFailRate ? '失败' : heat.nonStrategicMissRate >= thresholds.nonStrategicMissRiskRate ? '风险' : '通过';
  const longRate = randomGroup.result.over20Rate;
  const longCheck = longRate <= thresholds.longBattlePassRate ? '通过' : longRate <= thresholds.longBattleRiskRate ? '风险' : '失败';
  return {
    exposedVerdict,
    responseCheck,
    ignoreCheck: ignorePass ? '通过' : '失败',
    ignoreCosts,
    defenseVerdict,
    missCheck,
    longCheck,
    attackShift,
    highCostShift,
    manaShift,
    damageRatio,
    exposedDamageShare
  };
}

function representativeSeeds(battles, windows) {
  const ignoredBattles = battles.filter((battle) => battle.victory && battle.windows.some((window) => window.completelyIgnored));
  const activeWindows = windows.filter((window) => window.activeHandled && window.heatHit);
  const categories = [
    ['破绽利用最明显', windows.filter((window) => window.damage > 0), (window) => window.damage + window.highCostAttacks * 100],
    ['完全忽略预告仍获胜', ignoredBattles, (battle) => battle.finalHpRatio * 1000 - battle.rounds],
    ['主动处理后低损失', activeWindows, (window) => 1000 - window.heatHpDamage + window.heatAbsorbed],
    ['高温爆发造成击杀', windows.filter((window) => window.heatKilled), (window) => window.heatHpDamage],
    ['目标行为空导致落空', windows.filter((window) => window.outcomeType === 'target-row-empty'), () => 1],
    ['高防队超长战斗', battles.filter((battle) => battle.teamId === 'TEAM-DEFENSE'), (battle) => battle.rounds],
    ['异常或边界情况', battles.filter((battle) => battle.errors.length > 0 || battle.rounds > 20), (battle) => battle.errors.length * 1000 + battle.rounds]
  ];
  return categories.flatMap(([type, items, score]) => topDistinct(items, score, 3).map((item) => ({
    type,
    seed: item.seed,
    team: item.team,
    rounds: item.battleRounds ?? item.rounds,
    result: item.battleResult ?? (item.victory ? 'victory' : 'defeat'),
    reason: representativeReason(type, item)
  })));
}

function representativeReason(type, item) {
  if (type === '破绽利用最明显') return `窗口伤害${item.damage}，高费攻击${item.highCostAttacks}次`;
  if (type === '完全忽略预告仍获胜') return `全部有效窗口均未主动处理，最终生命比例${number(item.finalHpRatio)}`;
  if (type === '主动处理后低损失') return `高温生命伤害${item.heatHpDamage}，护盾吸收${item.heatAbsorbed}`;
  if (type === '高温爆发造成击杀') return `高温造成${item.heatHpDamage}生命伤害并击杀`;
  if (type === '目标行为空导致落空') return '锁定行在兑现时为空';
  if (type === '高防队超长战斗') return `高防队战斗持续${item.rounds}回合`;
  return item.errors?.[0]?.message ?? `边界长战斗${item.rounds}回合`;
}

export function renderForgeSummary(analysis, metadata) {
  const { randomGroup, groups, phase, responses, activeOutcome, ignoredOutcome, battleOutcome, defenseActive, defenseIgnored, heat, verdicts } = analysis;
  const phaseRows = [
    ['玩家攻击行为占比', phase.normal.attackShare, phase.exposed.attackShare, signedPoints(phase.exposed.attackShare - phase.normal.attackShare), true],
    ['高费攻击占比', phase.normal.highCostAttackShare, phase.exposed.highCostAttackShare, signedPoints(phase.exposed.highCostAttackShare - phase.normal.highCostAttackShare), true],
    ['平均实际妖力支付', phase.normal.averageCost, phase.exposed.averageCost, number(phase.exposed.averageCost - phase.normal.averageCost), false],
    ['单次玩家行动平均伤害', phase.normal.averageDamagePerAction, phase.exposed.averageDamagePerAction, number(phase.exposed.averageDamagePerAction - phase.normal.averageDamagePerAction), false],
    ['恢复行为占比', phase.normal.recoverShare, phase.exposed.recoverShare, signedPoints(phase.exposed.recoverShare - phase.normal.recoverShare), true],
    ['防护行为占比', phase.normal.protectShare, phase.exposed.protectShare, signedPoints(phase.exposed.protectShare - phase.normal.protectShare), true],
    ['回能行为占比', phase.normal.energyShare, phase.exposed.energyShare, signedPoints(phase.exposed.energyShare - phase.normal.energyShare), true]
  ];
  const sampleDescription = groups.map((group) => `${group.label}${group.result.samples}局`).join('、');
  const thresholds = metadata.thresholds;
  return `# 熔核守卫单 Boss 测试总结

## 测试范围

- 日期：${metadata.date}
- 策略：balanced-v3
- Seed：${metadata.seed}
- 样本：${sampleDescription}，共${metadata.totalRuns ?? analysis.allBattles.length}局
- 规则与正式数值改动：无
- 说明：本报告中的“响应”均指自动策略行为，不代表真实玩家行为；切换前后排不能规避锁定，因此只记录、不计入有效处理。

### 阈值定义

- 破绽改变决策：攻击或高费攻击占比提升至少${signedPoints(thresholds.decisionShiftPercentagePoints)}，或平均实际妖力支付提升至少${number(thresholds.manaSpendShift)}。
- 主动响应：达到${percent(thresholds.activeResponsePassRate)}判为通过，${percent(thresholds.activeResponseRiskRate)}至通过线之间判为风险，低于风险线判为失败。
- 忽略代价：胜率下降至少${percent(thresholds.ignoreWinRatePenalty)}、最终生命下降至少${percent(thresholds.ignoreRemainingHpPenalty)}、高温击杀率增加至少${percent(thresholds.ignoreKillRateIncrease)}或平均强制替补增加至少${number(thresholds.ignoreForcedReplacementIncrease)}，任一满足即判为存在明显代价。
- 高防队可忽略：主动与忽略组胜率差、最终生命差、击杀率差和强制替补差均低于对应小差异阈值时成立；每组至少需要${thresholds.minimumGroupWindows}个窗口。
- 非策略性落空：达到${percent(thresholds.nonStrategicMissRiskRate)}判为风险，达到${percent(thresholds.nonStrategicMissFailRate)}判为失败。
- 超长战斗：超过20回合占比不高于${percent(thresholds.longBattlePassRate)}判为通过，高于${percent(thresholds.longBattleRiskRate)}判为失败，中间判为风险。

## 通用结果

| 指标 | 结果 |
|---|---:|
| 样本数 | ${randomGroup.result.samples} |
| 玩家胜率 | ${percent(randomGroup.result.winRate)} |
| 平均回合 | ${number(randomGroup.result.averageRounds)} |
| 中位回合 | ${number(randomGroup.result.medianRounds)} |
| P90 | ${number(randomGroup.result.p90Rounds)} |
| P95 | ${number(randomGroup.result.p95Rounds)} |
| 超过15回合占比 | ${percent(randomGroup.result.over15Rate)} |
| 超过20回合占比 | ${percent(randomGroup.result.over20Rate)} |
| 核心机制出现率 | ${percent(ratio(randomGroup.battles.filter((battle) => battle.windows.length > 0).length, randomGroup.battles.length))} |
| 运行异常 | ${randomGroup.result.anomalies} |

## 四套固定阵容

| 阵容 | 胜率 | 平均回合 | P90 | 最终剩余生命 | 平均减员 | 主动换宠 |
|---|---:|---:|---:|---:|---:|---:|
${groups.filter((group) => group.id !== 'RANDOM').map((group) => `| ${group.label} | ${percent(group.result.winRate)} | ${number(group.result.averageRounds)} | ${number(group.result.p90Rounds)} | ${percent(group.result.finalHpRatio)} | ${number(group.result.averageCasualties)} | ${number(group.result.tacticalSwaps)} |`).join('\n')}

## 技能生态与破绽窗口

| 指标 | 普通阶段 | 破绽窗口 | 变化 |
|---|---:|---:|---:|
${phaseRows.map(([label, normal, exposed, delta, isPercent]) => `| ${label} | ${isPercent ? percent(normal) : number(normal)} | ${isPercent ? percent(exposed) : number(exposed)} | ${delta} |`).join('\n')}

| 破绽指标 | 结果 |
|---|---:|
| 破绽窗口总次数 | ${analysis.randomWindows.length} |
| 窗口内击杀 Boss 次数 | ${analysis.randomWindows.filter((window) => window.bossKilledBeforeCast).length} |
| 破绽窗口总伤害 | ${sum(analysis.randomWindows, (window) => window.damage)} |
| 破绽伤害占 Boss 总受伤比例 | ${percent(verdicts.exposedDamageShare)} |
| 使用高费攻击的窗口占比 | ${percent(ratio(analysis.randomWindows.filter((window) => window.highCostAttacks > 0).length, analysis.randomWindows.length))} |
| 窗口攻击占比较普通阶段提升 | ${signedPoints(verdicts.attackShift)} |

自动判断：**${verdicts.exposedVerdict}**。

## 锁定后的自动策略响应

| 响应类型 | 次数 | 占有效窗口 |
|---|---:|---:|
| 主动换宠 | ${responses.swap} | ${percent(ratio(responses.swap, responses.valid))} |
| 切换前后排（不能规避） | ${responses.rowSwitchAttempt} | ${percent(ratio(responses.rowSwitchAttempt, responses.valid))} |
| 给锁定行单位治疗 | ${responses.heal} | ${percent(ratio(responses.heal, responses.valid))} |
| 给锁定行单位护盾 | ${responses.shield} | ${percent(ratio(responses.shield, responses.valid))} |
| 破绽窗口有效抢杀 | ${responses.burstKill} | ${percent(ratio(responses.burstKill, responses.valid))} |
| 同时采取两种以上有效应对 | ${responses.multi} | ${percent(ratio(responses.multi, responses.valid))} |
| 完全未处理 | ${responses.ignored} | ${percent(ratio(responses.ignored, responses.valid))} |

有效主动响应率：${percent(responses.activeRate)}，判定：**${verdicts.responseCheck}**。

## 高温爆发结算

| 结算结果 | 次数 | 占全部窗口 |
|---|---:|---:|
${Object.entries({
  '命中原锁定单位': heat.outcomeCounts['original-target-hit'] ?? 0,
  '换宠后命中新单位': heat.outcomeCounts['replacement-hit'] ?? 0,
  '切排后继续命中': heat.outcomeCounts['row-switch-continued-hit'] ?? 0,
  '目标行为空导致落空': heat.outcomeCounts['target-row-empty'] ?? 0,
  'Boss兑现前被击杀': heat.outcomeCounts['boss-defeated-before-cast'] ?? 0,
  '战斗提前结束': heat.outcomeCounts['battle-ended'] ?? 0,
  '其他': heat.outcomeCounts.other ?? 0
}).map(([label, count]) => `| ${label} | ${count} | ${percent(ratio(count, heat.windows))} |`).join('\n')}

| 伤害指标 | 结果 |
|---|---:|
| 平均总伤害 | ${number(heat.averageAttempted)} |
| 平均护盾吸收 | ${number(heat.averageAbsorbed)} |
| 平均生命伤害 | ${number(heat.averageHpDamage)} |
| 击杀率 | ${percent(heat.killRate)} |
| 命中后平均剩余生命比例 | ${percent(heat.averageRemainingHpRatio)} |
| 造成强制替补比例 | ${percent(heat.forcedReplacementRate)} |

## 主动处理与完全忽略对照（窗口级）

| 结果 | 主动处理组 | 完全忽略组 | 差值 |
|---|---:|---:|---:|
${outcomeComparisonRows(activeOutcome, ignoredOutcome)}

本表为观察性分组，受阵容、血量和资源条件影响，只能说明关联，不能直接证明因果。

### 战斗级分组

| 分组 | 战斗数 | 胜率 | 最终生命比例 | 平均强制替补 | 平均回合 |
|---|---:|---:|---:|---:|---:|
| 至少主动处理一次 | ${battleOutcome.active.battles} | ${percent(battleOutcome.active.winRate)} | ${percent(battleOutcome.active.finalHpRatio)} | ${number(battleOutcome.active.forcedReplacements)} | ${number(battleOutcome.active.averageRounds)} |
| 全部锁定均忽略 | ${battleOutcome.ignored.battles} | ${percent(battleOutcome.ignored.winRate)} | ${percent(battleOutcome.ignored.finalHpRatio)} | ${number(battleOutcome.ignored.forcedReplacements)} | ${number(battleOutcome.ignored.averageRounds)} |

## 高防队专项

| 高防队指标 | 主动处理组 | 完全忽略组 |
|---|---:|---:|
| 锁定窗口数 | ${defenseActive.windows} | ${defenseIgnored.windows} |
| 玩家胜率 | ${percent(defenseActive.winRate)} | ${percent(defenseIgnored.winRate)} |
| 高温爆发生命伤害 | ${number(defenseActive.averageHeatHpDamage)} | ${number(defenseIgnored.averageHeatHpDamage)} |
| 高温爆发击杀率 | ${percent(defenseActive.heatKillRate)} | ${percent(defenseIgnored.heatKillRate)} |
| 平均护盾吸收 | ${number(defenseActive.averageAbsorbed)} | ${number(defenseIgnored.averageAbsorbed)} |
| 平均强制替补 | ${number(defenseActive.averageForcedReplacement)} | ${number(defenseIgnored.averageForcedReplacement)} |
| 战斗结束剩余生命 | ${percent(defenseActive.finalHpRatio)} | ${percent(defenseIgnored.finalHpRatio)} |
| 平均回合 | ${number(defenseActive.averageRounds)} | ${number(defenseIgnored.averageRounds)} |

自动判断：**${verdicts.defenseVerdict}**。

## 负面情况检查

| 检查项 | 结果 | 判定 |
|---|---:|---|
| 破绽窗口是否改变自动策略技能选择 | 攻击${signedPoints(verdicts.attackShift)}，高费攻击${signedPoints(verdicts.highCostShift)}，妖力${number(verdicts.manaShift)} | ${verdicts.exposedVerdict.includes('有效推动') ? '通过' : verdicts.exposedVerdict.includes('被动') ? '风险' : '失败'} |
| 自动策略是否主动响应锁定 | ${percent(responses.activeRate)} | ${verdicts.responseCheck} |
| 忽略高温爆发是否有明显代价 | 胜率差${signedPoints(verdicts.ignoreCosts.winRate)}，剩余生命差${signedPoints(verdicts.ignoreCosts.remainingHp)} | ${verdicts.ignoreCheck} |
| 高防队能否无视机制 | ${verdicts.defenseVerdict} | ${verdicts.defenseVerdict.startsWith('样本不足') ? '样本不足' : verdicts.defenseVerdict.includes('明显代价') ? '通过' : '失败'} |
| 高温爆发是否存在非策略性落空 | ${heat.nonStrategicMisses}次，${percent(heat.nonStrategicMissRate)} | ${verdicts.missCheck} |
| Boss是否存在明显超长战斗 | 超过20回合${percent(randomGroup.result.over20Rate)} | ${verdicts.longCheck} |

## 自动结论

### 1. 破绽机制
- 事实：破绽窗口攻击占比变化${signedPoints(verdicts.attackShift)}，高费攻击变化${signedPoints(verdicts.highCostShift)}，平均妖力支付变化${number(verdicts.manaShift)}，窗口伤害占比${percent(verdicts.exposedDamageShare)}。
- 判断：${verdicts.exposedVerdict}。
- 置信度：中。自动策略本身含有破绽响应权重，只能验证策略与机制是否形成可观察差异。

### 2. 锁定与高温爆发
- 事实：有效锁定窗口${responses.valid}个，主动处理率${percent(responses.activeRate)}；高温爆发击杀率${percent(heat.killRate)}，非策略性落空${heat.nonStrategicMisses}次。
- 判断：忽略代价判定为${verdicts.ignoreCheck}；该结果为观察性相关，不作因果裁定。
- 置信度：中。

### 3. 高防队
- 事实：主动组${defenseActive.windows}个窗口，忽略组${defenseIgnored.windows}个窗口。
- 判断：${verdicts.defenseVerdict}。
- 置信度：${defenseActive.windows >= 30 && defenseIgnored.windows >= 30 ? '中' : '低'}。

### 4. 当前主要问题归因
- Boss数值问题：${verdicts.longCheck === '失败' ? '不确定' : '否'}
- Boss机制问题：${verdicts.responseCheck === '失败' || verdicts.ignoreCheck === '失败' ? '是' : '否'}
- 自动策略问题：${verdicts.responseCheck === '失败' ? '是' : '不确定'}
- UI提示问题：不确定，本轮无真人与界面理解测试

### 5. 建议
- 正式数值是否修改：本报告不自动修改；根据以上事实再决定。
- 是否需要新增测试：若需因果结论，后续追加同Seed强制处理/强制忽略配对实验。
- 下一步优先事项：先核对破绽是否改变投入、忽略是否付出代价及高防队能否无视机制。

## 代表 Seed

| 类型 | Seed | 阵容 | 回合 | 结果 | 选择理由 |
|---|---:|---|---:|---|---|
${analysis.representativeSeeds.map((item) => `| ${item.type} | ${item.seed} | ${item.team.join('/')} | ${item.rounds} | ${item.result === 'victory' ? '胜利' : '失败'} | ${item.reason} |`).join('\n')}

未出现的代表类型表示该类样本为0，不补造Seed。

## 仍不能确认的内容

- 真实玩家是否能理解破绽、锁定和高温爆发提示；
- UI提示是否足够醒目；
- 观察性主动/忽略分组之间的差异是否具有因果关系；
- balanced-v3的行为是否等同于目标玩家群体的真实决策。
`;
}

function outcomeComparisonRows(active, ignored) {
  const rows = [
    ['玩家胜率', active.winRate, ignored.winRate, active.winRate - ignored.winRate, true],
    ['高温爆发平均生命伤害', active.averageHeatHpDamage, ignored.averageHeatHpDamage, active.averageHeatHpDamage - ignored.averageHeatHpDamage, false],
    ['高温爆发击杀率', active.heatKillRate, ignored.heatKillRate, active.heatKillRate - ignored.heatKillRate, true],
    ['平均强制替补', active.averageForcedReplacement, ignored.averageForcedReplacement, active.averageForcedReplacement - ignored.averageForcedReplacement, false],
    ['战斗结束剩余生命比例', active.finalHpRatio, ignored.finalHpRatio, active.finalHpRatio - ignored.finalHpRatio, true],
    ['平均回合', active.averageRounds, ignored.averageRounds, active.averageRounds - ignored.averageRounds, false]
  ];
  return rows.map(([label, a, b, delta, isPercent]) => `| ${label} | ${isPercent ? percent(a) : number(a)} | ${isPercent ? percent(b) : number(b)} | ${isPercent ? signedPoints(delta) : number(delta)} |`).join('\n');
}
