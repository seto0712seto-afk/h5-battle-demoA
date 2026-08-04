import assert from 'node:assert/strict';
import test from 'node:test';
import { buildForgeAnalysis, renderForgeSummary } from '../scripts/boss-report/forge-summary.mjs';

const thresholds = {
  decisionShiftPercentagePoints: 0.1,
  manaSpendShift: 0.5,
  damageIncreaseRatio: 0.15,
  lowExposedDamageShare: 0.2,
  activeResponsePassRate: 0.3,
  activeResponseRiskRate: 0.15,
  ignoreWinRatePenalty: 0.1,
  ignoreRemainingHpPenalty: 0.15,
  ignoreKillRateIncrease: 0.1,
  ignoreForcedReplacementIncrease: 0.5,
  minimumGroupWindows: 1,
  nonStrategicMissRiskRate: 0.01,
  nonStrategicMissFailRate: 0.05,
  longBattlePassRate: 0.05,
  longBattleRiskRate: 0.15
};

test('row switching is recorded but does not count as an effective lock response', () => {
  const analysis = analysisFor([trace({ rowSwitch: true })]);
  assert.equal(analysis.responses.rowSwitchAttempt, 1);
  assert.equal(analysis.responses.active, 0);
  assert.equal(analysis.responses.ignored, 1);
  assert.equal(analysis.heat.outcomeCounts['row-switch-continued-hit'], 1);
});

test('switching the locked line counts as a response and records the replacement hit', () => {
  const analysis = analysisFor([trace({ swap: true })]);
  assert.equal(analysis.responses.swap, 1);
  assert.equal(analysis.responses.active, 1);
  assert.equal(analysis.heat.outcomeCounts['replacement-hit'], 1);
});

test('forge report keeps facts, thresholds and automatic judgments in one document', () => {
  const analysis = analysisFor([trace({ shield: true }), trace({ rowSwitch: true, seed: 2 })]);
  const report = renderForgeSummary(analysis, { date: '2026-07-30', seed: 1, thresholds, totalRuns: 2 });
  assert.match(report, /技能生态与破绽窗口/);
  assert.match(report, /切换前后排（不能规避）/);
  assert.match(report, /阈值定义/);
  assert.match(report, /自动结论/);
});

function analysisFor(traces) {
  const groupIds = ['RANDOM', 'TEAM-BALANCED', 'TEAM-OFFENSE', 'TEAM-DEFENSE', 'TEAM-LOW-MANA'];
  return buildForgeAnalysis(groupIds.map((id) => ({
    id,
    label: id,
    runs: traces.length,
    roster: id === 'RANDOM' ? 'random' : 'fixed',
    traces
  })), thresholds);
}

function trace({ rowSwitch = false, swap = false, shield = false, seed = 1 }) {
  const events = [
    event(1, 'skill_confirmed', { round: 1, actorId: 'P01', skillId: 'M01-S1', actualCost: 0, bossExposed: false, skill: skill('energy') }),
    event(2, 'boss_skill', { round: 1, skillId: 'FORGE_BOSS_MOUNTAIN_CHARGE', telegraph: true, targetIds: ['P01'], lockedSlotIndex: 0 }),
    event(3, 'action_start', { round: 2, side: 'player', actorId: 'P01' }),
    event(4, 'skill_confirmed', { round: 2, actorId: 'P01', skillId: 'M01-S2', actualCost: 3, bossExposed: true, skill: skill('attack', true) }),
    event(5, 'damage', { round: 2, sourceSide: 'player', targetExposed: true, actual: 120 })
  ];
  let sequence = 6;
  if (rowSwitch) events.push(event(sequence++, 'row_switch', { round: 2, slotIndex: 0 }));
  if (swap) events.push(event(sequence++, 'switch', { round: 2, forced: false, slotIndex: 0, incomingId: 'P02' }));
  if (shield) events.push(event(sequence++, 'shield', { round: 2, targetSlotIndex: 0, granted: 50 }));
  events.push(event(sequence++, 'damage', {
    round: 2,
    sourceSide: 'enemy',
    skillId: 'FORGE_BOSS_MOUNTAIN_CLEAVE',
    targetId: swap ? 'P02' : 'P01',
    attempted: 200,
    absorbed: shield ? 50 : 0,
    actual: shield ? 150 : 200,
    targetHpAfter: 50,
    targetMaxHp: 250
  }));
  events.push(event(sequence++, 'boss_skill', {
    round: 2,
    skillId: 'FORGE_BOSS_MOUNTAIN_CLEAVE',
    telegraph: false,
    targetIds: [swap ? 'P02' : 'P01'],
    lockedSlotIndex: 0
  }));
  events.push(event(sequence, 'battle_end', { round: 8, result: 'victory' }));
  return {
    seed,
    team: ['P01', 'P02', 'P03', 'P04', 'P05', 'P06'],
    result: 'victory',
    rounds: 8,
    finalHpRatio: 0.6,
    survivingSpirits: 5,
    forcedReplacements: 0,
    tacticalSwaps: swap ? 1 : 0,
    errors: [],
    events
  };
}

function event(sequence, type, values) {
  return { sequence, type, ...values };
}

function skill(primaryBehavior, burst = false) {
  return { kind: primaryBehavior === 'attack' ? 'attack' : 'support', primaryBehavior, burst };
}
