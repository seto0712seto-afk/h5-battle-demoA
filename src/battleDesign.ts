import type { BattleBehavior, SkillData, SpiritData } from './types';

export const BATTLE_BEHAVIOR_LABELS: Record<BattleBehavior, string> = {
  attack: '攻击',
  protect: '防护',
  recover: '恢复',
  energy: '回能'
};

export interface BattleDesignIssue {
  code: 'missing-skill' | 'role-overflow' | 'behavior-mismatch';
  spiritId: string;
  spiritName: string;
  skillId: string;
  skillName: string;
  message: string;
}

export function validateBattleDesign(spirits: SpiritData[], skills: Record<string, SkillData>) {
  const issues: BattleDesignIssue[] = [];

  spirits.forEach((spirit) => {
    const allowed = new Set<BattleBehavior>([spirit.primaryRole]);
    if (spirit.secondaryRole) allowed.add(spirit.secondaryRole);

    spirit.skillIds.forEach((skillId) => {
      const skill = skills[skillId];
      if (!skill) {
        issues.push({
          code: 'missing-skill',
          spiritId: spirit.id,
          spiritName: spirit.name,
          skillId,
          skillName: skillId,
          message: `${spirit.name} 引用了不存在的技能 ${skillId}`
        });
        return;
      }

      const declared = new Set<BattleBehavior>([skill.primaryBehavior]);
      if (skill.secondaryBehavior) declared.add(skill.secondaryBehavior);
      declared.forEach((behavior) => {
        if (allowed.has(behavior)) return;
        issues.push({
          code: 'role-overflow',
          spiritId: spirit.id,
          spiritName: spirit.name,
          skillId: skill.id,
          skillName: skill.name,
          message: `${spirit.name} 的【${skill.name}】包含设定职能外的${BATTLE_BEHAVIOR_LABELS[behavior]}效果`
        });
      });

      inferSkillBehaviors(skill).forEach((behavior) => {
        if (declared.has(behavior)) return;
        issues.push({
          code: 'behavior-mismatch',
          spiritId: spirit.id,
          spiritName: spirit.name,
          skillId: skill.id,
          skillName: skill.name,
          message: `【${skill.name}】存在未登记的${BATTLE_BEHAVIOR_LABELS[behavior]}效果`
        });
      });
    });
  });

  return issues;
}

export function reportBattleDesignIssues(spirits: SpiritData[], skills: Record<string, SkillData>) {
  const issues = validateBattleDesign(spirits, skills);
  if (issues.length === 0) return issues;
  console.groupCollapsed(`[战斗设计校验] 发现 ${issues.length} 个待确认项`);
  issues.forEach((issue) => console.warn(issue.message, issue));
  console.groupEnd();
  return issues;
}

function inferSkillBehaviors(skill: SkillData) {
  const behaviors = new Set<BattleBehavior>();
  if (skill.kind === 'attack' || skill.kind === 'debuff' || skill.fixedDamage || skill.addBossVulnerabilityTurns) {
    behaviors.add('attack');
  }
  if (
    skill.shieldPercent ||
    skill.shieldValue ||
    skill.teamShieldValue ||
    skill.addChargeTurns
  ) {
    behaviors.add('protect');
  }
  if (
    skill.healPercent ||
    skill.healSelfAndTargetPercent ||
    skill.teamHealPercent ||
    skill.selfHealPercent ||
    skill.frontHealPercent ||
    skill.healFlatValue ||
    skill.addRegenTurns ||
    skill.fullManaHealBonusPercent
  ) {
    behaviors.add('recover');
  }
  if (skill.gain > 0 || skill.restoreManaTo !== undefined || skill.gainWhenManaBelow !== undefined || skill.addEnergySaving) {
    behaviors.add('energy');
  }
  return behaviors;
}
