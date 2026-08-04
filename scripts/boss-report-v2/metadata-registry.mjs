import { readFile } from 'node:fs/promises';
import { contentHash } from './utils.mjs';

export async function loadMetadataOverlay(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function createCombatMetadataRegistry({ creatureConfig, skillConfig, monsters, monsterSkills, overlay }) {
  if (!overlay?.metadataVersion) throw new Error('Combat metadata overlay requires metadataVersion.');
  const owners = new Map();
  creatureConfig.forEach((unit) => unit.skillIds.forEach((skillId) => owners.set(skillId, unit.id)));
  const units = Object.fromEntries(creatureConfig.map((unit) => {
    const manual = overlay.units?.[unit.id] ?? {};
    const roleWeights = normalizeRoleWeights(manual.roleWeights);
    return [unit.id, {
      unitId: unit.id,
      displayName: unit.name,
      side: 'player',
      defaultPosition: unit.defaultPosition,
      primaryRole: manual.primaryRole ?? null,
      secondaryRoles: manual.secondaryRoles ?? [],
      roleWeights,
      damageProfile: damageProfile(unit, unit.skillIds.map((id) => skillConfig[id]).filter(Boolean)),
      expectedOutputWeight: roleWeights.damage,
      survivalRoleWeight: Math.max(roleWeights.healing, roleWeights.protection),
      resourceRoleWeight: roleWeights.resource,
      tags: [...new Set([...(manual.tags ?? []), `${unit.defaultPosition}_default`])],
      skillIds: [...unit.skillIds],
      roleSource: manual.primaryRole ? 'registered' : 'missing'
    }];
  }));
  const skills = Object.fromEntries(Object.values(skillConfig).map((skill) => [skill.id, playerSkillMetadata(skill, owners.get(skill.id))]));
  const enemySkills = Object.fromEntries(Object.values(monsterSkills ?? {}).map((skill) => [skill.id, enemySkillMetadata(skill)]));
  const bosses = Object.fromEntries(Object.values(monsters ?? {}).filter((monster) => monster.category === 'boss').map((boss) => [boss.id, {
    bossId: boss.id,
    displayName: boss.name,
    side: 'enemy',
    defaultPosition: boss.defaultPosition,
    archetypeTags: overlay.bosses?.[boss.id]?.archetypeTags ?? [],
    skillIds: [...(boss.skillIds ?? [])]
  }]));
  const snapshot = {
    schemaVersion: overlay.schemaVersion,
    metadataVersion: overlay.metadataVersion,
    units,
    skills: { ...skills, ...enemySkills },
    bosses
  };
  const hash = contentHash(snapshot);
  const issues = auditMetadata(snapshot);
  return {
    ...snapshot,
    hash,
    issues,
    unit(id) { return units[id] ?? null; },
    skill(id) { return snapshot.skills[id] ?? null; },
    boss(id) { return bosses[id] ?? null; },
    roleWeights(ids) {
      return ids.reduce((total, id) => addWeights(total, units[id]?.roleWeights), emptyWeights());
    }
  };
}

export function auditMetadata(registry) {
  const issues = [];
  if (!registry.metadataVersion) issues.push('metadata:missing-version');
  for (const unit of Object.values(registry.units ?? {})) {
    if (!unit.primaryRole) issues.push(`unit:${unit.unitId}:missing-primary-role`);
    for (const role of ['damage', 'healing', 'protection', 'resource']) {
      if (!Number.isFinite(unit.roleWeights?.[role])) issues.push(`unit:${unit.unitId}:missing-${role}-weight`);
    }
    for (const skillId of unit.skillIds ?? []) if (!registry.skills?.[skillId]) issues.push(`unit:${unit.unitId}:missing-skill:${skillId}`);
  }
  for (const boss of Object.values(registry.bosses ?? {})) {
    if (!boss.archetypeTags?.length) issues.push(`boss:${boss.bossId}:missing-archetype-tags`);
  }
  return issues;
}

function playerSkillMetadata(skill, ownerId) {
  const categories = [skill.primaryBehavior, skill.secondaryBehavior].filter(Boolean);
  const damage = contributionLevel(skill.fixedDamage ?? skill.power ?? 0, 100, 35);
  const healingMagnitude = Math.max(skill.healPercent ?? 0, skill.teamHealPercent ?? 0, skill.frontHealPercent ?? 0, skill.healSelfAndTargetPercent ?? 0, skill.healFlatValue ?? 0);
  const shieldMagnitude = Math.max(skill.shieldValue ?? 0, skill.teamShieldValue ?? 0, skill.addShieldFormationTurns ?? 0);
  const resourceMagnitude = Math.max(skill.gain ?? 0, Math.max(0, (skill.gain ?? 0) - (skill.cost ?? 0)));
  return {
    skillId: skill.id,
    displayName: skill.name,
    ownerId: ownerId ?? null,
    primaryBehavior: skill.primaryBehavior ?? null,
    secondaryBehavior: skill.secondaryBehavior ?? null,
    actionCategories: categories,
    functionalTags: functionalTags(skill),
    targetingTags: [targetingTag(skill.target)],
    resourceCostType: 'team_mana',
    baseCost: skill.cost ?? 0,
    expectedContribution: {
      damage: skill.kind === 'attack' ? damage : 'none',
      heal: healingMagnitude ? contributionLevel(healingMagnitude, 0.35, 0.1) : 'none',
      shield: shieldMagnitude ? contributionLevel(shieldMagnitude, 180, 60) : 'none',
      resource: resourceMagnitude ? contributionLevel(resourceMagnitude, 3, 1) : 'none'
    }
  };
}

function enemySkillMetadata(skill) {
  return {
    skillId: skill.id,
    displayName: skill.name,
    ownerId: null,
    actionCategories: [skill.behaviorCategory === '攻击' || skill.behaviorCategory === '预告攻击' ? 'attack' : 'support'],
    functionalTags: [skill.behaviorCategory === '预告攻击' ? 'telegraph' : skill.behaviorCategory === '强化' ? 'growth' : 'direct_damage'],
    targetingTags: [skill.targeting?.rule ?? 'configured'],
    resourceCostType: 'none',
    baseCost: 0,
    expectedContribution: { damage: skill.execution?.power ? contributionLevel(skill.execution.power, 100, 35) : 'none', heal: 'none', shield: 'none', resource: 'none' }
  };
}

function functionalTags(skill) {
  const tags = [];
  if (skill.kind === 'attack') tags.push('direct_damage');
  if ((skill.cost ?? 0) >= 3) tags.push('high_cost');
  if ((skill.power ?? 0) >= 100 || skill.alwaysCrit || skill.fullManaCrit) tags.push('burst');
  if (skill.kind === 'heal' || skill.primaryBehavior === 'recover') tags.push('healing');
  if (skill.shieldValue || skill.teamShieldValue || skill.primaryBehavior === 'protect') tags.push('shielding');
  if ((skill.gain ?? 0) > 0 || skill.primaryBehavior === 'energy') tags.push('resource_gain');
  if (skill.addBossVulnerabilityTurns) tags.push('debuff');
  return [...new Set(tags)];
}

function targetingTag(target) {
  return ({ boss: 'enemy_single', 'ally-field': 'ally_single', 'ally-all': 'ally_all', self: 'self', 'team-mana': 'team_resource' })[target] ?? String(target ?? 'none');
}

function damageProfile(unit, skills) {
  const physical = skills.filter((skill) => skill.damageType === 'physical').length;
  const magical = skills.filter((skill) => skill.damageType === 'magic').length;
  const total = physical + magical;
  if (!total) return { physical: 0, magical: 0 };
  return { physical: physical / total, magical: magical / total };
}

function contributionLevel(value, high, low) {
  if (value >= high) return 'high';
  if (value >= low) return 'medium';
  return value > 0 ? 'low' : 'none';
}

function normalizeRoleWeights(value = {}) {
  return Object.fromEntries(['damage', 'healing', 'protection', 'resource'].map((role) => [role, Number(value[role] ?? 0)]));
}

function emptyWeights() {
  return { damage: 0, healing: 0, protection: 0, resource: 0 };
}

function addWeights(left, right = {}) {
  return Object.fromEntries(Object.keys(left).map((key) => [key, left[key] + (Number(right[key]) || 0)]));
}
