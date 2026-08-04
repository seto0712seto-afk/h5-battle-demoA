import { CORE_STATUS_RULES } from './coreBattleRules';
import type { SkillData } from './types';

type CoreStatusRule = (typeof CORE_STATUS_RULES)[keyof typeof CORE_STATUS_RULES];

const STATUS_RULES_BY_ID = Object.fromEntries(
  Object.values(CORE_STATUS_RULES).map((rule) => [rule.id, rule])
) as Record<string, CoreStatusRule>;

export function skillDescriptionWithStatusDetails(skill: SkillData) {
  const parts = [skill.description?.trim() ?? ''];
  skillReferencedStatusIds(skill).forEach((statusId) => {
    const rule = STATUS_RULES_BY_ID[statusId];
    if (rule) parts.push(`【${rule.name}】${rule.description}`);
  });
  return parts.filter(Boolean).join(' ');
}

export function statusDescription(statusId: string) {
  return STATUS_RULES_BY_ID[statusId]?.description ?? '';
}

function skillReferencedStatusIds(skill: SkillData) {
  const ids = new Set<string>();
  if (skill.addDamageAmpStacks || skill.critIfDamageAmp) ids.add(CORE_STATUS_RULES.damageAmp.id);
  if (skill.addChargeTurns) ids.add(CORE_STATUS_RULES.charge.id);
  if (skill.addRegenTurns) ids.add(CORE_STATUS_RULES.regen.id);
  if (skill.addShieldFormationTurns) ids.add(CORE_STATUS_RULES.shieldFormation.id);
  if (skill.addBossVulnerabilityTurns) ids.add(CORE_STATUS_RULES.vulnerable.id);
  skill.enhanceRules?.forEach((rule) => {
    if (rule.condition.type === 'target_has_status' || rule.condition.type === 'actor_status_stacks') {
      ids.add(rule.condition.statusId);
    }
  });
  return [...ids];
}
