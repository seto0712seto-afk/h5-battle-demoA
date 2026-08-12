import type { ActionContext, Row } from './types';

export type TelemetrySide = 'player' | 'enemy';

export type UnifiedBattleEventType =
  | 'battle_start' | 'battle_end' | 'round_start' | 'round_end'
  | 'action_start' | 'action_end' | 'skill_confirm' | 'skill_resolve'
  | 'damage' | 'heal' | 'shield_gain' | 'shield_absorb' | 'shield_consume'
  | 'resource_gain' | 'resource_spend' | 'status_apply' | 'status_remove'
  | 'target_lock' | 'telegraph_start' | 'telegraph_end'
  | 'mechanic_window_start' | 'mechanic_window_end' | 'boss_mechanic_trigger'
  | 'unit_death' | 'replacement_scheduled' | 'replacement_completed'
  | 'position_change' | 'swap' | 'phase_change' | 'ai_decision';

export interface UnifiedBattleEvent {
  battleId: string;
  seed: string | number;
  round: number;
  actionIndex: number;
  eventType: UnifiedBattleEventType;
  sourceId: string | null;
  targetId: string | null;
  targetPosition: Row | string | null;
  skillId: string | null;
  mechanicId: string | null;
  value: number;
  resourceCost: number;
  statusId: string | null;
  phaseId: string | null;
  timestampOrder: number;
  metadata: Record<string, unknown>;
}

export type CombatEventV2AttributionMode = 'exclusive' | 'multi_label' | 'weighted';

