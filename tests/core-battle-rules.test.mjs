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
  const game = new BattleGame({ config, selectedSpiritIds: config.creatureConfig.map((spirit) => spirit.id) });
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
  assert.equal(game.getSpirit(actorId).skillCooldowns[skillId], 2);
  assert.equal(game.getSpirit(actorId).skillCooldowns[extraSkillId], 2);
  assert.equal(manaAfterNormalStart >= 0, true);
});

test('v4.1 十精灵最终属性与三技能配置一致', () => {
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
      seed: [skills['M03-S2'].cost, skills['M03-S2'].healPercent, skills['M03-S2'].addRegenTurns],
      shell: [skills['M05-S2'].cost, skills['M05-S2'].healPercent],
      barrier: skills['M05-S3'].teamShieldValue,
      formation: skills['M06-S3'].addShieldFormationTurns,
      eclipse: [skills['M07-S2'].power, skills['M07-S3'].cost],
      deer: [skills['M08-S2'].cost, skills['M08-S2'].target, skills['M08-S2'].healSelfAndTargetPercent],
      bell: [skills['M08-S3'].cost, skills['M08-S3'].healFlatValue, skills['M08-S3'].shieldValue, skills['M08-S3'].firstSkillAfterEntryCostReduction],
      vulnerable: skills['M09-S3'].addBossVulnerabilityTurns,
      starArmor: [skills['M10-S2'].fixedDamage, skills['M10-S2'].shieldValue]
    },
    {
      seed: [3, 0.2, 2],
      shell: [3, 0.4],
      barrier: 200,
      formation: 3,
      eclipse: [130, 5],
      deer: [4, 'ally-field', 0.4],
      bell: [4, 150, 150, 4],
      vulnerable: 3,
      starArmor: [150, 150]
    }
  );
});

test('生机播种立即治疗目标20%并赋予2回合回复', () => {
  const game = gameFor(['P03', 'P01', 'P02']);
  const target = game.getSpirit('P01');
  target.hp = 100;
  forcePlayerAction(game, 'P03');
  game.state.mana.current = 10;
  assert.equal(game.useSkill('M03-S2').ok, true);
  assert.equal(game.chooseSkillTarget('P01').ok, true);
  assert.equal(target.hp, 100 + Math.floor(262 * 0.2));
  assert.equal(target.statuses.regen.duration, 2);
  assert.equal(target.statuses.regen.value, 0.1);
  assert.equal(game.state.mana.current, 7);
});

test('鹿鸣回春治疗自身与目标各40%，选择自身时不重复结算', () => {
  const game = gameFor(['P08', 'P01', 'P02']);
  const actor = game.getSpirit('P08');
  const target = game.getSpirit('P01');
  actor.hp = 100;
  target.hp = 100;
  forcePlayerAction(game, 'P08');
  game.state.mana.current = 10;
  assert.equal(game.useSkill('M08-S2').ok, true);
  assert.equal(game.chooseSkillTarget('P01').ok, true);
  assert.equal(actor.hp, 100 + Math.floor(267 * 0.4));
  assert.equal(target.hp, 100 + Math.floor(262 * 0.4));
  assert.equal(actor.statuses.regen, undefined);
  assert.equal(target.statuses.regen, undefined);

  const selfGame = gameFor(['P08']);
  const self = selfGame.getSpirit('P08');
  self.hp = 50;
  forcePlayerAction(selfGame, 'P08');
  selfGame.state.mana.current = 10;
  assert.equal(selfGame.useSkill('M08-S2').ok, true);
  assert.equal(selfGame.chooseSkillTarget('P08').ok, true);
  assert.equal(self.hp, 50 + Math.floor(267 * 0.4));
});

test('蓄势每次受到攻击且存活时获得4层爆发', () => {
  const game = gameFor(['P02', 'P01', 'P03']);
  game['addCharge']('P02', 1, '测试');
  const enemyId = game.getActiveEnemyIds()[0];
  game['activateEnemyContext'](enemyId);
  const attack = monsterData.MONSTER_SKILLS.RANGE_BOSS_VOLLEY;
  game['applyMonsterDamage']('P02', attack);
  assert.equal(game.getSpirit('P02').damageAmpStacks, 4);
  game['applyMonsterDamage']('P02', attack);
  assert.equal(game.getSpirit('P02').damageAmpStacks, 8);
});

