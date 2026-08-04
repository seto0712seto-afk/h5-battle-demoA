import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeMechanicWindows } from '../scripts/boss-report-v2/attribution-engine.mjs';
import { detectChangePoints } from '../scripts/boss-report-v2/change-point.mjs';
import { validateComparability, pairedExperimentComparison } from '../scripts/boss-report-v2/experiment-registry.mjs';
import { createMetricRegistry } from '../scripts/boss-report-v2/metric-registry.mjs';
import { validateMechanicDsl } from '../scripts/boss-report-v2/mechanic-dsl.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = async (name) => JSON.parse(await readFile(path.join(root, name), 'utf8'));

test('V2 metadata, metric and mechanic registries are internally complete', async () => {
  const metricConfig = await readJson('config/metrics-v2.json');
  const mechanics = await readJson('config/boss-mechanics-v2.json');
  const registry = createMetricRegistry(metricConfig);
  assert.deepEqual(registry.issues, []);
  assert.deepEqual(validateMechanicDsl(mechanics, registry), []);
  assert.deepEqual(Object.keys(mechanics.bosses).sort(), ['FORGE_BOSS_WARRIOR', 'MAGE_BOSS', 'RANGE_BOSS_SHOOTER']);
  assert.equal(mechanics.bosses.FORGE_BOSS_WARRIOR.mechanics.some((item) => item.mechanicId === 'hunter_wound'), false);
  assert.equal(mechanics.bosses.RANGE_BOSS_SHOOTER.mechanics.some((item) => item.mechanicId === 'hunter_wound'), true);
});

