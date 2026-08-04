import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { analyzeGenericBoss, validateBossMechanicConfig } from '../scripts/boss-report/generic-engine.mjs';
import { renderGenericBossReport } from '../scripts/boss-report/generic-renderer.mjs';
import { normalizeTraceEvents, validateUnifiedEvents } from '../scripts/boss-report/unified-events.mjs';

const defaults = {
  longTailRound: 21,
  highCostThreshold: 3,
  postImpactRounds: 3,
  healthyWinRateMin: 0.7,
  healthyWinRateMax: 0.9,
  healthyMedianRoundMin: 9,
  healthyMedianRoundMax: 14,
  longTailRateRisk: 0.05,
  decisionShift: 0.1,
  aiInfluenceThreshold: 0.05,
  minimumCohortSamples: 1
};

const bossConfig = {
  bossId: 'CONFIG_ONLY_BOSS',
  bossName: '配置测试首领',
  existingAbResults: [],
  mechanics: [{
    mechanicId: 'warning_hit',
    displayName: '预警打击',
    type: 'telegraph_attack',
    startEvent: { eventType: 'telegraph_start', skillIds: ['BOSS-WARN'] },
    resolveEvent: { eventType: 'skill_resolve', skillIds: ['BOSS-HIT'] },
    endEvent: { eventType: 'skill_resolve', skillIds: ['BOSS-HIT'] },
    targetScope: 'locked_target',
    responseTags: ['heal_target', 'shield_target', 'burst_kill'],
    outcomeMetrics: ['life_damage', 'shield_absorb', 'kill'],
    postImpactRounds: 3
  }]
};

test('legacy telemetry is normalized to the complete unified event shape', () => {
  const events = normalizeTraceEvents(trace(1).events ? trace(1) : {});
  assert.equal(validateUnifiedEvents(events).length, 0);
  assert.ok(events.some((event) => event.eventType === 'target_lock'));
  assert.ok(events.some((event) => event.eventType === 'mechanic_window_start') === false);
  for (const event of events) {
    for (const key of ['battleId', 'seed', 'round', 'actionIndex', 'eventType', 'sourceId', 'targetId', 'targetPosition', 'skillId', 'mechanicId', 'value', 'resourceCost', 'statusId', 'phaseId', 'timestampOrder', 'metadata']) assert.ok(key in event);
  }
});

test('generic engine analyzes a config-only boss without report code branches', () => {
  assert.deepEqual(validateBossMechanicConfig(bossConfig), []);
  const mainGroups = [group('RANDOM', trace(1)), group('TEAM-BALANCED', trace(2), 'fixed')];
  const aiGroups = [
    { ...group('AI-FULL', trace(3)), pairKey: 'random', policyRole: 'full' },
    { ...group('AI-NEUTRAL', trace(3)), pairKey: 'random', policyRole: 'neutral' }
  ];
  const tendencyGroups = [
    { ...group('TENDENCY-BALANCED', trace(4)), label: '均衡型玩家', playerTendency: 'balanced' },
    { ...group('TENDENCY-OFFENSE', trace(4)), label: '进攻型玩家', playerTendency: 'offense' },
    { ...group('TENDENCY-DEFENSE', trace(4)), label: '防守型玩家', playerTendency: 'defense' }
  ];
  const data = analyzeGenericBoss({ bossConfig, defaults, mainGroups, aiGroups, tendencyGroups });
  assert.equal(data.audit.passed, true);
  assert.equal(data.mechanics[0].triggerCount, 2);
  assert.equal(data.mechanics[0].resolvedCount, 2);
  assert.ok(data.allBattles[0].events.some((event) => event.eventType === 'mechanic_window_start' && event.mechanicId === 'warning_hit'));
  const report = renderGenericBossReport(data, { date: '2026-07-30' });
  for (const section of ['一页结论', '数据质量审计', '机制列表', '行为变化', '处理与忽略', '机制后续影响', '玩家技能生态', '长尾诊断', '玩家倾向对照', 'AI策略偏差', '问题归因矩阵', '自动结论', '代表Seed']) assert.match(report, new RegExp(section));
  for (const tendency of ['均衡型玩家', '进攻型玩家', '防守型玩家']) assert.match(report, new RegExp(tendency));
  assert.match(report, /配置测试首领/);
});

test('generic report modules do not hardcode current boss names or skill ids', async () => {
  const source = (await Promise.all([
    readFile(new URL('../scripts/boss-report/generic-engine.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/boss-report/generic-renderer.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/boss-report/unified-events.mjs', import.meta.url), 'utf8')
  ])).join('\n');
  for (const forbidden of ['FORGE_BOSS_', 'RANGE_BOSS_', 'MAGE_BOSS', '熔核守卫', '灰羽猎王', '炽印法主']) assert.equal(source.includes(forbidden), false);
});

test('all configured bosses use the same valid mechanism schema', async () => {
  const root = JSON.parse(await readFile(new URL('../config/boss-mechanics.json', import.meta.url), 'utf8'));
  assert.equal(root.schemaVersion, 1);
  assert.equal(Object.keys(root.bosses).length, 3);
  for (const config of Object.values(root.bosses)) assert.deepEqual(validateBossMechanicConfig(config), []);
});

