import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let server;
let BattleGame;
let battleSystemConfig;
let coreRules;
let monsterData;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  ({ BattleGame } = await server.ssrLoadModule('/src/battle.ts'));
  ({ battleSystemConfig } = await server.ssrLoadModule('/src/battleSystems.ts'));
  coreRules = await server.ssrLoadModule('/src/coreBattleRules.ts');
  monsterData = await server.ssrLoadModule('/src/monsterData.ts');
});

after(async () => {
  await server?.close();
});

function gameFor(selectedSpiritIds) {
  const config = battleSystemConfig();
  return new BattleGame({
    config,
    selectedSpiritIds: selectedSpiritIds ?? config.creatureConfig.map((spirit) => spirit.id)
  });
}

function forcePlayerAction(game, actorId) {
  game.state.round.actionSlots.forEach((slot) => {
    slot.status = slot.type === 'spirit' && slot.unitId === actorId ? 'executing' : slot.status;
  });
  game.state.activeUnit = { type: 'spirit', id: actorId };
  game.state.phase = 'player-action';
  game.state.actionContext = 'normal';
  game['beginPlayerAction'](actorId);
}

test('回合开始锁定场上行动位并按速度排序，中途换入不追加行动位', () => {
  const game = gameFor();
  const initialIds = game.state.slots.map((slot) => slot.spiritId);
  assert.deepEqual(
    new Set(game.state.round.actionSlots.filter((slot) => slot.type === 'spirit').map((slot) => slot.unitId)),
    new Set(initialIds)
  );
  const speeds = game.state.round.actionSlots.map((slot) => slot.speed);
  assert.deepEqual(speeds, [...speeds].sort((a, b) => b - a));

  const actorId = initialIds[0];
  const benchId = game.getBenchSpiritIds()[0];
  assert.equal(game.state.mana.current, 0);
  forcePlayerAction(game, actorId);
  const manaAfterActionStart = game.state.mana.current;
  assert.equal(game.swapWithBench(benchId).ok, true);
  assert.equal(manaAfterActionStart, 1);
  assert.equal(game.getSpirit(benchId).action, 0);
  assert.equal(game.state.round.actionSlots.some((slot) => slot.unitId === benchId), false);
});

test('主动换宠后按换入精灵默认站位登场', () => {
  const backToFront = gameFor(['P01', 'P02', 'P03', 'P04']);
  forcePlayerAction(backToFront, 'P01');
  assert.equal(backToFront['findSlotBySpirit']('P01').row, 'back');
  assert.equal(backToFront.swapWithBench('P04').ok, true);
  assert.equal(backToFront['findSlotBySpirit']('P04').row, 'front');

  const frontToBack = gameFor(['P04', 'P01', 'P02', 'P07']);
  forcePlayerAction(frontToBack, 'P04');
  assert.equal(frontToBack['findSlotBySpirit']('P04').row, 'front');
  assert.equal(frontToBack.swapWithBench('P07').ok, true);
  assert.equal(frontToBack['findSlotBySpirit']('P07').row, 'back');
});

test('死亡立即留空，直到回合结束才请求后备补位', () => {
  const game = gameFor();
  const targetId = game.state.slots[0].spiritId;
  game.getSpirit(targetId).hp = 0;
  game['vacateDefeatedSpirit'](targetId);
  assert.equal(game.state.slots[0].spiritId, null);
  assert.equal(game.state.phase, 'running');
  assert.equal(game.state.replacement, null);
  game.state.round.actionSlots.forEach((slot) => {
    if (slot.status === 'pending') slot.status = 'completed';
  });
  game.state.round.cursor = game.state.round.actionSlots.length;
  game['finishRound']();
  assert.equal(game.state.phase, 'forced-replacement');
  assert.equal(game.state.replacement.slotIndex, 0);
});

test('回合末死亡替补按换入精灵默认站位登场', () => {
  const game = gameFor(['P01', 'P02', 'P03', 'P10']);
  const targetId = game.state.slots[0].spiritId;
  assert.equal(game.state.slots[0].row, 'back');
  game.getSpirit(targetId).hp = 0;
  game['vacateDefeatedSpirit'](targetId);
  game.state.round.actionSlots.forEach((slot) => {
    if (slot.status === 'pending') slot.status = 'completed';
  });
  game.state.round.cursor = game.state.round.actionSlots.length;
  game['finishRound']();

  assert.equal(game.state.phase, 'forced-replacement');
  assert.ok(game.getReplacementCandidates().includes('P10'));
  assert.equal(game.resolveForcedReplacement('P10').ok, true);
  assert.equal(game['findSlotBySpirit']('P10').row, 'front');
});

