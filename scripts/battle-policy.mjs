export const BALANCED_V3_COMPONENTS = [
  'immediateDamage',
  'effectiveHealing',
  'effectiveShield',
  'energyValue',
  'futureDamage',
  'futureMitigation',
  'bossMechanicResponse',
  'genericRule',
  'antiStall',
  'energyCostPenalty',
  'overhealPenalty',
  'overshieldPenalty',
  'delayRisk'
];

export const PLAYER_TENDENCY_IDS = ['balanced', 'offense', 'defense'];

export function usesWeightedDecisionPolicy(policy) {
  return ['balanced-v3', 'balanced-v3-neutral', 'balanced-v4-hunter-aware'].includes(policy);
}

export const PLAYER_TENDENCY_PROFILES = {
  balanced: {
    id: 'balanced',
    name: '均衡型',
    weights: {}
  },
  offense: {
    id: 'offense',
    name: '进攻型',
    weights: {
      immediateDamage: 1.3,
      futureDamage: 1.2,
      effectiveHealing: 0.75,
      effectiveShield: 0.72,
      futureMitigation: 0.78,
      energyValue: 0.95,
      bossMechanicResponse: 0.95,
      energyCostPenalty: 0.75,
      delayRisk: 0.8
    }
  },
  defense: {
    id: 'defense',
    name: '防守型',
    weights: {
      immediateDamage: 0.78,
      futureDamage: 0.82,
      effectiveHealing: 1.25,
      effectiveShield: 1.25,
      futureMitigation: 1.25,
      energyValue: 1.08,
      bossMechanicResponse: 1.15
    }
  }
};

export function createScoreBreakdown() {
  return Object.fromEntries(BALANCED_V3_COMPONENTS.map((key) => [key, 0]));
}

export function totalScore(breakdown) {
  return BALANCED_V3_COMPONENTS.reduce((sum, key) => sum + (Number(breakdown[key]) || 0), 0);
}

export function totalScoreForTendency(breakdown, tendencyId = 'balanced') {
  const profile = playerTendencyProfile(tendencyId);
  return BALANCED_V3_COMPONENTS.reduce((sum, key) => {
    const weight = profile.weights[key] ?? 1;
    return sum + (Number(breakdown[key]) || 0) * weight;
  }, 0);
}

export function weightedBreakdownForTendency(breakdown, tendencyId = 'balanced') {
  const profile = playerTendencyProfile(tendencyId);
  return Object.fromEntries(BALANCED_V3_COMPONENTS.map((key) => [key, (Number(breakdown[key]) || 0) * (profile.weights[key] ?? 1)]));
}

export function decisionScoreSources(breakdown, tendencyId = 'balanced') {
  const weighted = weightedBreakdownForTendency(breakdown, tendencyId);
  return {
    baseScore: weighted.immediateDamage + weighted.futureDamage,
    genericRule: weighted.genericRule,
    bossSpecific: weighted.bossMechanicResponse,
    resource: weighted.energyValue + weighted.energyCostPenalty,
    survival: weighted.effectiveHealing + weighted.effectiveShield + weighted.futureMitigation + weighted.overhealPenalty + weighted.overshieldPenalty,
    antiStall: weighted.antiStall,
    delayRisk: weighted.delayRisk
  };
}

export function playerTendencyProfile(tendencyId = 'balanced') {
  const profile = PLAYER_TENDENCY_PROFILES[tendencyId];
  if (!profile) throw new Error(`Unknown player tendency: ${tendencyId}`);
  return profile;
}

export function effectiveHealAmount(hp, maxHp, requested) {
  return Math.max(0, Math.min(Math.max(0, maxHp - hp), Math.max(0, requested)));
}

export function percentHealAmount(hp, maxHp, percent) {
  return effectiveHealAmount(hp, maxHp, Math.floor(maxHp * Math.max(0, percent)));
}

export function selfAndTargetEffectiveHeal({ actorHp, actorMaxHp, targetHp, targetMaxHp, percent, sameTarget }) {
  const actorHeal = percentHealAmount(actorHp, actorMaxHp, percent);
  if (sameTarget) return actorHeal;
  return actorHeal + percentHealAmount(targetHp, targetMaxHp, percent);
}

