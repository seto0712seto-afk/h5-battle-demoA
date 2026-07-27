import { SPIRITS } from './data';
import type { BossRuntime, RuntimeSpirit, SkillData } from './types';

export interface SkillPowerBreakdown {
  base: number;
  bonus: number;
  total: number;
  details: string[];
}

export interface SkillPowerContext {
  boss?: BossRuntime;
  manaCurrent?: number;
  fullManaThreshold?: number;
}

export function spiritData(id: string) {
  const data = SPIRITS.find((spirit) => spirit.id === id);
  if (!data) throw new Error('Unknown spirit: ' + id);
  return data;
}

export function hpPercent(current: number, max: number) {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current / max) * 100)));
}

export function formatPercent(value: number) {
  return Math.round(value * 100) + '%';
}

export function formatMultiplier(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

export function resolvedSkillPower(spirit: RuntimeSpirit, skill: SkillData, context: SkillPowerContext = {}) {
  return skillPowerBreakdown(spirit, skill, context).total;
}

export function skillPowerBreakdown(spirit: RuntimeSpirit, skill: SkillData, context: SkillPowerContext = {}): SkillPowerBreakdown {
  const base = skill.power ?? 0;
  const details: string[] = [];
  let bonus = spirit.skillPowerGrowth[skill.id] ?? 0;
  if (bonus > 0) details.push('成长 +' + bonus);

  if (base > 0 && spirit.nextSkillPowerBonus > 0) {
    bonus += spirit.nextSkillPowerBonus;
    details.push('下次威力 +' + spirit.nextSkillPowerBonus);
  }

  if (base > 0 && skill.fullManaPowerBonusRatio && (context.manaCurrent ?? 0) >= (context.fullManaThreshold ?? 5)) {
    const fullManaBonus = Math.floor(base * skill.fullManaPowerBonusRatio);
    bonus += fullManaBonus;
    details.push('妖力达到 ' + (context.fullManaThreshold ?? 5) + '，威力 +' + fullManaBonus);
  }

  return { base, bonus, total: base + bonus, details };
}

export function healAmount(target: RuntimeSpirit, percent: number) {
  return Math.floor(spiritData(target.id).maxHp * percent);
}
