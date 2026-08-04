import { readFile } from 'node:fs/promises';
import { contentHash, mean, median } from './utils.mjs';

export async function loadExperimentRegistry(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  const issues = validateRegistry(config);
  return {
    ...config,
    hash: contentHash(config),
    issues,
    get(id) {
      const experiment = config.experiments?.[id];
      if (!experiment) throw new Error(`Experiment not registered: ${id}`);
      return experiment;
    },
    compareDefinitions(controlId, variantId, runtime = {}) {
      return validateComparability(config.experiments?.[controlId], config.experiments?.[variantId], runtime);
    }
  };
}

export function validateComparability(control, variant, runtime = {}) {
  if (!control || !variant) return { status: 'not_applicable', issues: [], rows: [] };
  const required = variant.comparability?.requiredSame ?? control.comparability?.requiredSame ?? [];
  const rows = required.map((field) => ({ field, control: runtime.control?.[field] ?? control[field], variant: runtime.variant?.[field] ?? variant[field] }));
  if (runtime.control?.sampleCount !== undefined || runtime.variant?.sampleCount !== undefined) {
    rows.push({ field: 'sampleCount', control: runtime.control?.sampleCount, variant: runtime.variant?.sampleCount });
  }
  const issues = rows.filter((row) => row.control !== row.variant).map((row) => `${row.field}:${row.control}!=${row.variant}`);
  const controlPairing = control.pairing?.seedPlanId;
  const variantPairing = variant.pairing?.seedPlanId;
  if (controlPairing !== variantPairing) issues.push(`pairing.seedPlanId:${controlPairing}!=${variantPairing}`);
  return { status: issues.length ? 'failed' : 'passed', issues, rows, controlId: control.experimentId, variantId: variant.experimentId };
}

export function pairedExperimentComparison({ controlBattles, variantBattles, comparability, longTailRound = 21 }) {
  if (comparability.status !== 'passed') return { status: 'blocked', reason: 'comparability_failed', comparability };
  const controlBySeed = new Map(controlBattles.map((battle) => [battle.seed, battle]));
  const pairs = variantBattles.flatMap((variant) => {
    const control = controlBySeed.get(variant.seed);
    return control ? [{ control, variant }] : [];
  });
  if (!pairs.length) return { status: 'blocked', reason: 'no_same_seed_pairs', comparability };
  const rosterMismatches = pairs.filter(({ control, variant }) => [...control.team].sort().join('/') !== [...variant.team].sort().join('/'));
  if (rosterMismatches.length) return { status: 'blocked', reason: 'paired_roster_mismatch', mismatchSeeds: rosterMismatches.map(({ control }) => control.seed), comparability };
  const winFlips = pairs.filter(({ control, variant }) => control.victory !== variant.victory);
  const roundDeltas = pairs.map(({ control, variant }) => variant.rounds - control.rounds);
  const longTailTransitions = countTransitions(pairs, longTailRound);
  const mechanismIds = new Set(pairs.flatMap(({ control, variant }) => [...control.mechanicWindows, ...variant.mechanicWindows].map((window) => window.mechanicId)));
  return {
    status: 'passed',
    pairs: pairs.length,
    winRate: {
      control: mean(pairs.map(({ control }) => control.victory ? 1 : 0)),
      variant: mean(pairs.map(({ variant }) => variant.victory ? 1 : 0))
    },
    winRateDelta: {
      absolute: mean(pairs.map(({ variant }) => variant.victory ? 1 : 0)) - mean(pairs.map(({ control }) => control.victory ? 1 : 0)),
      relative: relativeDelta(mean(pairs.map(({ control }) => control.victory ? 1 : 0)), mean(pairs.map(({ variant }) => variant.victory ? 1 : 0)))
    },
    winFlipRate: winFlips.length / pairs.length,
    roundDelta: { mean: mean(roundDeltas), median: median(roundDeltas), relative: relativeDelta(mean(pairs.map(({ control }) => control.rounds)), mean(pairs.map(({ variant }) => variant.rounds))), improved: roundDeltas.filter((value) => value < 0).length / pairs.length, worsened: roundDeltas.filter((value) => value > 0).length / pairs.length },
    longTailTransitions,
    rosterHeterogeneity: rosterEffects(pairs),
    mechanismChanges: [...mechanismIds].map((mechanicId) => mechanismComparison(pairs, mechanicId)),
    comparability
  };
}

function relativeDelta(control, variant) {
  return control === 0 ? null : (variant - control) / Math.abs(control);
}

function validateRegistry(config) {
  const issues = [];
  if (config.schemaVersion !== '2.0.0') issues.push('experiment:schema-version');
  if (!config.registryVersion) issues.push('experiment:missing-version');
  for (const [id, experiment] of Object.entries(config.experiments ?? {})) {
    if (experiment.experimentId !== id) issues.push(`experiment:${id}:id-mismatch`);
    for (const field of ['rulesetId', 'teamPoolId', 'aiPolicyId', 'seedPlanId', 'initialStateId']) if (!experiment[field]) issues.push(`experiment:${id}:missing-${field}`);
  }
  return issues;
}

function countTransitions(pairs, threshold) {
  const result = { stayedShort: 0, enteredLongTail: 0, exitedLongTail: 0, stayedLong: 0 };
  for (const { control, variant } of pairs) {
    const left = control.rounds >= threshold;
    const right = variant.rounds >= threshold;
    if (!left && !right) result.stayedShort += 1;
    else if (!left && right) result.enteredLongTail += 1;
    else if (left && !right) result.exitedLongTail += 1;
    else result.stayedLong += 1;
  }
  return result;
}

function rosterEffects(pairs) {
  const groups = new Map();
  for (const pair of pairs) {
    const team = [...pair.control.team].sort().join('/');
    if (!groups.has(team)) groups.set(team, []);
    groups.get(team).push(pair);
  }
  return [...groups.entries()].map(([team, rows]) => ({
    team,
    samples: rows.length,
    winRateDelta: mean(rows.map(({ variant }) => variant.victory ? 1 : 0)) - mean(rows.map(({ control }) => control.victory ? 1 : 0)),
    averageRoundDelta: mean(rows.map(({ control, variant }) => variant.rounds - control.rounds))
  })).sort((a, b) => b.samples - a.samples);
}

function mechanismComparison(pairs, mechanicId) {
  const summarize = (side) => {
    const windows = pairs.flatMap((pair) => pair[side].mechanicWindows.filter((window) => window.mechanicId === mechanicId));
    return {
      triggers: windows.length,
      effectiveResponseRate: windows.length ? windows.filter((window) => window.responseClassification === 'effective').length / windows.length : 0
    };
  };
  const control = summarize('control');
  const variant = summarize('variant');
  return { mechanicId, control, variant, triggerDelta: variant.triggers - control.triggers, responseRateDelta: variant.effectiveResponseRate - control.effectiveResponseRate };
}
