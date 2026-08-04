import { mad, mean, median, slope, standardDeviation } from './utils.mjs';

export function buildRoundSeries({ battle, metricRegistry, roleLoss }) {
  const rows = [];
  for (let round = 1; round <= battle.rounds; round += 1) {
    const events = battle.events.filter((event) => event.round === round);
    const role = roleLoss.rounds.find((entry) => entry.round === round) ?? roleLoss.rounds.at(-1);
    const externalValues = {
      alive_damage_weight: role?.weights.damage ?? 0,
      alive_healing_weight: role?.weights.healing ?? 0,
      alive_protection_weight: role?.weights.protection ?? 0,
      alive_resource_weight: role?.weights.resource ?? 0
    };
    const playerDamage = metricRegistry.evaluate('player_damage_to_boss', events);
    const values = {
      player_damage_to_boss: playerDamage,
      boss_life_damage: metricRegistry.evaluate('boss_life_damage', events),
      effective_heal: metricRegistry.evaluate('effective_heal', events),
      effective_shield: metricRegistry.evaluate('effective_shield', events),
      resource_spend: metricRegistry.evaluate('resource_spend', events),
      resource_balance: metricRegistry.evaluate('resource_balance', events),
      attack_share: metricRegistry.evaluate('attack_share', events),
      defense_share: metricRegistry.evaluate('defense_share', events),
      resource_action_share: metricRegistry.evaluate('resource_action_share', events),
      ...externalValues,
      boss_hp_loss_rate: playerDamage
    };
    const resourceLevel = lastFinite(events.map((event) => event.resourceAfter ?? event.metadata?.mana));
    rows.push({ round, values, resourceLevel, events: events.map(compactPrecedingEvent) });
  }
  return rows;
}

export function detectChangePoints(series, config) {
  const baselineRows = series.slice(0, Math.min(config.baselineRounds, series.length));
  const baseline = Object.fromEntries(config.changePoints.map((rule) => {
    const values = baselineRows.map((row) => row.values[rule.metric] ?? 0);
    return [rule.metric, { median: median(values), mad: mad(values), mean: mean(values), standardDeviation: standardDeviation(values), slope: slope(values) }];
  }));
  const signals = config.changePoints.map((rule) => detectRule(series, baseline[rule.metric], rule, config.slidingWindows, baselineRows.length)).filter(Boolean);
  const compositeStartRound = firstCompositeRound(signals);
  return {
    baselineRounds: baselineRows.length,
    baseline,
    signals,
    compositeStartRound,
    statisticalLongTailRound: config.longTailRound,
    intervalToStatisticalThreshold: compositeStartRound ? config.longTailRound - compositeStartRound : null
  };
}

function detectRule(series, baseline, rule, windowSizes, baselineRoundCount) {
  const candidates = windowSizes.flatMap((windowSize) => {
    const checks = [];
    for (let end = windowSize - 1; end < series.length; end += 1) {
      const start = end - windowSize + 1;
      if (series[start].round <= baselineRoundCount) continue;
      const values = series.slice(start, end + 1).map((row) => row.values[rule.metric] ?? 0);
      const value = mean(values);
      checks.push({ windowSize, startRound: series[start].round, endRound: series[end].round, value, abnormal: conditionMatches(value, baseline, rule.condition) && value >= (rule.condition.absoluteFloor ?? -Infinity) });
    }
    return persistentRuns(checks, rule.persistenceWindows).map((run) => ({ ...run, windowSize }));
  });
  if (!candidates.length) return null;
  const first = candidates.sort((a, b) => a.startRound - b.startRound || a.windowSize - b.windowSize)[0];
  const baselineValue = baseline.median;
  const magnitude = first.value - baselineValue;
  const precedingRound = Math.max(1, first.startRound - 1);
  const precedingEvents = series.find((row) => row.round === precedingRound)?.events ?? [];
  return {
    signalId: rule.id,
    displayName: rule.displayName,
    metricId: rule.metric,
    firstChangeRound: first.startRound,
    confirmedRound: first.confirmedRound,
    duration: first.endRound - first.startRound + 1,
    recovered: first.recovered,
    recoveryRound: first.recoveryRound,
    baselineValue,
    changedValue: first.value,
    magnitude,
    relativeMagnitude: baselineValue ? magnitude / Math.abs(baselineValue) : null,
    detectionWindow: first.windowSize,
    precedingRound,
    precedingEvents,
    activeStart: first.startRound,
    activeEnd: first.recoveryRound ? first.recoveryRound - 1 : series.at(-1)?.round ?? first.endRound
  };
}

function persistentRuns(checks, required) {
  const runs = [];
  let start = null;
  let count = 0;
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    if (check.abnormal) {
      if (start === null) start = index;
      count += 1;
      if (count === required) {
        const recovery = checks.slice(index + 1).find((candidate) => !candidate.abnormal);
        runs.push({
          startRound: checks[start].startRound,
          confirmedRound: check.endRound,
          endRound: recovery?.startRound ? recovery.startRound - 1 : checks.at(-1).endRound,
          recoveryRound: recovery?.startRound ?? null,
          recovered: Boolean(recovery),
          value: mean(checks.slice(start, index + 1).map((candidate) => candidate.value))
        });
      }
    } else {
      start = null;
      count = 0;
    }
  }
  return runs.slice(0, 1);
}

function conditionMatches(value, baseline, condition) {
  if (condition.relativeToBaseline) {
    if (baseline.median === 0) return false;
    return compare(value / baseline.median, condition.relativeToBaseline.operator, condition.relativeToBaseline.value);
  }
  if (condition.absoluteDelta) return compare(value - baseline.median, condition.absoluteDelta.operator, condition.absoluteDelta.value);
  return false;
}

function compare(left, operator, right) {
  if (operator === '<=') return left <= right;
  if (operator === '>=') return left >= right;
  if (operator === '<') return left < right;
  if (operator === '>') return left > right;
  if (operator === '==') return left === right;
  throw new Error(`Unsupported change-point operator: ${operator}`);
}

function firstCompositeRound(signals) {
  if (signals.length < 2) return null;
  const maxRound = Math.max(...signals.map((signal) => signal.activeEnd));
  for (let round = 1; round <= maxRound; round += 1) {
    if (signals.filter((signal) => round >= signal.activeStart && round <= signal.activeEnd).length >= 2) return round;
  }
  return null;
}

function compactPrecedingEvent(event) {
  return { eventType: event.eventType, sourceId: event.sourceId, targetId: event.targetId, skillId: event.skillId, value: event.effectiveValue ?? event.value ?? 0 };
}

function lastFinite(values) {
  return [...values].reverse().find(Number.isFinite) ?? null;
}
