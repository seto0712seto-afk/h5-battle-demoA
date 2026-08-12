export type Row = 'front' | 'back';
export type DamageType = 'physical' | 'magic' | 'fixed' | 'none';
export type SkillKind = 'attack' | 'heal' | 'support' | 'buff' | 'debuff';
export type SkillTarget = 'boss' | 'ally-field' | 'ally-all' | 'self' | 'team-mana';
export type Phase = 'running' | 'player-action' | 'target-select' | 'forced-replacement' | 'victory' | 'defeat';
export type ActionContext = 'normal' | 'extra';
export type ActionSlotStatus = 'pending' | 'executing' | 'completed' | 'invalid' | 'skipped';
export type BossId = string;
export type EnemyBattlePosition = 'front' | 'back_1' | 'back_2';
export type BossPreviewSkillTag = 'single' | 'aoe' | 'status';
export type ManaGainSource = 'attack_on_hit' | 'hybrid_attack_charge' | 'charge_only' | 'kill_reward' | 'other';
export type SkillEnhanceCheckTiming = 'confirmation';
export type BattleBehavior = 'attack' | 'protect' | 'recover' | 'energy';

export type SkillEnhanceCondition =
  | { type: 'team_mana_at_least'; value: number }
  | { type: 'actor_hp_at_most'; ratio: number }
  | { type: 'actor_hp_above'; ratio: number }
  | { type: 'target_hp_at_most'; ratio: number }
  | { type: 'target_has_status'; statusId: string; minStacks?: number }
  | { type: 'actor_position'; row: Row }
  | { type: 'actor_status_stacks'; statusId: string; minStacks: number };

export interface SkillEnhanceEffect {
  powerBonus?: number;
  costReduction?: number;
  healPercentBonus?: number;
  fixedDamageBonus?: number;
  guaranteedCrit?: boolean;
  scaleByConditionValue?: boolean;
}

export interface SkillEnhanceRule {
  condition: SkillEnhanceCondition;
  reason: string;
  value: string;
  checkTiming?: SkillEnhanceCheckTiming;
  effect?: SkillEnhanceEffect;
}

export interface SkillButtonState {
  usable: boolean;
  enhanced: boolean;
  enhanceReason: string | null;
  enhanceValue: string | null;
  targetDependent: boolean;
  unavailableReason: string | null;
  actualCost: number;
  costDiscounted: boolean;
  manaGainOriginal: number;
  manaGainActual: number;
  powerBase: number;
  powerBonus: number;
  powerTotal: number;
  powerDetails: string[];
}

export interface UnitStats {
  maxHp: number;
  physicalAttack: number;
  physicalDefense: number;
  magicAttack: number;
  magicDefense: number;
  speed: number;
}

export interface SpiritData extends UnitStats {
  id: string;
  name: string;
  primaryRole: BattleBehavior;
  secondaryRole?: BattleBehavior;
  skillIds: string[];
  accent: string;
  defaultPosition: Row;
  shortDescription: string;
  battleStyle: string;
  playTip: string;
}

export interface SkillData {
  id: string;
  name: string;
  primaryBehavior: BattleBehavior;
  secondaryBehavior?: BattleBehavior;
  kind: SkillKind;
  damageType: DamageType;
  target: SkillTarget;
  excludeSelfTarget?: boolean;
  power?: number;
  cost: number;
  gain: number;
  manaGainSource?: ManaGainSource;
  cooldown?: number;
  hitCount?: number;
  costAllMana?: boolean;
  restoreManaTo?: number;
  gainCap?: number;
  gainWhenManaBelow?: number;
  fullManaCostReduction?: number;
  fullManaPowerBonusRatio?: number;
  fullManaHealBonusPercent?: number;
  fullManaCrit?: boolean;
  alwaysCrit?: boolean;
  highHpCritThreshold?: number;
  critIfDamageAmp?: boolean;
  healPercent?: number;
  healSelfAndTargetPercent?: number;
  teamHealPercent?: number;
  shieldPercent?: number;
  shieldValue?: number;
  teamShieldValue?: number;
  bonusDamageFromShield?: boolean;
  shieldToFixedDamageRatio?: number;
  maxConvertedShield?: number;
  bonusDamageCanCrit?: boolean;
  addDamageAmpStacks?: number;
  addChargeTurns?: number;
  addRegenTurns?: number;
  selfHealPercent?: number;
  frontHealPercent?: number;
  healFlatValue?: number;
  selfHpCostPercent?: number;
  addEnergySaving?: boolean;
  addBossVulnerabilityTurns?: number;
  consecutiveUseCostReduction?: number;
  minimumCost?: number;
  resetConsecutiveUseAtMinimumCost?: boolean;
  firstUseInBattleCostReduction?: number;
  firstSkillAfterEntryCostReduction?: number;
  consecutivePowerBonus?: number;
  permanentPowerGain?: number;
  selfPhysicalAttackBonus?: number;
  selfMagicAttackBonus?: number;
  nextSkillPowerBonus?: number;
  resetOwnCooldowns?: boolean;
  fixedDamage?: number;
  grantsExtraAction?: boolean;
  enhanceRules?: SkillEnhanceRule[];
  description?: string;
}