test('场上全灭但后备存活时不失败，回合末逐格补位', () => {
  const game = gameFor();
  const fieldIds = game.state.slots.map((slot) => slot.spiritId);
  fieldIds.forEach((id) => {
    game.getSpirit(id).hp = 0;
    game['vacateDefeatedSpirit'](id);
  });
  assert.equal(game['checkGameOver'](), false);
  game.state.round.actionSlots.forEach((slot) => { slot.status = 'completed'; });
  game.state.round.cursor = game.state.round.actionSlots.length;
  game['finishRound']();
  assert.equal(game.state.phase, 'forced-replacement');
  assert.equal(game.getReplacementCandidates().length, 3);
});

test('普通状态取更高持续时间和数值，可叠状态累加且受上限限制', () => {
  const first = coreRules.mergeRuntimeStatus(undefined, {
    id: 'test', name: '测试', duration: 2, value: 0.3
  });
  const merged = coreRules.mergeRuntimeStatus(first, {
    id: 'test', name: '测试', duration: 4, value: 0.2
  });
  assert.equal(merged.duration, 4);
  assert.equal(merged.value, 0.3);
  assert.equal(merged.stacks, 1);

  const stacked = coreRules.mergeRuntimeStatus(undefined, {
    id: 'stack', name: '层数', duration: 2, stackable: true, maxStacks: 3, stacks: 1
  });
  const capped = coreRules.mergeRuntimeStatus(stacked, {
    id: 'stack', name: '层数', duration: 4, stackable: true, maxStacks: 3, stacks: 2
  });
  assert.equal(capped.stacks, 3);
  assert.equal(capped.duration, 4);
});

test('新状态不在获得它的同次行动结束扣时长', () => {
  const statuses = {
    test: coreRules.mergeRuntimeStatus(undefined, {
      id: 'test', name: '测试', duration: 2, appliedDuringOwnerAction: true
    })
  };
  coreRules.tickOwnerStatuses(statuses);
  assert.equal(statuses.test.duration, 2);
  coreRules.tickOwnerStatuses(statuses);
  assert.equal(statuses.test.duration, 1);
});

test('普通单体目标受前排限制，无前排时才开放后排', () => {
  const game = gameFor();
  game.state.slots[0].row = 'front';
  game.state.slots[1].row = 'back';
  game.state.slots[2].row = 'back';
  assert.deepEqual(coreRules.legalSingleTargetIds(game.state.slots, game.state.spirits), [game.state.slots[0].spiritId]);
  game.state.slots[0].spiritId = null;
  assert.deepEqual(
    coreRules.legalSingleTargetIds(game.state.slots, game.state.spirits),
    [game.state.slots[1].spiritId, game.state.slots[2].spiritId]
  );
});

test('敌方详情统一提供最终属性、属性系数、技能和状态信息', () => {
  const game = gameFor();
  const detail = game.enemyDetailView(game.state.boss.id);
  assert.ok(detail);
  assert.equal(detail.name, game.state.boss.name);
  assert.equal(detail.stats.physicalAttack, game.state.boss.physicalAttack);
  assert.equal(detail.stats.magicDefense, game.state.boss.magicDefense);
  assert.equal(typeof detail.coefficients.physicalAttack, 'number');
  assert.equal(typeof detail.coefficients.speed, 'number');
  assert.ok(detail.skills.length > 0);
  assert.ok(Array.isArray(detail.statuses));
});

test('同一结算链双方全灭时判定 Boss 获胜', () => {
  const game = gameFor(battleSystemConfig().creatureConfig.slice(0, 3).map((spirit) => spirit.id));
  game.state.boss.hp = 0;
  game.state.selectedSpiritIds.forEach((id) => { game.getSpirit(id).hp = 0; });
  assert.equal(game['checkGameOver'](), true);
  assert.equal(game.state.phase, 'defeat');
});

