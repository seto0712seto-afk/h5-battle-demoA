import { MONSTERS, RANDOM_BOSS_POOL, RANDOM_ELITE_POOL, RANDOM_GRUNT_POOL } from './monsterData';
import { calculateMonsterStats, SeededBattleRandom } from './monsterSystem';
import type { EnemyBattlePosition, StageBattleConfig, StageConfig, StageEnemyConfig } from './types';

export const DUNGEON_FORGE = 'DUNGEON_FORGE';
export const DUNGEON_RANGE = 'DUNGEON_RANGE';
export const DUNGEON_MAGE = 'DUNGEON_MAGE';
export const DUNGEON_RANDOM = 'DUNGEON_RANDOM';
export const BOSS_CHALLENGE_FORGE = 'BOSS_CHALLENGE_FORGE';
export const BOSS_CHALLENGE_RANGE = 'BOSS_CHALLENGE_RANGE';
export const BOSS_CHALLENGE_MAGE = 'BOSS_CHALLENGE_MAGE';
export const DEFAULT_RANDOM_DUNGEON_SEED = 20260722;
export const RANDOM_DUNGEON_PRE_BOSS_HP_MULTIPLIER = 0.8;

function enemy(enemyId: string, position: EnemyBattlePosition): StageEnemyConfig {
  return { enemyId, position };
}

function randomDungeonEnemy(enemyId: string, position: EnemyBattlePosition): StageEnemyConfig {
  const maxHp = Math.ceil(calculateMonsterStats(MONSTERS[enemyId]).maxHp * RANDOM_DUNGEON_PRE_BOSS_HP_MULTIPLIER);
  return { enemyId, position, overrides: { maxHp } };
}

function battle(dungeonId: string, stage: number, enemies: StageEnemyConfig[]): StageBattleConfig {
  return { battleId: `${dungeonId}_BATTLE_${stage}`, enemies };
}

const SINGLE_BOSS_STAGES: StageConfig[] = [
  {
    id: BOSS_CHALLENGE_FORGE,
    name: '熔核守卫挑战',
    description: '单场挑战熔核守卫，验证前排重击与锁定位置爆发。',
    type: 'fixed',
    carryOverPlayerState: false,
    battles: [battle(BOSS_CHALLENGE_FORGE, 1, [enemy('FORGE_BOSS_WARRIOR', 'front')])]
  },
  {
    id: BOSS_CHALLENGE_RANGE,
    name: '灰羽猎王挑战',
    description: '单场挑战灰羽猎王，验证后排群压、随机狙击与锁定点杀。',
    type: 'fixed',
    carryOverPlayerState: false,
    battles: [battle(BOSS_CHALLENGE_RANGE, 1, [enemy('RANGE_BOSS_SHOOTER', 'back_1')])]
  },
  {
    id: BOSS_CHALLENGE_MAGE,
    name: '炽印法主挑战',
    description: '单场挑战炽印法主，验证三次攻击后强制强化的阶梯式压力。',
    type: 'fixed',
    carryOverPlayerState: false,
    battles: [battle(BOSS_CHALLENGE_MAGE, 1, [enemy('MAGE_BOSS', 'back_1')])]
  }
];

const FIXED_STAGES: StageConfig[] = [
  {
    id: DUNGEON_FORGE,
    name: '熔核工坊',
    description: '战士主题五场连战：前排持续承伤、单体重击与锁位斩杀。',
    type: 'fixed',
    carryOverPlayerState: true,
    battles: [
      battle(DUNGEON_FORGE, 1, [enemy('FORGE_GRUNT_WARRIOR', 'front'), enemy('FORGE_GRUNT_SHOOTER', 'back_1')]),
      battle(DUNGEON_FORGE, 2, [enemy('FORGE_GRUNT_WARRIOR', 'front'), enemy('FORGE_GRUNT_SHOOTER', 'back_1'), enemy('FORGE_GRUNT_MAGE', 'back_2')]),
      battle(DUNGEON_FORGE, 3, [enemy('FORGE_ELITE_WARRIOR', 'front'), enemy('FORGE_GRUNT_SHOOTER', 'back_1')]),
      battle(DUNGEON_FORGE, 4, [enemy('FORGE_ELITE_WARRIOR', 'front'), enemy('FORGE_GRUNT_SHOOTER', 'back_1'), enemy('FORGE_GRUNT_MAGE', 'back_2')]),
      battle(DUNGEON_FORGE, 5, [enemy('FORGE_BOSS_WARRIOR', 'front')])
    ]
  },
  {
    id: DUNGEON_RANGE,
    name: '雷鸣矿区',
    description: '射手主题五场连战：后排群压、随机点名与锁定救援。',
    type: 'fixed',
    carryOverPlayerState: true,
    battles: [
      battle(DUNGEON_RANGE, 1, [enemy('RANGE_GRUNT_WARRIOR', 'front'), enemy('RANGE_GRUNT_SHOOTER', 'back_1')]),
      battle(DUNGEON_RANGE, 2, [enemy('RANGE_GRUNT_WARRIOR', 'front'), enemy('RANGE_GRUNT_SHOOTER', 'back_1'), enemy('RANGE_GRUNT_SHOOTER', 'back_2')]),
      battle(DUNGEON_RANGE, 3, [enemy('RANGE_GRUNT_WARRIOR', 'front'), enemy('RANGE_ELITE_SHOOTER', 'back_1')]),
      battle(DUNGEON_RANGE, 4, [enemy('RANGE_ELITE_WARRIOR', 'front'), enemy('RANGE_ELITE_SHOOTER', 'back_1'), enemy('RANGE_GRUNT_SHOOTER', 'back_2')]),
      battle(DUNGEON_RANGE, 5, [enemy('RANGE_BOSS_SHOOTER', 'back_1')])
    ]
  },
  {
    id: DUNGEON_MAGE,
    name: '苔生遗迹',
    description: '法师主题五场连战：Boss 每三次攻击后的下一行动强化，拖延越久压力越高。',
    type: 'fixed',
    carryOverPlayerState: true,
    battles: [
      battle(DUNGEON_MAGE, 1, [enemy('MAGE_GRUNT_WARRIOR', 'front'), enemy('MAGE_GRUNT_MAGE', 'back_1')]),
      battle(DUNGEON_MAGE, 2, [enemy('MAGE_GRUNT_WARRIOR', 'front'), enemy('MAGE_GRUNT_SHOOTER', 'back_1'), enemy('MAGE_GRUNT_MAGE', 'back_2')]),
      battle(DUNGEON_MAGE, 3, [enemy('MAGE_ELITE_WARRIOR', 'front'), enemy('MAGE_ELITE_MAGE', 'back_1')]),
      battle(DUNGEON_MAGE, 4, [enemy('MAGE_ELITE_WARRIOR', 'front'), enemy('MAGE_GRUNT_SHOOTER', 'back_1'), enemy('MAGE_ELITE_MAGE', 'back_2')]),
      battle(DUNGEON_MAGE, 5, [enemy('MAGE_BOSS', 'back_1')])
    ]
  }
];

