import { analyzeAiScoreSources, mergeAiScoreSources } from './ai-source-analysis.mjs';
import { analyzeMechanicWindows } from './attribution-engine.mjs';
import { buildRoundSeries, detectChangePoints } from './change-point.mjs';
import { buildEvidenceConclusions } from './evidence-engine.mjs';
import { toCombatEventsV2 } from './event-v2.mjs';
import { classifyLongTail } from './long-tail-classifier.mjs';
import { runQualityGates } from './quality-gates.mjs';
import { analyzeRoleLoss } from './role-loss.mjs';
import { mean, median, percentile } from './utils.mjs';

export function analyzeBossReportV2({
  bossId,
  groups,
  metadataRegistry,
  metricRegistry,
  mechanicDsl,
  diagnosticsConfig,
  experimentRegistry,
  experimentId = 'CURRENT-BASELINE',
  rulesetId = 'system1-current',
  experimentComparison = null
}) {
  const bossMechanicConfig = mechanicDsl.forBoss(bossId);
  const analyzedGroups = groups.map((group) => ({ ...group, battles: group.traces.map((trace) => analyzeBattle({
    trace,
    group,
    bossId,
    bossMechanicConfig,
    metadataRegistry,
    metricRegistry,
    diagnosticsConfig,
    experimentId: group.experimentId ?? experimentId,
    rulesetId: group.rulesetId ?? rulesetId
  })) }));
  const battles = analyzedGroups.flatMap((group) => group.battles);
  const experiment = experimentRegistry.get(experimentId);
  const quality = runQualityGates({ battles, metadataRegistry, metricRegistry, mechanicConfig: bossMechanicConfig, mechanicDslIssues: mechanicDsl.issues, experimentRegistryIssues: experimentRegistry.issues, experimentValidation: experimentComparison?.comparability });
  const analysis = aggregate({ battles, groups: analyzedGroups, bossId, metadataRegistry, diagnosticsConfig });
  const conclusions = buildEvidenceConclusions({ analysis, quality, experimentComparison, diagnosticsConfig, experiment });
  return {
    schemaVersion: '2.0.0',
    reportVersion: 'generic-single-boss-v2',
    generatedAt: new Date().toISOString(),
    bossId,
    bossMetadata: metadataRegistry.boss(bossId),
    metadata: { version: metadataRegistry.metadataVersion, hash: metadataRegistry.hash },
    metrics: { version: metricRegistry.registryVersion, hash: metricRegistry.hash },
    metricDefinitions: metricRegistry.list(),
    mechanics: { version: mechanicDsl.dslVersion, hash: mechanicDsl.hash },
    experiment: { ...experiment, registryVersion: experimentRegistry.registryVersion, registryHash: experimentRegistry.hash },
    diagnosticsVersion: diagnosticsConfig.diagnosticsVersion,
    groups: analyzedGroups,
    battles,
    quality,
    analysis,
    experimentComparison,
    conclusions,
    representatives: representativeSeeds(battles)
  };
}

export function compactBatchResultForMerge(result) {
  return {
    quality: result.quality,
    battles: result.battles.map(compactAnalyzedBattle),
    groupMeta: result.groups.map((group) => ({ id: group.id, label: group.label, policy: group.policy, playerTendency: group.playerTendency }))
  };
}

export function combineBossReportV2Batches({
  batches,
  bossId,
  metadataRegistry,
  metricRegistry,
  mechanicDsl,
  diagnosticsConfig,
  experimentRegistry,
  experimentId = 'CURRENT-BASELINE',
  experimentComparison = null
}) {
  const battles = batches.flatMap((batch) => batch.battles);
  const groupMap = new Map();
  for (const batch of batches) {
    for (const meta of batch.groupMeta) {
      if (!groupMap.has(meta.id)) groupMap.set(meta.id, { ...meta, battles: [] });
      groupMap.get(meta.id).battles.push(...batch.battles.filter((battle) => battle.groupId === meta.id));
    }
  }
  const groups = [...groupMap.values()];
  const experiment = experimentRegistry.get(experimentId);
  const quality = mergeBatchQuality(batches.map((batch) => batch.quality), battles);
  const analysis = aggregate({ battles, groups, bossId, metadataRegistry, diagnosticsConfig });
  const conclusions = buildEvidenceConclusions({ analysis, quality, experimentComparison, diagnosticsConfig, experiment });
  return {
    schemaVersion: '2.0.0',
    reportVersion: 'generic-single-boss-v2',
    generatedAt: new Date().toISOString(),
    bossId,
    bossMetadata: metadataRegistry.boss(bossId),
    metadata: { version: metadataRegistry.metadataVersion, hash: metadataRegistry.hash },
    metrics: { version: metricRegistry.registryVersion, hash: metricRegistry.hash },
    metricDefinitions: metricRegistry.list(),
    mechanics: { version: mechanicDsl.dslVersion, hash: mechanicDsl.hash },
    experiment: { ...experiment, registryVersion: experimentRegistry.registryVersion, registryHash: experimentRegistry.hash },
    diagnosticsVersion: diagnosticsConfig.diagnosticsVersion,
    groups,
    battles,
    quality,
    analysis,
    experimentComparison,
    conclusions,
    representatives: representativeSeeds(battles)
  };
}