test('多段攻击击杀原目标后，剩余段数落空且不转移', () => {
  const base = battleSystemConfig();
  const actorId = base.creatureConfig[1].id;
  const skillId = base.creatureConfig[1].skillIds[0];
  const config = {
    ...base,
    creatureConfig: base.creatureConfig.slice(0, 3),
    skillConfig: { ...base.skillConfig, [skillId]: { ...base.skillConfig[skillId], hitCount: 3, gain: 0, cost: 1, cooldown: 2 } }
  };
  const game = new BattleGame({ config, selectedSpiritIds: config.creatureConfig.map((spirit) => spirit.id) });
  forcePlayerAction(game, actorId);
  const skill = config.skillConfig[skillId];
  const hitDamage = game['attackDamage'](actorId, skill, skill.power, false, 1);
  game.state.boss.hp = hitDamage * 2;
  game.state.boss.maxHp = hitDamage * 2;
  const manaBefore = game.state.mana.current;
  assert.equal(game.useSkill(skillId).ok, true);
  assert.equal(game.state.boss.hp, 0);
  assert.equal(game.state.mana.current, manaBefore - 1);
  assert.equal(game.getSpirit(actorId).skillCooldowns[skillId], 2);
  assert.equal(game.state.logs.some((line) => line.includes('剩余 1 段落空')), true);
});

test('行动来源在多段技能中途死亡时，后续效果停止', () => {
  const base = battleSystemConfig();
  const actorId = base.creatureConfig[1].id;
  const skillId = base.creatureConfig[1].skillIds[0];
  const config = {
    ...base,
    creatureConfig: base.creatureConfig.slice(0, 3),
    skillConfig: { ...base.skillConfig, [skillId]: { ...base.skillConfig[skillId], hitCount: 3, gain: 0 } }
  };
  const game = new BattleGame({ config, selectedSpiritIds: config.creatureConfig.map((spirit) => spirit.id) });
  forcePlayerAction(game, actorId);
  const originalAttackDamage = game['attackDamage'].bind(game);
  let calls = 0;
  game['attackDamage'] = (...args) => {
    const damage = originalAttackDamage(...args);
    calls += 1;
    if (calls === 1) game.getSpirit(actorId).hp = 0;
    return damage;
  };
  assert.equal(game.useSkill(skillId).ok, true);
  assert.equal(calls, 1);
  assert.equal(game.state.logs.some((line) => line.includes('行动来源已阵亡')), true);
});

test('额外行动不回能、不减冷却、不扣状态且不能连续触发', () => {
  const base = battleSystemConfig();
  const actorId = base.creatureConfig[1].id;
  const [skillId, extraSkillId] = base.creatureConfig[1].skillIds;
  const config = {
    ...base,
    creatureConfig: base.creatureConfig.slice(0, 3),
    skillConfig: {
      ...base.skillConfig,
      [skillId]: { ...base.skillConfig[skillId], grantsExtraAction: true, cooldown: 2 },
      [extraSkillId]: {
        ...base.skillConfig[extraSkillId],
        costAllMana: false,
        cost: 0,
        gain: 2,
        grantsExtraAction: true,
        cooldown: 2
      }
    }
  };
  const energyEvents = [];
  const game = new BattleGame({
    config,
    selectedSpiritIds: config.creatureConfig.map((spirit) => spirit.id),
    telemetry: { onEnergyChanged: (event) => energyEvents.push(event) }
  });
  forcePlayerAction(game, actorId);
  const manaAfterNormalStart = game.state.mana.current;
  assert.equal(game.useSkill(skillId).ok, true);
  assert.equal(game.state.actionContext, 'extra');
  assert.equal(game.getSpirit(actorId).skillCooldowns[skillId], 2);
  const manaBeforeExtra = game.state.mana.current;
  assert.equal(game.useSkill(extraSkillId).ok, true);
  assert.equal(game.state.actionContext, 'normal');
  assert.equal(game.state.phase, 'running');
  assert.equal(game.state.mana.current, manaBeforeExtra);
  const suppressedGain = energyEvents.findLast((event) => event.skillId === extraSkillId && event.attemptedGain === 2);
  assert.equal(suppressedGain.gained, 0);
  assert.equal(game.getSpirit(actorId).skillCooldowns[skillId], 2);
  assert.equal(game.getSpirit(actorId).skillCooldowns[extraSkillId], 2);
  assert.equal(manaAfterNormalStart >= 0, true);
});

