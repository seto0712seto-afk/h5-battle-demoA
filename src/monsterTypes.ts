import type { Row } from './types';

export type MonsterCategory = 'minor' | 'elite' | 'boss';
export type MonsterRole = 'warrior' | 'shooter' | 'mage';
export type MonsterDamageType = 'physical' | 'magical' | 'fixed' | 'none';
export type MonsterTargetRule = 'enemy_single' | 'enemy_all' | 'self';
export type MonsterTargetPreference = 'front' | 'back' | 'all';
export type MonsterSkillSelectionMode = 'weighted' | 'sequence' | 'forced_opening' | 'forced_followup';
export type MonsterSpecialEffect = 'apply_exposed';

export type MonsterSkillEffect =
  | {
      type: 'apply_status';
      statusId: string;
      name: string;
      duration?: number;
      value?: number;
      temporary?: boolean;
      clearOnBench?: boolean;
      stackable?: boolean;
      maxStacks?: number;
      stacks?: number;
    }
  | {
      type: 'increase_runtime_skill_power';
      targetSkillId: string;
      amount: number;
    }
  | {
      type: 'set_runtime_skill_temporary_power';
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
  consumeTemporaryPowerAfterUse?: boolean;
  targetStatusDamageInteraction?: {
    statusId: string;
    finalDamageMultiplierPerStack?: number;
    shieldPenetration?: {
      mode: 'percentage' | 'flat';
      amountPerStack: number;
      maxValue?: number;
      settlement: 'bypass';
    };
  };
}

export interface MonsterSkillDefinition {
  id: string;
  tier: string;
  name: string;
  element?: string;
  behaviorCategory: string;
  cooldown: number;
  isBasicAttack: boolean;
  execution: SkillExecutionConfig;
  description: string;
}

export interface MonsterDefinition {
  id: string;
  name: string;
  element?: string;
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
  raceStats?: MonsterFinalStats;
  growthRates?: {
    hp: number;
    other: number;
  };
  skillSequence?: string[];
  actionCycle?: {
    counterLabel: string;
    countedSkillIds: string[];
    threshold: number;
    forcedSkillId: string;
  };
  temporaryPowerResponse?: {
    targetSkillId: string;
    reductionPerPlayerAttack: number;
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
  temporarySkillPowerBonuses: Record<string, number>;
  actionCycleCount: number;
  lastTargetIdBySkill: Record<string, string>;
  sequenceIndex: number;
}

export interface MonsterRandomTrace {
  callIndex: number;
  label: string;
  value: number;
}

export interface MonsterActionSelection {
  skillId: string | null;
  source: 'forced_followup' | 'forced_opening' | 'sequence' | 'weighted' | 'basic_fallback' | 'skip';
  randomTrace?: MonsterRandomTrace;
  lockedTargetId?: string;
  lockedSlotIndex?: number;
  lockedRow?: Row;
  lockedOriginSlotIndex?: number;
  lockedOriginRow?: Row;
}
