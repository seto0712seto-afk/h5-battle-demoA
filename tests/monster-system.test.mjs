import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let server;
let BattleGame;
let battleSystemConfig;
let monsterData;
let monsterSystem;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  ({ BattleGame } = await server.ssrLoadModule('/src/battle.ts'));
  ({ battleSystemConfig } = await server.ssrLoadModule('/src/battleSystems.ts'));
  monsterData = await server.ssrLoadModule('/src/monsterData.ts');
  monsterSystem = await server.ssrLoadModule('/src/monsterSystem.ts');
});

after(async () => {
  await server?.close();
});

function monsterGame(enemyIds, seed = 'monster-test-seed', selectedSpiritIds) {
  const config = battleSystemConfig();
  return new BattleGame({
    config,
    selectedSpiritIds: selectedSpiritIds ?? config.creatureConfig.map((spirit) => spirit.id),
    enemies: enemyIds.map((enemyId, index) => ({
      enemyId,
      position: index === 0 ? 'front' : index === 1 ? 'back_1' : 'back_2'
    })),
    battleSeed: seed
  });
}

function activate(game, enemyId = game.getActiveEnemyIds()[0]) {
  game['activateEnemyContext'](enemyId);
  game.state.activeUnit = { type: 'boss', id: enemyId };
  return enemyId;
}

function forcePlayerAction(game, actorId) {
  game.state.round.actionSlots.forEach((slot) => {
    if (slot.type === 'spirit' && slot.unitId === actorId) slot.status = 'executing';
  });
  game.state.activeUnit = { type: 'spirit', id: actorId };
  game.state.phase = 'player-action';
  game.state.actionContext = 'normal';
  game['beginPlayerAction'](actorId);
}

test('等级倍率统一计算攻防速与生命，并允许实例属性覆盖', () => {
  const definition = {
    id: 'TEST', name: '测试', level: 1, category: 'minor', role: 'warrior', defaultPosition: 'front', baseHp: 300,
    coefficients: { physicalAttack: 1, physicalDefense: 1, magicAttack: 1, magicDefense: 1, speed: 1 },
    skills: []
  };
  assert.deepEqual(monsterSystem.calculateMonsterStats(definition, 1), {
    physicalAttack: 100, physicalDefense: 100, magicAttack: 100, magicDefense: 100, speed: 100, maxHp: 300
  });
  assert.deepEqual(monsterSystem.calculateMonsterStats(definition, 2), {
    physicalAttack: 125, physicalDefense: 125, magicAttack: 125, magicDefense: 125, speed: 125, maxHp: 375
  });
  const instance = monsterSystem.createMonsterInstance(definition, { level: 2, stats: { maxHp: 999 } });
  assert.equal(instance.stats.maxHp, 999);
  assert.equal(instance.stats.speed, 125);
});

test('正式怪物数据包含三主题各六只普通/精英怪与三只Boss', () => {
  assert.equal(Object.keys(monsterData.MONSTERS).length, 21);
  assert.equal(monsterData.MONSTERS.FORGE_BOSS_WARRIOR.baseHp, 3000);
  assert.equal(monsterData.MONSTERS.RANGE_BOSS_SHOOTER.baseHp, 2200);
  assert.equal(monsterData.MONSTERS.RANGE_BOSS_SHOOTER.coefficients.physicalAttack, 3);
  assert.equal(monsterData.MONSTERS.MAGE_BOSS.baseHp, 2200);
  assert.equal(monsterData.MONSTERS.FORGE_ELITE_WARRIOR.skills[0].weight, 67);
  assert.equal(monsterData.MONSTERS.RANGE_ELITE_SHOOTER.skills[1].weight, 25);
  assert.equal(monsterData.MONSTERS.MAGE_ELITE_MAGE.skills[1].selectionMode, 'forced_opening');
});

