
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
      max: definition.actionCycle.threshold
    };
  }

  enemyDetailView(enemyId: string) {
    const enemy = this.state.enemies[enemyId];
    const definition = this.enemyDefinitions[enemyId];
    const runtime = this.enemyAi[enemyId];
    if (!enemy || !definition) return null;

    const statuses: Array<{ name: string; detail: string }> = [];
    if (runtime?.pendingFollowup) {
      const pendingSkill = MONSTER_SKILLS[runtime.pendingFollowup.skillId];
      statuses.push({
        name: '预告蓄力',
        detail: `下一次行动强制使用【${pendingSkill?.name ?? runtime.pendingFollowup.skillId}】。`
      });
    }
    if (runtime?.exposedActive) {
      statuses.push({ name: '破绽', detail: '当前处于破绽状态，受到伤害提高。' });
    }
    if ((runtime?.damageIncreaseStacks ?? 0) > 0) {
      statuses.push({
        name: '伤害提高',
        detail: `当前 ${runtime?.damageIncreaseStacks ?? 0} 层，由怪物技能在本场战斗中累计。`
      });
    }
    if (runtime && definition.temporaryPowerResponse) {
      const targetSkillId = definition.temporaryPowerResponse.targetSkillId;
      const targetSkill = MONSTER_SKILLS[targetSkillId];
      const permanentPower = runtime.runtimeSkillPowers[targetSkillId] ?? targetSkill?.execution.power ?? 0;
      const basePower = targetSkill?.execution.power ?? 0;
      const temporaryPower = runtime.temporarySkillPowerBonuses[targetSkillId] ?? 0;
      if (permanentPower > basePower) {
        statuses.push({ name: '永久成长', detail: `【${targetSkill?.name ?? targetSkillId}】永久威力 +${permanentPower - basePower}，本场战斗持续累积。` });
      }
      if (temporaryPower > 0) {
        statuses.push({ name: '临时强化', detail: `下一次【${targetSkill?.name ?? targetSkillId}】临时威力 +${temporaryPower}；玩家每次攻击命中降低 ${definition.temporaryPowerResponse.reductionPerPlayerAttack}。` });
      }
    }
    const cycle = this.enemyCycleView(enemyId);
    if (cycle) {
      statuses.push({
        name: cycle.label,
        detail: `当前 ${cycle.current}/${cycle.max}；达到 ${cycle.max}/${cycle.max} 后，下一次合法行动执行强化。`
      });
    }
    Object.values(enemy.statuses).forEach((status) => {
      statuses.push({
        name: status.name,
        detail: `${status.stacks > 1 ? `${status.stacks} 层，` : ''}${status.duration > 0 ? `剩余 ${status.duration} 回合` : '持续生效'}${status.value ? `，效果值 ${status.value}` : ''}。`
      });
    });

    return {
      id: enemy.id,
      name: enemy.name,
      level: definition.level,
      category: enemy.category,
      role: definition.role,
      row: enemy.row,
      position: enemy.position,
      hp: enemy.hp,
      maxHp: enemy.maxHp,
      action: enemy.action,
      stats: {
        physicalAttack: enemy.physicalAttack,
        physicalDefense: enemy.physicalDefense,
        magicAttack: enemy.magicAttack,
        magicDefense: enemy.magicDefense,
        speed: enemy.speed
      },
      coefficients: definition.coefficients,
      statuses,
      skills: definition.skills.map((entry) => {
        const skill = MONSTER_SKILLS[entry.skillId];
        return {
          id: entry.skillId,
          name: skill?.name ?? entry.skillId,
          currentPower: runtime && skill ? runtimeMonsterSkillPower(runtime, skill) : skill?.execution.power ?? 0,
          cooldown: skill?.cooldown ?? 0,
          weight: entry.weight,
          description: skill?.description ?? ''
        };
      })
    };
  }

  private activateEnemyContext(enemyId: string) {
    const enemy = this.state.enemies[enemyId];
    const definition = this.enemyDefinitions[enemyId];
    if (!enemy || !definition) throw new Error('Unknown battle enemy: ' + enemyId);
    this.state.boss = enemy;
    this.monsterDefinition = definition;
    this.monsterAi = this.enemyAi[enemyId];
    this.monsterRandom = this.enemyRandom[enemyId];
    this.config = { ...this.config, bossConfig: this.enemyBossData[enemyId], monsterDefinitionId: definition.id };
  }

  private getActiveOrDeadFieldSpiritIds() {
    return this.state.slots.map((slot) => slot.spiritId).filter((id): id is string => Boolean(id));
  }

  getBenchSpiritIds() {
    const field = new Set(this.state.slots.map((slot) => slot.spiritId).filter(Boolean));
    return this.state.selectedSpiritIds.filter((id) => !field.has(id) && this.isAlive(id));
  }

  getActingSpirit() {
    const active = this.state.activeUnit;
    if (!active || active.type !== 'spirit') return null;
    return this.getSpirit(active.id);
  }

  canUseSkill(skill: SkillData, actor: RuntimeSpirit | null = this.getActingSpirit()) {
    return this.evaluateSkillState(skill, actor).usable;
  }

  getSkillButtonState(skill: SkillData, actor: RuntimeSpirit | null = this.getActingSpirit(), targetId?: string): SkillButtonState {
    const evaluation = this.evaluateSkillState(skill, actor, targetId);
    return {
      usable: evaluation.usable,
      enhanced: evaluation.enhanced,
      enhanceReason: evaluation.enhanceReason,
      enhanceValue: evaluation.enhanceValue,
      targetDependent: evaluation.targetDependent,
      unavailableReason: evaluation.unavailableReason,
      actualCost: evaluation.actualCost,
      costDiscounted: evaluation.costDiscounted,
      manaGainOriginal: evaluation.manaGainOriginal,
      manaGainActual: evaluation.manaGainActual,
      powerBase: evaluation.powerBase,
      powerBonus: evaluation.powerBonus,
      powerTotal: evaluation.powerTotal,
      powerDetails: evaluation.powerDetails
    };
  }

  private currentBossExposedMultiplier() {
    if (this.monsterAi?.exposedActive) {
      return this.config.monsterExposedDamageTakenMultiplier ?? 1;
    }
    return 1;
  }

  private currentBossDamageTakenMultiplier() {
    return this.currentBossExposedMultiplier() * this.currentBossVulnerabilityMultiplier();
  }

  private currentBossVulnerabilityMultiplier() {
    return this.state.boss.statuses.vulnerable ? 1.5 : 1;
  }

  previewSkillManaGain(skill: SkillData) {
    const original = this.rawSkillManaGain(skill);
    return {
      original,
      actual: original
    };
  }

  skillActualCost(skill: SkillData, manaCurrent = this.state.mana.current, actor: RuntimeSpirit | null = this.getActingSpirit()) {
    return this.evaluateSkillState(skill, actor, undefined, manaCurrent).actualCost;
  }

  skillCostDiscounted(skill: SkillData, manaCurrent = this.state.mana.current, actor: RuntimeSpirit | null = this.getActingSpirit()) {
    return this.evaluateSkillState(skill, actor, undefined, manaCurrent).costDiscounted;
  }

  bossStatusView() {
    return this.enemyStatusView(this.state.boss.id);
  }

  useSkill(skillId: string, alwaysSelectEnemyTarget = false): ActionResult {
    const spirit = this.getActingSpirit();
    if (!spirit || this.state.phase !== 'player-action') return { ok: false, message: '当前没有可行动精灵。' };
    const skill = this.config.skillConfig[skillId];
    if (!skill) return { ok: false, message: '技能不存在。' };
    if (!this.canUseSkill(skill, spirit)) return { ok: false, message: this.unavailableSkillMessage(spirit, skill) };
    if (skill.target === 'boss') {
      const targets = this.getLegalEnemyTargetIds();
      if (targets.length === 0) return { ok: false, message: '没有合法敌方目标。' };
      if (targets.length === 1 && !alwaysSelectEnemyTarget) return this.resolveSkill(spirit.id, skillId, targets[0]);
      this.state.phase = 'target-select';
      this.state.pendingSkillId = skillId;
      this.log('选择敌方目标。');
      this.emit();
      return { ok: true };
    }
    if (skill.target === 'ally-field') {
      const targets = this.getAllySkillTargetIds(skill, spirit.id);
      if (targets.length === 0) return { ok: false, message: '没有可回复目标。' };
      this.state.phase = 'target-select';
      this.state.pendingSkillId = skillId;
      this.log('选择技能目标。');
      this.emit();
      return { ok: true };
    }
    return this.resolveSkill(spirit.id, skillId);
  }

  chooseSkillTarget(targetId: string): ActionResult {
    if (this.state.phase !== 'target-select' || !this.state.pendingSkillId) {
      return { ok: false, message: '当前不需要选择目标。' };
    }
    const actor = this.getActingSpirit();
    if (!actor) return { ok: false, message: '当前没有可行动精灵。' };
    const skill = this.config.skillConfig[this.state.pendingSkillId];
    const targets = skill.target === 'boss' ? this.getLegalEnemyTargetIds() : this.getAllySkillTargetIds(skill, actor.id);
    if (!targets.includes(targetId)) {
      return { ok: false, message: '目标不可用。' };
    }
    return this.resolveSkill(actor.id, this.state.pendingSkillId, targetId);
  }

  cancelTargetSelect() {
    if (this.state.phase !== 'target-select') return;
    this.state.phase = 'player-action';
    this.state.pendingSkillId = null;
    this.emit();
  }

  swapWithBench(targetId: string): ActionResult {
    const actor = this.getActingSpirit();
    if (!actor || this.state.phase !== 'player-action') return { ok: false, message: '当前不能换宠。' };
    if (this.state.actionContext === 'extra') return { ok: false, message: '额外行动不能换宠。' };
    if (!this.getBenchSpiritIds().includes(targetId)) return { ok: false, message: '后备精灵不可用。' };
    const slot = this.findSlotBySpirit(actor.id);
    if (!slot) return { ok: false, message: '当前精灵不在登场位。' };
    const outgoing = this.spiritName(actor.id);
    const incoming = this.spiritName(targetId);
    const rowBefore = slot.row;
    const clearedHuntStacks = actor.statuses['hunter-wound']?.stacks ?? 0;
    this.clearTemporaryBattleState(actor, true, 'switched_to_bench', true);
    actor.action = 0;
    this.getSpirit(targetId).action = 0;
    this.getSpirit(targetId).lastSkillId = null;
    this.getSpirit(targetId).skillUseStreak = 0;
    this.getSpirit(targetId).entrySkillAvailable = true;
    this.getSpirit(targetId).entrySequenceId += 1;
    this.getSpirit(targetId).skillUseIndexAfterEntry = 0;
    slot.spiritId = targetId;
    slot.row = this.spiritInfo(targetId).defaultPosition;
    this.log(outgoing + ' 换下，' + incoming + ' 在' + rowName(slot.row) + '登场。');
    if (clearedHuntStacks > 0) this.log(outgoing + ' 进入后备，清除 ' + clearedHuntStacks + ' 层【猎伤】。');
    this.notifyTelemetry('onSwitchResolved', {
      round: this.state.round.index,
      outgoingId: actor.id,
      incomingId: targetId,
      forced: false,
      slotIndex: slot.index,
      rowBefore,
      rowAfter: slot.row
    });
    this.finishPlayerAction(false);
    return { ok: true };
  }

  switchRow(): ActionResult {
    const actor = this.getActingSpirit();
    if (!actor || this.state.phase !== 'player-action') return { ok: false, message: '当前不能切换站位。' };
    if (this.state.actionContext === 'extra') return { ok: false, message: '额外行动只能使用技能。' };
    const slot = this.findSlotBySpirit(actor.id);
    if (!slot) return { ok: false, message: '当前精灵不在登场位。' };
    const rowBefore = slot.row;
    slot.row = slot.row === 'front' ? 'back' : 'front';
    actor.lastSkillId = null;
    actor.skillUseStreak = 0;
    this.log(this.spiritName(actor.id) + ' 切换至' + rowName(slot.row) + '。');
    this.notifyTelemetry('onRowSwitchResolved', {
      round: this.state.round.index,
      unitId: actor.id,
      slotIndex: slot.index,
      rowBefore,
      rowAfter: slot.row
    });
    this.finishPlayerAction(false);
    return { ok: true };
  }

  useItem(): ActionResult {
    if (this.state.phase !== 'player-action') return { ok: false, message: '当前不能使用道具。' };
    if (this.state.actionContext === 'extra') return { ok: false, message: '额外行动只能使用技能。' };
    this.log('道具暂未开放。');
    this.emit();
    return { ok: true, message: '暂未开放' };
  }

  resolveForcedReplacement(candidateId: string): ActionResult {
    const replacement = this.state.replacement;
    if (!replacement || this.state.phase !== 'forced-replacement') return { ok: false, message: '当前不需要替换。' };
    if (!replacement.candidates.includes(candidateId)) return { ok: false, message: '候选精灵不可用。' };
    const targetSlot = this.state.slots[replacement.slotIndex];
    const rowBefore = targetSlot.row;
    this.getSpirit(candidateId).action = 0;
    this.getSpirit(candidateId).entrySkillAvailable = true;
    this.getSpirit(candidateId).entrySequenceId += 1;
    this.getSpirit(candidateId).skillUseIndexAfterEntry = 0;
    targetSlot.spiritId = candidateId;
    targetSlot.row = this.spiritInfo(candidateId).defaultPosition;
    this.log(this.spiritName(candidateId) + ' 进入原' + rowName(targetSlot.row) + '格。');
    this.notifyTelemetry('onSwitchResolved', {
      round: this.state.round.index,
      incomingId: candidateId,
      forced: true,
      slotIndex: targetSlot.index,
      rowBefore,
      rowAfter: targetSlot.row
    });
    this.notifyTelemetry('onReplacementLifecycle', {
      round: this.state.round.index,
      status: 'completed',
      slotIndex: targetSlot.index,
      incomingId: candidateId,
      reserveIds: this.getBenchSpiritIds()
    });
    this.state.replacement = null;
    this.continueRoundEndReplacement();
    this.emit();
    return { ok: true };
  }

  getHealTargets() {
    return this.getActiveSpiritIds();
  }

  getReplacementCandidates() {
    return this.state.replacement?.candidates ?? [];
  }

  createPlayerSnapshot(): PlayerBattleSnapshot {
    const spirits = cloneSpirits(this.state.spirits);
    Object.values(spirits).forEach((spirit) => this.clearTemporaryBattleState(spirit));
    return {
      selectedSpiritIds: [...this.state.selectedSpiritIds],
      spirits,
      slots: this.state.slots.map((slot) => ({
        ...slot,
        spiritId: slot.spiritId && spirits[slot.spiritId]?.hp > 0 ? slot.spiritId : null
      })),
      mana: { ...this.state.mana }
    };
  }

  private buildBattleRound(
    index: number,
    slots: BattleState['slots'],
    spirits: Record<string, RuntimeSpirit>,
    enemySlots: BattleState['enemySlots'],
    enemies: Record<string, RuntimeEnemy>
  ) {
    const round = buildRoundState(index, slots, spirits, '', false, 0);
    enemySlots.forEach((slot, enemyIndex) => {
      const enemyId = slot.enemyId;
      if (!enemyId || enemies[enemyId]?.hp <= 0) return;
      round.actionSlots.push({
        key: `enemy:${enemyId}`,
        type: 'boss',
        unitId: enemyId,
        speed: enemies[enemyId].speed,
        creationOrder: slots.length + enemyIndex,
        status: 'pending'
      });
    });
    const roundWithSortedSlots = sortRoundActionSlots(
      round,
      Object.fromEntries(this.config.creatureConfig.map((spirit) => [spirit.id, spirit.speed + (spirits[spirit.id]?.speedModifier ?? 0)]))
    );
    const normalActionSlots = roundWithSortedSlots.actionSlots.filter(
      (slot) => slot.type !== 'boss' || !this.enemyAi[slot.unitId]?.actLastNextRound
    );
    const delayedBossActionSlots = roundWithSortedSlots.actionSlots.filter(
      (slot) => slot.type === 'boss' && this.enemyAi[slot.unitId]?.actLastNextRound
    );
    roundWithSortedSlots.actionSlots = [...normalActionSlots, ...delayedBossActionSlots];
    return roundWithSortedSlots;
  }

  private createInitialState(): BattleState {
    this.enemyAi = {};
    this.enemyRandom = {};
    const enemies: Record<string, RuntimeEnemy> = {};
    const enemySlots = this.enemySetups.map((setup, index) => {
      this.enemyAi[setup.instanceId] = createMonsterAiRuntime(setup.definition, MONSTER_SKILLS);
      this.enemyRandom[setup.instanceId] = new SeededBattleRandom(`${this.battleSeed}:enemy:${index}:${setup.definition.id}`);
      enemies[setup.instanceId] = {
        ...setup.bossData,
        id: setup.instanceId,
        definitionId: setup.definition.id,
        name: setup.definition.name,
        category: setup.definition.category,
        row: setup.position === 'front' ? 'front' : 'back',
        position: setup.position,
        hp: setup.bossData.maxHp,
        action: 100,
        cooldowns: {},
        statuses: {}
      };
      return {
        position: setup.position,
        row: setup.position === 'front' ? 'front' as const : 'back' as const,
        enemyId: setup.instanceId
      };
    });
    const firstEnemy = enemies[this.enemySetups[0].instanceId];
    this.monsterDefinition = this.enemySetups[0].definition;
    this.monsterAi = this.enemyAi[firstEnemy.id];
    this.monsterRandom = this.enemyRandom[firstEnemy.id];
    const spirits: Record<string, RuntimeSpirit> = {};
    this.config.creatureConfig.forEach((spirit) => {
      spirits[spirit.id] = {
        id: spirit.id,
        hp: spirit.maxHp,
        action: 0,
        shieldNextBossAction: 0,
        physicalAttackBonus: 0,
        magicAttackBonus: 0,
        speedModifier: 0,
        nextSkillPowerBonus: 0,
        skillCooldowns: {},
        skillPowerGrowth: {},
        lastSkillId: null,
        skillUseStreak: 0,
        skillUseCounts: {},
        entrySkillAvailable: false,
        entrySequenceId: 0,
        skillUseIndexAfterEntry: 0,
        damageAmpStacks: 0,
        freshDamageAmpStacks: 0,
        chargeTurns: 0,
        freshChargeTurns: 0,
        regenTurns: 0,
        freshRegenTurns: 0,
        shieldValue: 0,
        freshShieldValue: 0,
        shieldInstances: [],
        statuses: {}
      };
    });
    const selectedSpiritIds = this.playerSnapshot ? [...this.playerSnapshot.selectedSpiritIds] : [...this.selectedSpiritIds];
    const snapshotSpirits = this.playerSnapshot?.spirits;
    if (snapshotSpirits) {
      Object.entries(snapshotSpirits).forEach(([id, spirit]) => {
        spirits[id] = cloneSpirit(spirit);
      });
    }
    const slots = this.playerSnapshot
      ? this.playerSnapshot.slots.map((slot) => ({ ...slot }))
      : selectedSpiritIds.slice(0, 3).map((spiritId, index) => ({
          index,
          spiritId,
          row: this.spiritInfo(spiritId).defaultPosition
        }));
    Object.values(spirits).forEach((spirit) => {
      spirit.skillUseCounts = {};
      spirit.entrySkillAvailable = slots.some((slot) => slot.spiritId === spirit.id);
      spirit.entrySequenceId = 0;
      if (spirit.entrySkillAvailable) spirit.entrySequenceId += 1;
      spirit.skillUseIndexAfterEntry = 0;
    });
    const round = this.buildBattleRound(1, slots, spirits, enemySlots, enemies);
    round.actionSlots.forEach((slot) => {
      if (slot.type === 'spirit') spirits[slot.unitId].action = 100;
    });
    const activeNames = slots
      .filter((slot) => slot.spiritId)
      .map((slot) => this.spiritName(slot.spiritId as string) + '进入' + rowName(slot.row))
      .join('，');
    const startLog = this.playerSnapshot ? '新一场战斗开始，玩家侧状态已继承。' + activeNames + '。' : '战斗开始。' + activeNames + '。';
    return {
      phase: 'running',
      selectedSpiritIds,
      spirits,
      slots,
      boss: firstEnemy,
      enemies,
      enemySlots,
      mana: {
        current: this.playerSnapshot?.mana.current ?? this.config.teamMana.initial,
        max: this.config.teamMana.max
      },
      activeUnit: null,
      pendingSkillId: null,
      replacement: null,
      hitFeedback: null,
      battleFx: null,
      logs: [formatLogEntry(2, '战斗 Seed：' + String(this.battleSeed) + '。'), formatLogEntry(1, startLog)],
      logSerial: 2,
      actionSerial: 0,
      tick: 0,
      actionContext: 'normal',
      round
    };
  }

  private advance() {
    if (this.state.phase !== 'running') return;
    if (this.checkGameOver()) {
      this.emit();
      return;
    }
    const next = this.nextRoundActionSlot();
    if (!next) {
      this.finishRound();
      return;
    }
    next.status = 'executing';
    if (next.type === 'boss') {
      const enemy = this.state.enemies[next.unitId];
      if (!enemy || enemy.hp <= 0) {
        this.completeCurrentActionSlot('invalid');
        this.emit();
        return;
      }
      this.activateEnemyContext(next.unitId);
      this.state.activeUnit = { type: 'boss', id: next.unitId };
      this.notifyTelemetry('onActionStart', {
        round: this.state.round.index,
        side: 'enemy',
        unitId: next.unitId,
        actionContext: 'normal',
        mana: this.state.mana.current,
        playerSlots: this.playerTelemetrySlots(),
        reserveIds: this.getBenchSpiritIds()
      });
      this.executeBossTurn();
      return;
    }
    if (!this.isAlive(next.unitId) || !this.findSlotBySpirit(next.unitId)) {
      this.log(this.spiritName(next.unitId) + ' 的本回合行动位失效。');
      this.completeCurrentActionSlot('invalid');
      this.emit();
      return;
    }
    this.state.phase = 'player-action';
    this.state.actionContext = 'normal';
    this.state.activeUnit = { type: 'spirit', id: next.unitId };
    this.state.actionSerial += 1;
    this.log(this.spiritName(next.unitId) + ' 获得行动机会。');
    this.notifyTelemetry('onActionStart', {
      round: this.state.round.index,
      side: 'player',
      unitId: next.unitId,
      actionContext: 'normal',
      mana: this.state.mana.current,
      playerSlots: this.playerTelemetrySlots(),
      reserveIds: this.getBenchSpiritIds()
    });
    this.beginPlayerAction(next.unitId, false);
    if (!this.hasLegalPlayerAction(next.unitId)) {
      this.log(this.spiritName(next.unitId) + ' 没有合法行动，自动跳过。');
      this.finishPlayerAction(false, undefined, 'skipped');
      return;
    }
    this.emit();
  }

  private beginPlayerAction(actorId: string, incrementActionSerial = true) {
    if (incrementActionSerial) this.state.actionSerial += 1;
    const manaBefore = this.state.mana.current;
    this.state.mana.current = Math.min(this.state.mana.max, this.state.mana.current + 1);
    const gained = this.state.mana.current - manaBefore;
    this.telemetryActionEnergy = { before: manaBefore, gained, after: this.state.mana.current };
    this.notifyTelemetry('onEnergyChanged', {
      round: this.state.round.index,
      source: 'action_start',
      actorId,
      before: manaBefore,
      attemptedGain: 1,
      gained,
      spent: 0,
      after: this.state.mana.current
    });
    if (gained > 0) {
      this.log('行动开始：团队妖力 ' + manaBefore + ' → ' + this.state.mana.current + '（+1）。');
    } else {
      this.log('行动开始：团队妖力已达上限。');
    }

    const actor = this.getSpirit(actorId);
    if (actor.statuses.regen) {
      const healed = this.healSpirit(actorId, actorId, 0.1, '回复');
      this.log(this.spiritName(actorId) + ' 的回复状态生效，恢复 ' + healed + ' 点生命。');
    }
  }

  private resolveSkill(actorId: string, skillId: string, targetId?: string): ActionResult {
    const spirit = this.getSpirit(actorId);
    const skill = this.config.skillConfig[skillId];
    if (!this.canUseSkill(skill, spirit)) return { ok: false, message: this.unavailableSkillMessage(spirit, skill) };
    let enemyTargetId: string | undefined;
    if (skill.target === 'boss') {
      enemyTargetId = targetId ?? this.getLegalEnemyTargetIds()[0];
      if (!enemyTargetId || !this.getLegalEnemyTargetIds().includes(enemyTargetId)) {
        return { ok: false, message: '攻击目标已失效。' };
      }
      this.activateEnemyContext(enemyTargetId);
    }
    if (skill.target === 'ally-field' && targetId && !this.getAllySkillTargetIds(skill, actorId).includes(targetId)) {
      return { ok: false, message: '目标已失效。' };
    }

    const manaBeforeAction = this.state.mana.current;
    const confirmation = this.evaluateSkillState(skill, spirit, targetId, manaBeforeAction);
    if (!confirmation.usable) return { ok: false, message: confirmation.unavailableReason ?? '当前无法使用。' };
    const skillCastId = `${String(this.battleSeed)}:cast:${++this.telemetrySkillCastSerial}`;
    const stateBeforeCast = this.skillRuntimeTelemetryState(spirit, skill.id);
    const freeCastReason = this.skillFreeCastReason(skill, spirit, confirmation.actualCost);
    this.telemetrySkillContext = { actorId, skillId, skillCastId, hitIndex: 0 };
    this.notifyTelemetry('onSkillConfirmed', {
      round: this.state.round.index,
      actorId,
      skillId,
      skillName: skill.name,
      skillCastId,
      targetId,
      targetIds: this.skillTelemetryTargetIds(skill, actorId, targetId ?? enemyTargetId),
      actionContext: this.state.actionContext,
      configuredCost: skill.cost,
      costBeforeEnergySaving: confirmation.costBeforeEnergySaving,
      actualCost: confirmation.actualCost,
      manaBefore: manaBeforeAction,
      energyBeforeActionStart: this.telemetryActionEnergy.before,
      energyGainedFromActionStart: this.telemetryActionEnergy.gained,
      energyAfterActionStart: this.telemetryActionEnergy.after,
      energyGainRequested: skill.gain,
      isFreeCast: skill.cost > 0 && confirmation.actualCost === 0,
      freeCastReason,
      stateBeforeCast,
      entrySequenceId: spirit.entrySequenceId,
      battleUseIndex: (spirit.skillUseCounts[skill.id] ?? 0) + 1,
      skillUseIndexAfterEntry: spirit.skillUseIndexAfterEntry + 1,
      guaranteedCrit: confirmation.guaranteedCrit,
      enhanced: confirmation.enhanced,
      targetDependent: confirmation.targetDependent,
      bossExposed: Boolean(this.monsterAi?.exposedActive),
      actorHp: spirit.hp,
      actorMaxHp: this.spiritInfo(actorId).maxHp,
      teamHp: this.state.selectedSpiritIds.reduce((sum, id) => sum + Math.max(0, this.getSpirit(id).hp), 0),
      teamMaxHp: this.state.selectedSpiritIds.reduce((sum, id) => sum + this.spiritInfo(id).maxHp, 0),
      energySavingSourceUnitId: spirit.statuses[CORE_STATUS_RULES.energySaving.id]?.sourceUnitId,
      energySavingSourceSkillId: spirit.statuses[CORE_STATUS_RULES.energySaving.id]?.sourceSkillId
    });
    const actorRow = this.findSlotBySpirit(actorId)?.row ?? 'front';
    let fxKind: BattleFxEvent['kind'] = skill.kind === 'attack' ? 'player-attack' : skill.kind === 'heal' ? 'player-heal' : skill.kind === 'support' ? 'player-support' : skill.kind === 'debuff' ? 'player-debuff' : 'player-buff';
    let fxTargetIds: string[] = [];
    let fxTargetEnemyIds: string[] = [];
    if (enemyTargetId) fxTargetEnemyIds = [enemyTargetId];
    let fxAmount = 0;
    const actualCost = confirmation.actualCost;
    const manaSpent = this.payMana(actualCost);
    this.consumeEnergySavingForSkill(spirit, skill, actualCost);
    const shieldBeforeSkill = spirit.shieldValue;
    const convertedShield = this.consumeShieldForSkill(spirit, skill);
    const resetTrigger = this.recordSkillUse(spirit, skill, actualCost, stateBeforeCast.lastSkillId);
    let manaGain = this.rawSkillManaGain(skill);

    if (skill.kind === 'attack') {
      this.applySelfHpCost(spirit, skill);
      const crit = confirmation.guaranteedCrit || this.shouldCrit(spirit, skill, manaBeforeAction);
      const ampMultiplier = this.damageAmpMultiplier(spirit);
      const power = {
        base: confirmation.powerBase,
        bonus: confirmation.powerBonus,
        total: confirmation.powerTotal,
        details: confirmation.powerDetails
      };
      const hits = skill.damageType === 'fixed' ? 0 : this.skillHitCount(skill, manaSpent);
      let damage = 0;
      let resolvedHits = 0;
      for (let hit = 0; hit < hits; hit += 1) {
        if (spirit.hp <= 0) {
          this.log(skill.name + ' 的行动来源已阵亡，剩余 ' + (hits - hit) + ' 段停止结算。');
          break;
        }
        if (this.state.boss.hp <= 0) {
          this.log(skill.name + ' 的原目标已阵亡，剩余 ' + (hits - hit) + ' 段落空。');
          break;
        }
        const hpBefore = this.state.boss.hp;
        const baseDamage = this.attackBaseDamage(actorId, skill, power.total);
        const hitDamageWithoutVulnerability = this.attackDamage(actorId, skill, power.total, crit, ampMultiplier);
        const exposedMultiplier = this.currentBossExposedMultiplier();
        const vulnerabilityMultiplier = this.currentBossVulnerabilityMultiplier();
        const damageTakenMultiplier = this.currentBossDamageTakenMultiplier();
        const hitDamageAfterExposed = Math.ceil(hitDamageWithoutVulnerability * exposedMultiplier);
        const hitDamage = Math.ceil(hitDamageWithoutVulnerability * damageTakenMultiplier);
        const actualDamage = Math.min(this.state.boss.hp, hitDamage);
        this.state.boss.hp -= actualDamage;
        this.notifyTelemetry('onDamageResolved', {
          round: this.state.round.index,
          sourceSide: 'player',
          sourceId: actorId,
          skillId,
          targetSide: 'enemy',
          targetId: this.state.boss.id,
          attempted: hitDamage,
          actual: actualDamage,
          absorbed: 0,
          skillCastId,
          hitIndex: ++this.telemetrySkillContext.hitIndex,
          damageType: skill.damageType === 'magic' ? 'magic' : 'physical',
          baseOrPreModifierDamage: baseDamage,
          finalDamage: actualDamage,
          isCritical: crit,
          criticalMultiplier: crit ? 1.5 : 1,
          hpBefore,
          hpAfter: this.state.boss.hp,
          activeVulnerabilityStatusInstanceId: this.state.boss.statuses.vulnerable?.instanceId,
          damageTakenMultiplier,
          exposedMultiplier,
          vulnerabilityMultiplier,
          finalDamageWithoutTakenModifiers: Math.min(hpBefore, hitDamageWithoutVulnerability),
          finalDamageWithoutVulnerability: Math.min(hpBefore, hitDamageAfterExposed),
          extraDamageFromExposed: Math.max(0, Math.min(hpBefore, hitDamageAfterExposed) - Math.min(hpBefore, hitDamageWithoutVulnerability)),
          extraDamageFromVulnerability: Math.max(0, actualDamage - Math.min(hpBefore, hitDamageAfterExposed)),
          vulnerabilitySourceUnitId: this.state.boss.statuses.vulnerable?.sourceUnitId,
          vulnerabilitySourceSkillId: this.state.boss.statuses.vulnerable?.sourceSkillId,
          targetExposed: Boolean(this.monsterAi?.exposedActive)
        });
        if (this.state.boss.hp <= 0) {
          this.notifyTelemetry('onUnitDefeated', {
            round: this.state.round.index,
            side: 'enemy',
            unitId: this.state.boss.id,
            sourceId: actorId,
            skillId
          });
        }
        damage += actualDamage;
        resolvedHits += 1;
      }
      let extraDamage = skill.fixedDamage ?? 0;
      extraDamage += confirmation.fixedDamageBonus;
      if (skill.bonusDamageFromShield) extraDamage += shieldBeforeSkill;
      if (convertedShield > 0) extraDamage += Math.ceil(convertedShield * (skill.shieldToFixedDamageRatio ?? 0));
      if (extraDamage > 0 && spirit.hp > 0 && this.state.boss.hp > 0) {
        const hpBefore = this.state.boss.hp;
        const fixedDamageWithoutVulnerability = extraDamage;
        const exposedMultiplier = this.currentBossExposedMultiplier();
        const vulnerabilityMultiplier = this.currentBossVulnerabilityMultiplier();
        const damageTakenMultiplier = this.currentBossDamageTakenMultiplier();
        const fixedDamageAfterExposed = Math.ceil(fixedDamageWithoutVulnerability * exposedMultiplier);
        extraDamage = Math.ceil(extraDamage * damageTakenMultiplier);
        const actualExtraDamage = Math.min(this.state.boss.hp, extraDamage);
        this.state.boss.hp -= actualExtraDamage;
        this.notifyTelemetry('onDamageResolved', {
          round: this.state.round.index,
          sourceSide: 'player',
          sourceId: actorId,
          skillId,
          targetSide: 'enemy',
          targetId: this.state.boss.id,
          attempted: extraDamage,
          actual: actualExtraDamage,
          absorbed: 0,
          skillCastId,
          hitIndex: ++this.telemetrySkillContext.hitIndex,
          damageType: 'fixed',
          baseOrPreModifierDamage: fixedDamageWithoutVulnerability,
          finalDamage: actualExtraDamage,
          isCritical: false,
          criticalMultiplier: 1,
          hpBefore,
          hpAfter: this.state.boss.hp,
          activeVulnerabilityStatusInstanceId: this.state.boss.statuses.vulnerable?.instanceId,
          damageTakenMultiplier,
          exposedMultiplier,
          vulnerabilityMultiplier,
          finalDamageWithoutTakenModifiers: Math.min(hpBefore, fixedDamageWithoutVulnerability),
          finalDamageWithoutVulnerability: Math.min(hpBefore, fixedDamageAfterExposed),
          extraDamageFromExposed: Math.max(0, Math.min(hpBefore, fixedDamageAfterExposed) - Math.min(hpBefore, fixedDamageWithoutVulnerability)),
          extraDamageFromVulnerability: Math.max(0, actualExtraDamage - Math.min(hpBefore, fixedDamageAfterExposed)),
          vulnerabilitySourceUnitId: this.state.boss.statuses.vulnerable?.sourceUnitId,
          vulnerabilitySourceSkillId: this.state.boss.statuses.vulnerable?.sourceSkillId,
          targetExposed: Boolean(this.monsterAi?.exposedActive)
        });
        if (this.state.boss.hp <= 0) {
          this.notifyTelemetry('onUnitDefeated', {
            round: this.state.round.index,
            side: 'enemy',
            unitId: this.state.boss.id,
            sourceId: actorId,
            skillId
          });
        }
        damage += actualExtraDamage;
        extraDamage = actualExtraDamage;
      } else if (extraDamage > 0) {
        this.log(skill.name + ' 的追加伤害因行动来源或目标失效而停止结算。');
        extraDamage = 0;
      }
      if (damage > 0 && this.state.boss.hp > 0) this.reduceMonsterTemporaryPowerOnPlayerAttack();
      fxKind = 'player-attack';
      fxAmount = damage;
      this.log(
        this.spiritName(actorId) +
          ' 使用 ' +
          skill.name +
          '，实际消耗 ' +
          manaSpent +
          ' 妖力' +
          (skill.damageType === 'fixed' && !skill.power ? '，固定伤害 ' + extraDamage : '，威力 ' + powerText(power.base, power.bonus)) +
          (hits > 1 ? '，计划 ' + hits + ' 段、结算 ' + resolvedHits + ' 段' : '') +
          '，造成 ' +
          damage +
          ' 点伤害。'
      );
      if (this.state.boss.hp <= 0) this.log(this.config.bossConfig.name + ' 被击败。');
      power.details.forEach((detail) => this.log(skill.name + ' 条件收益触发：' + detail + '。'));
      if (extraDamage > 0 && (skill.damageType !== 'fixed' || convertedShield > 0)) {
        this.log(skill.name + ' 额外造成 ' + extraDamage + ' 点固定伤害（不暴击，不吃伤害增加）。');
      }
      if (skill.power && spirit.nextSkillPowerBonus > 0) {
        this.log(this.spiritName(actorId) + ' 的下次威力提升已消耗。');
        spirit.nextSkillPowerBonus = 0;
      }
      if (skill.selfHealPercent && spirit.hp > 0) {
        const healed = this.healSpirit(actorId, actorId, skill.selfHealPercent, skill.name);
        fxTargetIds = [actorId];
        this.log(skill.name + ' 额外回复自身 ' + healed + ' 点生命。');
      }
      if (skill.frontHealPercent && spirit.hp > 0) {
        const healed = this.healFrontline(actorId, skill.frontHealPercent, skill.name);
        if (healed.length > 0) {
          this.log(skill.name + ' 回复前排：' + healed.map((item) => this.spiritName(item.id) + ' +' + item.amount).join('，') + '。');
        } else {
          this.log(skill.name + ' 没有可回复的前排目标。');
        }
      }
      if (skill.teamHealPercent && spirit.hp > 0) {
        const healed = this.healAllAllies(actorId, skill.teamHealPercent, skill.name);
        fxTargetIds = healed.map((item) => item.id);
        this.log(skill.name + ' 回复全体：' + healed.map((item) => this.spiritName(item.id) + ' +' + item.amount).join('，') + '。');
      }
      if (spirit.hp > 0) this.applySkillStatusEffects(actorId, skill, actorId);
    }

    if (skill.kind === 'heal') {
      if (skill.target === 'ally-all') {
        const healed = this.healAllAllies(actorId, skill.teamHealPercent ?? ((skill.healPercent ?? 0) + confirmation.healPercentBonus), skill.name);
        fxKind = 'player-heal';
        fxTargetIds = healed.map((item) => item.id);
        fxAmount = Math.max(0, ...healed.map((item) => item.amount));
      } else {
      const finalTargetId = skill.target === 'self' ? actorId : targetId;
      if (!finalTargetId) return { ok: false, message: '没有选择回复目标。' };
      const healed = this.healSpirit(actorId, finalTargetId, (skill.healPercent ?? 0) + confirmation.healPercentBonus, skill.name);
      if (skill.shieldPercent) {
        this.shieldSpirit(actorId, finalTargetId, skill.shieldPercent, skill.name);
      }
      this.applySkillStatusEffects(actorId, skill, finalTargetId);
      fxKind = 'player-heal';
      fxTargetIds = [finalTargetId];
      fxAmount = healed;
      }
    }

    if (skill.kind === 'support') {
      const supportTargetId = skill.target === 'ally-field' ? targetId : actorId;
      if (!supportTargetId) return { ok: false, message: '没有选择辅助目标。' };
      fxKind = 'player-support';
      fxTargetIds = [supportTargetId];
      this.log(this.spiritName(actorId) + ' 使用 ' + skill.name + '。');
      if (skill.healPercent) {
        fxAmount += this.healSpirit(actorId, supportTargetId, skill.healPercent, skill.name);
      }
      if (skill.healSelfAndTargetPercent) {
        const healed = [...new Set([actorId, supportTargetId])].map((id) => ({
          id,
          amount: this.healSpirit(actorId, id, skill.healSelfAndTargetPercent ?? 0, skill.name)
        }));
        fxTargetIds = healed.map((item) => item.id);
        fxAmount = Math.max(fxAmount, ...healed.map((item) => item.amount));
      }
      if (skill.healFlatValue) {
        fxAmount += this.healSpiritFlat(actorId, supportTargetId, skill.healFlatValue, skill.name);
      }
      if (confirmation.healPercentBonus > 0) {
        const enhancedHeal = this.healSpirit(actorId, supportTargetId, confirmation.healPercentBonus, skill.name + ' 强化');
        fxAmount += enhancedHeal;
        this.log(skill.name + ' 的确认条件生效，额外回复 ' + enhancedHeal + ' 点生命。');
      }
      if (skill.resetOwnCooldowns) {
        this.resetOwnSkillCooldowns(spirit, skill.id);
        this.log(this.spiritName(actorId) + ' 重置自身其他技能冷却。');
      }
      if (skill.restoreManaTo !== undefined) {
        const restoreGain = Math.max(0, skill.restoreManaTo - this.state.mana.current);
        manaGain += restoreGain;
        this.log(restoreGain > 0 ? skill.name + ' 将团队妖力恢复至 ' + skill.restoreManaTo + '。' : '当前团队妖力不低于 ' + skill.restoreManaTo + '，妖力不降低。');
      }
      if (skill.gainCap !== undefined) {
        this.log(manaGain > 0 ? skill.name + ' 回复 ' + manaGain + ' 点妖力，最高不超过 ' + skill.gainCap + '。' : '当前团队妖力不低于 ' + skill.gainCap + '，妖力不降低。');
      }
      if (skill.target === 'ally-all' && skill.shieldPercent) {
        fxTargetIds = this.getActiveSpiritIds();
        fxTargetIds.forEach((id) => this.shieldSpirit(actorId, id, skill.shieldPercent ?? 0, skill.name));
      }
      this.applySkillStatusEffects(actorId, skill, supportTargetId);
    }

    if (skill.kind === 'buff') {
      fxKind = 'player-buff';
      fxTargetIds = [actorId];
      if (skill.selfPhysicalAttackBonus) {
        spirit.physicalAttackBonus += skill.selfPhysicalAttackBonus;
        this.log(this.spiritName(actorId) + ' 使用 ' + skill.name + '，本场战斗物攻 +' + formatPercent(skill.selfPhysicalAttackBonus) + '。');
      }
      if (skill.selfMagicAttackBonus) {
        spirit.magicAttackBonus += skill.selfMagicAttackBonus;
        this.log(this.spiritName(actorId) + ' 使用 ' + skill.name + '，本场战斗魔攻 +' + formatPercent(skill.selfMagicAttackBonus) + '。');
      }
      if (skill.nextSkillPowerBonus) {
        spirit.nextSkillPowerBonus = skill.nextSkillPowerBonus;
        this.log(this.spiritName(actorId) + ' 使用 ' + skill.name + '，下次有威力的技能威力 +' + skill.nextSkillPowerBonus + '。');
      }
    }

    if (skill.kind === 'debuff') {
      fxKind = 'player-debuff';
      this.log(this.spiritName(actorId) + ' 使用 ' + skill.name + '。');
      this.applySkillStatusEffects(actorId, skill, actorId);
    }

    this.consumeDamageAmpAfterSkill(spirit, stateBeforeCast.damageAmpStacks);
    const requestedManaGain = manaGain;
    if (this.state.actionContext === 'extra' && manaGain > 0) {
      this.log('额外行动不获得妖力（' + skill.name + ' 原始回能 +' + manaGain + ' → 实际 +0）。');
      manaGain = 0;
    }
    const manaGained = this.gainMana(manaGain, requestedManaGain);
    this.applySkillCooldown(spirit, skill);
    this.recordBattleFx({
      kind: fxKind,
      actorId,
      actorRow,
      targetIds: fxTargetIds,
      targetEnemyIds: fxTargetEnemyIds,
      skillName: skill.name,
      amount: fxAmount,
      manaBefore: manaBeforeAction,
      manaAfter: this.state.mana.current,
      manaCost: manaSpent,
      manaGain: manaGained
    });
    this.notifyTelemetry('onSkillResolved', {
      round: this.state.round.index,
      actorId,
      skillId,
      skillName: skill.name,
      skillCastId,
      configuredCost: skill.cost,
      actualCost: manaSpent,
      energyGainRequested: requestedManaGain,
      energyGainActual: manaGained,
      energyOverflow: Math.max(0, requestedManaGain - manaGained),
      energyAfterSkillResolution: this.state.mana.current,
      resetTrigger,
      stateAfterCast: this.skillRuntimeTelemetryState(spirit, skill.id)
    });
    this.telemetrySkillContext = undefined;
    this.finishPlayerAction(true, skill.id);
    return { ok: true };
  }

  private skillCooldown(spirit: RuntimeSpirit, skill: SkillData) {
    return spirit.skillCooldowns[skill.id] ?? 0;
  }

  private evaluateSkillState(
    skill: SkillData,
    actor: RuntimeSpirit | null,
    targetId?: string,
    manaAtConfirmation = this.state.mana.current
  ): SkillEvaluation {
    const enhancements: Array<{ reason: string; value: string }> = [];
    let ruleCostReduction = 0;
    let rulePowerBonus = 0;
    let healPercentBonus = 0;
    let fixedDamageBonus = 0;
    let guaranteedCrit = Boolean(skill.alwaysCrit);
    let targetDependent = false;

    for (const rule of skill.enhanceRules ?? []) {
      const result = this.evaluateEnhanceCondition(rule.condition, actor, targetId, manaAtConfirmation);
      targetDependent ||= result.targetDependent;
      if (!result.matched) continue;
      const scale = rule.effect?.scaleByConditionValue ? Math.max(1, result.value) : 1;
      ruleCostReduction += (rule.effect?.costReduction ?? 0) * scale;
      rulePowerBonus += (rule.effect?.powerBonus ?? 0) * scale;
      healPercentBonus += (rule.effect?.healPercentBonus ?? 0) * scale;
      fixedDamageBonus += (rule.effect?.fixedDamageBonus ?? 0) * scale;
      guaranteedCrit ||= Boolean(rule.effect?.guaranteedCrit);
      enhancements.push({
        reason: rule.reason.replaceAll('{value}', String(result.value)),
        value: rule.value.replaceAll('{value}', String(result.value))
      });
    }

    const configuredCost = this.skillManaCost(skill, manaAtConfirmation, actor);
    const costBeforeEnergySaving = skill.costAllMana
      ? manaAtConfirmation
      : Math.max(skill.minimumCost ?? 0, configuredCost - ruleCostReduction);
    const energySavingActive = Boolean(actor?.statuses[CORE_STATUS_RULES.energySaving.id]);
    const actualCost = !skill.costAllMana && energySavingActive
      ? Math.max(0, Math.floor(costBeforeEnergySaving * 0.5))
      : costBeforeEnergySaving;
    const costDiscounted = !skill.costAllMana && actualCost < skill.cost;

    if (actor) {
      const consecutiveUses = actor.lastSkillId === skill.id ? actor.skillUseStreak : 0;
      if (skill.consecutiveUseCostReduction && consecutiveUses > 0) {
        enhancements.push({
          reason: '连续使用 ' + consecutiveUses + ' 次',
          value: '妖力消耗 -' + Math.min(skill.cost, consecutiveUses * skill.consecutiveUseCostReduction)
        });
      }
      if (skill.firstUseInBattleCostReduction && (actor.skillUseCounts[skill.id] ?? 0) === 0) {
        enhancements.push({ reason: '本场首次使用', value: '妖力消耗 -' + skill.firstUseInBattleCostReduction });
      }
      if (skill.firstSkillAfterEntryCostReduction && actor.entrySkillAvailable) {
        enhancements.push({ reason: '本次入场后的首次行动使用本技能', value: '妖力消耗 -' + skill.firstSkillAfterEntryCostReduction });
      }
      if (energySavingActive) {
        enhancements.push({ reason: '持有节能', value: '妖力消耗 ' + costBeforeEnergySaving + '→' + actualCost });
      }
      if (skill.fullManaCostReduction && manaAtConfirmation >= this.fullManaThreshold()) {
        enhancements.push({ reason: '确认时团队妖力达到 ' + this.fullManaThreshold(), value: '妖力消耗 -' + skill.fullManaCostReduction });
      }
      if (skill.highHpCritThreshold !== undefined && actor.hp / Math.max(1, this.spiritInfo(actor.id).maxHp) > skill.highHpCritThreshold) {
        enhancements.push({ reason: '自身生命高于 ' + Math.round(skill.highHpCritThreshold * 100) + '%', value: '本次攻击必定暴击' });
        guaranteedCrit = true;
      }
      if (skill.critIfDamageAmp && actor.damageAmpStacks > 0) {
        enhancements.push({
          reason: '爆发 ' + actor.damageAmpStacks + ' 层',
          value: '伤害 +' + actor.damageAmpStacks * 25 + '%，本次攻击必定暴击'
        });
        guaranteedCrit = true;
      } else if (skill.kind === 'attack' && actor.damageAmpStacks > 0) {
        enhancements.push({ reason: '爆发 ' + actor.damageAmpStacks + ' 层', value: '伤害 +' + actor.damageAmpStacks * 25 + '%' });
      }
      if (skill.shieldToFixedDamageRatio && actor.shieldValue > 0) {
        const converted = Math.min(actor.shieldValue, skill.maxConvertedShield ?? actor.shieldValue);
        enhancements.push({
          reason: '确认时拥有 ' + converted + ' 护盾',
          value: '追加 ' + Math.ceil(converted * skill.shieldToFixedDamageRatio) + ' 固定伤害'
        });
      }
      if (skill.fullManaPowerBonusRatio && manaAtConfirmation >= this.fullManaThreshold()) {
        enhancements.push({
          reason: '确认时团队妖力达到 ' + this.fullManaThreshold(),
          value: '威力 +' + Math.floor((skill.power ?? 0) * skill.fullManaPowerBonusRatio)
        });
      }
      if (skill.fullManaHealBonusPercent && manaAtConfirmation >= this.fullManaThreshold()) {
        healPercentBonus += skill.fullManaHealBonusPercent;
        enhancements.push({
          reason: '确认时团队妖力达到 ' + this.fullManaThreshold(),
          value: '额外治疗 ' + Math.round(skill.fullManaHealBonusPercent * 100) + '% 最大生命'
        });
      }
      if (skill.fullManaCrit && manaAtConfirmation >= this.fullManaThreshold()) {
        enhancements.push({ reason: '确认时团队妖力达到 ' + this.fullManaThreshold(), value: '本次攻击必定暴击' });
        guaranteedCrit = true;
      }
    }

    const power = actor
      ? skillPowerBreakdown(actor, skill, {
          boss: this.state.boss,
          manaCurrent: manaAtConfirmation,
          fullManaThreshold: this.config.fullManaThreshold
        })
      : { base: skill.power ?? 0, bonus: 0, total: skill.power ?? 0, details: [] };
    if (rulePowerBonus > 0) power.details.push('条件强化 +' + rulePowerBonus);
    const powerBonus = power.bonus + rulePowerBonus;
    const manaGainOriginal = this.rawSkillManaGain(skill, manaAtConfirmation);
    const manaGainActual = manaGainOriginal;
    const cooldown = actor ? this.skillCooldown(actor, skill) : 0;
    let unavailableReason: string | null = null;
    if (cooldown > 0) unavailableReason = skill.name + ' 冷却中，还剩 ' + cooldown + ' 回合。';
    else if (skill.costAllMana && manaAtConfirmation <= 0) unavailableReason = '当前妖力为 0，无法使用。';
    else if (!skill.costAllMana && manaAtConfirmation < actualCost) unavailableReason = '团队妖力不足。';

    return {
      usable: unavailableReason === null,
      enhanced: enhancements.length > 0,
      enhanceReason: enhancements.length > 0 ? enhancements.map((item) => item.reason).join('；') : null,
      enhanceValue: enhancements.length > 0 ? enhancements.map((item) => item.value).join('；') : null,
      targetDependent,
      unavailableReason,
      costBeforeEnergySaving,
      actualCost,
      costDiscounted,
      manaGainOriginal,
      manaGainActual,
      powerBase: power.base,
      powerBonus,
      powerTotal: power.base + powerBonus,
      powerDetails: power.details,
      guaranteedCrit,
      healPercentBonus,
      fixedDamageBonus
    };
  }

  private evaluateEnhanceCondition(
    condition: SkillEnhanceCondition,
    actor: RuntimeSpirit | null,
    targetId: string | undefined,
    manaAtConfirmation: number
  ) {
    const targetDependent = condition.type === 'target_hp_at_most' || condition.type === 'target_has_status';
    if (condition.type === 'team_mana_at_least') {
      return { matched: manaAtConfirmation >= condition.value, targetDependent, value: manaAtConfirmation };
    }
    if (!actor) return { matched: false, targetDependent, value: 0 };
    if (condition.type === 'actor_hp_at_most') {
      return { matched: actor.hp / Math.max(1, this.spiritInfo(actor.id).maxHp) <= condition.ratio, targetDependent, value: actor.hp };
    }
    if (condition.type === 'actor_hp_above') {
      return { matched: actor.hp / Math.max(1, this.spiritInfo(actor.id).maxHp) > condition.ratio, targetDependent, value: actor.hp };
    }
    if (condition.type === 'actor_position') {
      return { matched: this.findSlotBySpirit(actor.id)?.row === condition.row, targetDependent, value: 1 };
    }
    if (condition.type === 'actor_status_stacks') {
      const stacks = actor.statuses[condition.statusId]?.stacks ?? 0;
      return { matched: stacks >= condition.minStacks, targetDependent, value: stacks };
    }
    if (!targetId) return { matched: false, targetDependent, value: 0 };
    const targetSpirit = this.state.spirits[targetId];
    const targetEnemy = this.state.enemies[targetId];
    if (condition.type === 'target_hp_at_most') {
      const hp = targetSpirit?.hp ?? targetEnemy?.hp ?? 0;
      const maxHp = targetSpirit ? this.spiritInfo(targetId).maxHp : targetEnemy?.maxHp ?? 1;
      return { matched: hp / Math.max(1, maxHp) <= condition.ratio, targetDependent, value: hp };
    }
    const status = targetSpirit?.statuses[condition.statusId] ?? targetEnemy?.statuses[condition.statusId];
    const stacks = status?.stacks ?? 0;
    return { matched: Boolean(status) && stacks >= (condition.minStacks ?? 1), targetDependent, value: stacks };
  }

  private unavailableSkillMessage(spirit: RuntimeSpirit, skill: SkillData) {
    return this.evaluateSkillState(skill, spirit).unavailableReason ?? '当前无法使用。';
  }

  private skillManaCost(skill: SkillData, manaBeforeAction: number, actor: RuntimeSpirit | null = this.getActingSpirit()) {
    if (skill.costAllMana) return manaBeforeAction;
    let reduction = manaBeforeAction >= this.fullManaThreshold() ? skill.fullManaCostReduction ?? 0 : 0;
    if (actor && skill.consecutiveUseCostReduction) {
      const priorConsecutiveUses = actor.lastSkillId === skill.id ? actor.skillUseStreak : 0;
      reduction += priorConsecutiveUses * skill.consecutiveUseCostReduction;
    }
    if (actor && skill.firstUseInBattleCostReduction && (actor.skillUseCounts[skill.id] ?? 0) === 0) {
      reduction += skill.firstUseInBattleCostReduction;
    }
    if (actor?.entrySkillAvailable && skill.firstSkillAfterEntryCostReduction) {
      reduction += skill.firstSkillAfterEntryCostReduction;
    }
    return Math.max(skill.minimumCost ?? 0, skill.cost - reduction);
  }

  private rawSkillManaGain(skill: SkillData, manaCurrent = this.state.mana.current) {
    let gain = skill.gain;
    if (skill.gainWhenManaBelow !== undefined && manaCurrent < this.fullManaThreshold()) {
      gain += skill.gainWhenManaBelow;
    }
    if (skill.gainCap !== undefined) {
      return Math.max(0, Math.min(gain, skill.gainCap - manaCurrent));
    }
    return gain;
  }

  private skillHitCount(skill: SkillData, manaSpent: number) {
    if (skill.costAllMana) return 1 + manaSpent;
    return skill.hitCount ?? 1;
  }

  private currentActorId() {
    return this.state.activeUnit?.type === 'spirit' ? this.state.activeUnit.id : null;
  }

  private addDamageAmp(spiritId: string, stacks: number, source: string, sourceUnitId?: string, sourceSkillId?: string) {
    if (stacks <= 0) return;
    const target = this.getSpirit(spiritId);
    const rule = CORE_STATUS_RULES.damageAmp;
    const before = target.statuses['damage-amp'] ? { ...target.statuses['damage-amp'] } : undefined;
    target.statuses['damage-amp'] = mergeRuntimeStatus(target.statuses['damage-amp'], {
      ...rule,
      stacks,
      duration: 1,
      appliedDuringOwnerAction: this.currentActorId() === spiritId,
      instanceId: before?.instanceId ?? this.nextStatusInstanceId(),
      sourceUnitId: sourceUnitId ?? this.telemetrySkillContext?.actorId ?? spiritId,
      sourceSkillId: sourceSkillId ?? this.telemetrySkillContext?.skillId
    });
    target.damageAmpStacks = target.statuses['damage-amp'].stacks;
    this.notifyStatusChange(before, target.statuses['damage-amp'], spiritId, source);
    this.log(this.spiritName(spiritId) + ' 获得爆发 ' + stacks + ' 层（来源：' + source + '），当前 ' + target.damageAmpStacks + ' 层。');
  }

  private consumeDamageAmpAfterSkill(spirit: RuntimeSpirit, lockedStacks: number) {
    if (lockedStacks <= 0) return;
    const status = spirit.statuses[CORE_STATUS_RULES.damageAmp.id];
    if (!status || status.stacks <= 0) return;
    const before = { ...status };
    status.stacks -= 1;
    if (status.stacks <= 0) {
      delete spirit.statuses[CORE_STATUS_RULES.damageAmp.id];
      this.notifyStatusRemoval(before, spirit.id, 'consumed_by_skill');
    } else {
      this.notifyStatusChange(before, status, spirit.id, 'consumed_by_skill');
    }
    spirit.damageAmpStacks = spirit.statuses[CORE_STATUS_RULES.damageAmp.id]?.stacks ?? 0;
    this.log(this.spiritName(spirit.id) + ' 的本次技能消耗 1 层旧爆发，剩余 ' + spirit.damageAmpStacks + ' 层。');
  }

  private addCharge(spiritId: string, turns: number, source: string) {
    if (turns <= 0) return;
    const target = this.getSpirit(spiritId);
    const rule = CORE_STATUS_RULES.charge;
    const before = target.statuses.charge ? { ...target.statuses.charge } : undefined;
    target.statuses.charge = mergeRuntimeStatus(target.statuses.charge, {
      ...rule,
      duration: turns,
      appliedDuringOwnerAction: this.currentActorId() === spiritId,
      instanceId: before?.instanceId ?? this.nextStatusInstanceId(),
      sourceUnitId: this.telemetrySkillContext?.actorId ?? spiritId,
      sourceSkillId: this.telemetrySkillContext?.skillId
    });
    target.chargeTurns = target.statuses.charge.duration;
    this.notifyStatusChange(before, target.statuses.charge, spiritId, source);
    this.log(this.spiritName(spiritId) + ' 获得蓄势（来源：' + source + '）。');
  }

  private addRegen(spiritId: string, turns: number, source: string) {
    if (turns <= 0) return;
    const target = this.getSpirit(spiritId);
    const rule = CORE_STATUS_RULES.regen;
    const before = target.statuses.regen ? { ...target.statuses.regen } : undefined;
    target.statuses.regen = mergeRuntimeStatus(target.statuses.regen, {
      ...rule,
      duration: turns,
      value: 0.1,
      appliedDuringOwnerAction: this.currentActorId() === spiritId,
      instanceId: before?.instanceId ?? this.nextStatusInstanceId(),
      sourceUnitId: this.telemetrySkillContext?.actorId ?? spiritId,
      sourceSkillId: this.telemetrySkillContext?.skillId
    });
    target.regenTurns = target.statuses.regen.duration;
    this.notifyStatusChange(before, target.statuses.regen, spiritId, source);
    this.log(this.spiritName(spiritId) + ' 获得回复 ' + turns + ' 回合（来源：' + source + '，同名回复仅保留一个）。');
  }

  private addEnergySaving(spiritId: string, source: string) {
    const target = this.getSpirit(spiritId);
    const rule = CORE_STATUS_RULES.energySaving;
    const before = target.statuses[rule.id] ? { ...target.statuses[rule.id] } : undefined;
    target.statuses[rule.id] = mergeRuntimeStatus(target.statuses[rule.id], {
      ...rule,
      duration: 0,
      instanceId: before?.instanceId ?? this.nextStatusInstanceId(),
      sourceUnitId: this.telemetrySkillContext?.actorId ?? spiritId,
      sourceSkillId: this.telemetrySkillContext?.skillId
    });
    this.notifyStatusChange(before, target.statuses[rule.id], spiritId, source);
    this.log(this.spiritName(spiritId) + ' 获得节能（来源：' + source + '）。');
  }

  private consumeEnergySavingForSkill(spirit: RuntimeSpirit, skill: SkillData, actualCost: number) {
    const statusId = CORE_STATUS_RULES.energySaving.id;
    const status = spirit.statuses[statusId];
    if (!status) return;
    delete spirit.statuses[statusId];
    this.notifyStatusRemoval(status, spirit.id, 'consumed_by_skill');
    this.log(this.spiritName(spirit.id) + ' 的节能生效，' + skill.name + ' 实际消耗 ' + actualCost + ' 妖力，随后移除节能。');
  }

  private addShieldValue(spiritId: string, amount: number, source: string) {
    if (amount <= 0) return;
    const target = this.getSpirit(spiritId);
    const shieldBefore = target.shieldValue;
    const shieldInstance: RuntimeShieldInstance = {
      id: `${String(this.battleSeed)}:shield:${++this.telemetryShieldSerial}`,
      sourceUnitId: this.telemetrySkillContext?.actorId ?? spiritId,
      sourceSkillId: this.telemetrySkillContext?.skillId,
      generated: amount,
      remaining: amount,
      createdOrder: this.telemetryShieldSerial
    };
    target.shieldInstances.push(shieldInstance);
    target.shieldValue += amount;
    if (this.currentActorId() === spiritId) target.freshShieldValue += amount;
    this.notifyTelemetry('onShieldGranted', {
      round: this.state.round.index,
      actorId: this.telemetrySkillContext?.actorId ?? spiritId,
      skillId: this.telemetrySkillContext?.skillId,
      targetId: spiritId,
      attempted: amount,
      granted: amount,
      mode: 'stacking',
      shieldInstanceId: shieldInstance.id,
      skillCastId: this.telemetrySkillContext?.skillCastId,
      shieldBefore,
      shieldAfter: target.shieldValue,
      targetSlotIndex: this.findSlotBySpirit(spiritId)?.index,
      targetRow: this.findSlotBySpirit(spiritId)?.row
    });
    this.log(this.spiritName(spiritId) + ' 获得护盾 ' + amount + '（来源：' + source + '），当前护盾 ' + target.shieldValue + '。');
  }

  private addBossVulnerability(turns: number, source: string) {
    if (turns <= 0) return;
    const rule = CORE_STATUS_RULES.vulnerable;
    const before = this.state.boss.statuses[rule.id] ? { ...this.state.boss.statuses[rule.id] } : undefined;
    this.state.boss.statuses[rule.id] = mergeRuntimeStatus(this.state.boss.statuses[rule.id], {
      ...rule,
      duration: turns,
      value: 0.5,
      instanceId: before?.instanceId ?? this.nextStatusInstanceId(),
      sourceUnitId: this.telemetrySkillContext?.actorId,
      sourceSkillId: this.telemetrySkillContext?.skillId
    });
    this.notifyStatusChange(before, this.state.boss.statuses[rule.id], this.state.boss.id, source);
    this.log(this.config.bossConfig.name + ' 获得易伤 ' + turns + ' 回合（来源：' + source + '），受到伤害提高 50%。');
  }

  private nextStatusInstanceId() {
    return `${String(this.battleSeed)}:status:${++this.telemetryStatusSerial}`;
  }

  private notifyStatusChange(before: RuntimeSpirit['statuses'][string] | undefined, after: RuntimeSpirit['statuses'][string], targetUnitId: string, reason: string) {
    this.notifyTelemetry('onStatusChanged', {
      round: this.state.round.index,
      change: before ? (after.stacks !== before.stacks ? 'stack' : 'refresh') : 'apply',
      statusInstanceId: after.instanceId ?? this.nextStatusInstanceId(),
      statusId: after.id,
      statusName: after.name,
      sourceUnitId: after.sourceUnitId,
      sourceSkillId: after.sourceSkillId,
      targetUnitId,
      stackBefore: before?.stacks ?? 0,
      stackDelta: after.stacks - (before?.stacks ?? 0),
      stackAfter: after.stacks,
      durationBefore: before?.duration ?? 0,
      durationAfter: after.duration,
      applyReason: reason
    });
  }

  private notifyStatusRemoval(status: RuntimeSpirit['statuses'][string], targetUnitId: string, reason: string) {
    this.notifyTelemetry('onStatusChanged', {
      round: this.state.round.index,
      change: 'remove',
      statusInstanceId: status.instanceId ?? `${String(this.battleSeed)}:status:untracked`,
      statusId: status.id,
      statusName: status.name,
      sourceUnitId: status.sourceUnitId,
      sourceSkillId: status.sourceSkillId,
      targetUnitId,
      stackBefore: status.stacks,
      stackDelta: -status.stacks,
      stackAfter: 0,
      durationBefore: status.duration,
      durationAfter: 0,
      removeReason: reason
    });
  }

  private applySkillStatusEffects(actorId: string, skill: SkillData, targetId = actorId) {
    if (skill.addDamageAmpStacks) this.addDamageAmp(actorId, skill.addDamageAmpStacks, skill.name);
    if (skill.addChargeTurns) this.addCharge(actorId, skill.addChargeTurns, skill.name);
    if (skill.shieldValue) this.addShieldValue(targetId, skill.shieldValue, skill.name);
    if (skill.teamShieldValue) {
      this.getActiveSpiritIds().forEach((id) => this.addShieldValue(id, skill.teamShieldValue ?? 0, skill.name));
    }
    if (skill.addRegenTurns) {
      const targets = skill.target === 'ally-all' ? this.getActiveSpiritIds() : [targetId];
      targets.forEach((id) => this.addRegen(id, skill.addRegenTurns ?? 0, skill.name));
    }
    if (skill.addEnergySaving) this.addEnergySaving(targetId, skill.name);
    if (skill.addBossVulnerabilityTurns) this.addBossVulnerability(skill.addBossVulnerabilityTurns, skill.name);
  }

  private consumeShieldForSkill(spirit: RuntimeSpirit, skill: SkillData) {
    if (!skill.shieldToFixedDamageRatio || spirit.shieldValue <= 0) return 0;
    const converted = Math.min(spirit.shieldValue, skill.maxConvertedShield ?? spirit.shieldValue);
    this.consumeShieldLedger(spirit, converted, {
      reason: 'skill',
      consumedBySkillId: skill.id,
      fixedDamageRatio: skill.shieldToFixedDamageRatio
    });
    spirit.freshShieldValue = Math.min(spirit.freshShieldValue, spirit.shieldValue);
    this.log(skill.name + ' 确认：消耗 ' + converted + ' 护盾用于转换固定伤害，当前护盾 ' + spirit.shieldValue + '。');
    return converted;
  }

  private applySelfHpCost(spirit: RuntimeSpirit, skill: SkillData) {
    if (!skill.selfHpCostPercent || spirit.hp <= 1) return 0;
    const requested = Math.ceil(this.spiritInfo(spirit.id).maxHp * skill.selfHpCostPercent);
    const actual = Math.min(spirit.hp - 1, requested);
    spirit.hp -= actual;
    this.log(this.spiritName(spirit.id) + ' 为使用 ' + skill.name + ' 消耗 ' + actual + ' 点生命，当前 ' + spirit.hp + '。');
    return actual;
  }

  private attackDamage(actorId: string, skill: SkillData, power: number, crit: boolean, damageAmpMultiplier: number) {
    const baseDamage = this.attackBaseDamage(actorId, skill, power);
    if (baseDamage <= 0) return 0;
    const critMultiplier = crit ? 1.5 : 1;
    return Math.max(1, Math.ceil(baseDamage * critMultiplier * damageAmpMultiplier));
  }

  private attackBaseDamage(actorId: string, skill: SkillData, power: number) {
    if (!skill.power && power <= 0) return 0;
    const actorData = this.spiritInfo(actorId);
    const attack = skill.damageType === 'physical'
      ? Math.floor(actorData.physicalAttack * (1 + this.getSpirit(actorId).physicalAttackBonus))
      : Math.floor(actorData.magicAttack * (1 + this.getSpirit(actorId).magicAttackBonus));
    const defense = skill.damageType === 'physical' ? this.config.bossConfig.physicalDefense : this.config.bossConfig.magicDefense;
    return power * attack / Math.max(1, defense);
  }

  private shouldCrit(spirit: RuntimeSpirit, skill: SkillData, manaBeforeAction: number) {
    if (skill.fullManaCrit && manaBeforeAction >= this.fullManaThreshold()) return true;
    if (skill.highHpCritThreshold !== undefined && spirit.hp / Math.max(1, this.spiritInfo(spirit.id).maxHp) > skill.highHpCritThreshold) return true;
    if (skill.critIfDamageAmp && spirit.damageAmpStacks > 0) return true;
    return false;
  }

  private damageAmpMultiplier(spirit: RuntimeSpirit) {
    return 1 + spirit.damageAmpStacks * 0.25;
  }

  private healSpirit(actorId: string, targetId: string, percent: number, skillName: string) {
    const target = this.getSpirit(targetId);
    const amount = Math.floor(this.spiritInfo(targetId).maxHp * percent);
    const before = target.hp;
    target.hp = Math.min(this.spiritInfo(targetId).maxHp, target.hp + amount);
    const actual = target.hp - before;
    this.notifyTelemetry('onHealingResolved', {
      round: this.state.round.index,
      actorId,
      skillId: this.telemetrySkillContext?.skillId,
      targetId,
      attempted: amount,
      effective: actual,
      overheal: Math.max(0, amount - actual),
      skillCastId: this.telemetrySkillContext?.skillCastId,
      hpBefore: before,
      hpAfter: target.hp,
      healingSourceType: skillName === '回复' ? 'status' : 'direct',
      statusInstanceId: skillName === '回复' ? target.statuses.regen?.instanceId : undefined,
      targetSlotIndex: this.findSlotBySpirit(targetId)?.index,
      targetRow: this.findSlotBySpirit(targetId)?.row,
      targetHpAfter: target.hp,
      targetMaxHp: this.spiritInfo(targetId).maxHp
    });
    this.log(this.spiritName(actorId) + ' 使用 ' + skillName + '，' + this.spiritName(targetId) + ' 回复 ' + actual + ' 点生命。');
    return actual;
  }

  private healSpiritFlat(actorId: string, targetId: string, amount: number, skillName: string) {
    const target = this.getSpirit(targetId);
    const before = target.hp;
    const attempted = Math.max(0, amount);
    target.hp = Math.min(this.spiritInfo(targetId).maxHp, target.hp + attempted);
    const actual = target.hp - before;
    this.notifyTelemetry('onHealingResolved', {
      round: this.state.round.index,
      actorId,
      skillId: this.telemetrySkillContext?.skillId,
      targetId,
      attempted,
      effective: actual,
      overheal: Math.max(0, attempted - actual),
      skillCastId: this.telemetrySkillContext?.skillCastId,
      hpBefore: before,
      hpAfter: target.hp,
      healingSourceType: 'direct',
      targetSlotIndex: this.findSlotBySpirit(targetId)?.index,
      targetRow: this.findSlotBySpirit(targetId)?.row,
      targetHpAfter: target.hp,
      targetMaxHp: this.spiritInfo(targetId).maxHp
    });
    this.log(this.spiritName(actorId) + ' 使用 ' + skillName + '，' + this.spiritName(targetId) + ' 回复 ' + actual + ' 点生命。');
    return actual;
  }

  private healFrontline(actorId: string, percent: number, skillName: string) {
    return this.frontSpiritIds().map((id) => ({
      id,
      amount: this.healSpirit(actorId, id, percent, skillName)
    }));
  }

  private healAllAllies(actorId: string, percent: number, skillName: string) {
    return this.getActiveSpiritIds().map((id) => ({
      id,
      amount: this.healSpirit(actorId, id, percent, skillName)
    }));
  }

  private shieldSpirit(actorId: string, targetId: string, percent: number, skillName: string) {
    const target = this.getSpirit(targetId);
    const amount = healAmount(target, percent);
    const before = target.shieldNextBossAction;
    target.shieldNextBossAction = Math.max(target.shieldNextBossAction, amount);
    const changed = target.shieldNextBossAction - before;
    this.notifyTelemetry('onShieldGranted', {
      round: this.state.round.index,
      actorId,
      skillId: this.telemetrySkillContext?.skillId,
      targetId,
      attempted: amount,
      granted: changed,
      mode: 'replace-if-higher',
      targetSlotIndex: this.findSlotBySpirit(targetId)?.index,
      targetRow: this.findSlotBySpirit(targetId)?.row
    });
    this.log(
      this.spiritName(actorId) +
        ' 使用 ' +
        skillName +
        '，' +
        this.spiritName(targetId) +
        ' 获得护盾 ' +
        target.shieldNextBossAction +
        (changed > 0 ? '。' : '（原护盾更高，数值不变）。')
    );
    return target.shieldNextBossAction;
  }

  private resetOwnSkillCooldowns(spirit: RuntimeSpirit, skipSkillId: string) {
    this.spiritInfo(spirit.id).skillIds.forEach((skillId) => {
      if (skillId !== skipSkillId) spirit.skillCooldowns[skillId] = 0;
    });
  }

  private applySkillCooldown(spirit: RuntimeSpirit, skill: SkillData) {
    const cooldown = skill.cooldown ?? 0;
    if (cooldown <= 0) return;
    spirit.skillCooldowns[skill.id] = cooldown;
    this.log(skill.name + ' 进入 CD ' + cooldown + '。');
  }

  private tickSkillCooldowns(spirit: RuntimeSpirit, skipSkillId?: string) {
    Object.keys(spirit.skillCooldowns).forEach((skillId) => {
      if (skillId === skipSkillId) return;
      const before = spirit.skillCooldowns[skillId] ?? 0;
      if (before <= 0) return;
      spirit.skillCooldowns[skillId] = Math.max(0, before - 1);
      if (spirit.skillCooldowns[skillId] === 0) {
        this.log((this.config.skillConfig[skillId]?.name ?? skillId) + ' 冷却完毕。');
      }
    });
  }

  private payMana(cost: number) {
    if (cost <= 0) return 0;
    const before = this.state.mana.current;
    this.state.mana.current = Math.max(0, this.state.mana.current - cost);
    const spent = before - this.state.mana.current;
    this.notifyTelemetry('onEnergyChanged', {
      round: this.state.round.index,
      source: 'skill',
      actorId: this.telemetrySkillContext?.actorId,
      skillId: this.telemetrySkillContext?.skillId,
      before,
      attemptedGain: 0,
      gained: 0,
      spent,
      after: this.state.mana.current
    });
    this.log('团队妖力 ' + before + ' → ' + this.state.mana.current + '（-' + (before - this.state.mana.current) + '，技能消耗）。');
    return spent;
  }

  private gainMana(gain: number, attemptedGain = gain) {
    if (attemptedGain <= 0) return 0;
    const before = this.state.mana.current;
    this.state.mana.current = Math.min(this.state.mana.max, this.state.mana.current + gain);
    const actual = this.state.mana.current - before;
    this.notifyTelemetry('onEnergyChanged', {
      round: this.state.round.index,
      source: 'skill',
      actorId: this.telemetrySkillContext?.actorId,
      skillId: this.telemetrySkillContext?.skillId,
      before,
      attemptedGain,
      gained: actual,
      spent: 0,
      after: this.state.mana.current
    });
    if (actual > 0) {
      this.log('团队妖力 ' + before + ' → ' + this.state.mana.current + '（+' + actual + '，技能回能）。');
    } else if (gain > 0) {
      this.log('团队妖力已达上限，尝试获得 +' + gain + ' 未改变。');
    }
    return actual;
  }

  private fullManaThreshold() {
    return this.config.fullManaThreshold;
  }

  private recordBattleFx(event: Omit<BattleFxEvent, 'serial'>) {
    this.state.battleFx = {
      ...event,
      enemyActorId: event.enemyActorId ?? (event.kind.startsWith('boss-') && this.state.activeUnit?.type === 'boss' ? this.state.activeUnit.id : undefined),
      serial: (this.state.battleFx?.serial ?? 0) + 1
    };
  }

  private skillRuntimeTelemetryState(spirit: RuntimeSpirit, skillId: string) {
    return {
      lastSkillId: spirit.lastSkillId,
      consecutiveUseCount: spirit.lastSkillId === skillId ? spirit.skillUseStreak : 0,
      skillBattleUseCount: spirit.skillUseCounts[skillId] ?? 0,
      entrySkillAvailable: spirit.entrySkillAvailable,
      entrySequenceId: spirit.entrySequenceId,
      skillUseIndexAfterEntry: spirit.skillUseIndexAfterEntry,
      damageAmpStacks: spirit.damageAmpStacks,
      shieldValue: spirit.shieldValue
    };
  }

  private skillFreeCastReason(skill: SkillData, spirit: RuntimeSpirit, actualCost: number) {
    if (skill.cost <= 0 || actualCost > 0) return 'none' as const;
    if (skill.firstUseInBattleCostReduction && (spirit.skillUseCounts[skill.id] ?? 0) === 0) return 'first_use_in_battle' as const;
    if (skill.firstSkillAfterEntryCostReduction && spirit.entrySkillAvailable) return 'first_skill_after_entry' as const;
    if (skill.consecutiveUseCostReduction) return 'dynamic_cost_reduced_to_zero' as const;
    return 'none' as const;
  }

  private skillTelemetryTargetIds(skill: SkillData, actorId: string, selectedTargetId?: string) {
    if (skill.target === 'ally-all') return this.getActiveSpiritIds();
    if (skill.target === 'self') return [actorId];
    if (skill.target === 'team-mana') return [];
    return selectedTargetId ? [selectedTargetId] : [];
  }

  private recordSkillUse(spirit: RuntimeSpirit, skill: SkillData, actualCost: number, previousSkillId: string | null) {
    let resetTrigger: 'none' | 'zero_cost_cast' | 'other_skill_used' | 'battle_start' = 'none';
    if (previousSkillId && previousSkillId !== skill.id && this.config.skillConfig[previousSkillId]?.consecutiveUseCostReduction) {
      resetTrigger = 'other_skill_used';
    }
    if (spirit.lastSkillId === skill.id) {
      spirit.skillUseStreak += 1;
    } else {
      spirit.lastSkillId = skill.id;
      spirit.skillUseStreak = 1;
    }
    spirit.skillUseCounts[skill.id] = (spirit.skillUseCounts[skill.id] ?? 0) + 1;
    spirit.skillUseIndexAfterEntry += 1;
    spirit.entrySkillAvailable = false;
    if (skill.resetConsecutiveUseAtMinimumCost && actualCost === (skill.minimumCost ?? 0)) {
      spirit.lastSkillId = null;
      spirit.skillUseStreak = 0;
      resetTrigger = 'zero_cost_cast';
    }
    return resetTrigger;
  }

  private finishSpiritTurnStatuses(spirit: RuntimeSpirit) {
    const before = Object.fromEntries(Object.entries(spirit.statuses).map(([id, status]) => [id, { ...status }]));
    tickOwnerStatuses(spirit.statuses);
    Object.entries(before).forEach(([id, status]) => {
      if (!spirit.statuses[id]) {
        this.log(this.spiritName(spirit.id) + ' 的' + statusName(id) + '结束。');
        this.notifyStatusRemoval(status, spirit.id, 'duration_expired');
      } else if (spirit.statuses[id].duration !== status.duration) {
        this.notifyStatusChange(status, spirit.statuses[id], spirit.id, 'owner_action_end');
      }
    });
    this.syncLegacyStatusFields(spirit);
    this.finishSpiritShield(spirit);
  }

  private finishSpiritShield(spirit: RuntimeSpirit) {
    if (spirit.shieldValue <= 0) {
      spirit.freshShieldValue = 0;
      return;
    }
    const preservedFreshShield = Math.min(spirit.shieldValue, spirit.freshShieldValue);
    const cleared = spirit.shieldValue - preservedFreshShield;
    if (cleared > 0) this.consumeShieldLedger(spirit, cleared, { reason: 'expiration' });
    spirit.freshShieldValue = 0;
    if (cleared > 0) this.log(this.spiritName(spirit.id) + ' 正常行动结束，清除 ' + cleared + ' 护盾。');
  }

  private finishBossTurnStatuses() {
    const before = Object.fromEntries(Object.entries(this.state.boss.statuses).map(([id, status]) => [id, { ...status }]));
    tickOwnerStatuses(this.state.boss.statuses);
    Object.entries(before).forEach(([id, status]) => {
      if (!this.state.boss.statuses[id]) {
        this.log(this.config.bossConfig.name + ' 的' + statusName(id) + '结束。');
        this.notifyStatusRemoval(status, this.state.boss.id, 'duration_expired');
      } else if (this.state.boss.statuses[id].duration !== status.duration) {
        this.notifyStatusChange(status, this.state.boss.statuses[id], this.state.boss.id, 'owner_action_end');
      }
    });
  }

  private finishPlayerAction(keepLastSkill: boolean, usedSkillId?: string, slotStatus: 'completed' | 'skipped' = 'completed') {
    const actor = this.getActingSpirit();
    if (actor) {
      actor.action = 0;
      if (this.state.actionContext === 'normal') {
        this.tickSkillCooldowns(actor, usedSkillId);
        this.finishSpiritTurnStatuses(actor);
        if (!usedSkillId) actor.entrySkillAvailable = false;
        this.completeCurrentActionSlot(slotStatus);
      }
      if (!keepLastSkill) actor.lastSkillId = null;
      if (!keepLastSkill) actor.skillUseStreak = 0;
    }
    this.state.pendingSkillId = null;
    this.state.activeUnit = null;
    if (this.checkGameOver()) {
      this.emit();
      return;
    }
    const shouldGrantExtraAction = Boolean(
      usedSkillId &&
      this.config.skillConfig[usedSkillId]?.grantsExtraAction &&
      this.state.actionContext === 'normal' &&
      actor &&
      actor.hp > 0 &&
      this.findSlotBySpirit(actor.id)
    );
    if (shouldGrantExtraAction && actor) {
      this.state.actionSerial += 1;
      this.telemetryActionEnergy = { before: this.state.mana.current, gained: 0, after: this.state.mana.current };
      this.state.actionContext = 'extra';
      this.state.phase = 'player-action';
      this.state.activeUnit = { type: 'spirit', id: actor.id };
      this.log(this.spiritName(actor.id) + ' 获得额外行动。');
      this.notifyTelemetry('onActionStart', {
        round: this.state.round.index,
        side: 'player',
        unitId: actor.id,
        actionContext: 'extra',
        mana: this.state.mana.current,
        playerSlots: this.playerTelemetrySlots(),
        reserveIds: this.getBenchSpiritIds()
      });
      this.emit();
      return;
    }
    this.state.actionContext = 'normal';
    this.state.phase = 'running';
    this.emit();
  }

  private executeBossTurn() {
    this.executeMonsterTurn();
  }

  private executeMonsterTurn() {
    const definition = this.monsterDefinition;
    const runtime = this.monsterAi;
    const random = this.monsterRandom;
    if (!definition || !runtime || !random) return;

    this.state.boss.action = 0;
    this.expireMonsterActionWindows();

    const selection = selectMonsterAction(
      definition,
      MONSTER_SKILLS,
      runtime,
      random,
      (skillId) => this.isMonsterSkillAvailable(MONSTER_SKILLS[skillId])
    );
    this.logMonsterRandomTrace(selection.randomTrace);

    if (!selection.skillId) {
      this.log(this.config.bossConfig.name + ' 没有合法技能，本次行动跳过。');
    } else {
      const skill = MONSTER_SKILLS[selection.skillId];
      this.log(this.config.bossConfig.name + ' 使用 ' + skill.name + '。');
      this.executeMonsterSkill(
        skill,
        selection.source,
        selection.lockedTargetId,
        selection.lockedSlotIndex,
        selection.lockedRow,
        selection.lockedOriginSlotIndex,
        selection.lockedOriginRow
      );
      this.setMonsterSkillCooldown(skill);
      this.tickBossCooldowns(skill.id);
    }

    this.finishBossTurnStatuses();
    this.completeCurrentActionSlot('completed');
    this.state.activeUnit = null;
    if (this.checkGameOver()) {
      this.emit();
      return;
    }
    this.state.phase = 'running';
    this.emit();
  }

  private expireMonsterActionWindows() {
    if (!this.monsterAi) return;
    if (this.monsterAi.exposedActive) {
      this.monsterAi.exposedActive = false;
      this.log('熔核破绽移除：本次怪物行动开始前结束。');
    }
  }

  private isMonsterSkillAvailable(skill?: MonsterSkillDefinition) {
    if (!skill || (this.state.boss.cooldowns[skill.id] ?? 0) > 0) return false;
    if (skill.execution.targetRule === 'self') return true;
    return this.monsterTargetIds(skill).length > 0;
  }

  private executeMonsterSkill(
    skill: MonsterSkillDefinition,
    source: 'forced_followup' | 'forced_opening' | 'weighted' | 'basic_fallback' | 'skip',
    lockedTargetId?: string,
    lockedSlotIndex?: number,
    lockedRow?: Row,
    lockedOriginSlotIndex?: number,
    lockedOriginRow?: Row
  ) {
    const runtime = this.monsterAi;
    const random = this.monsterRandom;
    if (!runtime || !random) return;

    if (skill.execution.telegraph?.enabled && source !== 'forced_followup') {
      let targetId: string | undefined;
      if (skill.execution.telegraph.targetSelection === 'random_legal_single_target') {
        const picked = selectSeededTarget(this.monsterTargetIds(skill), random, 'monster_telegraph_target_selection');
        this.logMonsterRandomTrace(picked.randomTrace);
        targetId = picked.targetId ?? undefined;
      }
      runtime.pendingFollowup = {
        skillId: skill.execution.telegraph.followupSkillId ?? skill.id,
        lockedTargetId: skill.execution.telegraph.lockMode === 'unit' ? targetId : undefined,
        lockedSlotIndex: skill.execution.telegraph.lockMode === 'position' && targetId ? this.findSlotBySpirit(targetId)?.index : undefined,
        lockedRow: skill.execution.telegraph.lockMode === 'position' && targetId ? this.findSlotBySpirit(targetId)?.row : undefined,
        lockedOriginSlotIndex: skill.execution.telegraph.lockMode === 'unit' && targetId ? this.findSlotBySpirit(targetId)?.index : undefined,
        lockedOriginRow: skill.execution.telegraph.lockMode === 'unit' && targetId ? this.findSlotBySpirit(targetId)?.row : undefined
      };
      if (this.monsterDefinition?.category === 'boss') {
        runtime.actLastNextRound = true;
        this.log(this.state.boss.name + ' 使用了预告技能，将在下一回合最后行动。');
      }
      this.log(
        skill.name +
          '完成预告，下一次合法行动强制使用 ' +
          (MONSTER_SKILLS[runtime.pendingFollowup.skillId]?.name ?? runtime.pendingFollowup.skillId) +
          (targetId ? skill.execution.telegraph.lockMode === 'position' ? '，锁定 ' + rowName(this.findSlotBySpirit(targetId)?.row ?? 'front') + '位置' : '，锁定 ' + this.spiritName(targetId) : '') +
          '。'
      );
      this.recordBattleFx({
        kind: 'boss-buff',
        bossBehaviorName: skill.name,
        telegraphSkillName: MONSTER_SKILLS[runtime.pendingFollowup.skillId]?.name ?? runtime.pendingFollowup.skillId,
        amount: 0,
        manaBefore: this.state.mana.current,
        manaAfter: this.state.mana.current,
        manaCost: 0,
        manaGain: 0
      });
      this.notifyTelemetry('onBossSkillUsed', {
        round: this.state.round.index,
        enemyId: this.state.boss.id,
        enemyDefinitionId: this.state.boss.definitionId,
        skillId: skill.id,
        source,
        telegraph: true,
        targetIds: targetId ? [targetId] : [],
        power: runtimeMonsterSkillPower(runtime, MONSTER_SKILLS[runtime.pendingFollowup.skillId] ?? skill),
        lockedTargetId: runtime.pendingFollowup.lockedTargetId,
        lockedSlotIndex: runtime.pendingFollowup.lockedSlotIndex,
        lockedOriginSlotIndex: runtime.pendingFollowup.lockedOriginSlotIndex,
        lockedRow: runtime.pendingFollowup.lockedRow,
        playerSlots: this.playerTelemetrySlots(),
        reserveIds: this.getBenchSpiritIds()
      });
      return;
    }

    if (skill.execution.status) {
      const status = skill.execution.status;
      runtime.damageIncreaseStacks += status.stacksAdded;
      this.log(
        this.config.bossConfig.name +
          ' 获得 ' +
          status.stacksAdded +
          ' 层【伤害增加】，当前 ' +
          runtime.damageIncreaseStacks +
          ' 层，造成伤害倍率 ×' +
          formatMultiplier(monsterDamageMultiplier(runtime)) +
          '。'
      );
      this.recordBattleFx({
        kind: 'boss-buff',
        bossBehaviorName: skill.name,
        amount: status.stacksAdded * status.perStackValue,
        manaBefore: this.state.mana.current,
        manaAfter: this.state.mana.current,
        manaCost: 0,
        manaGain: 0
      });
    }

    const power = runtimeMonsterSkillPower(runtime, skill);
    let affectedTargetIds: string[] = [];
    if (skill.execution.damageType !== 'none' && power > 0) {
      if (skill.execution.targetRule === 'enemy_all') {
        affectedTargetIds = this.executeMonsterAreaDamage(skill);
      } else if (skill.execution.targetRule === 'enemy_single') {
        affectedTargetIds = this.executeMonsterSingleDamage(
          skill,
          source,
          lockedTargetId,
          lockedSlotIndex,
          lockedRow,
          lockedOriginSlotIndex,
          lockedOriginRow
        );
      }
    }

    this.applyMonsterSkillEffects(skill, affectedTargetIds);
    this.updateMonsterActionCycle(skill);
    if (skill.execution.specialEffects?.includes('apply_exposed')) {
      runtime.exposedActive = true;
      this.log('高温爆发完成结算，熔核破绽施加：Boss 在下一次行动开始前受到伤害 ×' + formatMultiplier(this.config.monsterExposedDamageTakenMultiplier ?? 1) + '。');
    }
    const unresolvedReason = source === 'forced_followup' && affectedTargetIds.length === 0
      ? lockedTargetId && this.state.spirits[lockedTargetId]?.hp <= 0
        ? 'locked-unit-defeated' as const
        : lockedSlotIndex !== undefined || lockedOriginSlotIndex !== undefined
          ? 'target-row-empty' as const
          : 'other' as const
      : undefined;
    this.notifyTelemetry('onBossSkillUsed', {
      round: this.state.round.index,
      enemyId: this.state.boss.id,
      enemyDefinitionId: this.state.boss.definitionId,
      skillId: skill.id,
      source,
      telegraph: false,
      targetIds: [...affectedTargetIds],
      power,
      lockedTargetId,
      lockedSlotIndex,
      lockedOriginSlotIndex,
      lockedRow,
      playerSlots: this.playerTelemetrySlots(),
      reserveIds: this.getBenchSpiritIds(),
      unresolvedReason
    });
    if (skill.execution.consumeTemporaryPowerAfterUse) {
      const consumed = consumeRuntimeMonsterSkillTemporaryPower(runtime, skill.id);
      if (consumed.before > 0) this.log(skill.name + ' 完成结算，临时威力 +' + consumed.before + ' 已清除。');
    }

  }

  private executeMonsterSingleDamage(
    skill: MonsterSkillDefinition,
    source: 'forced_followup' | 'forced_opening' | 'weighted' | 'basic_fallback' | 'skip',
    lockedTargetId?: string,
    lockedSlotIndex?: number,
    lockedRow?: Row,
    lockedOriginSlotIndex?: number,
    lockedOriginRow?: Row
  ) {
    let targetId: string | null = null;
    if (source === 'forced_followup' && lockedTargetId) {
      targetId = this.getActiveSpiritIds().includes(lockedTargetId) ? lockedTargetId : null;
      if (!targetId) {
        const lockedTarget = this.state.spirits[lockedTargetId];
        const targetSwappedOut = Boolean(lockedTarget && lockedTarget.hp > 0);
        if (targetSwappedOut && lockedOriginSlotIndex !== undefined) {
          const originSlot = this.state.slots[lockedOriginSlotIndex];
          targetId = originSlot?.spiritId && this.isAlive(originSlot.spiritId) ? originSlot.spiritId : null;
          if (targetId) {
            this.log(skill.name + ' 的原锁定目标已换宠，攻击改为命中原目标行上的 ' + this.spiritName(targetId) + '。');
          }
        }
        if (!targetId) {
          this.log(skill.name + ' 的锁定目标已死亡或原目标行无人占据，技能落空且不重新选取目标。');
          return [];
        }
      }
    } else if (source === 'forced_followup' && lockedSlotIndex !== undefined && lockedRow) {
      const slot = this.state.slots[lockedSlotIndex];
      targetId = slot?.spiritId && this.isAlive(slot.spiritId) ? slot.spiritId : null;
      if (!targetId) {
        this.log(skill.name + ' 的锁定目标行为空，技能落空且不重新选取目标。');
        return [];
      }
    } else {
      const legalTargetIds = this.monsterTargetIds(skill);
      const lastTargetId = this.monsterAi?.lastTargetIdBySkill[skill.id];
      const controlledCandidates =
        skill.execution.targetSelection === 'controlled_random_no_immediate_repeat' &&
        legalTargetIds.length > 1 &&
        lastTargetId
          ? legalTargetIds.filter((id) => id !== lastTargetId)
          : legalTargetIds;
      const picked = selectSeededTarget(controlledCandidates, this.monsterRandom!, 'monster_single_target_selection');
      this.logMonsterRandomTrace(picked.randomTrace);
      targetId = picked.targetId;
      if (targetId && skill.execution.targetSelection === 'controlled_random_no_immediate_repeat') {
        this.monsterAi!.lastTargetIdBySkill[skill.id] = targetId;
      }
    }
    if (!targetId) {
      this.log(skill.name + ' 没有合法目标，技能落空。');
      return [];
    }
    const amount = this.applyMonsterDamage(targetId, skill);
    this.flashHit([targetId]);
    this.recordBattleFx({
      kind: 'boss-attack',
      targetIds: [targetId],
      targetAmounts: { [targetId]: amount },
      bossBehaviorName: skill.name,
      amount,
      manaBefore: this.state.mana.current,
      manaAfter: this.state.mana.current,
      manaCost: 0,
      manaGain: 0
    });
    return [targetId];
  }

  private executeMonsterAreaDamage(skill: MonsterSkillDefinition) {
    const targetIds = this.monsterTargetIds(skill);
    const targetAmounts: Record<string, number> = {};
    targetIds.forEach((targetId) => {
      targetAmounts[targetId] = this.applyMonsterDamage(targetId, skill);
    });
    this.flashHit(targetIds);
    this.recordBattleFx({
      kind: 'boss-attack',
      targetIds,
      targetAmounts,
      bossBehaviorName: skill.name,
      amount: Math.max(0, ...Object.values(targetAmounts)),
      manaBefore: this.state.mana.current,
      manaAfter: this.state.mana.current,
      manaCost: 0,
      manaGain: 0
    });
    return targetIds;
  }

  private applyMonsterSkillEffects(skill: MonsterSkillDefinition, targetIds: string[]) {
    const runtime = this.monsterAi;
    const definition = this.monsterDefinition;
    if (!runtime || !definition) return;
    (skill.execution.effects ?? []).forEach((effect) => {
      if (effect.type === 'increase_runtime_skill_power') {
        const change = increaseRuntimeMonsterSkillPower(runtime, effect.targetSkillId, effect.amount);
        this.log((MONSTER_SKILLS[effect.targetSkillId]?.name ?? effect.targetSkillId) + '威力：' + change.before + ' → ' + change.after + '。');
        this.recordBattleFx({
          kind: 'boss-buff', bossBehaviorName: skill.name, amount: effect.amount,
          manaBefore: this.state.mana.current, manaAfter: this.state.mana.current, manaCost: 0, manaGain: 0
        });
        return;
      }
      if (effect.type === 'set_runtime_skill_temporary_power') {
        const change = setRuntimeMonsterSkillTemporaryPower(runtime, effect.targetSkillId, effect.amount);
        this.log((MONSTER_SKILLS[effect.targetSkillId]?.name ?? effect.targetSkillId) + '临时威力：+' + change.before + ' → +' + change.after + '。');
        this.recordBattleFx({
          kind: 'boss-buff', bossBehaviorName: skill.name, amount: effect.amount,
          manaBefore: this.state.mana.current, manaAfter: this.state.mana.current, manaCost: 0, manaGain: 0
        });
        return;
      }
      targetIds.forEach((targetId) => {
        const target = this.getSpirit(targetId);
        if (!target || target.hp <= 0) return;
        const beforeStacks = target.statuses[effect.statusId]?.stacks ?? 0;
        target.statuses[effect.statusId] = mergeRuntimeStatus(target.statuses[effect.statusId], {
          id: effect.statusId,
          name: effect.name,
          duration: effect.duration ?? 0,
          value: effect.value ?? 0,
          temporary: effect.temporary,
          clearOnBench: effect.clearOnBench,
          stackable: effect.stackable,
          maxStacks: effect.maxStacks,
          stacks: effect.stacks,
          sourceId: definition.id
        });
        const afterStacks = target.statuses[effect.statusId].stacks;
        this.log(this.spiritName(targetId) + ' 获得【' + effect.name + '】' + (effect.stackable ? '，当前 ' + afterStacks + ' 层' + (afterStacks === beforeStacks ? '（已达上限）' : '') : '') + '。');
      });
    });
  }

  private updateMonsterActionCycle(skill: MonsterSkillDefinition) {
    const runtime = this.monsterAi;
    const cycle = this.monsterDefinition?.actionCycle;
    if (!runtime || !cycle) return;
    if (skill.id === cycle.forcedSkillId) {
      runtime.actionCycleCount = 0;
      this.log(cycle.counterLabel + '重置为 0/' + cycle.threshold + '。');
      return;
    }
    if (!cycle.countedSkillIds.includes(skill.id)) return;
    runtime.actionCycleCount = Math.min(cycle.threshold, runtime.actionCycleCount + 1);
    this.log(cycle.counterLabel + '：' + runtime.actionCycleCount + '/' + cycle.threshold + '。');
    if (runtime.actionCycleCount < cycle.threshold) return;
    runtime.pendingFollowup = { skillId: cycle.forcedSkillId };
    this.log(
      cycle.counterLabel +
        '达到 ' +
        cycle.threshold +
        '/' +
        cycle.threshold +
        '，下一次合法行动强制使用【' +
        (MONSTER_SKILLS[cycle.forcedSkillId]?.name ?? cycle.forcedSkillId) +
        '】。'
    );
  }

  private applyMonsterDamage(targetId: string, skill: MonsterSkillDefinition) {
    const target = this.getSpirit(targetId);
    const hpBefore = target.hp;
    const damageType = skill.execution.damageType ?? 'none';
    const power = runtimeMonsterSkillPower(this.monsterAi!, skill);
    const attack = damageType === 'physical' ? this.config.bossConfig.physicalAttack : this.config.bossConfig.magicAttack;
    const targetData = this.spiritInfo(targetId);
    const defense = damageType === 'physical' ? targetData.physicalDefense : targetData.magicDefense;
    const baseDamage = damageType === 'fixed' ? power : Math.ceil((power * attack) / Math.max(1, defense));
    const damageMultiplier = monsterDamageMultiplier(this.monsterAi!);
    const statusInteraction = skill.execution.targetStatusDamageInteraction;
    const statusStacks = statusInteraction ? target.statuses[statusInteraction.statusId]?.stacks ?? 0 : 0;
    const statusDamageMultiplier = statusInteraction
      ? 1 + statusStacks * (statusInteraction.finalDamageMultiplierPerStack ?? 0)
      : 1;
    const finalDamageMultiplier = damageMultiplier * statusDamageMultiplier;
    const rawDamage = Math.max(1, Math.ceil(baseDamage * finalDamageMultiplier));
    const shieldPenetration = this.monsterShieldPenetration(rawDamage, statusStacks, statusInteraction?.shieldPenetration);
    if (statusInteraction && statusStacks > 0 && statusDamageMultiplier > 1) {
      const statusName = target.statuses[statusInteraction.statusId]?.name ?? statusInteraction.statusId;
      this.log(this.spiritName(targetId) + ' 的 ' + statusStacks + ' 层【' + statusName + '】生效，' + skill.name + '伤害倍率 ×' + formatMultiplier(statusDamageMultiplier) + '。');
    }
    if (statusInteraction && statusStacks > 0 && shieldPenetration > 0) {
      const statusName = target.statuses[statusInteraction.statusId]?.name ?? statusInteraction.statusId;
      this.log(this.spiritName(targetId) + ' 的 ' + statusStacks + ' 层【' + statusName + '】使 ' + skill.name + ' 有 ' + shieldPenetration + ' 点伤害绕过护盾。');
    }
    const shieldableDamage = Math.max(0, rawDamage - shieldPenetration);
    const absorbed = Math.min(target.shieldValue, shieldableDamage);
    if (absorbed > 0) {
      this.consumeShieldLedger(target, absorbed, {
        reason: 'absorb',
        incomingDamageBeforeShield: rawDamage,
        hpDamageAfterShield: Math.max(0, rawDamage - absorbed)
      });
      target.freshShieldValue = Math.min(target.freshShieldValue, target.shieldValue);
      this.log(this.spiritName(targetId) + ' 的护盾吸收 ' + absorbed + ' 点伤害。');
    }
    const hpDamage = Math.max(0, rawDamage - absorbed);
    target.hp = Math.max(0, target.hp - hpDamage);
    const actualHpDamage = hpBefore - target.hp;
    const overkillDamage = Math.max(0, hpDamage - actualHpDamage);
    this.notifyTelemetry('onDamageResolved', {
      round: this.state.round.index,
      sourceSide: 'enemy',
      sourceId: this.state.boss.id,
      skillId: skill.id,
      targetSide: 'player',
      targetId,
      attempted: rawDamage,
      actual: actualHpDamage,
      absorbed,
      hitIndex: 1,
      damageType: damageType === 'magical' ? 'magic' : damageType === 'fixed' ? 'fixed' : 'physical',
      baseOrPreModifierDamage: baseDamage,
      finalDamage: actualHpDamage,
      isCritical: false,
      criticalMultiplier: 1,
      hpBefore,
      hpAfter: target.hp,
      power,
      targetRow: this.findSlotBySpirit(targetId)?.row,
      targetSlotIndex: this.findSlotBySpirit(targetId)?.index,
      targetHpAfter: target.hp,
      targetMaxHp: targetData.maxHp,
      formulaBaseDamage: baseDamage,
      damageMultiplier: finalDamageMultiplier,
      theoreticalDamage: rawDamage,
      actualSettlementDamage: rawDamage,
      overkillDamage,
      mitigatedDamage: 0,
      ineffectiveDamage: 0
    });
    this.log(this.config.bossConfig.name + ' 的' + skill.name + '命中 ' + this.spiritName(targetId) + '，造成 ' + hpDamage + ' 点伤害。');
    if (target.hp === 0) {
      this.log(this.spiritName(targetId) + ' 阵亡。');
      this.notifyTelemetry('onUnitDefeated', {
        round: this.state.round.index,
        side: 'player',
        unitId: targetId,
        sourceId: this.state.boss.id,
        skillId: skill.id
      });
      this.vacateDefeatedSpirit(targetId, skill.id);
    } else if (target.chargeTurns > 0) {
      this.log(this.spiritName(targetId) + ' 的蓄势被攻击触发。');
      const charge = target.statuses[CORE_STATUS_RULES.charge.id];
      if (charge) {
        delete target.statuses[CORE_STATUS_RULES.charge.id];
        target.chargeTurns = 0;
        this.notifyStatusRemoval(charge, targetId, 'triggered');
      }
      this.addDamageAmp(targetId, CHARGE_DAMAGE_AMP_STACKS_ON_HIT, '蓄势', this.state.boss.id, skill.id);
    }
    return hpDamage;
  }

  private reconcileShieldLedger(spirit: RuntimeSpirit) {
    spirit.shieldInstances ??= [];
    const tracked = spirit.shieldInstances.reduce((sum, instance) => sum + instance.remaining, 0);
    if (tracked < spirit.shieldValue) {
      const amount = spirit.shieldValue - tracked;
      spirit.shieldInstances.push({
        id: `${String(this.battleSeed)}:shield:${++this.telemetryShieldSerial}`,
        sourceUnitId: spirit.id,
        generated: amount,
        remaining: amount,
        createdOrder: this.telemetryShieldSerial
      });
    } else if (tracked > spirit.shieldValue) {
      let excess = tracked - spirit.shieldValue;
      for (let index = spirit.shieldInstances.length - 1; index >= 0 && excess > 0; index -= 1) {
        const instance = spirit.shieldInstances[index];
        const removed = Math.min(instance.remaining, excess);
        instance.remaining -= removed;
        excess -= removed;
      }
      spirit.shieldInstances = spirit.shieldInstances.filter((instance) => instance.remaining > 0);
    }
  }

  private consumeShieldLedger(
    spirit: RuntimeSpirit,
    requested: number,
    context: {
      reason: 'absorb' | 'skill' | 'expiration';
      incomingDamageBeforeShield?: number;
      hpDamageAfterShield?: number;
      consumedBySkillId?: string;
      fixedDamageRatio?: number;
    }
  ) {
    this.reconcileShieldLedger(spirit);
    let remaining = Math.min(Math.max(0, requested), spirit.shieldValue);
    const consumedTotal = remaining;
    for (const instance of spirit.shieldInstances) {
      if (remaining <= 0) break;
      const consumed = Math.min(instance.remaining, remaining);
      if (consumed <= 0) continue;
      instance.remaining -= consumed;
      remaining -= consumed;
      if (context.reason === 'absorb') {
        this.notifyTelemetry('onShieldAbsorbed', {
          round: this.state.round.index,
          targetId: spirit.id,
          shieldInstanceId: instance.id,
          sourceUnitId: instance.sourceUnitId,
          sourceSkillId: instance.sourceSkillId,
          absorbedDamage: consumed,
          remainingShield: instance.remaining,
          incomingDamageBeforeShield: context.incomingDamageBeforeShield ?? 0,
          hpDamageAfterShield: context.hpDamageAfterShield ?? 0
        });
      } else if (context.reason === 'skill' && context.consumedBySkillId) {
        this.notifyTelemetry('onShieldConsumed', {
          round: this.state.round.index,
          targetId: spirit.id,
          shieldInstanceId: instance.id,
          sourceUnitId: instance.sourceUnitId,
          sourceSkillId: instance.sourceSkillId,
          consumedBySkillId: context.consumedBySkillId,
          skillCastId: this.telemetrySkillContext?.skillCastId,
          shieldConsumed: consumed,
          fixedDamageGenerated: Math.ceil(consumed * (context.fixedDamageRatio ?? 0)),
          remainingShield: instance.remaining
        });
      }
    }
    spirit.shieldInstances = spirit.shieldInstances.filter((instance) => instance.remaining > 0);
    spirit.shieldValue = Math.max(0, spirit.shieldValue - consumedTotal);
    return consumedTotal;
  }

  private monsterShieldPenetration(
    rawDamage: number,
    statusStacks: number,
    config?: NonNullable<MonsterSkillDefinition['execution']['targetStatusDamageInteraction']>['shieldPenetration']
  ) {
    if (!config || statusStacks <= 0 || rawDamage <= 0 || config.settlement !== 'bypass') return 0;
    const uncappedValue = Math.max(0, config.amountPerStack * statusStacks);
    const cappedValue = config.maxValue === undefined ? uncappedValue : Math.min(uncappedValue, Math.max(0, config.maxValue));
    if (config.mode === 'percentage') return Math.min(rawDamage, Math.ceil(rawDamage * Math.min(1, cappedValue)));
    return Math.min(rawDamage, Math.ceil(cappedValue));
  }

  private reduceMonsterTemporaryPowerOnPlayerAttack() {
    const runtime = this.monsterAi;
    const response = this.monsterDefinition?.temporaryPowerResponse;
    if (!runtime || !response) return;
    const change = reduceRuntimeMonsterSkillTemporaryPower(runtime, response.targetSkillId, response.reductionPerPlayerAttack);
    if (change.before <= 0 || change.before === change.after) return;
    this.log(
      '攻击削弱【' +
        (MONSTER_SKILLS[response.targetSkillId]?.name ?? response.targetSkillId) +
        '】临时威力：+' +
        change.before +
        ' → +' +
        change.after +
        '。'
    );
  }

  private setMonsterSkillCooldown(skill: MonsterSkillDefinition) {
    if (skill.cooldown > 0) this.state.boss.cooldowns[skill.id] = skill.cooldown;
  }

  private logMonsterRandomTrace(trace?: { callIndex: number; label: string; value: number }) {
    if (!trace) return;
    this.log('随机调用 #' + trace.callIndex + ' [' + trace.label + '] = ' + trace.value.toFixed(6) + '。');
  }

  private monsterTargetIds(skill: MonsterSkillDefinition) {
    const preference = skill.execution.targetPreference ?? (skill.execution.targetRule === 'enemy_all' ? 'all' : 'front');
    if (preference === 'all') return this.getActiveSpiritIds();
    const primary = preference === 'front' ? this.frontSpiritIds() : this.backSpiritIds();
    if (primary.length > 0) return primary;
    return preference === 'front' ? this.backSpiritIds() : this.frontSpiritIds();
  }

  private frontSpiritIds() {
    return this.state.slots
      .filter((slot) => slot.row === 'front' && slot.spiritId && this.isAlive(slot.spiritId))
      .map((slot) => slot.spiritId as string);
  }

  private backSpiritIds() {
    return this.state.slots
      .filter((slot) => slot.row === 'back' && slot.spiritId && this.isAlive(slot.spiritId))
      .map((slot) => slot.spiritId as string);
  }

  private lowestHpRatioTarget(ids: string[]) {
    return ids
      .map((id) => ({ id, ratio: this.getSpirit(id).hp / this.spiritInfo(id).maxHp }))
      .sort((a, b) => a.ratio - b.ratio)[0]?.id ?? null;
  }

  private tickBossCooldowns(skipId: string) {
    Object.keys(this.state.boss.cooldowns).forEach((id) => {
      if (id === skipId) return;
      this.state.boss.cooldowns[id] = Math.max(0, this.state.boss.cooldowns[id] - 1);
    });
  }

  private vacateDefeatedSpirit(spiritId: string, sourceSkillId: string) {
    const slot = this.findSlotBySpirit(spiritId);
    this.clearDeadActionState(spiritId);
    if (!slot) return;
    if (!this.state.round.pendingReplacementSlotIndexes.includes(slot.index)) {
      this.state.round.pendingReplacementSlotIndexes.push(slot.index);
      this.state.round.pendingReplacementSlotIndexes.sort((a, b) => a - b);
      this.notifyTelemetry('onReplacementLifecycle', {
        round: this.state.round.index,
        status: 'scheduled',
        slotIndex: slot.index,
        defeatedUnitId: spiritId,
        sourceSkillId,
        reserveIds: this.getBenchSpiritIds()
      });
    }
    slot.spiritId = null;
    this.log('该位置在本回合剩余期间保持空置。');
  }

  private continueRoundEndReplacement() {
    if (this.checkGameOver()) return;
    while (this.state.round.pendingReplacementSlotIndexes.length > 0) {
      const slotIndex = this.state.round.pendingReplacementSlotIndexes.shift() as number;
      const slot = this.state.slots[slotIndex];
      if (!slot || slot.spiritId) continue;
      const candidates = this.getBenchSpiritIds();
      if (candidates.length === 0) {
        this.notifyTelemetry('onReplacementLifecycle', {
          round: this.state.round.index,
          status: 'no_reserve',
          slotIndex,
          reserveIds: []
        });
        this.log(rowName(slot.row) + '空位没有可用后备，继续保留空位。');
        continue;
      }
      this.state.replacement = {
        slotIndex,
        row: slot.row,
        candidates,
        reason: '回合结束：为' + rowName(slot.row) + '空位选择后备'
      };
      this.notifyTelemetry('onReplacementLifecycle', {
        round: this.state.round.index,
        status: 'requested',
        slotIndex,
        reserveIds: [...candidates]
      });
      this.state.phase = 'forced-replacement';
      return;
    }
    this.beginNextRound();
  }

  private finishRound() {
    this.log('第 ' + this.state.round.index + ' 回合的全部正常行动位已处理。');
    this.clearUntriggeredChargeAtRoundEnd();
    this.continueRoundEndReplacement();
    this.emit();
  }

  private clearUntriggeredChargeAtRoundEnd() {
    Object.values(this.state.spirits).forEach((spirit) => {
      const status = spirit.statuses[CORE_STATUS_RULES.charge.id];
      if (!status) return;
      delete spirit.statuses[CORE_STATUS_RULES.charge.id];
      spirit.chargeTurns = 0;
      this.notifyStatusRemoval(status, spirit.id, 'round_end');
      this.log(this.spiritName(spirit.id) + ' 的蓄势在回合结束时移除。');
    });
  }

  private beginNextRound() {
    const nextIndex = this.state.round.index + 1;
    const delayedEnemyIds = Object.entries(this.enemyAi)
      .filter(([, runtime]) => runtime.actLastNextRound)
      .map(([enemyId]) => enemyId);
    const round = this.buildBattleRound(nextIndex, this.state.slots, this.state.spirits, this.state.enemySlots, this.state.enemies);
    delayedEnemyIds.forEach((enemyId) => {
      this.enemyAi[enemyId].actLastNextRound = false;
    });
    this.state.round = round;
    this.state.tick = nextIndex - 1;
    Object.values(this.state.spirits).forEach((spirit) => {
      spirit.action = round.actionSlots.some((slot) => slot.type === 'spirit' && slot.unitId === spirit.id) ? 100 : 0;
    });
    Object.values(this.state.enemies).forEach((enemy) => {
      enemy.action = round.actionSlots.some((slot) => slot.type === 'boss' && slot.unitId === enemy.id) ? 100 : 0;
    });
    this.state.phase = 'running';
    this.state.actionContext = 'normal';
    this.state.activeUnit = null;
    this.log('第 ' + nextIndex + ' 回合开始，行动位已按当前速度锁定。');
    this.notifyTelemetry('onRoundStart', { round: nextIndex });
    delayedEnemyIds.forEach((enemyId) => {
      if (this.state.enemies[enemyId]?.hp > 0) {
        this.log(this.state.enemies[enemyId].name + ' 因上一回合使用预告技能，本回合行动移至最后。');
      }
    });
  }

  private nextRoundActionSlot() {
    while (this.state.round.cursor < this.state.round.actionSlots.length) {
      const slot = this.state.round.actionSlots[this.state.round.cursor];
      if (slot.status === 'pending') return slot;
      this.state.round.cursor += 1;
    }
    return null;
  }

  private completeCurrentActionSlot(status: 'completed' | 'invalid' | 'skipped') {
    const index = this.state.round.actionSlots.findIndex((slot) => slot.status === 'executing');
    if (index < 0) return;
    this.state.round.actionSlots[index].status = status;
    this.state.round.cursor = Math.max(this.state.round.cursor, index + 1);
  }

  private checkGameOver() {
    const bossDead = this.getActiveEnemyIds().length === 0;
    const playerDead = this.allSpiritsDead();
    if (bossDead && playerDead) {
      if (this.state.phase !== 'defeat') this.log('同一结算链中双方全部死亡，按规则判定 Boss 获胜。');
      this.state.phase = 'defeat';
      this.state.activeUnit = null;
      this.finishTelemetryBattle('defeat');
      return true;
    }
    if (bossDead) {
      if (this.state.phase !== 'victory') {
        this.log('敌方单位全部阵亡，战斗胜利。');
      }
      this.state.phase = 'victory';
      this.state.activeUnit = null;
      this.finishTelemetryBattle('victory');
      return true;
    }
    if (playerDead) {
      if (this.state.phase !== 'defeat') {
        this.log('玩家全部精灵阵亡，战斗失败。');
      }
      this.state.phase = 'defeat';
      this.state.activeUnit = null;
      this.finishTelemetryBattle('defeat');
      return true;
    }
    return false;
  }

  private allSpiritsDead() {
    return this.state.selectedSpiritIds.every((id) => this.state.spirits[id].hp <= 0);
  }

  private hasLegalPlayerAction(actorId: string) {
    const actor = this.getSpirit(actorId);
    const hasSkill = this.spiritInfo(actorId).skillIds.some((skillId) => {
      const skill = this.config.skillConfig[skillId];
      if (!skill || !this.canUseSkill(skill, actor)) return false;
      if (skill.kind === 'attack' || skill.target === 'boss') return this.getLegalEnemyTargetIds().length > 0;
      if (skill.target === 'ally-field') return this.getAllySkillTargetIds(skill, actorId).length > 0;
      if (skill.target === 'ally-all') return this.getActiveSpiritIds().length > 0;
      return true;
    });
    if (hasSkill) return true;
    if (this.state.actionContext === 'extra') return false;
    if (this.getBenchSpiritIds().length > 0) return true;
    return true;
  }

  private clearTemporaryBattleState(
    spirit: RuntimeSpirit,
    emitStatusEvents = false,
    removeReason = 'battle_transition',
    preserveBattleUseCounts = false
  ) {
    const removedStatuses = emitStatusEvents
      ? Object.values(spirit.statuses).filter((status) => status.temporary || status.clearOnBench).map((status) => ({ ...status }))
      : [];
    clearTemporaryStatuses(spirit.statuses);
    removedStatuses.forEach((status) => this.notifyStatusRemoval(status, spirit.id, removeReason));
    spirit.shieldNextBossAction = 0;
    spirit.nextSkillPowerBonus = 0;
    spirit.physicalAttackBonus = 0;
    spirit.magicAttackBonus = 0;
    spirit.speedModifier = 0;
    spirit.skillCooldowns = {};
    spirit.skillPowerGrowth = {};
    spirit.lastSkillId = null;
    spirit.skillUseStreak = 0;
    if (!preserveBattleUseCounts) spirit.skillUseCounts = {};
    spirit.entrySkillAvailable = false;
    spirit.skillUseIndexAfterEntry = 0;
    spirit.damageAmpStacks = 0;
    spirit.freshDamageAmpStacks = 0;
    spirit.chargeTurns = 0;
    spirit.freshChargeTurns = 0;
    spirit.regenTurns = 0;
    spirit.freshRegenTurns = 0;
    spirit.shieldValue = 0;
    spirit.freshShieldValue = 0;
    spirit.shieldInstances = [];
  }

  private syncLegacyStatusFields(spirit: RuntimeSpirit) {
    spirit.damageAmpStacks = spirit.statuses['damage-amp']?.stacks ?? 0;
    spirit.chargeTurns = spirit.statuses.charge?.duration ?? 0;
    spirit.regenTurns = spirit.statuses.regen?.duration ?? 0;
    spirit.freshDamageAmpStacks = 0;
    spirit.freshChargeTurns = 0;
    spirit.freshRegenTurns = 0;
  }

  private clearDeadActionState(spiritId: string) {
    const spirit = this.getSpirit(spiritId);
    spirit.action = 0;
    spirit.lastSkillId = null;
    spirit.skillUseStreak = 0;
    spirit.nextSkillPowerBonus = 0;
  }

  private flashHit(spiritIds: string[]) {
    this.state.hitFeedback = {
      spiritIds,
      serial: (this.state.hitFeedback?.serial ?? 0) + 1
    };
  }

  private findSlotBySpirit(spiritId: string) {
    return this.state.slots.find((slot) => slot.spiritId === spiritId) ?? null;
  }

  private isAlive(spiritId: string | null) {
    return Boolean(spiritId && this.state.spirits[spiritId].hp > 0);
  }

  private isFront(spiritId: string) {
    return this.findSlotBySpirit(spiritId)?.row === 'front';
  }

  private log(text: string) {
    this.state.logSerial += 1;
    this.state.logs = [formatLogEntry(this.state.logSerial, text)].concat(this.state.logs).slice(0, 500);
  }

  private finishTelemetryBattle(result: 'victory' | 'defeat') {
    if (this.telemetryBattleEnded) return;
    this.telemetryBattleEnded = true;
    this.state.round.pendingReplacementSlotIndexes.forEach((slotIndex) => {
      this.notifyTelemetry('onReplacementLifecycle', {
        round: this.state.round.index,
        status: 'battle_ended',
        slotIndex,
        reserveIds: this.getBenchSpiritIds()
      });
    });
    this.notifyTelemetry('onBattleEnd', {
      round: this.state.round.index,
      result,
      mana: this.state.mana.current,
      livingSpiritIds: this.state.selectedSpiritIds.filter((id) => this.state.spirits[id]?.hp > 0),
      livingEnemyIds: Object.values(this.state.enemies).filter((enemy) => enemy.hp > 0).map((enemy) => enemy.id)
    });
  }

  private notifyTelemetry<K extends keyof BattleTelemetryCollector>(
    method: K,
    payload: Parameters<NonNullable<BattleTelemetryCollector[K]>>[0]
  ) {
    const callback = this.telemetry?.[method] as ((value: typeof payload) => void) | undefined;
    if (!callback) return;
    try {
      callback({
        battleId: String(this.battleSeed),
        seed: this.battleSeed,
        actionId: `${String(this.battleSeed)}:action:${this.state?.actionSerial ?? 0}`,
        ...payload
      } as typeof payload);
    } catch (error) {
      this.telemetryErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  private playerTelemetrySlots() {
    return this.state.slots.map((slot) => {
      const spirit = slot.spiritId ? this.state.spirits[slot.spiritId] : undefined;
      return {
        slotIndex: slot.index,
        unitId: slot.spiritId,
        row: slot.row,
        hp: spirit?.hp ?? 0,
        maxHp: slot.spiritId ? this.spiritInfo(slot.spiritId).maxHp : 0,
        shield: spirit?.shieldValue ?? 0
      };
    });
  }

  private emit() {
    this.listeners.forEach((listener) => listener(this.state));
  }
}

function rowName(row: Row) {
  return row === 'front' ? '前排' : '后排';
}

function powerText(base: number, bonus: number) {
  if (bonus <= 0) return String(base);
  return base + bonus + '（+' + bonus + '）';
}

function formatLogEntry(serial: number, text: string) {
  return '#' + String(serial).padStart(3, '0') + '｜' + text;
}

function normalizeEnemyConfig(config: StageEnemyConfig): Exclude<StageEnemyConfig, string> {
  return typeof config === 'string' ? { enemyId: config } : config;
}

function defaultEnemyPosition(row: Row, index: number): EnemyBattlePosition {
  if (row === 'front') return 'front';
  return index <= 1 ? 'back_1' : 'back_2';
}

function bossOverridesToStats(overrides?: Partial<BossData>): Partial<MonsterFinalStats> {
  if (!overrides) return {};
  const result: Partial<MonsterFinalStats> = {};
  const keys: (keyof MonsterFinalStats)[] = ['maxHp', 'physicalAttack', 'physicalDefense', 'magicAttack', 'magicDefense', 'speed'];
  keys.forEach((key) => {
    const value = overrides[key];
    if (typeof value === 'number') result[key] = value;
  });
  return result;
}

function normalizeSelectedSpiritIds(ids: string[], config: BattleSystemConfig) {
  const validIds = new Set(config.creatureConfig.map((spirit) => spirit.id));
  const unique = ids.filter((id, index) => validIds.has(id) && ids.indexOf(id) === index).slice(0, 6);
  const minimum = Math.max(1, config.requiredSelection ?? 1);
  if (unique.length >= minimum) return unique;
  return config.creatureConfig.slice(0, minimum).map((spirit) => spirit.id);
}

function monsterConfigStatOverrides(config: BattleSystemConfig, defaults: MonsterFinalStats): Partial<MonsterFinalStats> {
  const overrides: Partial<MonsterFinalStats> = {};
  const statKeys: (keyof MonsterFinalStats)[] = [
    'maxHp',
    'physicalAttack',
    'physicalDefense',
    'magicAttack',
    'magicDefense',
    'speed'
  ];
  statKeys.forEach((key) => {
    if (config.bossConfig[key] !== defaults[key]) overrides[key] = config.bossConfig[key];
  });
  return overrides;
}

function cloneSpirits(spirits: Record<string, RuntimeSpirit>) {
  return Object.fromEntries(Object.entries(spirits).map(([id, spirit]) => [id, cloneSpirit(spirit)]));
}

function cloneSpirit(spirit: RuntimeSpirit): RuntimeSpirit {
  return {
    ...spirit,
    skillCooldowns: { ...spirit.skillCooldowns },
    skillPowerGrowth: { ...spirit.skillPowerGrowth },
    skillUseCounts: { ...(spirit.skillUseCounts ?? {}) },
    entrySkillAvailable: spirit.entrySkillAvailable ?? false,
    entrySequenceId: spirit.entrySequenceId ?? 0,
    skillUseIndexAfterEntry: spirit.skillUseIndexAfterEntry ?? 0,
    shieldInstances: (spirit.shieldInstances ?? []).map((instance) => ({ ...instance })),
    statuses: Object.fromEntries(Object.entries(spirit.statuses ?? {}).map(([id, status]) => [id, { ...status }]))
  };
}

function statusName(id: string) {
  const names: Record<string, string> = {
    'damage-amp': '爆发',
    charge: '蓄势',
    regen: '回复',
    'energy-saving': '节能',
    vulnerable: '易伤'
  };
  return names[id] ?? id;
}
