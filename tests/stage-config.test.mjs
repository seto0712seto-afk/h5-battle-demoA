import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function withModules(context) {
  const vite = await createServer({
    root: projectRoot,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true }
  });
  context.after(() => vite.close());
  const [stages, monsterData, battleModule, battleSystems, prebattle] = await Promise.all([
    vite.ssrLoadModule('/src/stages.ts'),
    vite.ssrLoadModule('/src/monsterData.ts'),
    vite.ssrLoadModule('/src/battle.ts'),
    vite.ssrLoadModule('/src/battleSystems.ts'),
    vite.ssrLoadModule('/src/prebattle.ts')
  ]);
  return {
    stages,
    monsterData,
    BattleGame: battleModule.BattleGame,
    battleSystemConfig: battleSystems.battleSystemConfig,
    buildRandomQuickTeam: prebattle.buildRandomQuickTeam
  };
}

function enemyId(config) {
  return typeof config === 'string' ? config : config.enemyId;
}

function enemyPosition(config) {
  return typeof config === 'string' ? undefined : config.position;
}

test('一键战斗从全部精灵随机抽取六只且首发固定为一前排两后排', async (context) => {
  const { battleSystemConfig, buildRandomQuickTeam } = await withModules(context);
  const config = battleSystemConfig();
  const byId = Object.fromEntries(config.creatureConfig.map((spirit) => [spirit.id, spirit]));
  const generatedTeams = new Set();
  const generatedReserveFrontCounts = new Set();

  for (let seed = 1; seed <= 12; seed += 1) {
    let value = seed;
    const random = () => {
      value = (value * 1664525 + 1013904223) >>> 0;
      return value / 0x100000000;
    };
    const team = buildRandomQuickTeam(config.creatureConfig, 6, random);
    generatedTeams.add(team.join(','));
    assert.equal(team.length, 6);
    assert.equal(new Set(team).size, 6);
    const starterRows = team.slice(0, 3).map((id) => byId[id].defaultPosition);
    assert.equal(starterRows.filter((row) => row === 'front').length, 1);
    assert.equal(starterRows.filter((row) => row === 'back').length, 2);
    const reserveRows = team.slice(3, 6).map((id) => byId[id].defaultPosition);
    const reserveFrontCount = reserveRows.filter((row) => row === 'front').length;
    generatedReserveFrontCounts.add(reserveFrontCount);
    assert.ok(reserveFrontCount >= 1 && reserveFrontCount <= 2);
  }

  assert.ok(generatedTeams.size > 1);
  assert.deepEqual([...generatedReserveFrontCounts].sort(), [1, 2]);
});

test('三套固定主题副本均为五场且第五场只有对应Boss', async (context) => {
  const { stages } = await withModules(context);
  const expectedBosses = {
    DUNGEON_FORGE: 'FORGE_BOSS_WARRIOR',
    DUNGEON_RANGE: 'RANGE_BOSS_SHOOTER',
    DUNGEON_MAGE: 'MAGE_BOSS'
  };
  Object.entries(expectedBosses).forEach(([dungeonId, bossId]) => {
    const stage = stages.stageById(dungeonId);
    assert.equal(stage.battles.length, 5);
    assert.equal(stage.carryOverPlayerState, true);
    assert.deepEqual(stage.battles[4].enemies.map(enemyId), [bossId]);
  });
  assert.equal(enemyPosition(stages.stageById('DUNGEON_FORGE').battles[4].enemies[0]), 'front');
  assert.equal(enemyPosition(stages.stageById('DUNGEON_RANGE').battles[4].enemies[0]), 'back_1');
  assert.equal(enemyPosition(stages.stageById('DUNGEON_MAGE').battles[4].enemies[0]), 'back_1');
  const rangeSecond = stages.stageById('DUNGEON_RANGE').battles[1].enemies.map(enemyId);
  assert.equal(rangeSecond.filter((id) => id === 'RANGE_GRUNT_SHOOTER').length, 2);
});

test('三个单场Boss挑战复用对应Boss且不启用连战继承', async (context) => {
  const { stages } = await withModules(context);
  const expectedBosses = {
    BOSS_CHALLENGE_FORGE: 'FORGE_BOSS_WARRIOR',
    BOSS_CHALLENGE_RANGE: 'RANGE_BOSS_SHOOTER',
    BOSS_CHALLENGE_MAGE: 'MAGE_BOSS'
  };
  Object.entries(expectedBosses).forEach(([stageId, bossId]) => {
    const stage = stages.stageById(stageId);
    assert.equal(stage.battles.length, 1);
    assert.equal(stage.carryOverPlayerState, false);
    assert.deepEqual(stage.battles[0].enemies.map(enemyId), [bossId]);
  });
  assert.equal(enemyPosition(stages.stageById('BOSS_CHALLENGE_FORGE').battles[0].enemies[0]), 'front');
  assert.equal(enemyPosition(stages.stageById('BOSS_CHALLENGE_RANGE').battles[0].enemies[0]), 'back_1');
  assert.equal(enemyPosition(stages.stageById('BOSS_CHALLENGE_MAGE').battles[0].enemies[0]), 'back_1');
});