test('三职业Boss正式模板的权重、威力与强制行动配置一致', () => {
  const forge = monsterData.MONSTERS.FORGE_BOSS_WARRIOR;
  const shooter = monsterData.MONSTERS.RANGE_BOSS_SHOOTER;
  const mage = monsterData.MONSTERS.MAGE_BOSS;
  assert.equal(forge.name, '熔核守卫');
  assert.deepEqual(forge.skills.map((entry) => entry.weight), [50, 25, 0]);
  assert.deepEqual(forge.skills.map((entry) => monsterData.MONSTER_SKILLS[entry.skillId].execution.power ?? 0), [100, 0, 200]);
  assert.equal(monsterData.MONSTER_SKILLS.FORGE_BOSS_BREAK_CHARGE, undefined);
  assert.deepEqual(forge.coefficients, {
    physicalAttack: 2.5, physicalDefense: 1, magicAttack: 2.5, magicDefense: 1, speed: 0.85
  });
  assert.deepEqual(shooter.skills.map((entry) => entry.weight), [35, 35, 30, 0]);
  assert.deepEqual(shooter.skills.map((entry) => monsterData.MONSTER_SKILLS[entry.skillId].execution.power ?? 0), [35, 60, 0, 100]);
  assert.equal(shooter.defaultPosition, 'back');
  assert.equal(shooter.coefficients.speed, 1);
  assert.deepEqual(mage.skills.map((entry) => entry.weight), [100, 0]);
  assert.equal(mage.defaultPosition, 'back');
  assert.equal(mage.coefficients.magicDefense, 1);
  assert.equal(mage.coefficients.speed, 0.9);
  assert.deepEqual(mage.actionCycle, {
    counterLabel: '魔力积蓄',
    countedSkillIds: ['MAGE_BOSS_ARCANE_BOLT'],
    threshold: 3,
    forcedSkillId: 'MAGE_BOSS_MANA_EXPANSION'
  });
});

test('多敌人分别获得行动位，玩家普通攻击优先合法前排', () => {
  const game = monsterGame(['FORGE_GRUNT_WARRIOR', 'FORGE_GRUNT_SHOOTER', 'FORGE_GRUNT_MAGE']);
  const enemyActionIds = game.state.round.actionSlots.filter((slot) => slot.type === 'boss').map((slot) => slot.unitId);
  assert.equal(enemyActionIds.length, 3);
  assert.deepEqual(game.getLegalEnemyTargetIds(), [game.state.enemySlots.find((slot) => slot.position === 'front').enemyId]);
  const frontId = game.getLegalEnemyTargetIds()[0];
  game.getEnemy(frontId).hp = 0;
  assert.equal(game.getLegalEnemyTargetIds().length, 2);
  assert.ok(game.getLegalEnemyTargetIds().every((id) => game.getEnemy(id).row === 'back'));
});

test('相对权重与固定Seed保持可复现，强制后继不消耗随机调用', () => {
  const definition = monsterData.MONSTERS.FORGE_ELITE_WARRIOR;
  const sequence = (seed) => {
    const runtime = monsterSystem.createMonsterAiRuntime(definition, monsterData.MONSTER_SKILLS);
    const random = new monsterSystem.SeededBattleRandom(seed);
    const ids = Array.from({ length: 30 }, () => monsterSystem.selectMonsterAction(definition, monsterData.MONSTER_SKILLS, runtime, random).skillId);
    return { ids, history: random.history() };
  };
  assert.deepEqual(sequence('same-seed'), sequence('same-seed'));
  assert.notDeepEqual(sequence('same-seed').ids, sequence('different-seed').ids);
});

test('强制技能当前不可执行时保留标记，直到下一次合法行动', () => {
  const definition = monsterData.MONSTERS.MAGE_BOSS;
  const runtime = monsterSystem.createMonsterAiRuntime(definition, monsterData.MONSTER_SKILLS);
  const random = new monsterSystem.SeededBattleRandom('forced-action-retain');
  runtime.pendingFollowup = { skillId: 'MAGE_BOSS_MANA_EXPANSION' };
  const skipped = monsterSystem.selectMonsterAction(definition, monsterData.MONSTER_SKILLS, runtime, random, () => false);
  assert.deepEqual(skipped, { skillId: null, source: 'skip' });
  assert.deepEqual(runtime.pendingFollowup, { skillId: 'MAGE_BOSS_MANA_EXPANSION' });
  const forced = monsterSystem.selectMonsterAction(definition, monsterData.MONSTER_SKILLS, runtime, random, () => true);
  assert.equal(forced.skillId, 'MAGE_BOSS_MANA_EXPANSION');
  assert.equal(forced.source, 'forced_followup');
  assert.equal(runtime.pendingFollowup, null);
});

