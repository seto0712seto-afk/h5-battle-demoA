
import { battleSystemConfig, resolveSelectedBossConfig, type BattleSystemConfig } from './battleSystems';
import {
  formatMultiplier,
  formatPercent,
  healAmount,
  skillPowerBreakdown,
  spiritData
} from './formulas';
import {
  buildRoundState,
  CHARGE_DAMAGE_AMP_STACKS_ON_HIT,
  clearTemporaryStatuses,
  CORE_STATUS_RULES,
  mergeRuntimeStatus,
  sortRoundActionSlots,
  tickOwnerStatuses
} from './coreBattleRules';
import { MONSTERS, MONSTER_SKILLS } from './monsterData';
import {
  consumeRuntimeMonsterSkillTemporaryPower,
  createMonsterAiRuntime,
  createMonsterInstance,
  increaseRuntimeMonsterSkillPower,
  monsterDamageMultiplier,
  reduceRuntimeMonsterSkillTemporaryPower,
  runtimeMonsterSkillPower,
  SeededBattleRandom,
  setRuntimeMonsterSkillTemporaryPower,
  selectMonsterAction,
  selectSeededTarget
} from './monsterSystem';
import type { ActionResult, BattleFxEvent, BattleState, BossData, BossId, EnemyBattlePosition, PlayerBattleSnapshot, Row, RuntimeEnemy, RuntimeShieldInstance, RuntimeSpirit, SkillButtonState, SkillData, SkillEnhanceCondition, StageEnemyConfig } from './types';
import type { MonsterAiRuntime, MonsterDefinition, MonsterFinalStats, MonsterSkillDefinition } from './monsterTypes';
import type { BattleTelemetryCollector } from './battleTelemetry';

type Listener = (state: BattleState) => void;

interface BattleGameOptions {
  selectedSpiritIds?: string[];
  selectedBossId?: BossId;
  config?: BattleSystemConfig;
  playerSnapshot?: PlayerBattleSnapshot;
  battleSeed?: string | number;
  monsterLevel?: number;
  monsterStatOverrides?: Partial<MonsterFinalStats>;
  enemies?: StageEnemyConfig[];
  telemetry?: BattleTelemetryCollector;
}

interface EnemyBattleSetup {
  instanceId: string;
  definition: MonsterDefinition;
  bossData: BossData;
  position: EnemyBattlePosition;
}

interface SkillEvaluation extends SkillButtonState {
  guaranteedCrit: boolean;
  healPercentBonus: number;
  fixedDamageBonus: number;
  costBeforeEnergySaving: number;
}

