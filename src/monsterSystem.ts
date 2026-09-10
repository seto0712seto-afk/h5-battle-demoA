import type { UnitStats } from './types';
import type {
  MonsterActionSelection,
  MonsterAiRuntime,
  MonsterDefinition,
  MonsterFinalStats,
  MonsterInstance,
  MonsterInstanceOverrides,
  MonsterRandomTrace,
  MonsterSkillDefinition
} from './monsterTypes';

export function battleLevelMultiplier(level: number) {
  if (!Number.isFinite(level) || level < 1) throw new Error('Monster level must be at least 1.');
  return 1 + (level - 1) * 0.25;
}

export const monsterLevelMultiplier = battleLevelMultiplier;

export function calculateLevelScaledUnitStats(baseStats: UnitStats, level: number): UnitStats {
  const multiplier = battleLevelMultiplier(level);
  return {
    physicalAttack: Math.round(baseStats.physicalAttack * multiplier),
    physicalDefense: Math.round(baseStats.physicalDefense * multiplier),
    magicAttack: Math.round(baseStats.magicAttack * multiplier),
    magicDefense: Math.round(baseStats.magicDefense * multiplier),
    speed: Math.round(baseStats.speed * multiplier),
    maxHp: Math.round(baseStats.maxHp * multiplier)
  };
}

export function calculateMonsterStats(definition: MonsterDefinition, level = definition.level): MonsterFinalStats {
  if (definition.growthRates) {
    return {
      maxHp: Math.round(definition.baseHp * level * definition.growthRates.hp),
      physicalAttack: Math.round(100 * definition.coefficients.physicalAttack * level * definition.growthRates.other),
      physicalDefense: Math.round(100 * definition.coefficients.physicalDefense * level * definition.growthRates.other),
      magicAttack: Math.round(100 * definition.coefficients.magicAttack * level * definition.growthRates.other),
      magicDefense: Math.round(100 * definition.coefficients.magicDefense * level * definition.growthRates.other),
      speed: Math.round(100 * definition.coefficients.speed * level * definition.growthRates.other)
    };
  }
  return calculateLevelScaledUnitStats({
    physicalAttack: 100 * definition.coefficients.physicalAttack,
    physicalDefense: 100 * definition.coefficients.physicalDefense,
    magicAttack: 100 * definition.coefficients.magicAttack,
    magicDefense: 100 * definition.coefficients.magicDefense,
    speed: 100 * definition.coefficients.speed,
    maxHp: definition.baseHp
  }, level);
}

export function createMonsterInstance(definition: MonsterDefinition, overrides: MonsterInstanceOverrides = {}): MonsterInstance {
  const level = overrides.level ?? definition.level;
  return {
    definitionId: definition.id,
    level,
    stats: {
      ...calculateMonsterStats(definition, level),
      ...overrides.stats
    }
  };
}

export function createMonsterAiRuntime(
  definition?: MonsterDefinition,
  skills: Record<string, MonsterSkillDefinition> = {},
  sequenceStartIndex = 0
): MonsterAiRuntime {
  const runtimeSkillPowers = Object.fromEntries(
    (definition?.skills ?? [])
      .map((entry) => skills[entry.skillId])
      .filter((skill): skill is MonsterSkillDefinition => Boolean(skill && typeof skill.execution.power === 'number'))
      .map((skill) => [skill.id, skill.execution.power as number])
  );
  return {
    pendingFollowup: null,
    actLastNextRound: false,
    usedForcedOpeningSkillIds: [],
    damageIncreaseStacks: 0,
    exposedActive: false,
    runtimeSkillPowers,
    temporarySkillPowerBonuses: {},
    actionCycleCount: 0,
    lastTargetIdBySkill: {},
    sequenceIndex: definition?.skillSequence?.length
      ? Math.max(0, Math.trunc(sequenceStartIndex)) % definition.skillSequence.length
      : 0
  };
}

export function runtimeMonsterSkillPower(runtime: MonsterAiRuntime, skill: MonsterSkillDefinition) {
  const permanentPower = runtime.runtimeSkillPowers[skill.id] ?? skill.execution.power ?? 0;
  return permanentPower + (runtime.temporarySkillPowerBonuses[skill.id] ?? 0);
}

export function increaseRuntimeMonsterSkillPower(runtime: MonsterAiRuntime, skillId: string, amount: number) {
  const current = runtime.runtimeSkillPowers[skillId];
  if (typeof current !== 'number') throw new Error('Runtime skill has no power: ' + skillId);
  runtime.runtimeSkillPowers[skillId] = current + amount;
  return { before: current, after: runtime.runtimeSkillPowers[skillId] };
}

