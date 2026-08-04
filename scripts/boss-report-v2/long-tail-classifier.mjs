export const LONG_TAIL_PRIMARY_TYPES = [
  '输出崩塌型', '高回复僵持型', '高护盾僵持型', '资源枯竭型', '残阵维持型',
  'Boss减伤/回复型', '缓慢失败型', '缓慢胜利型', '未分类'
];

export function classifyLongTail({ battle, series, changePoints, roleLoss, config, bossMetadata }) {
  const statisticalLongTail = battle.rounds >= config.longTailRound;
  const signalIds = new Set(changePoints.signals.map((signal) => signal.signalId));
  const totalHeal = series.reduce((sum, row) => sum + row.values.effective_heal, 0);
  const totalShield = series.reduce((sum, row) => sum + row.values.effective_shield, 0);
  const averageResource = average(series.map((row) => row.resourceLevel).filter(Number.isFinite));
  const repeatRate = skillRepeatRate(battle.events);
  const hasOutputStall = signalIds.has('output_collapse') || signalIds.has('boss_hp_stall');
  const majorRoleLoss = roleLoss.losses.some((loss) => loss.ruleId === 'major_damage_loss');
  let primaryType = '未分类';
  if (statisticalLongTail) {
    if (hasOutputStall && totalHeal > totalShield * 1.2 && signalIds.has('defense_takeover')) primaryType = '高回复僵持型';
    else if (hasOutputStall && totalShield > totalHeal * 1.2 && signalIds.has('defense_takeover')) primaryType = '高护盾僵持型';
    else if (averageResource <= config.lowResourceThreshold && signalIds.has('resource_contraction')) primaryType = '资源枯竭型';
    else if (majorRoleLoss && roleLoss.residualMaintenance) primaryType = '残阵维持型';
    else if (hasOutputStall) primaryType = '输出崩塌型';
    else if (bossMetadata?.archetypeTags?.some((tag) => ['healing', 'damage_reduction'].includes(tag))) primaryType = 'Boss减伤/回复型';
    else primaryType = battle.victory ? '缓慢胜利型' : '缓慢失败型';
  }
  const additionalTags = [];
  if (roleLoss.formalPrimaryDamageDeaths.length) additionalTags.push('核心输出损失');
  if (repeatRate >= config.repeatThreshold) additionalTags.push('低费技能循环');
  if (totalHeal > totalShield * 1.2) additionalTags.push('治疗占主导');
  if (totalShield > totalHeal * 1.2) additionalTags.push('护盾占主导');
  if (bossMetadata?.archetypeTags?.includes('backline_pressure')) additionalTags.push('后排持续受压');
  if (signalIds.size >= 3) additionalTags.push('混合型');
  return {
    statisticalLongTail,
    primaryType,
    additionalTags,
    actualLoopStartRound: changePoints.compositeStartRound,
    statisticalThresholdRound: config.longTailRound,
    interval: changePoints.compositeStartRound ? config.longTailRound - changePoints.compositeStartRound : null,
    repeatRate,
    averageResource,
    totalHeal,
    totalShield
  };
}

function skillRepeatRate(events) {
  const previous = new Map();
  let repeated = 0;
  let total = 0;
  for (const event of events.filter((item) => item.eventType === 'skill_confirm')) {
    total += 1;
    if (previous.get(event.sourceId) === event.skillId) repeated += 1;
    previous.set(event.sourceId, event.skillId);
  }
  return total ? repeated / total : 0;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Infinity;
}