export class BattleGame {
  state: BattleState;
  private listeners = new Set<Listener>();
  private timer: number | null = null;
  private selectedSpiritIds: string[];
  private config: BattleSystemConfig;
  private playerSnapshot?: PlayerBattleSnapshot;
  private monsterDefinition?: MonsterDefinition;
  private monsterAi?: MonsterAiRuntime;
  private monsterRandom?: SeededBattleRandom;
  private battleSeed: string | number;
  private enemySetups: EnemyBattleSetup[] = [];
  private enemyDefinitions: Record<string, MonsterDefinition> = {};
  private enemyBossData: Record<string, BossData> = {};
  private enemyAi: Record<string, MonsterAiRuntime> = {};
  private enemyRandom: Record<string, SeededBattleRandom> = {};
  private telemetry?: BattleTelemetryCollector;
  private telemetryErrors: string[] = [];
  private telemetrySkillContext?: { actorId: string; skillId: string; skillCastId: string; hitIndex: number };
  private telemetrySkillCastSerial = 0;
  private telemetryShieldSerial = 0;
  private telemetryStatusSerial = 0;
  private telemetryActionEnergy = { before: 0, gained: 0, after: 0 };
  private telemetryBattleEnded = false;
  constructor(options: string[] | BattleGameOptions = {}) {
    const normalizedOptions = Array.isArray(options) ? { selectedSpiritIds: options } : options;
    const rootConfig = normalizedOptions.config ?? battleSystemConfig();
    const requestedEnemies = normalizedOptions.enemies?.length
      ? normalizedOptions.enemies
      : [normalizedOptions.selectedBossId ?? rootConfig.monsterDefinitionId ?? rootConfig.defaultBossId ?? rootConfig.bossConfig.id];
    this.enemySetups = requestedEnemies.map((enemyConfig, index) => {
      const parsed = normalizeEnemyConfig(enemyConfig);
      const definition = MONSTERS[parsed.enemyId];
      if (!definition) throw new Error('Unknown monster definition: ' + parsed.enemyId);
      const resolved = resolveSelectedBossConfig(rootConfig, parsed.enemyId);
      const defaultInstance = createMonsterInstance(definition);
      const configOverrides = requestedEnemies.length === 1 ? monsterConfigStatOverrides(resolved, defaultInstance.stats) : {};
      const explicitOverrides = bossOverridesToStats(parsed.overrides);
      const instance = createMonsterInstance(definition, {
        level: parsed.level ?? normalizedOptions.monsterLevel,
        stats: {
          ...configOverrides,
          ...normalizedOptions.monsterStatOverrides,
          ...explicitOverrides
        }
      });
      const instanceId = `${definition.id}@${index + 1}`;
      const bossData: BossData = {
        ...(resolved.bossConfigsById?.[definition.id] ?? resolved.bossConfig),
        ...instance.stats,
        ...parsed.overrides,
        id: definition.id,
        name: definition.name
      };
      return {
        instanceId,
        definition,
        bossData,
        position: parsed.position ?? defaultEnemyPosition(definition.defaultPosition, index)
      };
    });
    const firstSetup = this.enemySetups[0];
    this.config = {
      ...resolveSelectedBossConfig(rootConfig, firstSetup.definition.id),
      bossConfig: firstSetup.bossData,
      monsterDefinitionId: firstSetup.definition.id
    };
    this.enemySetups.forEach((setup) => {
      this.enemyDefinitions[setup.instanceId] = setup.definition;
      this.enemyBossData[setup.instanceId] = setup.bossData;
    });
    this.monsterDefinition = firstSetup.definition;
    this.battleSeed = normalizedOptions.battleSeed ?? `${this.enemySetups.map((setup) => setup.definition.id).join('|')}:default`;
    this.playerSnapshot = normalizedOptions.playerSnapshot;
    this.telemetry = normalizedOptions.telemetry;
    this.selectedSpiritIds = normalizeSelectedSpiritIds(
      normalizedOptions.playerSnapshot?.selectedSpiritIds ?? normalizedOptions.selectedSpiritIds ?? this.config.creatureConfig.map((spirit) => spirit.id),
      this.config
    );
    this.state = this.createInitialState();
    this.notifyTelemetry('onBattleStart', {
      seed: this.battleSeed,
      selectedSpiritIds: [...this.state.selectedSpiritIds],
      activeSpiritIds: this.getActiveSpiritIds(),
      enemyIds: Object.keys(this.state.enemies),
      enemyDefinitionIds: Object.values(this.state.enemies).map((enemy) => enemy.definitionId),
      mana: this.state.mana.current,
      maxMana: this.state.mana.max,
      playerSlots: this.playerTelemetrySlots(),
      reserveIds: this.getBenchSpiritIds()
    });
    this.notifyTelemetry('onRoundStart', { round: this.state.round.index });
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  start() {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.advance(), 420);
  }

  stop() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  getTelemetryErrors() {
    return [...this.telemetryErrors];
  }

  getMonsterRandomHistory() {
    return Object.fromEntries(
      Object.entries(this.enemyRandom).map(([enemyId, random]) => [enemyId, random.history()])
    );
  }

  reset() {
    this.state = this.createInitialState();
    this.emit();
  }

  getSpirit(id: string) {
    return this.state.spirits[id];
  }

  private spiritInfo(id: string) {
    return this.config.creatureConfig.find((spirit) => spirit.id === id) ?? spiritData(id);
  }

  private spiritName(id: string) {
    return this.spiritInfo(id).name;
  }

  getActiveSpiritIds() {
    return this.state.slots
      .map((slot) => slot.spiritId)
      .filter((id): id is string => Boolean(id))
      .filter((id) => this.isAlive(id));
  }