test('精英法师首次强制强化，直接提高运行时技能威力且不创建状态', () => {
  const definition = monsterData.MONSTERS.FORGE_ELITE_MAGE;
  const runtime = monsterSystem.createMonsterAiRuntime(definition, monsterData.MONSTER_SKILLS);
  const random = new monsterSystem.SeededBattleRandom('mage-opening');
  const first = monsterSystem.selectMonsterAction(definition, monsterData.MONSTER_SKILLS, runtime, random);
  assert.equal(first.skillId, 'FORGE_ELITE_MAGE_GROWTH');
  assert.equal(first.source, 'forced_opening');

  const game = monsterGame(['FORGE_ELITE_MAGE']);
  const enemyId = activate(game);
  const growth = monsterData.MONSTER_SKILLS.FORGE_ELITE_MAGE_GROWTH;
  game['executeMonsterSkill'](growth, 'forced_opening');
  assert.equal(game['enemyAi'][enemyId].runtimeSkillPowers.FORGE_MAGE_BASIC, 65);
  game['executeMonsterSkill'](growth, 'weighted');
  assert.equal(game['enemyAi'][enemyId].runtimeSkillPowers.FORGE_MAGE_BASIC, 80);
  assert.deepEqual(game.getEnemy(enemyId).statuses, {});
});

test('精英战士预告锁定单位，目标失效后强制攻击落空且不改选', () => {
  const game = monsterGame(['FORGE_ELITE_WARRIOR'], 'elite-warrior-lock');
  const enemyId = activate(game);
  const skill = monsterData.MONSTER_SKILLS.FORGE_ELITE_WARRIOR_PREVIEW;
  game['executeMonsterSkill'](skill, 'weighted');
  const runtime = game['enemyAi'][enemyId];
  const pending = { ...runtime.pendingFollowup };
  assert.ok(pending.lockedTargetId);
  const forced = monsterSystem.selectMonsterAction(monsterData.MONSTERS.FORGE_ELITE_WARRIOR, monsterData.MONSTER_SKILLS, runtime, game['enemyRandom'][enemyId]);
  game.getSpirit(pending.lockedTargetId).hp = 0;
  game['vacateDefeatedSpirit'](pending.lockedTargetId);
  const before = Object.fromEntries(game.getActiveSpiritIds().map((id) => [id, game.getSpirit(id).hp]));
  game['executeMonsterSkill'](skill, forced.source, forced.lockedTargetId, forced.lockedSlotIndex, forced.lockedRow);
  assert.deepEqual(Object.fromEntries(game.getActiveSpiritIds().map((id) => [id, game.getSpirit(id).hp])), before);
});

test('精英战士锁定单位后，目标切到后排仍会被追踪命中', () => {
  const game = monsterGame(['FORGE_ELITE_WARRIOR'], 'elite-warrior-follow-row');
  const enemyId = activate(game);
  const skill = monsterData.MONSTER_SKILLS.FORGE_ELITE_WARRIOR_PREVIEW;
  game['executeMonsterSkill'](skill, 'weighted');
  const runtime = game['enemyAi'][enemyId];
  const pending = { ...runtime.pendingFollowup };
  assert.ok(pending.lockedTargetId);
  const targetSlot = game.state.slots.find((slot) => slot.spiritId === pending.lockedTargetId);
  targetSlot.row = 'back';
  const otherSlot = game.state.slots.find((slot) => slot.spiritId !== pending.lockedTargetId);
  otherSlot.row = 'front';
  const before = game.getSpirit(pending.lockedTargetId).hp;
  const forced = monsterSystem.selectMonsterAction(monsterData.MONSTERS.FORGE_ELITE_WARRIOR, monsterData.MONSTER_SKILLS, runtime, game['enemyRandom'][enemyId]);
  game['executeMonsterSkill'](skill, forced.source, forced.lockedTargetId, forced.lockedSlotIndex, forced.lockedRow);
  assert.ok(game.getSpirit(pending.lockedTargetId).hp < before);
});