test('V2 report core contains no Boss-id or Chinese Boss-name branching', async () => {
  const directory = path.join(root, 'scripts/boss-report-v2');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.mjs'));
  const source = (await Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8')))).join('\n');
  assert.doesNotMatch(source, /if\s*\([^)]*(FORGE_BOSS_WARRIOR|RANGE_BOSS_SHOOTER|MAGE_BOSS|熔核守卫|灰羽猎王|炽印法主)/);
});

test('MetricRegistry applies weighted post-impact attribution', () => {
  const registry = createMetricRegistry({ schemaVersion: '2.0.0', registryVersion: 'test', metrics: [{
    metricId: 'damage', displayName: '伤害', unit: 'hp', aggregation: ['sum'], sourceEvents: ['damage'],
    valueField: 'effectiveValue', scope: ['window'], missing: 'zero', allowWindowOverlap: false, format: 'number_2', evidenceUse: ['mechanic']
  }] });
  const events = [{ eventId: 'a', eventType: 'damage', effectiveValue: 100 }, { eventId: 'b', eventType: 'damage', effectiveValue: 50 }];
  assert.equal(registry.evaluate('damage', events, { eventWeights: new Map([['a', 0.5], ['b', 1]]) }), 100);
});

test('overlap attribution keeps direct outcomes exclusive and post impact weighted', () => {
  const registry = createMetricRegistry({ schemaVersion: '2.0.0', registryVersion: 'test', metrics: [{
    metricId: 'damage', displayName: '伤害', unit: 'hp', aggregation: ['sum'], sourceEvents: ['damage'],
    valueField: 'effectiveValue', scope: ['window'], missing: 'zero', allowWindowOverlap: false, format: 'number_2', evidenceUse: ['mechanic']
  }] });
  const events = [
    event(1, 1, 'battle_start'), event(2, 1, 'telegraph_start', { skillId: 'start' }),
    event(3, 1, 'action_start', { sourceId: 'P01', rootActionId: 'a1', metadata: { sourceSide: 'player', mana: 3, playerSlots: [{ hp: 10 }], reserveIds: [] } }),
    event(4, 1, 'skill_confirm', { sourceId: 'P01', rootActionId: 'a1', skillId: 'attack', metadata: { sourceSide: 'player', skill: { actionCategories: ['attack'] } } }),
    event(5, 2, 'skill_resolve', { skillId: 'resolve' }), event(6, 3, 'damage', { effectiveValue: 100, metadata: { sourceSide: 'enemy', targetSide: 'player' } }),
    event(7, 4, 'battle_end')
  ];
  const mechanic = (id, priority) => ({ mechanicId: id, displayName: id, mechanicType: 'telegraph_attack', priority,
    trigger: { eventType: 'telegraph_start', skillIds: ['start'] }, resolve: { eventType: 'skill_resolve', skillIds: ['resolve'] },
    window: { start: 'trigger_event', end: 'resolve_event' }, baseline: { matching: [] }, validResponses: [{ responseId: 'attack', requiredTags: ['generic_attack'] }],
    invalidResponses: [], incidentalActions: [], outcomeMetrics: ['damage'], postImpact: { rounds: 2, metrics: ['damage'] } });
  const result = analyzeMechanicWindows({ battle: { battleId: 'b', events }, bossMechanicConfig: {
    mechanics: [mechanic('high', 10), mechanic('low', 1)], attribution: { directOutcomeMode: 'exclusive', responseMode: 'multi_label', postImpactMode: 'weighted', overlapConfidenceThreshold: 0.2 }
  }, metricRegistry: registry });
  const post = result.attributions.filter((item) => item.attributionScope === 'post_impact' && item.eventId === 'e6');
  assert.equal(post.length, 1);
  assert.deepEqual(post[0].weights, { high: 0.5, low: 0.5 });
  assert.equal(result.windows.find((window) => window.mechanicId === 'high').postImpact.damage, 50);
  assert.equal(result.windows.find((window) => window.mechanicId === 'low').postImpact.damage, 50);
});

test('change point uses configured baseline and requires persistent abnormal windows', () => {
  const series = Array.from({ length: 14 }, (_, index) => ({ round: index + 1, values: { output: index < 4 ? 100 : index < 7 ? 90 : 30 }, events: [] }));
  const result = detectChangePoints(series, { baselineRounds: 4, slidingWindows: [3], longTailRound: 12, changePoints: [{
    id: 'collapse', displayName: '崩塌', metric: 'output', condition: { relativeToBaseline: { operator: '<=', value: 0.5 } }, persistenceWindows: 2
  }] });
  assert.equal(result.baselineRounds, 4);
  assert.ok(result.signals[0].firstChangeRound > 4);
});

test('A/B comparison blocks mismatched definitions and pairs same seeds only', () => {
  const base = { experimentId: 'A', rulesetId: 'r', teamPoolId: 't', aiPolicyId: 'ai', seedPlanId: 's', initialStateId: 'i', comparability: { requiredSame: ['rulesetId', 'teamPoolId', 'aiPolicyId', 'seedPlanId', 'initialStateId'] }, pairing: { seedPlanId: 's' } };
  const mismatch = validateComparability(base, { ...base, experimentId: 'B', aiPolicyId: 'other' });
  assert.equal(mismatch.status, 'failed');
  assert.equal(pairedExperimentComparison({ controlBattles: [], variantBattles: [], comparability: mismatch }).status, 'blocked');
  const comparability = validateComparability(base, { ...base, experimentId: 'B' });
  const battle = (seed, victory, rounds) => ({ seed, victory, rounds, team: ['P01'], mechanicWindows: [] });
  const compared = pairedExperimentComparison({ controlBattles: [battle(1, false, 20)], variantBattles: [battle(1, true, 15)], comparability });
  assert.equal(compared.status, 'passed');
  assert.equal(compared.winFlipRate, 1);
  assert.equal(compared.roundDelta.mean, -5);
  assert.equal(compared.winRateDelta.absolute, 1);
  const rosterBlocked = pairedExperimentComparison({ controlBattles: [battle(1, false, 20)], variantBattles: [{ ...battle(1, true, 15), team: ['P02'] }], comparability });
  assert.equal(rosterBlocked.reason, 'paired_roster_mismatch');
});

function event(index, round, eventType, values = {}) {
  return { schemaVersion: '2.0.0', eventId: `e${index}`, battleId: 'b', seed: 1, rulesetId: 'r', experimentId: 'x', groupId: 'g', round, actionIndex: index, eventIndex: index, eventType, tags: [eventType], metadata: {}, ...values };
}
