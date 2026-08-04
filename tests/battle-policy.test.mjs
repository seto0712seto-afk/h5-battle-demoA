import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveHealAmount,
  evaluateHunterWoundSwap,
  scoreShieldFormationFuture,
  scoreWindCutFuture,
  selfAndTargetEffectiveHeal,
  totalScoreForTendency
} from '../scripts/battle-policy.mjs';
import { FIXED_TEAMS, RANGE_TUNINGS } from '../scripts/single-boss-config.mjs';

test('风切未来收益在可存活且可兑现时为正', () => {
  const score = scoreWindCutFuture({
    nextAttackExpectedDamage: 180,
    survivalProbability: 0.8,
    canAffordPayoff: true,
    targetSurvivalProbability: 0.9
  });
  assert.ok(score > 0);
  assert.equal(scoreWindCutFuture({
    nextAttackExpectedDamage: 180,
    survivalProbability: 0,
    canAffordPayoff: true,
    targetSurvivalProbability: 0.9
  }), 0);
});

test('盾阵在多人持盾时的未来收益高于无盾', () => {
  const multi = scoreShieldFormationFuture({
    shieldedCount: 3,
    totalShield: 450,
    expectedIncomingDamage: 300,
    retainedActionWindows: 2,
    battleEndingSoon: false
  });
  const none = scoreShieldFormationFuture({
    shieldedCount: 0,
    totalShield: 0,
    expectedIncomingDamage: 300,
    retainedActionWindows: 2,
    battleEndingSoon: false
  });
  assert.ok(multi > none);
  assert.equal(none, 0);
});

test('有效治疗不会计入溢出部分', () => {
  assert.equal(effectiveHealAmount(90, 100, 30), 10);
  assert.equal(effectiveHealAmount(100, 100, 30), 0);
});

test('鹿鸣回春以自身为目标时只计算一次', () => {
  const self = selfAndTargetEffectiveHeal({
    actorHp: 40,
    actorMaxHp: 100,
    targetHp: 40,
    targetMaxHp: 100,
    percent: 0.4,
    sameTarget: true
  });
  const other = selfAndTargetEffectiveHeal({
    actorHp: 40,
    actorMaxHp: 100,
    targetHp: 20,
    targetMaxHp: 100,
    percent: 0.4,
    sameTarget: false
  });
  assert.equal(self, 40);
  assert.equal(other, 80);
});

test('灰羽Control沿用仓库2200生命且实验配置互相独立', () => {
  assert.equal(RANGE_TUNINGS['RANGE-CONTROL'].hp, 2200);
  assert.equal(RANGE_TUNINGS['RANGE-CONTROL'].skillPowers.RANGE_BOSS_SKYFALL, 100);
  assert.equal(RANGE_TUNINGS['RANGE-B'].skillPowers.RANGE_BOSS_SKYFALL, 120);
  assert.notEqual(RANGE_TUNINGS['RANGE-CONTROL'].skillPowers, RANGE_TUNINGS['RANGE-B'].skillPowers);
});

test('低资源固定队排除三个指定回能单位', () => {
  const lowMana = FIXED_TEAMS['TEAM-LOW-MANA'];
  assert.equal(lowMana.length, 6);
  ['P06', 'P09', 'P10'].forEach((id) => assert.equal(lowMana.includes(id), false));
});

test('三种玩家倾向只改变同一评分项的权重', () => {
  const damage = { immediateDamage: 100 };
  assert.ok(totalScoreForTendency(damage, 'offense') > totalScoreForTendency(damage, 'balanced'));
  assert.ok(totalScoreForTendency(damage, 'balanced') > totalScoreForTendency(damage, 'defense'));

  const protection = { effectiveShield: 100 };
  assert.ok(totalScoreForTendency(protection, 'defense') > totalScoreForTendency(protection, 'balanced'));
  assert.ok(totalScoreForTendency(protection, 'balanced') > totalScoreForTendency(protection, 'offense'));
  assert.throws(() => totalScoreForTendency(damage, 'unknown'), /Unknown player tendency/);
});

test('猎伤应对仅在当前贯射致死且换入者可存活时选择换宠', () => {
  assert.deepEqual(evaluateHunterWoundSwap({
    stacks: 4,
    currentHp: 180,
    currentHpDamage: 220,
    replacementHp: 300,
    replacementHpDamage: 120
  }), {
    shouldSwap: true,
    currentLethal: true,
    replacementSurvives: true,
    preventedHpDamage: 100
  });
  assert.equal(evaluateHunterWoundSwap({
    stacks: 4,
    currentHp: 240,
    currentHpDamage: 220,
    replacementHp: 300,
    replacementHpDamage: 120
  }).shouldSwap, false);
  assert.equal(evaluateHunterWoundSwap({
    stacks: 4,
    currentHp: 180,
    currentHpDamage: 220,
    replacementHp: 100,
    replacementHpDamage: 120
  }).shouldSwap, false);
});