test('战士Boss锁定目标行，换入者改变前后排后仍承受高温爆发', () => {
  const game = monsterGame(['FORGE_BOSS_WARRIOR'], 'forge-position-lock');
  const enemyId = activate(game);
  game.state.slots[0].row = 'front';
  const charge = monsterData.MONSTER_SKILLS.FORGE_BOSS_MOUNTAIN_CHARGE;
  game['executeMonsterSkill'](charge, 'weighted');
  const runtime = game['enemyAi'][enemyId];
  const pending = { ...runtime.pendingFollowup };
  assert.equal(typeof pending.lockedSlotIndex, 'number');
  assert.equal(pending.lockedRow, 'front');
  assert.deepEqual(game.enemyTelegraphView(enemyId), {
    skillName: '高温爆发',
    targetText: `锁定：第 ${pending.lockedSlotIndex + 1} 行`,
    estimatedPower: 200
  });
  assert.deepEqual(game.playerTelegraphThreats(pending.lockedSlotIndex, pending.lockedRow), [{
    enemyId,
    enemyName: '熔核守卫',
    skillName: '高温爆发',
    lockMode: 'position'
  }]);
  assert.equal(game.state.battleFx.telegraphSkillName, '高温爆发');
  const slot = game.state.slots[pending.lockedSlotIndex];
  const oldTarget = slot.spiritId;
  const replacement = game.getBenchSpiritIds()[0];
  slot.spiritId = replacement;
  slot.row = 'back';
  assert.equal(game.playerTelegraphThreats(pending.lockedSlotIndex, 'front', replacement).length, 0);
  assert.equal(game.playerTelegraphThreats(pending.lockedSlotIndex, 'back', replacement).length, 1);
  const before = game.getSpirit(replacement).hp;
  const forced = monsterSystem.selectMonsterAction(monsterData.MONSTERS.FORGE_BOSS_WARRIOR, monsterData.MONSTER_SKILLS, runtime, game['enemyRandom'][enemyId]);
  assert.equal(game.enemyTelegraphView(enemyId), null);
  game['executeMonsterSkill'](monsterData.MONSTER_SKILLS[forced.skillId], forced.source, forced.lockedTargetId, forced.lockedSlotIndex, forced.lockedRow);
  assert.ok(game.getSpirit(replacement).hp < before);
  assert.equal(game.getSpirit(oldTarget).hp, game['spiritInfo'](oldTarget).maxHp);
});

test('熔核破绽只在高温爆发完整结算后施加，并在Boss下次行动开始时移除', () => {
  const game = monsterGame(['FORGE_BOSS_WARRIOR'], 'forge-exposed-after-heat');
  const enemyId = activate(game);
  const runtime = game['enemyAi'][enemyId];
  const charge = monsterData.MONSTER_SKILLS.FORGE_BOSS_MOUNTAIN_CHARGE;
  const highHeat = monsterData.MONSTER_SKILLS.FORGE_BOSS_MOUNTAIN_CLEAVE;

  game['executeMonsterSkill'](charge, 'weighted');
  assert.equal(runtime.exposedActive, false);

  const pending = { ...runtime.pendingFollowup };
  let exposedDuringDamage = null;
  const executeDamage = game['executeMonsterSingleDamage'].bind(game);
  game['executeMonsterSingleDamage'] = (...args) => {
    exposedDuringDamage = runtime.exposedActive;
    return executeDamage(...args);
  };
  game['executeMonsterSkill'](
    highHeat,
    'forced_followup',
    pending.lockedTargetId,
    pending.lockedSlotIndex,
    pending.lockedRow,
    pending.lockedOriginSlotIndex,
    pending.lockedOriginRow
  );

  assert.equal(exposedDuringDamage, false);
  assert.equal(runtime.exposedActive, true);
  game['expireMonsterActionWindows']();
  assert.equal(runtime.exposedActive, false);
});

test('射手Boss锁定当前后排单位并预告雷霆贯射', () => {
  const game = monsterGame(['RANGE_BOSS_SHOOTER'], 'range-unit-lock');
  const enemyId = activate(game);
  game['executeMonsterSkill'](monsterData.MONSTER_SKILLS.RANGE_BOSS_ARROWSTORM_CHARGE, 'weighted');
  const pending = { ...game['enemyAi'][enemyId].pendingFollowup };
  assert.ok(pending.lockedTargetId);
  assert.equal(game.state.slots.find((slot) => slot.spiritId === pending.lockedTargetId).row, 'back');
  assert.deepEqual(game.enemyTelegraphView(enemyId), {
    skillName: '雷霆贯射',
    targetText: `锁定：${game['spiritName'](pending.lockedTargetId)}`,
    estimatedPower: 100
  });
  const lockedSlot = game.state.slots.find((slot) => slot.spiritId === pending.lockedTargetId);
  assert.deepEqual(game.playerTelegraphThreats(lockedSlot.index, lockedSlot.row, pending.lockedTargetId), [{
    enemyId,
    enemyName: '灰羽猎王',
    skillName: '雷霆贯射',
    lockMode: 'unit'
  }]);
  assert.equal(game.state.battleFx.telegraphSkillName, '雷霆贯射');

  lockedSlot.row = 'front';
  assert.equal(game.playerTelegraphThreats(lockedSlot.index, 'back').length, 0);
  assert.equal(game.playerTelegraphThreats(lockedSlot.index, 'front', pending.lockedTargetId).length, 1);
  const before = game.getSpirit(pending.lockedTargetId).hp;
  const forced = monsterSystem.selectMonsterAction(monsterData.MONSTERS.RANGE_BOSS_SHOOTER, monsterData.MONSTER_SKILLS, game['enemyAi'][enemyId], game['enemyRandom'][enemyId]);
  game['executeMonsterSkill'](
    monsterData.MONSTER_SKILLS[forced.skillId],
    forced.source,
    forced.lockedTargetId,
    forced.lockedSlotIndex,
    forced.lockedRow,
    forced.lockedOriginSlotIndex,
    forced.lockedOriginRow
  );
  assert.ok(game.getSpirit(pending.lockedTargetId).hp < before);
});

