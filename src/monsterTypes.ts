import type { Row } from './types';

export type MonsterCategory = 'minor' | 'elite' | 'boss';
export type MonsterRole = 'warrior' | 'shooter' | 'mage';
export type MonsterDamageType = 'physical' | 'magical' | 'fixed' | 'none';
export type MonsterTargetRule = 'enemy_single' | 'enemy_all' | 'self';
export type MonsterTargetPreference = 'front' | 'back' | 'all';
export type MonsterSkillSelectionMode = 'weighted' | 'forced_opening' | 'forced_followup';
export type MonsterSpecialEffect = 'apply_exposed';

export type MonsterSkillEffect =
  | {
      type: 'apply_status';
      statusId: string;
      name: string;
      duration: number;
      value: number;
    }
  | {
      type: 'increase_runtime_skill_power';
      targetSkillId: string;
      amount: number;
    };

export interface MonsterSkillLoadoutEntry {
  skillId: string;
  weight: number;
  selectionMode?: MonsterSkillSelectionMode;
}

export interface SkillExecutionConfig {
  power?: number;
  damageType?: MonsterDamageType;
  targetRule: MonsterTargetRule;
  targetPreference?: MonsterTargetPreference;
  targetSelection?: 'random' | 'controlled_random_no_immediate_repeat';
  telegraph?: {
    enabled: boolean;
    followupSkillId?: string;
    targetSelection?: 'random_legal_single_target' | 'none';
    lockMode?: 'unit' | 'position' | 'none';
    invalidTargetResult?: 'whiff' | 'retarget';
  };
  status?: {
    statusId: string;
    stacksAdded: number;
    maxStacks: number | null;
    perStackValue: number;
    stackingMode: 'additive';
    duration: 'battle';
  };
  effects?: MonsterSkillEffect[];
  specialEffects?: MonsterSpecialEffect[];
}

export interface MonsterSkillDefinition {
  id: string;
  tier: string;
  name: string;
  behaviorCategory: string;
  cooldown: number;
  isBasicAttack: boolean;
  execution: SkillExecutionConfig;
  description: string;
}

export interface MonsterDefinition {
  id: string;
  name: string;
  level: number;
  category: MonsterCategory;
  role?: MonsterRole;
  defaultPosition: Row;
  coefficients: {
    physicalAttack: number;
    physicalDefense: number;
    magicAttack: number;
    magicDefense: number;
    speed: number;
  };
  baseHp: number;
  skills: MonsterSkillLoadoutEntry[];
  actionCycle?: {
    counterLabel: string;
    countedSkillIds: string[];
    threshold: number;
    forcedSkillId: string;
  };
}

export interface MonsterFinalStats {
  maxHp: number;
  physicalAttack: number;
  physicalDefense: number;
  magicAttack: number;
  magicDefense: number;
  speed: number;
}

export interface MonsterInstanceOverrides {
  level?: number;
  stats?: Partial<MonsterFinalStats>;
}

export interface MonsterInstance {
  definitionId: string;
  level: number;
  stats: MonsterFinalStats;
}

export interface MonsterPendingFollowup {
  skillId: string;
  lockedTargetId?: string;
  lockedSlotIndex?: number;
  lockedRow?: Row;
  lockedOriginSlotIndex?: number;
  lockedOriginRow?: Row;
}

export interface MonsterAiRuntime {
  pendingFollowup: MonsterPendingFollowup | null;
  actLastNextRound: boolean;
  usedForcedOpeningSkillIds: string[];
  damageIncreaseStacks: number;
  exposedActive: boolean;
  runtimeSkillPowers: Record<string, number>;
  actionCycleCount: number;
  lastTargetIdBySkill: Record<string, string>;
}

export interface MonsterRandomTrace {
  callIndex: number;
  label: string;
  value: number;
}

export interface MonsterActionSelection {
  skillId: string | null;
  source: 'forced_followup' | 'forced_opening' | 'weighted' | 'basic_fallback' | 'skip';
  randomTrace?: MonsterRandomTrace;
  lockedTargetId?: string;
  lockedSlotIndex?: number;
  lockedRow?: Row;
  lockedOriginSlotIndex?: number;
  lockedOriginRow?: Row;
}