test('星能回流首次 0 费回 5，后续支付 3 并净回 2', () => {
  const game = gameFor(['P10', 'P01', 'P02']);
  forcePlayerAction(game, 'P10');
  game.state.mana.current = 7;
  assert.equal(game.skillActualCost(battleSystemConfig().skillConfig['M10-S3']), 0);
  assert.equal(game.useSkill('M10-S3').ok, true);
  assert.equal(game.state.mana.current, 10);

  forcePlayerAction(game, 'P10');
  game.state.mana.current = 5;
  assert.equal(game.skillActualCost(battleSystemConfig().skillConfig['M10-S3']), 3);
  assert.equal(game.useSkill('M10-S3').ok, true);
  assert.equal(game.state.mana.current, 7);
});

test('允许仅选择一只首发精灵进入战斗', () => {
  const config = battleSystemConfig();
  assert.equal(config.requiredSelection, 1);
  const game = gameFor(['P01']);
  assert.deepEqual(game.getActiveSpiritIds(), ['P01']);
  assert.deepEqual(game.getBenchSpiritIds(), []);
  assert.equal(game.state.slots.length, 1);
});

test('技能按钮统一返回风暴层数、连续降费、首次零费与护盾追加伤害', () => {
  const config = battleSystemConfig();

  const windGame = gameFor(['P02', 'P01', 'P03']);
  forcePlayerAction(windGame, 'P02');
  windGame.getSpirit('P02').damageAmpStacks = 2;
  const windState = windGame.getSkillButtonState(config.skillConfig['M02-S3'], windGame.getSpirit('P02'));
  assert.equal(windState.usable, false);
  assert.equal(windState.enhanced, true);
  assert.match(windState.enhanceReason, /爆发 2 层/);
  assert.match(windState.enhanceValue, /伤害 \+50%/);
  assert.match(windState.enhanceValue, /必定暴击/);

  const chainGame = gameFor(['P01', 'P02', 'P03']);
  const chainActor = chainGame.getSpirit('P01');
  chainActor.lastSkillId = 'M01-S2';
  chainActor.skillUseStreak = 2;
  chainGame.state.mana.current = 1;
  const chainState = chainGame.getSkillButtonState(config.skillConfig['M01-S2'], chainActor);
  assert.equal(chainState.usable, true);
  assert.equal(chainState.actualCost, 1);
  assert.match(chainState.enhanceReason, /连续使用 2 次/);
  assert.match(chainState.enhanceValue, /妖力消耗 -2/);

  const starGame = gameFor(['P10', 'P01', 'P02']);
  const starState = starGame.getSkillButtonState(config.skillConfig['M10-S3'], starGame.getSpirit('P10'));
  assert.equal(starState.actualCost, 0);
  assert.equal(starState.enhanced, true);
  assert.match(starState.enhanceReason, /本场首次使用/);

  const shieldGame = gameFor(['P04', 'P01', 'P02']);
  shieldGame.state.mana.current = 2;
  shieldGame.getSpirit('P04').shieldValue = 300;
  const shieldState = shieldGame.getSkillButtonState(config.skillConfig['M04-S2'], shieldGame.getSpirit('P04'));
  assert.equal(shieldState.usable, true);
  assert.match(shieldState.enhanceValue, /追加 300 固定伤害/);
});

test('铁壁防护按技能确认时妖力判断额外治疗', () => {
  const config = battleSystemConfig();
  const skill = config.skillConfig['M06-S2'];
  assert.equal(skill.name, '铁壁防护');

  const cancelledEnhanceGame = gameFor(['P06', 'P01', 'P02']);
  forcePlayerAction(cancelledEnhanceGame, 'P06');
  const firstTarget = cancelledEnhanceGame.getSpirit('P06');
  firstTarget.hp = 100;
  cancelledEnhanceGame.state.mana.current = 5;
  const preview = cancelledEnhanceGame.getSkillButtonState(skill, firstTarget, 'P06');
  assert.equal(preview.enhanced, true);
  assert.match(preview.enhanceValue, /20%/);
  assert.equal(cancelledEnhanceGame.useSkill(skill.id).ok, true);
  cancelledEnhanceGame.state.mana.current = 4;
  assert.equal(cancelledEnhanceGame.chooseSkillTarget('P06').ok, true);
  assert.equal(firstTarget.hp, 100);

  const confirmedEnhanceGame = gameFor(['P06', 'P01', 'P02']);
  forcePlayerAction(confirmedEnhanceGame, 'P06');
  const secondTarget = confirmedEnhanceGame.getSpirit('P06');
  secondTarget.hp = 100;
  confirmedEnhanceGame.state.mana.current = 5;
  assert.equal(confirmedEnhanceGame.useSkill(skill.id).ok, true);
  assert.equal(confirmedEnhanceGame.chooseSkillTarget('P06').ok, true);
  assert.equal(secondTarget.hp, 100 + Math.floor(config.creatureConfig.find((spirit) => spirit.id === 'P06').maxHp * 0.2));
});