test('射手Boss锁定单位后，其他目标行换宠不会改写雷霆贯射目标', () => {
  const game = monsterGame(
    ['RANGE_BOSS_SHOOTER'],
    'range-lock-unrelated-swap',
    ['P01', 'P02', 'P04', 'P03']
  );
  const enemyId = activate(game);
  game.state.slots[0].row = 'back';
  game.state.slots[1].row = 'back';
  game.state.slots[2].row = 'front';
  game['executeMonsterSkill'](monsterData.MONSTER_SKILLS.RANGE_BOSS_ARROWSTORM_CHARGE, 'weighted');

  const pending = { ...game['enemyAi'][enemyId].pendingFollowup };
  const lockedTargetId = pending.lockedTargetId;
  assert.ok(lockedTargetId);
  const unrelatedSlot = game.state.slots.find((slot) => slot.spiritId !== lockedTargetId && slot.row === 'front');
  const replacementId = game.getBenchSpiritIds().find((id) => game['spiritInfo'](id).defaultPosition === 'back');
  assert.ok(unrelatedSlot);
  assert.ok(replacementId);
  unrelatedSlot.spiritId = replacementId;
  unrelatedSlot.row = game['spiritInfo'](replacementId).defaultPosition;

  const lockedHp = game.getSpirit(lockedTargetId).hp;
  const replacementHp = game.getSpirit(replacementId).hp;
  const forced = monsterSystem.selectMonsterAction(
    monsterData.MONSTERS.RANGE_BOSS_SHOOTER,
    monsterData.MONSTER_SKILLS,
    game['enemyAi'][enemyId],
    game['enemyRandom'][enemyId]
  );
  game['executeMonsterSkill'](
    monsterData.MONSTER_SKILLS[forced.skillId],
    forced.source,
    forced.lockedTargetId,
    forced.lockedSlotIndex,
    forced.lockedRow,
    forced.lockedOriginSlotIndex,
    forced.lockedOriginRow
  );

  assert.ok(game.getSpirit(lockedTargetId).hp < lockedHp);
  assert.equal(game.getSpirit(replacementId).hp, replacementHp);
});