test('an immediate mechanic can include damage emitted before its skill-resolve event', () => {
  const immediateBoss = {
    bossId: 'IMMEDIATE_BOSS',
    bossName: '即时机制测试首领',
    mechanics: [{
      mechanicId: 'immediate_pressure',
      displayName: '即时压迫',
      type: 'position_pressure',
      startEvent: { eventType: 'skill_resolve', skillIds: ['BOSS-INSTANT'] },
      resolveEvent: { eventType: 'skill_resolve', skillIds: ['BOSS-INSTANT'] },
      endEvent: { eventType: 'action_start', sourceSide: 'enemy' },
      includeTriggerAction: true,
      targetScope: 'affected_targets',
      responseTags: ['attack'],
      outcomeMetrics: ['life_damage']
    }]
  };
  const sample = trace(9);
  sample.events = [
    sample.events[0],
    { sequence: 2, type: 'action_start', round: 1, side: 'enemy', unitId: 'B1' },
    { sequence: 3, type: 'damage', round: 1, sourceSide: 'enemy', sourceId: 'B1', skillId: 'BOSS-INSTANT', targetSide: 'player', targetId: 'P01', actual: 75 },
    { sequence: 4, type: 'boss_skill', round: 1, enemyId: 'B1', skillId: 'BOSS-INSTANT', source: 'weighted', telegraph: false, targetIds: ['P01'] },
    { sequence: 5, type: 'action_start', round: 2, side: 'enemy', unitId: 'B1' },
    sample.events.at(-1)
  ];
  const data = analyzeGenericBoss({ bossConfig: immediateBoss, defaults, mainGroups: [group('RANDOM', sample)] });
  assert.equal(data.mechanics[0].triggerCount, 1);
  assert.equal(data.mechanics[0].windows[0].outcome.life_damage, 75);
});

function group(id, oneTrace, roster = 'random') {
  return { id, label: id, roster, policy: 'balanced-v3', traces: [oneTrace] };
}

function trace(seed) {
  const slots = [{ slotIndex: 0, unitId: 'P01', row: 'front', hp: 200, maxHp: 200, shield: 0 }];
  return {
    seed,
    team: ['P01', 'P02'],
    result: 'victory',
    rounds: 10,
    finalHpRatio: 0.5,
    bossRemainingHpRatio: 0,
    survivingSpirits: 1,
    forcedReplacements: 0,
    tacticalSwaps: 0,
    rowSwitches: 0,
    finalMana: 4,
    errors: [],
    perRound: Array.from({ length: 10 }, (_, index) => ({ round: index + 1, damageToBoss: index === 1 ? 100 : 0, damageToPlayers: index === 1 ? 80 : 0, effectiveHealing: 0, effectiveShield: 20 })),
    events: [
      { sequence: 1, type: 'battle_start', seed, selectedSpiritIds: ['P01', 'P02'], activeSpiritIds: ['P01'], enemyIds: ['B1'], enemyDefinitionIds: ['CONFIG_ONLY_BOSS'], mana: 3, maxMana: 10, playerSlots: slots, reserveIds: ['P02'] },
      { sequence: 2, type: 'boss_skill', round: 1, enemyId: 'B1', enemyDefinitionId: 'CONFIG_ONLY_BOSS', skillId: 'BOSS-WARN', source: 'weighted', telegraph: true, targetIds: ['P01'], lockedTargetId: 'P01', lockedSlotIndex: 0, playerSlots: slots, reserveIds: ['P02'] },
      { sequence: 3, type: 'action_start', round: 2, side: 'player', unitId: 'P01', mana: 4, playerSlots: slots, reserveIds: ['P02'] },
      { sequence: 4, type: 'skill_confirmed', round: 2, actorId: 'P01', skillId: 'P-SHIELD', targetId: 'P01', actualCost: 2, manaBefore: 4, skill: { name: '护盾', kind: 'support', primaryBehavior: 'protect' } },
      { sequence: 5, type: 'shield', round: 2, actorId: 'P01', skillId: 'P-SHIELD', targetId: 'P01', granted: 20, targetSlotIndex: 0 },
      { sequence: 6, type: 'damage', round: 2, sourceSide: 'enemy', sourceId: 'B1', skillId: 'BOSS-HIT', targetSide: 'player', targetId: 'P01', attempted: 100, actual: 80, absorbed: 20, targetSlotIndex: 0 },
      { sequence: 7, type: 'boss_skill', round: 2, enemyId: 'B1', enemyDefinitionId: 'CONFIG_ONLY_BOSS', skillId: 'BOSS-HIT', source: 'forced_followup', telegraph: false, targetIds: ['P01'], playerSlots: slots, reserveIds: ['P02'] },
      { sequence: 8, type: 'battle_end', round: 10, result: 'victory', mana: 4, livingSpiritIds: ['P01'], livingEnemyIds: [] }
    ]
  };
}