function analyzeBattle({ trace, group, bossId, bossMechanicConfig, metadataRegistry, metricRegistry, diagnosticsConfig, experimentId, rulesetId }) {
  const battleId = `${group.id}:${trace.seed}`;
  const baseEvents = toCombatEventsV2({ ...trace, battleId }, {
    rulesetId,
    experimentId,
    groupId: group.id
  }, metadataRegistry);
  const battle = {
    battleId,
    seed: Number(trace.seed),
    groupId: group.id,
    groupLabel: group.label,
    aiPolicyId: group.policy,
    playerTendency: group.playerTendency ?? trace.playerTendency ?? 'balanced',
    team: [...(trace.team ?? [])],
    bossId,
    victory: trace.result === 'victory',
    result: trace.result,
    rounds: trace.rounds ?? 0,
    finalHpRatio: trace.finalHpRatio ?? 0,
    bossRemainingHpRatio: trace.bossRemainingHpRatio ?? 0,
    survivingSpirits: trace.survivingSpirits ?? 0,
    replacements: trace.forcedReplacements ?? 0,
    errors: trace.errors ?? [],
    events: baseEvents,
    mechanicWindows: []
  };
  const mechanic = analyzeMechanicWindows({ battle, bossMechanicConfig, metricRegistry });
  battle.events = mechanic.events;
  battle.mechanicWindows = mechanic.windows;
  battle.attributions = mechanic.attributions;
  battle.overlap = mechanic.overlap;
  battle.roleLoss = analyzeRoleLoss(battle, metadataRegistry, diagnosticsConfig.roleLossRules);
  battle.series = buildRoundSeries({ battle, metricRegistry, roleLoss: battle.roleLoss });
  battle.changePoints = detectChangePoints(battle.series, diagnosticsConfig);
  battle.longTail = classifyLongTail({ battle, series: battle.series, changePoints: battle.changePoints, roleLoss: battle.roleLoss, config: diagnosticsConfig, bossMetadata: metadataRegistry.boss(bossId) });
  battle.metrics = battleMetrics(battle.events, metricRegistry, battle.roleLoss);
  battle.skillUsage = skillUsageForBattle(battle.events, metadataRegistry);
  battle.aiSummary = analyzeAiScoreSources([battle]);
  battle.attributionStats = attributionStatsForBattle(battle.attributions);
  return battle;
}

function battleMetrics(events, metricRegistry, roleLoss) {
  const externalValues = {
    alive_damage_weight: roleLoss.rounds.at(-1)?.weights.damage ?? 0,
    alive_healing_weight: roleLoss.rounds.at(-1)?.weights.healing ?? 0,
    alive_protection_weight: roleLoss.rounds.at(-1)?.weights.protection ?? 0,
    alive_resource_weight: roleLoss.rounds.at(-1)?.weights.resource ?? 0
  };
  return Object.fromEntries(metricRegistry.list().map((metric) => {
    try {
      return [metric.metricId, metricRegistry.evaluate(metric.metricId, events, { externalValues, derivedValues: { boss_hp_loss_rate: metricRegistry.evaluate('player_damage_to_boss', events) } })];
    } catch {
      return [metric.metricId, null];
    }
  }));
}