test('通用强化条件支持低血、目标状态、位置、层数与目标依赖标记', () => {
  const game = gameFor(['P01', 'P02', 'P03']);
  const actor = game.getSpirit('P01');
  const slot = game.state.slots.find((item) => item.spiritId === 'P01');
  slot.row = 'front';
  actor.hp = 50;
  actor.statuses.focus = {
    id: 'focus', name: '专注', temporary: true, stackable: true, maxStacks: 9,
    stacks: 3, value: 0, duration: 2, skipCurrentOwnerActionEnd: false
  };
  game.state.boss.statuses.marked = {
    id: 'marked', name: '标记', temporary: true, stackable: false, maxStacks: 1,
    stacks: 1, value: 0, duration: 2, skipCurrentOwnerActionEnd: false
  };
  const skill = {
    ...battleSystemConfig().skillConfig['M01-S1'],
    id: 'TEST-ENHANCE',
    enhanceRules: [
      { condition: { type: 'actor_hp_at_most', ratio: 0.5 }, reason: '低血', value: '威力 +10', effect: { powerBonus: 10 } },
      { condition: { type: 'target_has_status', statusId: 'marked' }, reason: '目标有标记', value: '威力 +20', effect: { powerBonus: 20 } },
      { condition: { type: 'actor_position', row: 'front' }, reason: '位于前排', value: '威力 +5', effect: { powerBonus: 5 } },
      { condition: { type: 'actor_status_stacks', statusId: 'focus', minStacks: 2 }, reason: '专注 {value} 层', value: '威力 +{value}', effect: { powerBonus: 2, scaleByConditionValue: true } }
    ]
  };

  const pending = game.getSkillButtonState(skill, actor);
  assert.equal(pending.targetDependent, true);
  assert.equal(pending.powerTotal, 45 + 10 + 5 + 6);
  assert.doesNotMatch(pending.enhanceReason, /目标有标记/);

  const confirmed = game.getSkillButtonState(skill, actor, game.state.boss.id);
  assert.equal(confirmed.targetDependent, true);
  assert.equal(confirmed.powerTotal, 45 + 10 + 20 + 5 + 6);
  assert.match(confirmed.enhanceReason, /低血/);
  assert.match(confirmed.enhanceReason, /目标有标记/);
  assert.match(confirmed.enhanceReason, /位于前排/);
  assert.match(confirmed.enhanceReason, /专注 3 层/);
});

test('盾压在确认时消耗现有护盾并追加等额固定伤害', () => {
  const game = gameFor(['P04', 'P01', 'P02']);
  forcePlayerAction(game, 'P04');
  const actor = game.getSpirit('P04');
  actor.shieldValue = 300;
  actor.freshShieldValue = 0;
  game.state.mana.current = 10;
  const skill = battleSystemConfig().skillConfig['M04-S2'];
  const normalDamage = game['attackDamage']('P04', skill, skill.power, false, 1);
  const hpBefore = game.state.boss.hp;
  assert.equal(game.useSkill('M04-S2').ok, true);
  assert.equal(actor.shieldValue, 0);
  assert.equal(hpBefore - game.state.boss.hp, normalDamage + 300);
});

test('灵铃庇佑只在每次入场后的第一次技能为自身时 0 费', () => {
  const game = gameFor(['P08', 'P01', 'P02', 'P04']);
  const skill = battleSystemConfig().skillConfig['M08-S3'];
  forcePlayerAction(game, 'P08');
  game.state.mana.current = 10;
  assert.equal(game.skillActualCost(skill), 0);
  assert.equal(game.useSkill('M08-S1').ok, true);

  forcePlayerAction(game, 'P08');
  assert.equal(game.skillActualCost(skill), 4);
  assert.equal(game.swapWithBench('P04').ok, true);
  forcePlayerAction(game, 'P04');
  assert.equal(game.swapWithBench('P08').ok, true);

  forcePlayerAction(game, 'P08');
  assert.equal(game.skillActualCost(skill), 0);
  assert.equal(game.useSkill('M08-S3').ok, true);
  assert.equal(game.chooseSkillTarget('P08').ok, true);
  assert.equal(game.getSpirit('P08').shieldValue, 150);
});

