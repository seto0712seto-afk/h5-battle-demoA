import { SKILLS, SPIRITS, TEAM_MANA_INITIAL, TEAM_MANA_MAX } from './data';
import { MONSTERS, MONSTER_SKILLS } from './monsterData';
import { createMonsterInstance } from './monsterSystem';
import type { BossData, BossId, BossPreviewSkill, SkillData, SpiritData } from './types';

export interface PresetTeam {
  id: string;
  spiritIds: string[];
}

export interface BattleSystemConfig {
  name: string;
  creatureConfig: SpiritData[];
  skillConfig: Record<string, SkillData>;
  bossConfig: BossData;
  bossConfigsById?: Record<BossId, BossData>;
  defaultBossId?: BossId;
  teamMana: {
    initial: number;
    max: number;
  };
  fullManaThreshold: number;
  preBattlePresets: PresetTeam[];
  selectionLimit: number;
  requiredSelection: number;
  monsterDefinitionId: string;
  monsterExposedDamageTakenMultiplier: number;
}

const presetTeams: PresetTeam[] = [
  {
    id: 'preset-a',
    spiritIds: ['P01', 'P04', 'P07', 'P05', 'P06', 'P09']
  },
  {
    id: 'preset-b',
    spiritIds: ['P02', 'P08', 'P10', 'P03', 'P06', 'P07']
  }
];

function bossDataFromMonster(monsterId: string): BossData {
  const monster = MONSTERS[monsterId];
  const instance = createMonsterInstance(monster);
  return {
    id: monster.id,
    name: monster.name,
    ...instance.stats,
    display: {
      displayName: monster.name,
      portraitKey: 'boss-default',
      shortDescription: `${monster.category === 'boss' ? 'Boss' : monster.category === 'elite' ? '精英怪' : '小怪'} · ${monster.role}`,
      previewSkills: monster.skills
        .map<BossPreviewSkill>((entry) => {
          const skill = MONSTER_SKILLS[entry.skillId];
          return {
            id: skill.id,
            name: skill.name,
            tags: skill.execution.targetRule === 'enemy_all' ? ['aoe'] : skill.execution.damageType === 'none' ? ['status'] : ['single'],
            description: skill.description
          };
        })
    }
  };
}

const bossConfigsById: Record<BossId, BossData> = Object.fromEntries(
  Object.keys(MONSTERS).map((id) => [id, bossDataFromMonster(id)])
);
const DEFAULT_ENEMY = bossConfigsById.FORGE_BOSS_WARRIOR;

const BATTLE_CONFIG: BattleSystemConfig = {
  name: '核心战斗系统',
  creatureConfig: SPIRITS,
  skillConfig: SKILLS,
  bossConfig: DEFAULT_ENEMY,
  bossConfigsById,
  defaultBossId: DEFAULT_ENEMY.id,
  teamMana: {
    initial: TEAM_MANA_INITIAL,
    max: TEAM_MANA_MAX
  },
  fullManaThreshold: 5,
  preBattlePresets: presetTeams,
  selectionLimit: 6,
  requiredSelection: 1,
  monsterDefinitionId: 'FORGE_BOSS_WARRIOR',
  monsterExposedDamageTakenMultiplier: 2
};

export function battleSystemConfig() {
  return BATTLE_CONFIG;
}

export function battleSystemConfigWithBoss(bossId?: BossId) {
  return resolveSelectedBossConfig(BATTLE_CONFIG, bossId);
}

export function resolveSelectedBossConfig(config: BattleSystemConfig, bossId?: BossId): BattleSystemConfig {
  const selectedBossId = bossId ?? config.defaultBossId;
  if (!selectedBossId || config.bossConfig.id === selectedBossId || !config.bossConfigsById) return config;
  const bossConfig = config.bossConfigsById[selectedBossId] ?? config.bossConfig;
  if (bossConfig === config.bossConfig) return config;
  return {
    ...config,
    bossConfig
  };
}