function aggregate({ battles, groups, bossId, metadataRegistry, diagnosticsConfig }) {
  const baselineGroup = groups.find((group) => group.id === 'RANDOM') ?? groups[0];
  const mechanics = aggregateMechanics(battles, diagnosticsConfig.overlapConfidenceThreshold);
  const overlap = aggregateOverlap(battles);
  return {
    bossId,
    samples: battles.length,
    baselineGroupId: baselineGroup?.id,
    overall: aggregateBattles(baselineGroup?.battles ?? battles),
    groupResults: groups.map((group) => ({ id: group.id, label: group.label, policy: group.policy, playerTendency: group.playerTendency ?? 'balanced', ...aggregateBattles(group.battles) })),
    rosterHeterogeneity: aggregateRosters(battles, metadataRegistry),
    mechanics,
    overlap,
    changePointSummary: aggregateChangePoints(battles),
    longTail: aggregateLongTail(battles),
    roleLoss: aggregateRoleLoss(battles, metadataRegistry),
    skillEcology: aggregateSkills(battles, metadataRegistry),
    ai: battles.every((battle) => battle.aiSummary) ? mergeAiScoreSources(battles.map((battle) => battle.aiSummary)) : analyzeAiScoreSources(battles)
  };
}

function aggregateBattles(battles) {
  const rounds = battles.map((battle) => battle.rounds);
  return {
    samples: battles.length,
    winRate: mean(battles.map((battle) => battle.victory ? 1 : 0)),
    averageRounds: mean(rounds),
    medianRounds: median(rounds),
    p90Rounds: percentile(rounds, 0.9),
    over20Rate: mean(battles.map((battle) => battle.rounds > 20 ? 1 : 0)),
    over30Rate: mean(battles.map((battle) => battle.rounds > 30 ? 1 : 0)),
    finalHpRatio: mean(battles.map((battle) => battle.finalHpRatio)),
    averageDeaths: mean(battles.map((battle) => battle.metrics.deaths ?? 0))
  };
}

function aggregateMechanics(battles, overlapThreshold) {
  const ids = new Set(battles.flatMap((battle) => battle.mechanicWindows.map((window) => window.mechanicId)));
  return [...ids].map((mechanicId) => {
    const windows = battles.flatMap((battle) => battle.mechanicWindows.filter((window) => window.mechanicId === mechanicId));
    const effective = windows.filter((window) => window.responseClassification === 'effective');
    const ignored = windows.filter((window) => window.responseClassification === 'ignored');
    const baselineRate = mean(windows.map((window) => window.baselineResponseRate ?? 0));
    const effectiveRate = windows.length ? effective.length / windows.length : 0;
    const attributedCount = battles.reduce((sum, battle) => sum + (battle.attributionStats?.[mechanicId]?.attributed ?? battle.attributions?.filter((item) => item.primaryMechanicId === mechanicId).length ?? 0), 0);
    const overlapCount = battles.reduce((sum, battle) => sum + (battle.attributionStats?.[mechanicId]?.overlap ?? battle.attributions?.filter((item) => item.primaryMechanicId === mechanicId && item.secondaryMechanicIds.length).length ?? 0), 0);
    const overlapRate = attributedCount ? overlapCount / attributedCount : 0;
    const config = windows[0]?.config;
    return {
      mechanicId,
      displayName: windows[0]?.displayName ?? mechanicId,
      mechanicType: windows[0]?.mechanicType,
      windows: windows.length,
      effectiveResponseRate: effectiveRate,
      invalidResponseRate: windows.length ? windows.filter((window) => window.responseClassification === 'invalid').length / windows.length : 0,
      incidentalRate: windows.length ? windows.filter((window) => window.responseClassification === 'incidental').length / windows.length : 0,
      ignoreRate: windows.length ? ignored.length / windows.length : 0,
      noOpportunityRate: windows.length ? windows.filter((window) => window.responseClassification === 'no_opportunity').length / windows.length : 0,
      baselineResponseRate: baselineRate,
      netResponseRate: effectiveRate - baselineRate,
      overlapRate,
      confidenceReducedByOverlap: overlapRate > overlapThreshold,
      outcomes: aggregateMetricMaps(windows.map((window) => window.outcomes)),
      postImpact: aggregateMetricMaps(windows.map((window) => window.postImpact)),
      responseBreakdown: countValues(windows.flatMap((window) => window.effectiveResponses)),
      fullCombinationBreakdown: countValues(windows.map((window) => window.effectiveResponses.sort().join('+') || window.responseClassification)),
      outcomeMetricIds: config?.outcomeMetrics ?? windows[0]?.outcomeMetricIds ?? []
    };
  });
}