export interface RuntimeStatus {
  id: string;
  name: string;
  temporary: boolean;
  stackable: boolean;
  maxStacks: number;
  stacks: number;
  value: number;
  duration: number;
  skipCurrentOwnerActionEnd: boolean;
  clearOnBench?: boolean;
  sourceId?: string;
  instanceId?: string;
  sourceUnitId?: string;
  sourceSkillId?: string;
}

export interface RuntimeShieldInstance {
  id: string;
  sourceUnitId: string;
  sourceSkillId?: string;
  generated: number;
  remaining: number;
  createdOrder: number;
}

export interface BossPreviewSkill {
  id: string;
  name: string;
  tags: BossPreviewSkillTag[];
  behaviorCategory: string;
  targetDescription: string;
  damageTypeDescription?: string;
  power?: number;
  cooldown: number;
  telegraphFollowupName?: string;
  description: string;
}

export interface BossDisplayData {
  displayName: string;
  portraitKey?: string;
  shortDescription?: string;
  previewSkills: BossPreviewSkill[];
}

export interface BossData extends UnitStats {
  id: BossId;
  name: string;
  display?: BossDisplayData;
}

export interface RuntimeSpirit {
  id: string;
  hp: number;
  action: number;
  shieldNextBossAction: number;
  physicalAttackBonus: number;
  magicAttackBonus: number;
  speedModifier: number;
  nextSkillPowerBonus: number;
  skillCooldowns: Record<string, number>;
  skillPowerGrowth: Record<string, number>;
  lastSkillId: string | null;
  skillUseStreak: number;
  skillUseCounts: Record<string, number>;
  entrySkillAvailable: boolean;
  entrySequenceId: number;
  skillUseIndexAfterEntry: number;
  damageAmpStacks: number;
  freshDamageAmpStacks: number;
  chargeTurns: number;
  freshChargeTurns: number;
  regenTurns: number;
  freshRegenTurns: number;
  shieldValue: number;
  freshShieldValue: number;
  shieldInstances: RuntimeShieldInstance[];
  statuses: Record<string, RuntimeStatus>;
}

export interface FieldSlot {
  index: number;
  spiritId: string | null;
  row: Row;
}

export interface BossRuntime {
  hp: number;
  maxHp: number;
  action: number;
  cooldowns: Record<string, number>;
  statuses: Record<string, RuntimeStatus>;
}

export interface RuntimeEnemy extends BossRuntime, UnitStats {
  id: string;
  definitionId: string;
  name: string;
  row: Row;
  position: EnemyBattlePosition;
  category: 'minor' | 'elite' | 'boss';
}

export interface EnemyFieldSlot {
  position: EnemyBattlePosition;
  row: Row;
  enemyId: string | null;
}

export interface TeamMana {
  current: number;
  max: number;
}

export interface ActiveUnit {
  type: 'spirit' | 'boss';
  id: string;
}

export interface ReplacementState {
  slotIndex: number;
  row: Row;
  candidates: string[];
  reason: string;
}

export interface RoundActionSlot {
  key: string;
  type: 'spirit' | 'boss';
  unitId: string;
  speed: number;
  creationOrder: number;
  status: ActionSlotStatus;
}

export interface BattleRoundState {
  index: number;
  actionSlots: RoundActionSlot[];
  cursor: number;
  pendingReplacementSlotIndexes: number[];
}

export interface HitFeedback {
  spiritIds: string[];
  serial: number;
}

export interface BattleFxEvent {
  serial: number;
  kind: 'player-attack' | 'player-heal' | 'player-support' | 'player-buff' | 'player-debuff' | 'boss-attack' | 'boss-buff';
  actorId?: string;
  enemyActorId?: string;
  actorRow?: Row;
  targetIds?: string[];
  targetEnemyIds?: string[];
  skillName?: string;
  bossBehaviorName?: string;
  telegraphSkillName?: string;
  amount?: number;
  targetAmounts?: Record<string, number>;
  manaBefore: number;
  manaAfter: number;
  manaCost: number;
  manaGain: number;
}

export interface BattleState {
  phase: Phase;
  selectedSpiritIds: string[];
  spirits: Record<string, RuntimeSpirit>;
  slots: FieldSlot[];
  boss: RuntimeEnemy;
  enemies: Record<string, RuntimeEnemy>;
  enemySlots: EnemyFieldSlot[];
  mana: TeamMana;
  activeUnit: ActiveUnit | null;
  pendingSkillId: string | null;
  replacement: ReplacementState | null;
  hitFeedback: HitFeedback | null;
  battleFx: BattleFxEvent | null;
  logs: string[];
  logSerial: number;
  actionSerial: number;
  tick: number;
  actionContext: ActionContext;
  round: BattleRoundState;
}

export interface PlayerBattleSnapshot {
  selectedSpiritIds: string[];
  spirits: Record<string, RuntimeSpirit>;
  slots: FieldSlot[];
  mana: TeamMana;
}

export type StageEnemyConfig = BossId | {
  enemyId: BossId;
  position?: EnemyBattlePosition;
  level?: number;
  overrides?: Partial<BossData>;
};

export interface StageBattleConfig {
  battleId: string;
  enemies: StageEnemyConfig[];
}

export interface StageConfig {
  id: string;
  name: string;
  description: string;
  type?: 'fixed' | 'random';
  seed?: number;
  battles: StageBattleConfig[];
  carryOverPlayerState: boolean;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
}