export function scoreWindCutFuture({
  nextAttackExpectedDamage,
  survivalProbability,
  canAffordPayoff,
  targetSurvivalProbability
}) {
  const payoff = Math.max(0, nextAttackExpectedDamage) * 0.25;
  const affordability = canAffordPayoff ? 1 : 0.35;
  return payoff * clamp01(survivalProbability) * clamp01(targetSurvivalProbability) * affordability;
}

export function scoreShieldFormationFuture({
  shieldedCount,
  totalShield,
  expectedIncomingDamage,
  retainedActionWindows,
  battleEndingSoon
}) {
  if (shieldedCount <= 0 || totalShield <= 0 || battleEndingSoon) return 0;
  const retainedRatio = Math.min(1, Math.max(0, retainedActionWindows) / 2);
  const absorbable = Math.min(totalShield, Math.max(0, expectedIncomingDamage));
  const multiTargetBonus = shieldedCount >= 2 ? 1.35 : 0.55;
  return absorbable * retainedRatio * multiTargetBonus;
}

export function expectedShieldValue({ currentShield, incomingDamage, survivalNeed, isFront }) {
  const useful = Math.min(Math.max(0, currentShield), Math.max(0, incomingDamage));
  return useful * (0.7 + clamp01(survivalNeed) * 0.7) * (isFront ? 1.1 : 1);
}

export function estimateRegenFuture({
  currentHp,
  maxHp,
  appliedTurns,
  existingTurns = 0,
  expectedIncomingDamage = 0,
  isFront = false,
  healPercent = 0.1
}) {
  const availableTriggers = Math.max(0, Math.floor(appliedTurns) - Math.max(0, Math.floor(existingTurns)));
  const healPerTrigger = Math.floor(Math.max(0, maxHp) * Math.max(0, healPercent));
  if (availableTriggers === 0 || healPerTrigger === 0 || currentHp <= 0) {
    return { availableTriggers, expectedTriggers: 0, expectedEffectiveHealing: 0, healPerTrigger };
  }
  const incomingPerTrigger = Math.max(0, expectedIncomingDamage) * (isFront ? 0.35 : 0.18);
  const survivalProbability = clamp01(currentHp / Math.max(1, currentHp + incomingPerTrigger * availableTriggers));
  const expectedTriggers = availableTriggers * survivalProbability;
  const currentMissingHp = Math.max(0, maxHp - currentHp);
  const expectedMissingHp = currentMissingHp + incomingPerTrigger * expectedTriggers;
  return {
    availableTriggers,
    expectedTriggers,
    expectedEffectiveHealing: Math.min(healPerTrigger * expectedTriggers, expectedMissingHp),
    healPerTrigger
  };
}

export function estimateShieldPressFixedDamage({ currentShield, conversionRatio = 0 }) {
  return Math.max(0, Math.ceil(Math.max(0, currentShield) * Math.max(0, conversionRatio)));
}

export function evaluateHunterWoundSwap({
  stacks,
  currentHp,
  currentHpDamage,
  replacementHp,
  replacementHpDamage
}) {
  const currentLethal = stacks > 0 && currentHpDamage >= currentHp;
  const replacementSurvives = replacementHpDamage < replacementHp;
  const preventedHpDamage = Math.max(0, currentHpDamage - replacementHpDamage);
  return {
    shouldSwap: currentLethal && replacementSurvives,
    currentLethal,
    replacementSurvives,
    preventedHpDamage
  };
}

export function normalizeDecisionSample(candidate) {
  return {
    action: candidate.action ?? 'skill',
    skillId: candidate.skill?.id ?? null,
    targetId: candidate.targetId ?? null,
    score: round(candidate.score),
    scoreSources: Object.fromEntries(Object.entries(candidate.scoreSources ?? {}).map(([key, value]) => [key, round(value)])),
    breakdown: Object.fromEntries(BALANCED_V3_COMPONENTS.map((key) => [key, round(candidate.breakdown?.[key] ?? 0)])),
    diagnostics: Object.fromEntries(Object.entries(candidate.diagnostics ?? {}).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value]))
  };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function round(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}
