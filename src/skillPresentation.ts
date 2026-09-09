import { CORE_STATUS_RULES } from './coreBattleRules';
import type { SkillData } from './types';

type CoreStatusRule = (typeof CORE_STATUS_RULES)[keyof typeof CORE_STATUS_RULES];

const STATUS_RULES_BY_ID = Object.fromEntries(
  Object.values(CORE_STATUS_RULES).map((rule) => [rule.id, rule])
) as Record<string, CoreStatusRule>;

export function skillDescriptionWithStatusDetails(skill: SkillData) {
  const presentation = skillPresentation(skill);
  return [
    presentation.description,
    ...presentation.statuses.map((status) => `*【${status.name}】：${status.description}`)
  ].filter(Boolean).join('\n');
}

export function skillPresentation(skill: SkillData) {
  return {
    description: skill.description?.trim() ?? '',
    statuses: skillReferencedStatusIds(skill)
      .map((statusId) => STATUS_RULES_BY_ID[statusId])
      .filter((rule): rule is CoreStatusRule => Boolean(rule))
  };
}

export function renderSkillDescription(skill: SkillData) {
  const presentation = skillPresentation(skill);
  const block = document.createElement('div');
  block.className = 'skill-description-block';

  if (presentation.description) {
    const description = document.createElement('p');
    description.className = 'skill-description-main';
    appendStatusHighlightedText(description, presentation.description);
    block.append(description);
  }

  presentation.statuses.forEach((status) => {
    const detail = document.createElement('p');
    detail.className = 'skill-status-description';
    detail.append('*');
    const term = document.createElement('span');
    term.className = 'skill-status-term';
    term.textContent = `【${status.name}】`;
    detail.append(term, `：${status.description}`);
    block.append(detail);
  });

  return block;
}

export function statusDescription(statusId: string) {
  return STATUS_RULES_BY_ID[statusId]?.description ?? '';
}

function skillReferencedStatusIds(skill: SkillData) {
  const ids = new Set<string>();
  if (skill.addDamageAmpStacks || skill.critIfDamageAmp) ids.add(CORE_STATUS_RULES.damageAmp.id);
  if (skill.addChargeTurns) ids.add(CORE_STATUS_RULES.charge.id);
  if (skill.addRegenTurns) ids.add(CORE_STATUS_RULES.regen.id);
  if (skill.addEnergySaving) ids.add(CORE_STATUS_RULES.energySaving.id);
  if (skill.addBossVulnerabilityTurns) ids.add(CORE_STATUS_RULES.vulnerable.id);
  skill.enhanceRules?.forEach((rule) => {
    if (rule.condition.type === 'target_has_status' || rule.condition.type === 'actor_status_stacks') {
      ids.add(rule.condition.statusId);
    }
  });
  return [...ids];
}

function appendStatusHighlightedText(target: HTMLElement, content: string) {
  const statusNames = new Set<string>(Object.values(CORE_STATUS_RULES).map((rule) => rule.name));
  content.split(/(【[^】]+】)/g).filter(Boolean).forEach((part) => {
    const name = part.startsWith('【') && part.endsWith('】') ? part.slice(1, -1) : '';
    if (!statusNames.has(name)) {
      target.append(part);
      return;
    }
    const term = document.createElement('span');
    term.className = 'skill-status-term';
    term.textContent = part;
    target.append(term);
  });
}