export interface CombatEventV2 {
  schemaVersion: '2.0.0';
  eventId: string;
  battleId: string;
  seed: number;
  rulesetId: string;
  experimentId: string;
  groupId: string;
  round: number;
  actionIndex: number;
  eventIndex: number;
  eventType: string;
  sourceId?: string;
  sourcePosition?: string;
  targetId?: string;
  targetPosition?: string;
  skillId?: string;
  statusId?: string;
  mechanicId?: string;
  windowId?: string;
  phaseId?: string;
  value?: number;
  theoreticalValue?: number;
  effectiveValue?: number;
  overValue?: number;
  damageTakenMultiplier?: number;
  exposedMultiplier?: number;
  vulnerabilityMultiplier?: number;
  extraDamageFromExposed?: number;
  extraDamageFromVulnerability?: number;
  resourceBefore?: number;
  resourceAfter?: number;
  resourceDelta?: number;
  parentEventId?: string;
  rootActionId?: string;
  causedByEventId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface EventAttributionV2 {
  eventId: string;
  primaryMechanicId?: string;
  secondaryMechanicIds: string[];
  overlapGroupId?: string;
  attributionMode: CombatEventV2AttributionMode;
  weights?: Record<string, number>;
}

export interface PlayerSlotTelemetry {
  slotIndex: number;
  unitId: string | null;
  row: Row;
  hp: number;
  maxHp: number;
  shield: number;
}

export interface TelemetryEventBase {
  round: number;
  battleId?: string;
  seed?: string | number;
  actionId?: string;
}

export interface BattleStartTelemetry {
  seed: string | number;
  selectedSpiritIds: string[];
  activeSpiritIds: string[];
  enemyIds: string[];
  enemyDefinitionIds: string[];
  mana: number;
  maxMana: number;
  playerSlots: PlayerSlotTelemetry[];
  reserveIds: string[];
}

export interface RoundStartTelemetry extends TelemetryEventBase {}

export interface ActionStartTelemetry extends TelemetryEventBase {
  side: TelemetrySide;
  unitId: string;
  actionContext: ActionContext;
  mana: number;
  playerSlots: PlayerSlotTelemetry[];
  reserveIds: string[];
}

export interface SkillConfirmedTelemetry extends TelemetryEventBase {
  actorId: string;
  skillId: string;
  skillName: string;
  skillCastId: string;
  targetId?: string;
  targetIds: string[];
  actionContext: ActionContext;
  configuredCost: number;
  costBeforeEnergySaving: number;
  actualCost: number;
  manaBefore: number;
  energyBeforeActionStart: number;
  energyGainedFromActionStart: number;
  energyAfterActionStart: number;
  energyGainRequested: number;
  isFreeCast: boolean;
  freeCastReason: 'none' | 'first_use_in_battle' | 'first_skill_after_entry' | 'first_use_after_entry' | 'dynamic_cost_reduced_to_zero';
  stateBeforeCast: SkillRuntimeStateTelemetry;
  entrySequenceId: number;
  battleUseIndex: number;
  skillUseIndexAfterEntry: number;
  guaranteedCrit: boolean;
  enhanced: boolean;
  targetDependent: boolean;
  bossExposed: boolean;
  actorHp: number;
  actorMaxHp: number;
  teamHp: number;
  teamMaxHp: number;
  energySavingSourceUnitId?: string;
  energySavingSourceSkillId?: string;
}

export interface SkillRuntimeStateTelemetry {
  lastSkillId: string | null;
  consecutiveUseCount: number;
  skillBattleUseCount: number;
  entrySkillAvailable: boolean;
  entrySequenceId: number;
  skillUseIndexAfterEntry: number;
  damageAmpStacks: number;
  shieldValue: number;
}

export interface SkillResolvedTelemetry extends TelemetryEventBase {
  actorId: string;
  skillId: string;
  skillName: string;
  skillCastId: string;
  configuredCost: number;
  actualCost: number;
  energyGainRequested: number;
  energyGainActual: number;
  energyOverflow: number;
  energyAfterSkillResolution: number;
  resetTrigger: 'none' | 'zero_cost_cast' | 'other_skill_used' | 'battle_start';
  stateAfterCast: SkillRuntimeStateTelemetry;
}

export interface DamageResolvedTelemetry extends TelemetryEventBase {
  sourceSide: TelemetrySide;
  sourceId: string;
  skillId: string;
  targetSide: TelemetrySide;
  targetId: string;
  attempted: number;
  actual: number;
  absorbed: number;
  skillCastId?: string;
  hitIndex?: number;
  damageType?: 'physical' | 'magic' | 'fixed';
  baseOrPreModifierDamage?: number;
  finalDamage?: number;
  isCritical?: boolean;
  criticalMultiplier?: number;
  hpBefore?: number;
  hpAfter?: number;
  activeVulnerabilityStatusInstanceId?: string;
  damageTakenMultiplier?: number;
  exposedMultiplier?: number;
  vulnerabilityMultiplier?: number;
  finalDamageWithoutTakenModifiers?: number;
  finalDamageWithoutVulnerability?: number;
  extraDamageFromExposed?: number;
  extraDamageFromVulnerability?: number;
  vulnerabilitySourceUnitId?: string;
  vulnerabilitySourceSkillId?: string;
  power?: number;
  targetRow?: Row;
  targetSlotIndex?: number;
  targetHpAfter?: number;
  targetMaxHp?: number;
  targetExposed?: boolean;
  formulaBaseDamage?: number;
  damageMultiplier?: number;
  theoreticalDamage?: number;
  actualSettlementDamage?: number;
  overkillDamage?: number;
  mitigatedDamage?: number;
  ineffectiveDamage?: number;
}

export interface HealingResolvedTelemetry extends TelemetryEventBase {
  actorId: string;
  skillId?: string;
  targetId: string;
  attempted: number;
  effective: number;
  overheal: number;
  skillCastId?: string;
  hpBefore?: number;
  hpAfter?: number;
  healingSourceType?: 'direct' | 'status' | 'self_cost_related';
  statusInstanceId?: string;
  targetSlotIndex?: number;
  targetRow?: Row;
  targetHpAfter?: number;
  targetMaxHp?: number;
}

export interface ShieldGrantedTelemetry extends TelemetryEventBase {
  actorId: string;
  skillId?: string;
  targetId: string;
  attempted: number;
  granted: number;
  mode: 'stacking' | 'replace-if-higher';
  shieldInstanceId?: string;
  skillCastId?: string;
  shieldBefore?: number;
  shieldAfter?: number;
  targetSlotIndex?: number;
  targetRow?: Row;
}

export interface ShieldAbsorbedTelemetry extends TelemetryEventBase {
  targetId: string;
  shieldInstanceId: string;
  sourceUnitId: string;
  sourceSkillId?: string;
  absorbedDamage: number;
  remainingShield: number;
  incomingDamageBeforeShield: number;
  hpDamageAfterShield: number;
}

export interface ShieldConsumedTelemetry extends TelemetryEventBase {
  targetId: string;
  shieldInstanceId: string;
  sourceUnitId: string;
  sourceSkillId?: string;
  consumedBySkillId: string;
  skillCastId?: string;
  shieldConsumed: number;
  fixedDamageGenerated: number;
  remainingShield: number;
}

export interface StatusChangedTelemetry extends TelemetryEventBase {
  change: 'apply' | 'refresh' | 'stack' | 'remove';
  statusInstanceId: string;
  statusId: string;
  statusName: string;
  sourceUnitId?: string;
  sourceSkillId?: string;
  targetUnitId: string;
  stackBefore: number;
  stackDelta: number;
  stackAfter: number;
  durationBefore: number;
  durationAfter: number;
  applyReason?: string;
  removeReason?: string;
  powerBonusApplied?: number;
  stackConsumed?: number;
  affectedSkillCastId?: string;
}

export interface EnergyChangedTelemetry extends TelemetryEventBase {
  source: 'action_start' | 'skill';
  actorId?: string;
  skillId?: string;
  before: number;
  attemptedGain: number;
  gained: number;
  spent: number;
  after: number;
}

export interface SwitchResolvedTelemetry extends TelemetryEventBase {
  outgoingId?: string;
  incomingId: string;
  forced: boolean;
  slotIndex: number;
  rowBefore: Row;
  rowAfter: Row;
}

export interface RowSwitchResolvedTelemetry extends TelemetryEventBase {
  unitId: string;
  slotIndex: number;
  rowBefore: Row;
  rowAfter: Row;
}

export interface UnitDefeatedTelemetry extends TelemetryEventBase {
  side: TelemetrySide;
  unitId: string;
  sourceId: string;
  skillId: string;
}

export interface BossSkillUsedTelemetry extends TelemetryEventBase {
  enemyId: string;
  enemyDefinitionId: string;
  skillId: string;
  source: 'forced_followup' | 'forced_opening' | 'weighted' | 'basic_fallback' | 'skip';
  telegraph: boolean;
  targetIds: string[];
  power: number;
  lockedTargetId?: string;
  lockedSlotIndex?: number;
  lockedOriginSlotIndex?: number;
  lockedRow?: Row;
  playerSlots: PlayerSlotTelemetry[];
  reserveIds: string[];
  unresolvedReason?: 'boss-defeated-before-cast' | 'locked-unit-defeated' | 'target-row-empty' | 'battle-ended' | 'other';
}

export interface ReplacementLifecycleTelemetry extends TelemetryEventBase {
  status: 'scheduled' | 'requested' | 'completed' | 'no_reserve' | 'battle_ended';
  slotIndex: number;
  defeatedUnitId?: string;
  incomingId?: string;
  sourceSkillId?: string;
  reserveIds: string[];
}

export interface BattleEndTelemetry extends TelemetryEventBase {
  result: 'victory' | 'defeat';
  mana: number;
  livingSpiritIds: string[];
  livingEnemyIds: string[];
}

export interface BattleTelemetryCollector {
  onBattleStart?(payload: BattleStartTelemetry): void;
  onRoundStart?(payload: RoundStartTelemetry): void;
  onActionStart?(payload: ActionStartTelemetry): void;
  onSkillConfirmed?(payload: SkillConfirmedTelemetry): void;
  onSkillResolved?(payload: SkillResolvedTelemetry): void;
  onDamageResolved?(payload: DamageResolvedTelemetry): void;
  onHealingResolved?(payload: HealingResolvedTelemetry): void;
  onShieldGranted?(payload: ShieldGrantedTelemetry): void;
  onShieldAbsorbed?(payload: ShieldAbsorbedTelemetry): void;
  onShieldConsumed?(payload: ShieldConsumedTelemetry): void;
  onStatusChanged?(payload: StatusChangedTelemetry): void;
  onEnergyChanged?(payload: EnergyChangedTelemetry): void;
  onSwitchResolved?(payload: SwitchResolvedTelemetry): void;
  onRowSwitchResolved?(payload: RowSwitchResolvedTelemetry): void;
  onUnitDefeated?(payload: UnitDefeatedTelemetry): void;
  onBossSkillUsed?(payload: BossSkillUsedTelemetry): void;
  onReplacementLifecycle?(payload: ReplacementLifecycleTelemetry): void;
  onBattleEnd?(payload: BattleEndTelemetry): void;
}