test('20260811 十精灵冻结属性与三技能配置一致', () => {
  const config = battleSystemConfig();
  const expected = {
    P01: [262, 133, 80, 84, 88, 130],
    P02: [274, 124, 78, 92, 89, 126],
    P03: [268, 79, 124, 98, 90, 120],
    P04: [383, 83, 74, 128, 107, 83],
    P05: [371, 81, 71, 128, 118, 82],
    P06: [385, 87, 73, 125, 114, 77],
    P07: [209, 76, 126, 104, 104, 124],
    P08: [267, 72, 86, 119, 124, 113],
    P09: [265, 79, 131, 93, 93, 115],
    P10: [378, 75, 90, 117, 117, 77]
  };
  assert.equal(config.creatureConfig.length, 10);
  assert.equal(config.creatureConfig.find((spirit) => spirit.id === 'P02').defaultPosition, 'back');
  assert.equal(config.creatureConfig.find((spirit) => spirit.id === 'P03').defaultPosition, 'back');
  assert.deepEqual(config.creatureConfig.find((spirit) => spirit.id === 'P09').skillIds, ['M09-S1', 'M09-S3', 'M09-S2']);
  const configuredSkillIds = config.creatureConfig.flatMap((spirit) => spirit.skillIds);
  assert.equal(new Set(configuredSkillIds).size, 30);
  assert.equal(Object.keys(config.skillConfig).length, 30);
  config.creatureConfig.forEach((spirit) => {
    assert.deepEqual(
      [spirit.maxHp, spirit.physicalAttack, spirit.magicAttack, spirit.physicalDefense, spirit.magicDefense, spirit.speed],
      expected[spirit.id]
    );
    assert.equal(spirit.skillIds.length, 3);
    spirit.skillIds.forEach((skillId) => assert.ok(config.skillConfig[skillId]));
  });
});

test('确认后的十精灵技能费用、数值与持续时间配置一致', () => {
  const skills = battleSystemConfig().skillConfig;
  assert.deepEqual(
    {
      fox: [skills['M01-S2'].power, skills['M01-S2'].cost, skills['M01-S2'].consecutiveUseCostReduction, skills['M01-S3'].power, skills['M01-S3'].cost, skills['M01-S3'].alwaysCrit],
      falcon: [skills['M02-S1'].power, skills['M02-S2'].power, skills['M02-S3'].power, skills['M02-S3'].cost],
      seed: [skills['M03-S1'].power, skills['M03-S1'].selfHealPercent, skills['M03-S2'].cost, skills['M03-S2'].healPercent, skills['M03-S2'].addRegenTurns],
      badger: [skills['M04-S1'].shieldValue, skills['M04-S2'].cost, skills['M04-S2'].shieldToFixedDamageRatio, skills['M04-S3'].cost, skills['M04-S3'].shieldValue],
      shell: [skills['M05-S2'].cost, skills['M05-S2'].healPercent, skills['M05-S3'].cost, skills['M05-S3'].teamShieldValue],
      rhino: [skills['M06-S1'].power, skills['M06-S2'].cost, skills['M06-S2'].shieldValue, skills['M06-S3'].name, skills['M06-S3'].cost, skills['M06-S3'].addEnergySaving],
      eclipse: [skills['M07-S1'].power, skills['M07-S2'].power, skills['M07-S3'].cost, skills['M07-S3'].teamHealPercent],
      deer: [skills['M08-S2'].cost, skills['M08-S2'].target, skills['M08-S2'].excludeSelfTarget, skills['M08-S2'].healSelfAndTargetPercent],
      bell: [skills['M08-S3'].cost, skills['M08-S3'].healFlatValue, skills['M08-S3'].shieldValue, skills['M08-S3'].firstSkillAfterEntryCostReduction],
      vulnerable: [skills['M09-S1'].gain, skills['M09-S2'].cost, skills['M09-S2'].power, skills['M09-S3'].cost, skills['M09-S3'].addBossVulnerabilityTurns],
      starArmor: [skills['M10-S1'].power, skills['M10-S2'].cost, skills['M10-S2'].fixedDamage, skills['M10-S2'].shieldValue, skills['M10-S3'].cost, skills['M10-S3'].gain, skills['M10-S3'].firstUseInBattleCostReduction]
    },
    {
      fox: [85, 2, 1, 180, 6, true],
     