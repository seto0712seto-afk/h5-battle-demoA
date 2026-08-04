import type { ActionContext, Row } from './types';

export type TelemetrySide = 'player' | 'enemy';

export type UnifiedBattleEventType =
  | 'battle_start' | 'battle_end' | 'round_start' | 'round_end'
  | 'action_start' | 'action_end' | 'skill_confirm' | 'skill_resolve'
  | 'damage' | 'heal' | 'shield_gain' | 'shield_absorb'
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
  targetId?: string;
  actionContext: ActionContext;
  actualCost: number;
  manaBefore: number;
  enhanced: boolean;
  targetDependent: boolean;
  bossExposed: boolean;
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
  targetSlotIndex?: number;
  targetRow?: Row;
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
  onDamageResolved?(payload: DamageResolvedTelemetry): void;
  onHealingResolved?(payload: HealingResolvedTelemetry): void;
  onShieldGranted?(payload: ShieldGrantedTelemetry): void;
  onEnergyChanged?(payload: EnergyChangedTelemetry): void;
  onSwitchResolved?(payload: SwitchResolvedTelemetry): void;
  onRowSwitchResolved?(payload: RowSwitchResolvedTelemetry): void;
  onUnitDefeated?(payload: UnitDefeatedTelemetry): void;
  onBossSkillUsed?(payload: BossSkillUsedTelemetry): void;
  onReplacementLifecycle?(payload: ReplacementLifecycleTelemetry): void;
  onBattleEnd?(payload: BattleEndTelemetry): void;
}