export function setRuntimeMonsterSkillTemporaryPower(runtime: MonsterAiRuntime, skillId: string, amount: number) {
  const before = runtime.temporarySkillPowerBonuses[skillId] ?? 0;
  runtime.temporarySkillPowerBonuses[skillId] = Math.max(0, amount);
  return { before, after: runtime.temporarySkillPowerBonuses[skillId] };
}

export function reduceRuntimeMonsterSkillTemporaryPower(runtime: MonsterAiRuntime, skillId: string, amount: number) {
  const before = runtime.temporarySkillPowerBonuses[skillId] ?? 0;
  const after = Math.max(0, before - Math.max(0, amount));
  runtime.temporarySkillPowerBonuses[skillId] = after;
  return { before, after };
}

export function consumeRuntimeMonsterSkillTemporaryPower(runtime: MonsterAiRuntime, skillId: string) {
  const before = runtime.temporarySkillPowerBonuses[skillId] ?? 0;
  runtime.temporarySkillPowerBonuses[skillId] = 0;
  return { before, after: 0 };
}

export class SeededBattleRandom {
  private state: number;
  private callIndex = 0;
  private traces: MonsterRandomTrace[] = [];

  constructor(seed: string | number) {
    this.state = typeof seed === 'number' ? seed >>> 0 : fnv1a(seed);
    if (this.state === 0) this.state = 0x6d2b79f5;
  }

  next(label: string): MonsterRandomTrace {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    const normalized = ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    const trace = { callIndex: ++this.callIndex, label, value: normalized };
    this.traces.push(trace);
    return trace;
  }

  history() {
    return this.traces.map((trace) => ({ ...trace }));
  }
}

export function selectMonsterAction(
  definition: MonsterDefinition,
  skills: Record<string, MonsterSkillDefinition>,
  runtime: MonsterAiRuntime,
  random: SeededBattleRandom,
  isAvailable: (skillId: string) => boolean = () => true
): MonsterActionSelection {
  if (runtime.pendingFollowup) {
    const pending = runtime.pendingFollowup;
    if (!isAvailable(pending.skillId)) return { skillId: null, source: 'skip' };
    runtime.pendingFollowup = null;
    return {
      skillId: pending.skillId,
      source: 'forced_followup',
      lockedTargetId: pending.lockedTargetId,
      lockedSlotIndex: pending.lockedSlotIndex,
      lockedRow: pending.lockedRow,
      lockedOriginSlotIndex: pending.lockedOriginSlotIndex,
      lockedOriginRow: pending.lockedOriginRow
    };
  }

  const forcedOpening = definition.skills.find((entry) =>
    entry.selectionMode === 'forced_opening' &&
    !runtime.usedForcedOpeningSkillIds.includes(entry.skillId) &&
    isAvailable(entry.skillId)
  );
  if (forcedOpening) {
    runtime.usedForcedOpeningSkillIds.push(forcedOpening.skillId);
    return { skillId: forcedOpening.skillId, source: 'forced_opening' };
  }

  if (definition.skillSequence?.length) {
    for (let offset = 0; offset < definition.skillSequence.length; offset += 1) {
      const index = (runtime.sequenceIndex + offset) % definition.skillSequence.length;
      const skillId = definition.skillSequence[index];
      if (!isAvailable(skillId)) continue;
      runtime.sequenceIndex = (index + 1) % definition.skillSequence.length;
      return { skillId, source: 'sequence' };
    }
    return { skillId: null, source: 'skip' };
  }

  const candidates = definition.skills.filter((entry) =>
    entry.selectionMode !== 'forced_followup' && entry.weight > 0 && isAvailable(entry.skillId)
  );
  const totalWeight = candidates.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight > 0) {
    const randomTrace = random.next('monster_skill_weighted_selection');
    let cursor = randomTrace.value * totalWeight;
    for (const candidate of candidates) {
      cursor -= candidate.weight;
      if (cursor < 0) return { skillId: candidate.skillId, source: 'weighted', randomTrace };
    }
    return { skillId: candidates[candidates.length - 1].skillId, source: 'weighted', randomTrace };
  }

  const basic = definition.skills.find((entry) => skills[entry.skillId]?.isBasicAttack && isAvailable(entry.skillId));
  if (basic) return { skillId: basic.skillId, source: 'basic_fallback' };
  return { skillId: null, source: 'skip' };
}

export function selectSeededTarget(targetIds: string[], random: SeededBattleRandom, label: string) {
  if (targetIds.length === 0) return { targetId: null, randomTrace: undefined };
  const randomTrace = random.next(label);
  const index = Math.min(targetIds.length - 1, Math.floor(randomTrace.value * targetIds.length));
  return { targetId: targetIds[index], randomTrace };
}

export function monsterDamageMultiplier(runtime: MonsterAiRuntime) {
  return 1 + runtime.damageIncreaseStacks * 0.25;
}

function fnv1a(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
