import assert from 'node:assert/strict';
import test from 'node:test';
import { buildForgeV2, renderForgeV2 } from '../scripts/boss-report/forge-v2.mjs';

const thresholds = {
  healthyWinRateMin: 0.7,
  healthyWinRateMax: 0.9,
  healthyMedianRoundMin: 9,
  healthyMedianRoundMax: 14,
  longBattlePassRate: 0.05,
  decisionShiftPercentagePoints: 0.1,
  manaSpendShift: 0.5,
  netResponsePassRate: 0.1,
  netResponseRiskRate: 0.05
};

test('v2 report closes high-heat damage and attributes delayed replacement', () => {
  const data = build(false);
  assert.equal(data.audit.unclosedDamage, 0);
  assert.equal(data.audit.unattributedKill, 0);
  assert.equal(data.randomMechanics.heatLifecycle.highHeatKilledTarget, 1);
  assert.equal(data.randomMechanics.heatLifecycle.replacementCompletedByHighHeat, 1);
  assert.equal(data.randomMechanics.heatLifecycle.replacementOccurredLater, 1);
  assert.equal(data.randomMechanics.counterWindows.length, 1);
  assert.equal(data.randomMechanics.validCounterWindows.length, 1);
  assert.equal(data.randomMechanics.phaseExposed.actions, 1);
});

test('v2 audit rejects an unclosed high-heat event', () => {
  const data = build(true);
  assert.equal(data.audit.unclosedDamage, 9);
  assert.equal(data.audit.passed, false);
});

test('v2 final report contains the required single-document sections', () => {
  const report = renderForgeV2(build(false), { date: '2026-07-30', seed: 1, aiSeed: 2, thresholds });
  for (const heading of ['一页结论', '数据质量审计', '机制流程漏斗', '高防队专项', 'AI策略偏差检查', '最终12问', '修改建议']) {
    assert.match(report, new RegExp(heading));
  }
});

function build(unclosed) {
  const mainIds = ['RANDOM', 'TEAM-BALANCED', 'TEAM-OFFENSE', 'TEAM-DEFENSE', 'TEAM-LOW-MANA'];
  const aiIds = ['AI-RANDOM-FULL', 'AI-RANDOM-NEUTRAL', 'AI-DEFENSE-FULL', 'AI-DEFENSE-NEUTRAL'];
  const groups = mainIds.map((id, index) => group(id, trace(index + 1, unclosed)));
  const aiGroups = aiIds.map((id, index) => group(id, trace(index + 20, unclosed)));
  return buildForgeV2(groups, aiGroups, thresholds);
}

function group(id, oneTrace) {
  return { id, label: id, runs: 1, roster: id.includes('RANDOM') ? 'random' : 'fixed', traces: [oneTrace] };
}

function trace(seed, unclosed) {
  const slots = [{ slotIndex: 0, unitId: 'P01', row: 'front', hp: 200, maxHp: 200, shield: 0 }];
  const settlement = unclosed ? 201 : 200;
  return {
    seed,
    team: ['P01', 'P02'],
    result: 'victory',
    rounds: 10,
    finalHpRatio: 0.5,
    survivingSpirits: 1,
    forcedReplacements: 1,
    tacticalSwaps: 0,
    errors: [],
    skillUses: { 'M01-S2': 1 },
    maxSkillStreak: 1,
    perRound: Array.from({ length: 10 }, (_, index) => ({ round: index + 1, effectiveHealing: 0, effectiveShield: 0, damageToPlayers: index === 1 ? 200 : 0 })),
    events: [
      { sequence: 1, type: 'boss_skill', round: 1, skillId: 'FORGE_BOSS_MOUNTAIN_CHARGE', telegraph: true, targetIds: ['P01'], lockedSlotIndex: 0, playerSlots: slots, reserveIds: ['P02'] },
      { sequence: 2, type: 'action_start', round: 2, side: 'player', unitId: 'P01', mana: 2, playerSlots: slots, reserveIds: ['P02'] },
      { sequence: 3, type: 'skill_confirmed', round: 2, skillId: 'M01-S2', actualCost: 3, manaBefore: 3, bossExposed: false, skill: { kind: 'attack', primaryBehavior: 'attack' } },
      { sequence: 4, type: 'damage', round: 2, sourceSide: 'player', actual: 100 },
      { sequence: 5, type: 'damage', round: 2, sourceSide: 'enemy', skillId: 'FORGE_BOSS_MOUNTAIN_CLEAVE', targetId: 'P01', attempted: 200, theoreticalDamage: 200, actualSettlementDamage: settlement, absorbed: 0, actual: 200, overkillDamage: 0, targetHpAfter: 0, targetMaxHp: 200 },
      { sequence: 6, type: 'defeated', round: 2, side: 'player', skillId: 'FORGE_BOSS_MOUNTAIN_CLEAVE', unitId: 'P01' },
      { sequence: 7, type: 'replacement', round: 2, status: 'scheduled', slotIndex: 0, sourceSkillId: 'FORGE_BOSS_MOUNTAIN_CLEAVE', reserveIds: ['P02'] },
      { sequence: 8, type: 'boss_skill', round: 2, skillId: 'FORGE_BOSS_MOUNTAIN_CLEAVE', telegraph: false, targetIds: ['P01'] },
      { sequence: 9, type: 'replacement', round: 2, status: 'requested', slotIndex: 0, reserveIds: ['P02'] },
      { sequence: 10, type: 'replacement', round: 3, status: 'completed', slotIndex: 0, incomingId: 'P02', reserveIds: [] },
      { sequence: 11, type: 'action_start', round: 3, side: 'player', unitId: 'P02', mana: 3, playerSlots: slots, reserveIds: [] },
      { sequence: 12, type: 'skill_confirmed', round: 3, skillId: 'M01-S2', actualCost: 3, manaBefore: 3, bossExposed: true, skill: { kind: 'attack', primaryBehavior: 'attack' } },
      { sequence: 13, type: 'damage', round: 3, sourceSide: 'player', actual: 120 },
      { sequence: 14, type: 'battle_end', round: 10, result: 'victory' }
    ]
  };
}