  getActiveEnemyIds() {
    return this.state.enemySlots
      .map((slot) => slot.enemyId)
      .filter((id): id is string => Boolean(id && this.state.enemies[id]?.hp > 0));
  }

  getEnemy(enemyId: string) {
    return this.state.enemies[enemyId];
  }

  enemyName(enemyId: string) {
    return this.state.enemies[enemyId]?.name ?? this.enemyDefinitions[enemyId]?.name ?? enemyId;
  }

  getLegalEnemyTargetIds() {
    const aliveSlots = this.state.enemySlots.filter((slot) => slot.enemyId && this.state.enemies[slot.enemyId]?.hp > 0);
    const fronts = aliveSlots.filter((slot) => slot.row === 'front').map((slot) => slot.enemyId as string);
    return fronts.length > 0 ? fronts : aliveSlots.map((slot) => slot.enemyId as string);
  }

  getSkillTargetIds(skill: SkillData) {
    if (skill.target === 'boss') return this.getLegalEnemyTargetIds();
    return this.getAllySkillTargetIds(skill);
  }

  private getAllySkillTargetIds(skill: SkillData, actorId = this.getActingSpirit()?.id) {
    const targets = this.getHealTargets();
    return skill.excludeSelfTarget && actorId ? targets.filter((id) => id !== actorId) : targets;
  }

  enemyStatusView(enemyId: string) {
    const runtime = this.enemyAi[enemyId];
    const enemy = this.state.enemies[enemyId];
    const statuses: string[] = [];
    if (!runtime || !enemy) return { statuses: ['稳定'], damageMultiplier: 1 };
    if (runtime.pendingFollowup) {
      statuses.push('蓄力：' + (MONSTER_SKILLS[runtime.pendingFollowup.skillId]?.name ?? runtime.pendingFollowup.skillId));
    }
    const cycle = this.enemyCycleView(enemyId);
    if (cycle) statuses.push(cycle.label + ' ' + cycle.current + '/' + cycle.max);
    if (runtime.exposedActive) statuses.push('破绽');
    if (enemy.statuses.vulnerable) statuses.push('易伤 ' + enemy.statuses.vulnerable.duration + ' 回合');
    Object.entries(runtime.temporarySkillPowerBonuses).forEach(([skillId, value]) => {
      if (value > 0) statuses.push((MONSTER_SKILLS[skillId]?.name ?? skillId) + '临时威力 +' + value);
    });
    return { statuses: statuses.length > 0 ? statuses : ['稳定'], damageMultiplier: monsterDamageMultiplier(runtime) };
  }

  enemyTelegraphView(enemyId: string) {
    const pending = this.enemyAi[enemyId]?.pendingFollowup;
    if (!pending) return null;
    const skill = MONSTER_SKILLS[pending.skillId];
    const runtime = this.enemyAi[enemyId];
    let targetText = '目标：行动时选取';
    if (pending.lockedTargetId) {
      const targetStillActive = this.getActiveSpiritIds().includes(pending.lockedTargetId);
      const targetSwappedOut = !targetStillActive && (this.state.spirits[pending.lockedTargetId]?.hp ?? 0) > 0;
      if (targetStillActive) {
        targetText = '锁定：' + this.spiritName(pending.lockedTargetId);
      } else if (targetSwappedOut && pending.lockedOriginSlotIndex !== undefined) {
        targetText = '锁定：第 ' + (pending.lockedOriginSlotIndex + 1) + ' 行（目标已换宠）';
      } else {
        targetText = '锁定目标已失效';
      }
    } else if (pending.lockedSlotIndex !== undefined) {
      targetText = '锁定：第 ' + (pending.lockedSlotIndex + 1) + ' 行';
    } else if (skill?.execution.targetRule === 'enemy_all') {
      targetText = '目标：我方全体';
    } else if (skill?.execution.targetRule === 'self') {
      targetText = '目标：自身';
    }
    return {
      skillName: skill?.name ?? pending.skillId,
      targetText,
      estimatedPower: skill && runtime ? runtimeMonsterSkillPower(runtime, skill) : 0
    };
  }

