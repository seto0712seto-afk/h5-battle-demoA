export const TEST_ONLY_BOSS_PREFIX = 'TEST_ONLY_';

export function testOnlyBossId(sourceBossId) {
  return `${TEST_ONLY_BOSS_PREFIX}${sourceBossId}`;
}

export function sourceBossId(bossId) {
  return String(bossId ?? '').startsWith(TEST_ONLY_BOSS_PREFIX)
    ? String(bossId).slice(TEST_ONLY_BOSS_PREFIX.length)
    : bossId;
}

export function installTestOnlyBossMirror({ sourceId, monsters, config, calculateMonsterStats, maxHp, attack }) {
  const source = monsters[sourceId];
  if (!source) throw new Error(`Unknown TEST_ONLY source Boss: ${sourceId}`);
  if (source.category !== 'boss') throw new Error(`TEST_ONLY source is not a Boss: ${sourceId}`);
  const id = testOnlyBossId(sourceId);
  const formalStats = calculateMonsterStats(source);
  const resolvedHp = positive(maxHp, formalStats.maxHp, 'maxHp');
  const resolvedAttack = nonNegative(attack, Math.max(formalStats.physicalAttack, formalStats.magicAttack), 'attack');
  const physicalAttack = formalStats.physicalAttack > 0 ? resolvedAttack : 0;
  const magicAttack = formalStats.magicAttack > 0 ? resolvedAttack : 0;
  monsters[id] = {
    ...source,
    id,
    name: `TEST_ONLY ${source.name}`,
    coefficients: { ...source.coefficients },
    skills: source.skills.map((entry) => ({ ...entry })),
    actionCycle: source.actionCycle ? { ...source.actionCycle, countedSkillIds: [...source.actionCycle.countedSkillIds] } : undefined,
    temporaryPowerResponse: source.temporaryPowerResponse ? { ...source.temporaryPowerResponse } : undefined
  };
  const sourceBossConfig = config.bossConfigsById?.[sourceId] ?? config.bossConfig;
  config.bossConfigsById ??= {};
  config.bossConfigsById[id] = {
    ...sourceBossConfig,
    id,
    name: monsters[id].name,
    maxHp: resolvedHp,
    physicalAttack,
    magicAttack,
    display: sourceBossConfig.display ? {
      ...sourceBossConfig.display,
      displayName: monsters[id].name,
      previewSkills: sourceBossConfig.display.previewSkills?.map((skill) => ({ ...skill }))
    } : undefined
  };
  return {
    id,
    sourceId,
    name: monsters[id].name,
    stats: { maxHp: resolvedHp, physicalAttack, magicAttack, physicalDefense: formalStats.physicalDefense, magicDefense: formalStats.magicDefense, speed: formalStats.speed },
    formalStats
  };
}

function positive(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid TEST_ONLY ${label}: ${value}`);
  return Math.round(parsed);
}

function nonNegative(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid TEST_ONLY ${label}: ${value}`);
  return Math.round(parsed);
}