test('射手Boss锁定目标换宠后命中原位置的接替者', () => {
  const game = monsterGame(['RANGE_BOSS_SHOOTER'], 'range-lock-swap-fallback');
  const enemyId = activate(game);
  game['executeMonsterSkill'](monsterData.MONSTER_SKILLS.RANGE_BOSS_ARROWSTORM_CHARGE, 'weighted');

  const pending = { ...game['enemyAi'][enemyId].pendingFollowup };
  assert.ok(pending.lockedTargetId);
  assert.equal(typeof pending.lockedOriginSlotIndex, 'number');
  assert.ok(pending.lockedOriginRow);

  const outgoingId = pending.lockedTargetId;
  const replacementId = game.getBenchSpiritIds()[0];
  const originSlot = game.state.slots[pending.lockedOriginSlotIndex];
  originSlot.spiritId = replacementId;
  originSlot.row = game['spiritInfo'](replacementId).defaultPosition;
  const inactiveRow = originSlot.row === 'front' ? 'back' : 'front';

  assert.deepEqual(game.enemyTelegraphView(enemyId), {
    skillName: '雷霆贯射',
    targetText: `锁定：第 ${pending.lockedOriginSlotIndex + 1} 行（目标已换宠）`,
    estimatedPower: 100
  });
  assert.deepEqual(game.playerTelegraphThreats(originSlot.index, originSlot.row, replacementId), [{
    enemyId,
    enemyName: '灰羽猎王',
    skillName: '雷霆贯射',
    lockMode: 'position'
  }]);
  assert.equal(game.playerTelegraphThreats(originSlot.index, inactiveRow, replacementId).length, 0);

  const outgoingHp = game.getSpirit(outgoingId).hp;
  const replacementHp = game.getSpirit(replacementId).hp;
  const forced = monsterSystem.selectMonsterAction(
    monsterData.MONSTERS.RANGE_BOSS_SHOOTER,
    monsterData.MONSTER_SKILLS,
    game['enemyAi'][enemyId],
    game['enemyRandom'][enemyId]
  );
  game['executeMonsterSkill'](
    monsterData.MONSTER_SKILLS[forced.skillId],
    forced.source,
    forced.lockedTargetId,
    forced.lockedSlotIndex,
    forced.lockedRow,
    forced.lockedOriginSlotIndex,
    forced.lockedOriginRow
  );

  assert.equal(game.getSpirit(outgoingId).hp, outgoingHp);
  assert.ok(game.getSpirit(replacementId).hp < replacementHp);
  assert.ok(game.state.logs.some((entry) => entry.includes('原锁定目标已换宠')));
});

test('Boss使用预告技能后仅在下一回合移至行动顺序最后', () => {
  const game = monsterGame(['RANGE_BOSS_SHOOTER'], 'telegraph-act-last');
  const enemyId = activate(game);
  game.state.slots.forEach((slot) => {
    if (slot.spiritId) game.getSpirit(slot.spiritId).speedModifier = -1000;
  });

  game['executeMonsterSkill'](monsterData.MONSTER_SKILLS.RANGE_BOSS_ARROWSTORM_CHARGE, 'weighted');
  assert.equal(game['enemyAi'][enemyId].actLastNextRound, true);
  assert.equal(game['enemyAi'][enemyId].pendingFollowup.skillId, 'RANGE_BOSS_SKYFALL');

  game['beginNextRound']();
  const delayedOrder = game.state.round.actionSlots.map((slot) => slot.unitId);
  assert.equal(delayedOrder.at(-1), enemyId);
  assert.equal(game['enemyAi'][enemyId].actLastNextRound, false);
  assert.ok(game.state.logs.some((entry) => entry.includes('本回合行动移至最后')));

  game['beginNextRound']();
  const restoredOrder = game.state.round.actionSlots.map((slot) => slot.unitId);
  assert.equal(restoredOrder[0], enemyId);
  assert.equal(game['enemyAi'][enemyId].pendingFollowup.skillId, 'RANGE_BOSS_SKYFALL');
});

test('射手Boss雷鸣箭雨只攻击当前后排，无后排时回退当前前排', () => {
  const game = monsterGame(['RANGE_BOSS_SHOOTER'], 'range-back-area');
  activate(game);
  game.state.slots[0].row = 'front';
  game.state.slots[1].row = 'back';
  game.state.slots[2].row = 'back';
  const [frontId, backIdA, backIdB] = game.state.slots.map((slot) => slot.spiritId);
  const volley = monsterData.MONSTER_SKILLS.RANGE_BOSS_VOLLEY;
  game['executeMonsterSkill'](volley, 'weighted');
  assert.equal(game.getSpirit(frontId).hp, game['spiritInfo'](frontId).maxHp);
  assert.ok(game.getSpirit(backIdA).hp < game['spiritInfo'](backIdA).maxHp);
  assert.ok(game.getSpirit(backIdB).hp < game['spiritInfo'](backIdB).maxHp);

  game.state.slots[1].row = 'front';
  game.state.slots[2].row = 'front';
  const frontBefore = game.getSpirit(frontId).hp;
  game['executeMonsterSkill'](volley, 'weighted');
  assert.ok(game.getSpirit(frontId).hp < frontBefore);
});