test('盾阵结束当次保留护盾，下一次正常行动结束清空', () => {
  const game = gameFor(['P06', 'P01', 'P02']);
  const spirit = game.getSpirit('P06');
  spirit.shieldValue = 200;
  spirit.statuses['shield-formation'] = coreRules.mergeRuntimeStatus(undefined, {
    id: 'shield-formation', name: '盾阵', duration: 1
  });
  game['finishSpiritTurnStatuses'](spirit);
  assert.equal(spirit.statuses['shield-formation'], undefined);
  assert.equal(spirit.shieldValue, 200);
  game['finishSpiritTurnStatuses'](spirit);
  assert.equal(spirit.shieldValue, 0);
});

test('感电标记施加三回合易伤并使最终伤害提高 50%', () => {
  const game = gameFor(['P09', 'P01', 'P02']);
  forcePlayerAction(game, 'P09');
  game.state.mana.current = 10;
  assert.equal(game.useSkill('M09-S3').ok, true);
  assert.equal(game.state.boss.statuses.vulnerable.duration, 3);

  const attack = battleSystemConfig().skillConfig['M09-S2'];
  const base = game['attackDamage']('P09', attack, attack.power, false, 1);
  assert.equal(Math.ceil(base * game['currentBossDamageTakenMultiplier']()), Math.ceil(base * 1.5));
  game['finishBossTurnStatuses']();
  assert.equal(game.state.boss.statuses.vulnerable.duration, 2);
  game['finishBossTurnStatuses']();
  assert.equal(game.state.boss.statuses.vulnerable.duration, 1);
  game['finishBossTurnStatuses']();
  assert.equal(game.state.boss.statuses.vulnerable, undefined);
});

test('炽能连斩连续费用依次降至 0，使用其他技能后重置', () => {
  const game = gameFor(['P01', 'P02', 'P03']);
  const skill = battleSystemConfig().skillConfig['M01-S2'];
  for (const expectedCost of [3, 2, 1, 0]) {
    forcePlayerAction(game, 'P01');
    game.state.mana.current = 10;
    assert.equal(game.skillActualCost(skill), expectedCost);
    assert.equal(game.useSkill(skill.id).ok, true);
  }
  forcePlayerAction(game, 'P01');
  assert.equal(game.useSkill('M01-S1').ok, true);
  forcePlayerAction(game, 'P01');
  game.state.mana.current = 10;
  assert.equal(game.skillActualCost(skill), 3);
});

test('同回合多个技能可以累计获得超过 2 点妖力', () => {
  const game = gameFor(['P06', 'P09', 'P01']);
  forcePlayerAction(game, 'P06');
  game.state.mana.current = 0;
  assert.equal(game.useSkill('M06-S1').ok, true);
  assert.equal(game.state.mana.current, 1);
  forcePlayerAction(game, 'P09');
  assert.equal(game.useSkill('M09-S1').ok, true);
  assert.equal(game.state.mana.current, 4);
});

test('界面请求目标选择时，即使只有一个合法前排也不会自动结算', () => {
  const game = gameFor();
  const actorId = 'P01';
  forcePlayerAction(game, actorId);
  const targetId = game.getLegalEnemyTargetIds()[0];
  const hpBefore = game.getEnemy(targetId).hp;
  assert.equal(game.useSkill('M01-S1', true).ok, true);
  assert.equal(game.state.phase, 'target-select');
  assert.equal(game.getEnemy(targetId).hp, hpBefore);
  assert.equal(game.chooseSkillTarget(targetId).ok, true);
  assert.ok(game.getEnemy(targetId).hp < hpBefore);
});

test('星甲冲击造成 150 固定伤害并保留本次行动新获得的 150 护盾', () => {
  const game = gameFor(['P10', 'P01', 'P02']);
  forcePlayerAction(game, 'P10');
  game.state.mana.current = 10;
  const hpBefore = game.state.boss.hp;
  assert.equal(game.useSkill('M10-S2').ok, true);
  assert.equal(hpBefore - game.state.boss.hp, 150);
  assert.equal(game.getSpirit('P10').shieldValue, 150);
});