  enemySkillDamagePreview(enemyId: string, skillId: string, targetId: string) {
    const runtime = this.enemyAi[enemyId];
    const bossConfig = this.enemyBossData[enemyId];
    const skill = MONSTER_SKILLS[skillId];
    const target = this.state.spirits[targetId];
    const targetData = this.config.creatureConfig.find((spirit) => spirit.id === targetId);
    if (!runtime || !bossConfig || !skill || !target || !targetData) return null;
    const damageType = skill.execution.damageType ?? 'none';
    if (!['physical', 'magical', 'fixed'].includes(damageType)) return null;
    const power = runtimeMonsterSkillPower(runtime, skill);
    const attack = damageType === 'physical' ? bossConfig.physicalAttack : bossConfig.magicAttack;
    const defense = damageType === 'physical' ? targetData.physicalDefense : targetData.magicDefense;
    const baseDamage = damageType === 'fixed' ? power : Math.ceil((power * attack) / Math.max(1, defense));
    const statusInteraction = skill.execution.targetStatusDamageInteraction;
    const statusStacks = statusInteraction ? target.statuses[statusInteraction.statusId]?.stacks ?? 0 : 0;
    const statusDamageMultiplier = statusInteraction
      ? 1 + statusStacks * (statusInteraction.finalDamageMultiplierPerStack ?? 0)
      : 1;
    const finalDamageMultiplier = monsterDamageMultiplier(runtime) * statusDamageMultiplier;
    const rawDamage = Math.max(1, Math.ceil(baseDamage * finalDamageMultiplier));
    const shieldPenetration = this.monsterShieldPenetration(rawDamage, statusStacks, statusInteraction?.shieldPenetration);
    const shieldableDamage = Math.max(0, rawDamage - shieldPenetration);
    const absorbed = Math.min(target.shieldValue, shieldableDamage);
    const hpDamage = Math.max(0, rawDamage - absorbed);
    return {
      rawDamage,
      hpDamage,
      absorbed,
      shieldPenetration,
      lethal: hpDamage >= target.hp,
      statusStacks,
      finalDamageMultiplier
    };
  }

  playerTelegraphThreats(slotIndex: number, row: Row, spiritId?: string) {
    return this.getActiveEnemyIds().flatMap((enemyId) => {
      const pending = this.enemyAi[enemyId]?.pendingFollowup;
      if (!pending) return [];
      const lockedTargetStillActive = Boolean(pending.lockedTargetId && this.getActiveSpiritIds().includes(pending.lockedTargetId));
      const lockedTargetSwappedOut = Boolean(
        pending.lockedTargetId &&
          !lockedTargetStillActive &&
          (this.state.spirits[pending.lockedTargetId]?.hp ?? 0) > 0
      );
      const locksUnit = Boolean(lockedTargetStillActive && pending.lockedTargetId === spiritId);
      const currentSlot = this.state.slots[slotIndex];
      const isCurrentOccupiedCell = Boolean(currentSlot?.spiritId && currentSlot.row === row);
      const locksPosition = pending.lockedSlotIndex === slotIndex && isCurrentOccupiedCell;
      const locksOriginAfterSwap = Boolean(
        lockedTargetSwappedOut &&
          pending.lockedOriginSlotIndex === slotIndex &&
          isCurrentOccupiedCell
      );
      if (!locksUnit && !locksPosition && !locksOriginAfterSwap) return [];
      return [{
        enemyId,
        enemyName: this.enemyName(enemyId),
        skillName: MONSTER_SKILLS[pending.skillId]?.name ?? pending.skillId,
        lockMode: locksPosition || locksOriginAfterSwap ? 'position' as const : 'unit' as const
      }];
    });
  }

  enemyCycleView(enemyId: string) {
    const definition = this.enemyDefinitions[enemyId];
    const runtime = this.enemyAi[enemyId];
    if (!definition?.actionCycle || !runtime) return null;
    return {
      label: definition.actionCycle.counterLabel,
      current: runtime.actionCycleCount,
      max: definition.actionCycle.thresho