test('射手Boss狙击只从当前后排随机选取，无后排时回退当前前排', () => {
  const game = monsterGame(['RANGE_BOSS_SHOOTER'], 'range-back-single');
  activate(game);
  game.state.slots[0].row = 'front';
  game.state.slots[1].row = 'back';
  game.state.slots[2].row = 'front';
  const [frontIdA, backId, frontIdB] = game.state.slots.map((slot) => slot.spiritId);
  const snipe = monsterData.MONSTER_SKILLS.RANGE_BOSS_PIERCING_RAIN;
  game['executeMonsterSkill'](snipe, 'weighted');
  assert.equal(game.getSpirit(frontIdA).hp, game['spiritInfo'](frontIdA).maxHp);
  assert.ok(game.getSpirit(backId).hp < game['spiritInfo'](backId).maxHp);
  assert.equal(game.getSpirit(frontIdB).hp, game['spiritInfo'](frontIdB).maxHp);

  game.state.slots[1].row = 'front';
  const frontHpBefore = [frontIdA, backId, frontIdB].map((id) => game.getSpirit(id).hp);
  game['executeMonsterSkill'](snipe, 'weighted');
  assert.ok([frontIdA, backId, frontIdB].some((id, index) => game.getSpirit(id).hp < frontHpBefore[index]));
});

test('射手Boss狙击存在其他合法目标时不会连续攻击同一目标', () => {
  const game = monsterGame(['RANGE_BOSS_SHOOTER'], 'range-controlled-random');
  const enemyId = activate(game);
  game.state.slots[0].row = 'front';
  game.state.slots[1].row = 'back';
  game.state.slots[2].row = 'back';
  const firstBackId = game.state.slots[1].spiritId;
  const secondBackId = game.state.slots[2].spiritId;
  const snipe = monsterData.MONSTER_SKILLS.RANGE_BOSS_PIERCING_RAIN;
  game.getEnemy(enemyId).physicalAttack = 1;
  game['enemyAi'][enemyId].lastTargetIdBySkill[snipe.id] = firstBackId;

  const firstHp = game.getSpirit(firstBackId).hp;
  const secondHp = game.getSpirit(secondBackId).hp;
  game['executeMonsterSkill'](snipe, 'weighted');

  assert.equal(game.getSpirit(firstBackId).hp, firstHp);
  assert.ok(game.getSpirit(secondBackId).hp < secondHp);
  assert.equal(game['enemyAi'][enemyId].lastTargetIdBySkill[snipe.id], secondBackId);
});

test('灰羽猎王攻击叠加猎伤，贯射按层增伤且不消耗，换至后备清除', () => {
  const selected = ['P01', 'P02', 'P04', 'P03'];
  const game = monsterGame(['RANGE_BOSS_SHOOTER'], 'hunter-wound-stack', selected);
  const enemyId = activate(game);
  game['config'].bossConfig.physicalAttack = 1;
  game.state.slots[0].row = 'back';
  game.state.slots[1].row = 'front';
  game.state.slots[2].row = 'front';
  const targetId = game.state.slots[0].spiritId;
  const snipe = monsterData.MONSTER_SKILLS.RANGE_BOSS_PIERCING_RAIN;
  const skyfall = monsterData.MONSTER_SKILLS.RANGE_BOSS_SKYFALL;
  assert.equal(skyfall.execution.targetStatusDamageInteraction.finalDamageMultiplierPerStack, 0.4);
  assert.equal(skyfall.execution.targetStatusDamageInteraction.shieldPenetration, undefined);
  assert.equal(1 + 4 * skyfall.execution.targetStatusDamageInteraction.finalDamageMultiplierPerStack, 2.6);

  for (let count = 1; count <= 5; count += 1) game['executeMonsterSkill'](snipe, 'weighted');
  assert.equal(game.getSpirit(targetId).statuses['hunter-wound'].stacks, 4);
  const preview = game.enemySkillDamagePreview(enemyId, skyfall.id, targetId);
  assert.equal(preview.statusStacks, 4);
  assert.equal(preview.finalDamageMultiplier, 2.6);
  assert.equal(preview.shieldPenetration, 0);
  const enhancedBefore = game.getSpirit(targetId).hp;
  game['executeMonsterSkill'](skyfall, 'weighted');
  const enhancedDamage = enhancedBefore - game.getSpirit(targetId).hp;
  assert.equal(game.getSpirit(targetId).statuses['hunter-wound'].stacks, 4);

  const baseline = monsterGame(['RANGE_BOSS_SHOOTER'], 'hunter-wound-baseline', selected);
  activate(baseline);
  baseline['config'].bossConfig.physicalAttack = 1;
  baseline.state.slots[0].row = 'back';
  baseline.state.slots[1].row = 'front';
  baseline.state.slots[2].row = 'front';
  const baselineTargetId = baseline.state.slots[0].spiritId;
  const baselineBefore = baseline.getSpirit(baselineTargetId).hp;
  baseline['executeMonsterSkill'](skyfall, 'weighted');
  assert.ok(enhancedDamage > baselineBefore - baseline.getSpirit(baselineTargetId).hp);

  forcePlayerAction(game, targetId);
  assert.equal(game.swapWithBench('P03').ok, true);
  assert.equal(game.getSpirit(targetId).statuses['hunter-wound'], undefined);
  assert.equal(game.getSpirit('P03').statuses['hunter-wound'], undefined);
  assert.equal(game.enemyStatusView(enemyId).statuses.includes('稳定'), true);
});