export function generateRandomDungeon(seed: number): StageBattleConfig[] {
  const random = new SeededBattleRandom(seed);
  const battles: StageBattleConfig[] = [];
  const usedLineups = new Set<string>();
  let previousEliteId: string | null = null;

  for (let stage = 1; stage <= 4; stage += 1) {
    let generated: StageEnemyConfig[] | null = null;
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const eliteCandidates = RANDOM_ELITE_POOL.filter((id) => id !== previousEliteId);
      const eliteId = pick(eliteCandidates, random, `random_dungeon_stage_${stage}_elite_attempt_${attempt}`);
      const elite = MONSTERS[eliteId];
      let lineup: StageEnemyConfig[];
      if (elite.role === 'warrior') {
        const backCandidates = RANDOM_GRUNT_POOL.filter((id) => MONSTERS[id].role !== 'warrior');
        const first = pick(backCandidates, random, `random_dungeon_stage_${stage}_back_1_attempt_${attempt}`);
        const second = pick(backCandidates.filter((id) => id !== first), random, `random_dungeon_stage_${stage}_back_2_attempt_${attempt}`);
        lineup = [randomDungeonEnemy(eliteId, 'front'), randomDungeonEnemy(first, 'back_1'), randomDungeonEnemy(second, 'back_2')];
      } else {
        const warriorId = pick(RANDOM_GRUNT_POOL.filter((id) => MONSTERS[id].role === 'warrior'), random, `random_dungeon_stage_${stage}_front_attempt_${attempt}`);
        const backId = pick(RANDOM_GRUNT_POOL.filter((id) => MONSTERS[id].role !== 'warrior'), random, `random_dungeon_stage_${stage}_back_2_attempt_${attempt}`);
        lineup = [randomDungeonEnemy(warriorId, 'front'), randomDungeonEnemy(eliteId, 'back_1'), randomDungeonEnemy(backId, 'back_2')];
      }
      const key = lineup.map(stageEnemyId).sort().join('|');
      if (usedLineups.has(key)) continue;
      usedLineups.add(key);
      previousEliteId = eliteId;
      generated = lineup;
      break;
    }
    if (!generated) throw new Error(`Random dungeon configuration failed at stage ${stage} after 50 attempts.`);
    battles.push(battle(DUNGEON_RANDOM, stage, generated));
  }

  const bossId = pick(RANDOM_BOSS_POOL, random, 'random_dungeon_stage_5_boss');
  const bossPosition: EnemyBattlePosition = MONSTERS[bossId].defaultPosition === 'front' ? 'front' : 'back_1';
  battles.push(battle(DUNGEON_RANDOM, 5, [enemy(bossId, bossPosition)]));
  return battles;
}

const RANDOM_STAGE: StageConfig = {
  id: DUNGEON_RANDOM,
  name: '万象裂隙',
  description: 'Seed 决定阵容的随机五场连战：前四场各一只精英怪与两只小怪，第五场随机 Boss。',
  type: 'random',
  seed: DEFAULT_RANDOM_DUNGEON_SEED,
  carryOverPlayerState: true,
  battles: generateRandomDungeon(DEFAULT_RANDOM_DUNGEON_SEED)
};

export const STAGES: StageConfig[] = [...SINGLE_BOSS_STAGES, ...FIXED_STAGES, RANDOM_STAGE];

export function stageById(stageId: string, seed = DEFAULT_RANDOM_DUNGEON_SEED) {
  const stage = STAGES.find((item) => item.id === stageId);
  if (!stage) throw new Error('Unknown stage: ' + stageId);
  if (stage.type !== 'random') return stage;
  return { ...stage, seed, battles: generateRandomDungeon(seed) };
}

export function stageEnemyId(config: StageEnemyConfig) {
  return typeof config === 'string' ? config : config.enemyId;
}

function pick<T>(items: T[], random: SeededBattleRandom, label: string): T {
  if (items.length === 0) throw new Error('Cannot pick from an empty pool: ' + label);
  const trace = random.next(label);
  return items[Math.min(items.length - 1, Math.floor(trace.value * items.length))];
}
