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
  const [stages, monsterData, battleModule, battleSystems, prebattle, uiModule, integrationModule] = await Promise.all([
    vite.ssrLoadModule('/src/stages.ts'),
    vite.ssrLoadModule('/src/monsterData.ts'),
    vite.ssrLoadModule('/src/battle.ts'),
    vite.ssrLoadModule('/src/battleSystems.ts'),
    vite.ssrLoadModule('/src/prebattle.ts'),
    vite.ssrLoadModule('/src/ui.ts'),
    vite.ssrLoadModule('/src/battleIntegration.ts')
  ]);
  return {
    stages,
    monsterData,
    BattleGame: battleModule.BattleGame,
    BattleUI: uiModule.BattleUI,
    createBattleLifecycleStop: integrationModule.createBattleLifecycleStop,
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

test('Aries player instances keep duplicate definitions, initial HP, and result identity', async (context) => {
  const { BattleGame, battleSystemConfig } = await withModules(context);
  const config = battleSystemConfig();
  const definitionId = config.creatureConfig[0].id;
  const participants = [
    { instanceId: 'owned-001', spiritDefinitionId: definitionId, currentHp: 37 },
    { instanceId: 'owned-009', spiritDefinitionId: definitionId, currentHp: 52 }
  ];
  const game = new BattleGame({
    config,
    playerParticipants: participants,
    enemies: [{ enemyId: 'FORGE_GRUNT_WARRIOR', position: 'front' }]
  });

  assert.deepEqual(game.state.selectedSpiritIds, ['owned-001', 'owned-009']);
  assert.notStrictEqual(game.getSpirit('owned-001'), game.getSpirit('owned-009'));
  assert.equal(game.getSpirit('owned-001').spiritDefinitionId, definitionId);
  assert.equal(game.getSpirit('owned-009').spiritDefinitionId, definitionId);
  assert.equal(game.getSpirit('owned-001').hp, 37);
  assert.equal(game.getSpirit('owned-009').hp, 52);

  game.getSpirit('owned-001').hp = 21;
  game.getSpirit('owned-009').hp = 46;
  const snapshot = game.createPlayerSnapshot();
  assert.deepEqual(snapshot.selectedSpiritIds, ['owned-001', 'owned-009']);
  assert.equal(snapshot.spirits['owned-001'].spiritDefinitionId, definitionId);
  assert.equal(snapshot.spirits['owned-009'].spiritDefinitionId, definitionId);
  assert.equal(snapshot.spirits['owned-001'].hp, 21);
  assert.equal(snapshot.spirits['owned-009'].hp, 46);

  const next = new BattleGame({
    config,
    playerSnapshot: snapshot,
    enemies: [{ enemyId: 'FORGE_GRUNT_SHOOTER', position: 'back_1' }]
  });
  assert.equal(next.getSpirit('owned-001').spiritDefinitionId, definitionId);
  assert.equal(next.getSpirit('owned-009').spiritDefinitionId, definitionId);
  assert.equal(next.getSpirit('owned-001').hp, 21);
  assert.equal(next.getSpirit('owned-009').hp, 46);
});

test('Aries six-instance input uses three starters and three independent reserves', async (context) => {
  const { BattleGame, battleSystemConfig } = await withModules(context);
  const config = battleSystemConfig();
  const definitions = config.creatureConfig.slice(0, 3).map((spirit) => spirit.id);
  const participants = Array.from({ length: 6 }, (_, index) => ({
    instanceId: `owned-${index + 1}`,
    spiritDefinitionId: definitions[index % definitions.length],
    currentHp: 30 + index
  }));
  const game = new BattleGame({
    config,
    playerParticipants: participants,
    enemies: [{ enemyId: 'FORGE_GRUNT_WARRIOR', position: 'front' }]
  });

  assert.deepEqual(game.state.slots.map((slot) => slot.spiritId), ['owned-1', 'owned-2', 'owned-3']);
  assert.deepEqual(game.getBenchSpiritIds(), ['owned-4', 'owned-5', 'owned-6']);
  assert.equal(Object.keys(game.state.spirits).length, 6);
});

test('standalone definition-id selection remains a compatible full-HP input', async (context) => {
  const { BattleGame, battleSystemConfig } = await withModules(context);
  const config = battleSystemConfig();
  const selectedSpiritIds = config.creatureConfig.slice(0, 2).map((spirit) => spirit.id);
  const game = new BattleGame({
    config,
    selectedSpiritIds,
    enemies: [{ enemyId: 'FORGE_GRUNT_WARRIOR', position: 'front' }]
  });

  assert.deepEqual(game.state.selectedSpiritIds, selectedSpiritIds);
  selectedSpiritIds.forEach((id) => {
    const definition = config.creatureConfig.find((spirit) => spirit.id === id);
    assert.equal(game.getSpirit(id).spiritDefinitionId, id);
    assert.equal(game.getSpirit(id).hp, definition.maxHp);
  });
});

test('BattleGame stop clears the mounted main-loop interval and remains idempotent', async (context) => {
  const { BattleGame, battleSystemConfig } = await withModules(context);
  const timers = installLifecycleTestGlobals();
  try {
    const config = battleSystemConfig();
    const game = new BattleGame({
      config,
      selectedSpiritIds: [config.creatureConfig[0].id],
      enemies: [{ enemyId: 'FORGE_GRUNT_WARRIOR', position: 'front' }]
    });
    let stateUpdates = 0;
    const unsubscribe = game.subscribe(() => {
      stateUpdates += 1;
    });

    game.start();
    assert.equal(timers.intervals.size, 1);
    const mainLoop = [...timers.intervals.values()][0];
    mainLoop();
    assert.ok(stateUpdates > 1);

    game.stop();
    game.stop();
    assert.equal(timers.intervals.size, 0);
    const updatesAfterStop = stateUpdates;
    timers.runActiveIntervals();
    assert.equal(stateUpdates, updatesAfterStop);
    unsubscribe();
  } finally {
    timers.restore();
  }
});

test('mounted lifecycle stop disposes UI subscriptions, timers, transient nodes, and repeated calls', async (context) => {
  const { BattleUI, createBattleLifecycleStop } = await withModules(context);
  const timers = installLifecycleTestGlobals();
  try {
    let uiListener = null;
    let uiUnsubscribes = 0;
    let gameStarts = 0;
    let gameStops = 0;
    let resultUnsubscribes = 0;
    const game = {
      state: {},
      subscribe(listener) {
        uiListener = listener;
        listener({});
        return () => {
          uiUnsubscribes += 1;
        };
      },
      start() {
        gameStarts += 1;
      },
      stop() {
        gameStops += 1;
      }
    };
    const root = {
      innerHTML: 'mounted battle',
      querySelectorAll: () => []
    };
    const ui = new BattleUI(root, game, {});
    let renders = 0;
    ui.render = () => {
      renders += 1;
    };
    ui.mount();
    assert.equal(gameStarts, 1);
    assert.equal(renders, 1);

    let timerCallbacks = 0;
    ui.scheduleTimeout(() => {
      timerCallbacks += 1;
    }, 100);
    ui.scheduleInterval(() => {
      timerCallbacks += 1;
    }, 100);
    const staleTimeout = [...timers.timeouts.values()][0];
    const staleInterval = [...timers.intervals.values()][0];
    const transientNode = {
      removed: false,
      remove() {
        this.removed = true;
      }
    };
    ui.transientNodes.add(transientNode);

    const stop = createBattleLifecycleStop(game, ui, () => {
      resultUnsubscribes += 1;
    });
    stop();
    stop();

    assert.equal(gameStops, 1);
    assert.equal(resultUnsubscribes, 1);
    assert.equal(uiUnsubscribes, 1);
    assert.equal(timers.timeouts.size, 0);
    assert.equal(timers.intervals.size, 0);
    assert.equal(transientNode.removed, true);
    assert.equal(root.innerHTML, '');

    uiListener({});
    staleTimeout();
    staleInterval();
    assert.equal(renders, 1);
    assert.equal(timerCallbacks, 0);
  } finally {
    timers.restore();
  }
});

function installLifecycleTestGlobals() {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let nextHandle = 1;
  const timeouts = new Map();
  const intervals = new Map();
  globalThis.window = {
    performance: { now: () => 0 },
    setTimeout(callback) {
      const handle = nextHandle++;
      timeouts.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      timeouts.delete(handle);
    },
    setInterval(callback) {
      const handle = nextHandle++;
      intervals.set(handle, callback);
      return handle;
    },
    clearInterval(handle) {
      intervals.delete(handle);
    }
  };
  globalThis.document = {
    body: {
      append() {},
      classList: { remove() {} }
    }
  };
  return {
    timeouts,
    intervals,
    runActiveIntervals() {
      [...intervals.values()].forEach((callback) => callback());
    },
    restore() {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  };
}