test('当前猎伤只提供最终增伤且不穿盾，底层穿透接口仍可独立配置', () => {
  const game = monsterGame(['RANGE_BOSS_SHOOTER'], 'hunter-wound-config');
  assert.equal(game['monsterShieldPenetration'](100, 4, undefined), 0);
  const liveConfig = monsterData.MONSTER_SKILLS.RANGE_BOSS_SKYFALL.execution.targetStatusDamageInteraction.shieldPenetration;
  assert.equal(liveConfig, undefined);
  assert.equal(game['monsterShieldPenetration'](100, 4, liveConfig), 0);
  assert.equal(game['monsterShieldPenetration'](100, 4, {
    mode: 'percentage', amountPerStack: 0.15, maxValue: 0.5, settlement: 'bypass'
  }), 50);
  assert.equal(game['monsterShieldPenetration'](100, 4, {
    mode: 'flat', amountPerStack: 20, maxValue: 60, settlement: 'bypass'
  }), 60);
});

test('法师Boss每完成三次魔力脉冲后获得永久40与临时80威力，玩家攻击每次削减10', () => {
  const game = monsterGame(['MAGE_BOSS'], 'mage-boss-cycle');
  const enemyId = activate(game);
  game['config'].bossConfig.magicAttack = 1;
  const runtime = game['enemyAi'][enemyId];
  const pulse = monsterData.MONSTER_SKILLS.MAGE_BOSS_ARCANE_BOLT;
  assert.equal(game.enemyCycleView(enemyId).current, 0);
  for (let count = 1; count <= 3; count += 1) {
    game['executeMonsterSkill'](pulse, 'weighted');
    assert.equal(runtime.actionCycleCount, count);
    assert.equal(runtime.runtimeSkillPowers.MAGE_BOSS_ARCANE_BOLT, 80);
  }
  assert.deepEqual(game.enemyTelegraphView(enemyId), { skillName: '魔力增幅', targetText: '目标：自身', estimatedPower: 0 });

  const forced = monsterSystem.selectMonsterAction(monsterData.MONSTERS.MAGE_BOSS, monsterData.MONSTER_SKILLS, runtime, game['enemyRandom'][enemyId]);
  assert.equal(forced.skillId, 'MAGE_BOSS_MANA_EXPANSION');
  assert.equal(forced.source, 'forced_followup');
  game['executeMonsterSkill'](monsterData.MONSTER_SKILLS[forced.skillId], forced.source);
  assert.equal(runtime.actionCycleCount, 0);
  assert.equal(runtime.runtimeSkillPowers.MAGE_BOSS_ARCANE_BOLT, 120);
  assert.equal(runtime.temporarySkillPowerBonuses.MAGE_BOSS_ARCANE_BOLT, 80);
  assert.equal(monsterSystem.runtimeMonsterSkillPower(runtime, pulse), 200);
  assert.deepEqual(game.getEnemy(enemyId).statuses, {});

  forcePlayerAction(game, 'P01');
  assert.equal(game.useSkill('M01-S1').ok, true);
  assert.equal(runtime.temporarySkillPowerBonuses.MAGE_BOSS_ARCANE_BOLT, 70);
  assert.equal(monsterSystem.runtimeMonsterSkillPower(runtime, pulse), 190);

  activate(game, enemyId);
  game['executeMonsterSkill'](pulse, 'weighted');
  assert.equal(runtime.temporarySkillPowerBonuses.MAGE_BOSS_ARCANE_BOLT, 0);
  assert.equal(monsterSystem.runtimeMonsterSkillPower(runtime, pulse), 120);
});
