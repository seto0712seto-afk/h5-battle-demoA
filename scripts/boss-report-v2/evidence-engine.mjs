export const EVIDENCE_LEVELS = {
  0: '描述性事实',
  1: '观察性关联',
  2: '同Seed配对对照',
  3: '强制策略或单变量实验',
  4: '真人测试'
};

export const CONCLUSION_LABELS = ['已确认', '高概率', '主要关联', '次要放大因素', '非首要', '已排除', '需要因果验证', '无法确认'];
export const DESIGN_ACTIONS = ['Observe', 'Verify', 'Candidate Change', 'Formal Change'];

export function buildEvidenceConclusions({ analysis, quality, experimentComparison = null, diagnosticsConfig, experiment = null }) {
  if (!quality.automaticConclusionsAllowed) {
    return [{
      conclusionId: 'quality_gate_block',
      topic: '数据质量',
      fact: `P0门禁失败：${quality.p0Failures.join('、')}`,
      inference: '禁止自动设计裁定，仅允许工程排查。',
      counterEvidence: '无',
      evidenceLevel: 0,
      evidenceLabel: EVIDENCE_LEVELS[0],
      conclusionLabel: '无法确认',
      confidence: '低',
      allowedAction: 'Observe'
    }];
  }
  const sampleCount = analysis.samples;
  const baselineGroup = analysis.groupResults.find((group) => group.id === analysis.baselineGroupId);
  const strengthSampleCount = analysis.overall.samples;
  const strengthSampleLabel = baselineGroup?.label ?? analysis.baselineGroupId ?? '基准组';
  const winRate = analysis.overall.winRate;
  const longTailRate = analysis.longTail.rate;
  const paired = experimentComparison?.status === 'passed';
  const singleVariable = paired && ['boss_hp', 'skill_power', 'ai_policy', 'forced_strategy'].includes(experiment?.changeType);
  const evidenceLevel = singleVariable ? 3 : paired ? 2 : 1;
  const conclusions = [
    conclusion({
      id: 'strength', topic: '整体强度',
      fact: `${strengthSampleLabel}（${strengthSampleCount}场）玩家胜率为${percent(winRate)}`,
      inference: winRate > 0.9 ? '当前自动策略样本显示Boss偏易。' : winRate < 0.7 ? '当前自动策略样本显示Boss偏难。' : '当前自动策略样本的整体强度处于观察区间。',
      counter: '自动策略不等同真人玩家，阵容分布也会影响胜率。',
      level: evidenceLevel,
      label: paired ? '高概率' : '需要因果验证',
      confidence: strengthSampleCount >= 1000 ? '中' : '低',
      action: allowedAction('strength', evidenceLevel, strengthSampleCount, diagnosticsConfig, paired, strengthSampleCount >= 1000 ? '中' : '低', false)
    }),
    conclusion({
      id: 'long_tail', topic: '长尾',
      fact: `统计长尾率为${percent(longTailRate)}，${analysis.changePointSummary.withCompositeStart}场识别到复合异常真实起点`,
      inference: longTailRate >= 0.05 ? '存在需要继续定位的节奏长尾。' : '未达到当前长尾风险观察线。',
      counter: '变化点只能定位时间关联，不能单独证明根因。',
      level: evidenceLevel,
      label: longTailRate >= 0.05 ? '主要关联' : '非首要',
      confidence: sampleCount >= 1000 ? '中' : '低',
      action: allowedAction('long_tail', evidenceLevel, sampleCount, diagnosticsConfig, paired, sampleCount >= 1000 ? '中' : '低', false)
    })
  ];
  for (const mechanic of analysis.mechanics) {
    const overlapPenalty = mechanic.overlapRate > diagnosticsConfig.overlapConfidenceThreshold;
    conclusions.push(conclusion({
      id: `mechanic:${mechanic.mechanicId}`,
      topic: `机制：${mechanic.displayName}`,
      fact: `触发${mechanic.windows}次，有效响应率${percent(mechanic.effectiveResponseRate)}，完全忽略率${percent(mechanic.ignoreRate)}，重叠率${percent(mechanic.overlapRate)}`,
      inference: mechanic.netResponseRate >= 0.1 ? '机制形成了可观察的行动变化。' : '机制对行动结构的净变化较弱。',
      counter: overlapPenalty ? '重叠率超过阈值，单机制归因置信度已降低。' : '有效响应与结果差异仍是观察性关联。',
      level: 1,
      label: mechanic.netResponseRate >= 0.1 ? '主要关联' : '需要因果验证',
      confidence: overlapPenalty ? '低' : '中',
      action: 'Verify'
    }));
  }
  const eligibleRosters = analysis.rosterHeterogeneity.filter((row) => row.samples >= 5);
  const rosterRates = eligibleRosters.map((row) => row.winRate);
  if (analysis.rosterHeterogeneity.length > 1) {
    const sufficient = eligibleRosters.length > 1;
    const spread = sufficient ? Math.max(...rosterRates) - Math.min(...rosterRates) : 0;
    conclusions.push(conclusion({
      id: 'roster_heterogeneity', topic: '阵容异质性',
      fact: sufficient ? `有${eligibleRosters.length}种阵容达到至少5场样本，最高与最低胜率相差${percent(spread)}` : `已观察到${analysis.rosterHeterogeneity.length}种阵容，但达到至少5场样本的阵容不足两种`,
      inference: !sufficient ? '当前无法稳定判断阵容异质性。' : spread >= 0.2 ? '阵容构成与战斗结果存在较明显关联。' : '当前阵容间结果差异有限。',
      counter: '部分阵容样本可能很少，入选率和胜率差不能直接证明单个精灵是根因。',
      level: sufficient ? 1 : 0, label: !sufficient ? '无法确认' : spread >= 0.2 ? '主要关联' : '非首要', confidence: '低', action: sufficient ? 'Verify' : 'Observe'
    }));
  }
  const bossSource = analysis.ai.sources.find((source) => source.sourceId === 'bossSpecific');
  conclusions.push(conclusion({
    id: 'ai_boss_specific', topic: 'Boss专属AI权重',
    fact: `Boss专属评分影响${bossSource?.influencedActions ?? 0}次行动，并在移除该来源后改变${bossSource?.changedFinalChoice ?? 0}次最终选择`,
    inference: (bossSource?.changedFinalChoice ?? 0) > 0 ? 'Boss专属权重对部分决策形成了可观察影响。' : '当前未观察到Boss专属权重改写最终选择。',
    counter: '反事实移除单一评分来源仍属于自动策略内部诊断，不等同真人行为。',
    level: 1, label: (bossSource?.changedFinalChoice ?? 0) > 0 ? '主要关联' : '非首要', confidence: '中', action: 'Verify'
  }));
  return conclusions;
}

function conclusion({ id, topic, fact, inference, counter, level, label, confidence, action }) {
  return {
    conclusionId: id,
    topic,
    fact,
    inference,
    counterEvidence: counter,
    evidenceLevel: level,
    evidenceLabel: EVIDENCE_LEVELS[level],
    conclusionLabel: label,
    confidence,
    allowedAction: action
  };
}

function allowedAction(issue, evidenceLevel, samples, config, paired, confidence, noMajorContradiction) {
  const rule = config.actionRules.find((item) => item.issue === issue)?.formalChange;
  if (evidenceLevel >= 3 && rule && samples >= rule.descriptiveSample && (!rule.sameSeedComparison || paired) && confidence === '高' && noMajorContradiction) return 'Formal Change';
  if (evidenceLevel >= 2) return 'Candidate Change';
  if (evidenceLevel >= 1) return 'Verify';
  return 'Observe';
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}