test('随机副本同Seed完全复现并满足一精英两小怪、合法前排与不重复约束', async (context) => {
  const { stages, monsterData } = await withModules(context);
  const first = stages.generateRandomDungeon(778899);
  const second = stages.generateRandomDungeon(778899);
  assert.deepEqual(first, second);
  assert.equal(first.length, 5);
  const lineupKeys = new Set();
  let previousElite = null;
  first.slice(0, 4).forEach((battle) => {
    const definitions = battle.enemies.map((entry) => monsterData.MONSTERS[enemyId(entry)]);
    battle.enemies.forEach((entry) => {
      assert.equal(typeof entry, 'object');
      const definition = monsterData.MONSTERS[enemyId(entry)];
      assert.equal(entry.overrides.maxHp, Math.ceil(definition.baseHp * stages.RANDOM_DUNGEON_PRE_BOSS_HP_MULTIPLIER));
    });
    assert.equal(definitions.filter((definition) => definition.category === 'elite').length, 1);
    assert.equal(definitions.filter((definition) => definition.category === 'minor').length, 2);
    assert.ok(battle.enemies.some((entry) => typeof entry !== 'string' && entry.position === 'front'));
    const elite = definitions.find((definition) => definition.category === 'elite');
    assert.notEqual(elite.id, previousElite);
    previousElite = elite.id;
    const key = definitions.map((definition) => definition.id).sort().join('|');
    assert.equal(lineupKeys.has(key), false);
    lineupKeys.add(key);
  });
  assert.equal(first[4].enemies.length, 1);
  const randomBoss = monsterData.MONSTERS[enemyId(first[4].enemies[0])];
  assert.equal(randomBoss.category, 'boss');
  assert.equal(enemyPosition(first[4].enemies[0]), randomBoss.defaultPosition === 'front' ? 'front' : 'back_1');
});

test('多怪战斗实例按配置生成三只独立敌人和行动位', async (context) => {
  const { stages, BattleGame, battleSystemConfig } = await withModules(context);
  const stage = stages.stageById('DUNGEON_FORGE');
  const enemies = stage.battles[1].enemies;
  const config = battleSystemConfig();
  const game = new BattleGame({
    config,
    selectedSpiritIds: config.creatureConfig.slice(0, 6).map((spirit) => spirit.id),
    enemies,
    battleSeed: 'fixed-stage-test'
  });
  assert.equal(game.getActiveEnemyIds().length, 3);
  assert.equal(game.state.round.actionSlots.filter((slot) => slot.type === 'boss').length, 3);
  assert.equal(new Set(game.getActiveEnemyIds()).size, 3);
});

test('连战快照继承当前阵容、站位、生命、死亡与妖力，不恢复初始首发', async (context) => {
  const { BattleGame, battleSystemConfig } = await withModules(context);
  const config = battleSystemConfig();
  const team = config.creatureConfig.slice(0, 6).map((spirit) => spirit.id);
  const game = new BattleGame({ config, selectedSpiritIds: team, enemies: [{ enemyId: 'FORGE_GRUNT_WARRIOR', position: 'front' }] });
  game.state.mana.current = 8;
  game.getSpirit(team[0]).hp = 100;
  game.getSpirit(team[1]).hp = 0;
  game.getSpirit(team[0]).statuses.regen = {
    id: 'regen', name: '回复', temporary: true, stackable: false, maxStacks: 1, stacks: 1,
    value: 0.1, duration: 2, skipCurrentOwnerActionEnd: false
  };
  game.getSpirit(team[0]).skillCooldowns.TEST = 3;
  game.getSpirit(team[0]).skillPowerGrowth.TEST = 20;
  game.getSpirit(team[0]).skillUseCounts.TEST = 1;
  game.state.slots[0].spiritId = team[3];
  game.state.slots[0].row = 'back';
  game['vacateDefeatedSpirit'](team[1]);
  const snapshot = game.createPlayerSnapshot();
  assert.equal(snapshot.mana.current, 8);
  assert.equal(snapshot.spirits[team[0]].hp, 100);
  assert.equal(snapshot.spirits[team[1]].hp, 0);
  assert.deepEqual(snapshot.spirits[team[0]].statuses, {});
  assert.deepEqual(snapshot.spirits[team[0]].skillCooldowns, {});
  assert.deepEqual(snapshot.spirits[team[0]].skillPowerGrowth, {});
  assert.deepEqual(snapshot.spirits[team[0]].skillUseCounts, {});
  assert.deepEqual(snapshot.slots.map((slot) => slot.spiritId), [team[3], null, team[2]]);
  assert.deepEqual(snapshot.slots.map((slot) => slot.row), game.state.slots.map((slot) => slot.row));

  const next = new BattleGame({ config, selectedSpiritIds: team, playerSnapshot: snapshot, enemies: [{ enemyId: 'FORGE_GRUNT_SHOOTER', position: 'back_1' }] });
  assert.equal(next.state.mana.current, 8);
  assert.equal(next.getSpirit(team[0]).hp, 100);
  assert.equal(next.getSpirit(team[1]).hp, 0);
  assert.deepEqual(next.state.slots, snapshot.slots);
  assert.deepEqual(next.getBenchSpiritIds(), [team[0], team[4], team[5]]);
});