function aggregateOverlap(battles) {
  const map = new Map();
  for (const battle of battles) {
    for (const row of battle.overlap) {
      if (!map.has(row.mechanicCombination)) map.set(row.mechanicCombination, { mechanicCombination: row.mechanicCombination, events: 0, battleIds: new Set(), overlapping: row.overlapping });
      const target = map.get(row.mechanicCombination);
      target.events += row.events;
      target.battleIds.add(battle.battleId);
    }
  }
  const total = [...map.values()].reduce((sum, row) => sum + row.events, 0);
  return [...map.values()].map((row) => ({ mechanicCombination: row.mechanicCombination, events: row.events, battles: row.battleIds.size, share: total ? row.events / total : 0, overlapping: row.overlapping })).sort((a, b) => b.events - a.events);
}

function aggregateChangePoints(battles) {
  const signals = countValues(battles.flatMap((battle) => battle.changePoints.signals.map((signal) => signal.displayName)));
  const starts = battles.map((battle) => battle.changePoints.compositeStartRound).filter(Boolean);
  const intervals = battles.map((battle) => battle.changePoints.intervalToStatisticalThreshold).filter(Number.isFinite);
  return { signals, withCompositeStart: starts.length, compositeStartRate: battles.length ? starts.length / battles.length : 0, medianCompositeStartRound: starts.length ? median(starts) : null, averageThresholdInterval: intervals.length ? mean(intervals) : null };
}

function aggregateLongTail(battles) {
  const long = battles.filter((battle) => battle.longTail.statisticalLongTail);
  return {
    samples: long.length,
    rate: battles.length ? long.length / battles.length : 0,
    primaryTypes: countValues(long.map((battle) => battle.longTail.primaryType)),
    additionalTags: countValues(long.flatMap((battle) => battle.longTail.additionalTags)),
    medianActualStartRound: medianOrNull(long.map((battle) => battle.longTail.actualLoopStartRound).filter(Boolean)),
    averageThresholdInterval: meanOrNull(long.map((battle) => battle.longTail.interval).filter(Number.isFinite))
  };
}

function aggregateRoleLoss(battles, metadataRegistry) {
  const lossCounts = countValues(battles.flatMap((battle) => battle.roleLoss.losses.map((loss) => loss.displayName)));
  const formalDeaths = countValues(battles.flatMap((battle) => battle.roleLoss.formalPrimaryDamageDeaths.map((death) => metadataRegistry.unit(death.unitId)?.displayName ?? death.unitId)));
  return {
    lossCounts,
    formalPrimaryDamageDeaths: formalDeaths,
    protectionAliveAfterDamageLoss: battles.filter((battle) => battle.roleLoss.protectionStillAliveAtDamageLoss).length,
    residualMaintenance: battles.filter((battle) => battle.roleLoss.residualMaintenance).length,
    metadataIncompleteBattles: battles.filter((battle) => !battle.roleLoss.metadataComplete).length
  };
}

function aggregateSkills(battles, metadataRegistry) {
  const map = new Map();
  for (const battle of battles) {
    if (!battle.events && battle.skillUsage) {
      for (const item of battle.skillUsage) {
        if (!map.has(item.skillId)) map.set(item.skillId, { ...item, uses: 0 });
        map.get(item.skillId).uses += item.uses;
      }
      continue;
    }
    for (const event of battle.events.filter((item) => item.eventType === 'skill_confirm')) {
      if (!map.has(event.skillId)) map.set(event.skillId, { skillId: event.skillId, displayName: metadataRegistry.skill(event.skillId)?.displayName ?? event.skillId, uses: 0, categories: metadataRegistry.skill(event.skillId)?.actionCategories ?? [] });
      map.get(event.skillId).uses += 1;
    }
  }
  return [...map.values()].sort((a, b) => b.uses - a.uses);
}

function skillUsageForBattle(events, metadataRegistry) {
  const counts = countValues(events.filter((event) => event.eventType === 'skill_confirm').map((event) => event.skillId));
  return Object.entries(counts).map(([skillId, uses]) => ({
    skillId,
    displayName: metadataRegistry.skill(skillId)?.displayName ?? skillId,
    categories: metadataRegistry.skill(skillId)?.actionCategories ?? [],
    uses
  }));
}

function attributionStatsForBattle(attributions) {
  const result = {};
  for (const item of attributions) {
    if (!result[item.primaryMechanicId]) result[item.primaryMechanicId] = { attributed: 0, overlap: 0 };
    result[item.primaryMechanicId].attributed += 1;
    if (item.secondaryMechanicIds.length) result[item.primaryMechanicId].overlap += 1;
  }
  return result;
}

