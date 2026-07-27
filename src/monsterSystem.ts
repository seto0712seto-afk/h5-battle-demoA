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

export function monsterLevelMultiplier(level: number) {
  if (!Number.isFinite(level) || level < 1) throw new Error('Monster level must be at least 1.');
  return 1 + (level - 1) * 0.25;
}

export function calculateMonsterStats(definition: MonsterDefinition, level = definition.level): MonsterFinalStats {
  const multiplier = monsterLevelMultiplier(level);
  return {
    physicalAttack: Math.round(100 * definition.coefficients.physicalAttack * multiplier),
    physicalDefense: Math.round(100 * definition.coefficients.physicalDefense * multiplier),
    magicAttack: Math.round(100 * definition.coefficients.magicAttack * multiplier),
    magicDefense: Math.round(100 * definition.coefficients.magicDefense * multiplier),
    speed: Math.round(100 * definition.coefficients.speed * multiplier),
    maxHp: Math.round(definition.baseHp * multiplier)
  };
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
  skills: Record<string, MonsterSkillDefinition> = {}
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
    actionCycleCount: 0,
    lastTargetIdBySkill: {}
  };
}

export function runtimeMonsterSkillPower(runtime: MonsterAiRuntime, skill: MonsterSkillDefinition) {
  return runtime.runtimeSkillPowers[skill.id] ?? skill.execution.power ?? 0;
}

export function increaseRuntimeMonsterSkillPower(runtime: MonsterAiRuntime, skillId: string, amount: number) {
  const current = runtime.runtimeSkillPowers[skillId];
  if (typeof current !== 'number') throw new Error('Runtime skill has no power: ' + skillId);
  runtime.runtimeSkillPowers[skillId] = current + amount;
  return { before: current, after: runtime.runtimeSkillPowers[skillId] };
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