function compactAnalyzedBattle(battle) {
  return {
    battleId: battle.battleId,
    seed: battle.seed,
    groupId: battle.groupId,
    groupLabel: battle.groupLabel,
    aiPolicyId: battle.aiPolicyId,
    playerTendency: battle.playerTendency,
    team: battle.team,
    bossId: battle.bossId,
    victory: battle.victory,
    result: battle.result,
    rounds: battle.rounds,
    finalHpRatio: battle.finalHpRatio,
    bossRemainingHpRatio: battle.bossRemainingHpRatio,
    survivingSpirits: battle.survivingSpirits,
    replacements: battle.replacements,
    errors: battle.errors,
    mechanicWindows: battle.mechanicWindows.map(({ config, ...window }) => ({ ...window, outcomeMetricIds: config?.outcomeMetrics ?? [] })),
    overlap: battle.overlap,
    roleLoss: { ...battle.roleLoss, rounds: [] },
    changePoints: battle.changePoints,
    longTail: battle.longTail,
    metrics: battle.metrics,
    skillUsage: battle.skillUsage,
    aiSummary: battle.aiSummary,
    attributionStats: battle.attributionStats
  };
}

function mergeBatchQuality(qualities, battles) {
  const gateIds = new Set(qualities.flatMap((quality) => quality.gates.map((gate) => gate.id)));
  const gates = [...gateIds].map((id) => {
    const rows = qualities.map((quality) => quality.gates.find((gate) => gate.id === id)).filter(Boolean);
    const issues = rows.flatMap((row) => row.issues ?? []);
    return { id, severity: rows[0]?.severity ?? 'P0', status: rows.some((row) => row.status === 'failed') ? 'failed' : 'passed', issueCount: rows.reduce((sum, row) => sum + row.issueCount, 0), issues: issues.slice(0, 100) };
  });
  const seen = new Map();
  const duplicateIssues = [];
  for (const battle of battles) {
    const key = `${battle.groupId}:${battle.seed}`;
    if (seen.has(key)) duplicateIssues.push(`${key}:duplicate-across-batches`);
    seen.set(key, true);
  }
  const seedGate = gates.find((gate) => gate.id === 'seed_uniqueness');
  if (duplicateIssues.length && seedGate) {
    seedGate.status = 'failed';
    seedGate.issueCount += duplicateIssues.length;
    seedGate.issues.push(...duplicateIssues.slice(0, Math.max(0, 100 - seedGate.issues.length)));
  }
  const failures = gates.filter((gate) => gate.severity === 'P0' && gate.status === 'failed');
  return { gates, passed: failures.length === 0, automaticConclusionsAllowed: failures.length === 0, p0Failures: failures.map((gate) => gate.id) };
}

function aggregateRosters(battles, metadataRegistry) {
  const map = new Map();
  for (const battle of battles) {
    const key = [...battle.team].sort().join('/');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(battle);
  }
  return [...map.entries()].map(([teamIds, rows]) => ({
    teamIds: teamIds.split('/'),
    team: teamIds.split('/').map((id) => metadataRegistry.unit(id)?.displayName ?? id).join('/'),
    ...aggregateBattles(rows)
  })).sort((a, b) => b.samples - a.samples);
}

function aggregateMetricMaps(rows) {
  const keys = new Set(rows.flatMap((row) => Object.keys(row ?? {})));
  return Object.fromEntries([...keys].map((key) => [key, mean(rows.map((row) => row?.[key] ?? 0))]));
}

function countValues(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function medianOrNull(values) { return values.length ? median(values) : null; }
function meanOrNull(values) { return values.length ? mean(values) : null; }

function representativeSeeds(battles) {
  const byRounds = [...battles].sort((a, b) => a.rounds - b.rounds);
  const candidates = [
    ['典型短局', byRounds.find((battle) => battle.victory)],
    ['最长胜利', [...battles].filter((battle) => battle.victory).sort((a, b) => b.rounds - a.rounds)[0]],
    ['最长失败', [...battles].filter((battle) => !battle.victory).sort((a, b) => b.rounds - a.rounds)[0]],
    ['最早真实变化点', [...battles].filter((battle) => battle.changePoints.compositeStartRound).sort((a, b) => a.changePoints.compositeStartRound - b.changePoints.compositeStartRound)[0]],
    ['机制重叠', battles.find((battle) => battle.overlap.some((row) => row.overlapping))]
  ];
  return candidates.flatMap(([type, battle]) => battle ? [{ type, seed: battle.seed, groupId: battle.groupId, team: battle.team, rounds: battle.rounds, result: battle.result, actualLoopStartRound: battle.changePoints.compositeStartRound, longTailType: battle.longTail.primaryType }] : []);
}
