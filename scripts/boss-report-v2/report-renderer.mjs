export function buildV2ReportArtifacts(result) {
  const json = compactResult(result);
  return {
    reportJson: JSON.stringify(json, null, 2),
    reportMarkdown: renderMainReport(result),
    debugMarkdown: renderDebugReport(result),
    seedsJson: JSON.stringify({
      schemaVersion: result.schemaVersion,
      bossId: result.bossId,
      experimentId: result.experiment.experimentId,
      representatives: result.representatives
    }, null, 2)
  };
}

function renderMainReport(result) {
  const { analysis, quality } = result;
  const lines = [
    `# ${result.bossMetadata?.displayName ?? result.bossId}｜通用战斗诊断与因果分析 V2`,
    '',
    `- 生成时间：${result.generatedAt}`,
    `- 样本：${analysis.samples} 场`,
    `- 实验：${result.experiment.displayName}`,
    `- 数据门禁：${quality.passed ? '通过' : '失败，禁止自动设计裁定'}`,
    '',
    '## 1. 一页裁定',
    ...result.conclusions.map((item) => `- **${item.topic}｜${item.conclusionLabel}｜${item.allowedAction}**：${item.fact}；${item.inference} 反证/边界：${item.counterEvidence}`),
    '',
    '## 2. 数据质量与元数据',
    ...quality.gates.map((gate) => `- ${gate.id}：${gate.status === 'passed' ? '通过' : `失败（${gate.issueCount}）`}`),
    `- 元数据：${result.metadata.version}（hash ${shortHash(result.metadata.hash)}）`,
    `- 指标注册：${result.metrics.version}（hash ${shortHash(result.metrics.hash)}）`,
    `- 机制 DSL：${result.mechanics.version}（hash ${shortHash(result.mechanics.hash)}）`,
    '',
    '## 3. 实验身份与可比性',
    `- 实验 ID：${result.experiment.experimentId}`,
    `- 规则集：${result.experiment.rulesetId}`,
    `- 队伍池：${result.experiment.teamPoolId}`,
    `- AI 策略：${result.experiment.aiPolicyId}`,
    `- Seed 计划：${result.experiment.seedPlanId}`,
    `- A/B 可比性：${result.experimentComparison?.comparability?.status ?? '本次无对照'}`,
    '',
    '## 4. 整体强度与节奏',
    summaryTable(analysis.groupResults),
    '',
    '## 5. 阵容异质性',
    rosterTable(analysis.rosterHeterogeneity.slice(0, 20)),
    '',
    '## 6. 机制逐项分析',
    mechanicTable(analysis.mechanics),
    '',
    responseCategoryTable(analysis.mechanics),
    '',
    mechanicOutcomeTable(analysis.mechanics, result.metricDefinitions),
    '',
    '## 7. 机制重叠归因',
    overlapTable(analysis.overlap, analysis.mechanics),
    '',
    '## 8. 真实变化点与长尾形成',
    `- 识别到复合变化点：${analysis.changePointSummary.withCompositeStart}/${analysis.samples} 场（${pct(analysis.changePointSummary.compositeStartRate)}）`,
    `- 中位真实起点：${num(analysis.changePointSummary.medianCompositeStartRound)} 回合`,
    `- 到统计长尾线的平均间隔：${num(analysis.changePointSummary.averageThresholdInterval)} 回合`,
    `- 信号分布：${pairs(analysis.changePointSummary.signals)}`,
    '',
    '## 9. 长尾主类型与附加标签',
    `- 统计长尾：${analysis.longTail.samples}/${analysis.samples}（${pct(analysis.longTail.rate)}）`,
    `- 主要类型：${pairs(analysis.longTail.primaryTypes)}`,
    `- 附加标签：${pairs(analysis.longTail.additionalTags)}`,
    `- 中位真实循环起点：${num(analysis.longTail.medianActualStartRound)} 回合`,
    '',
    '## 10. 队伍功能损失',
    `- 功能损失触发：${pairs(analysis.roleLoss.lossCounts)}`,
    `- 正式主输出死亡：${pairs(analysis.roleLoss.formalPrimaryDamageDeaths)}`,
    `- 输出损失后仍保有防护：${analysis.roleLoss.protectionAliveAfterDamageLoss} 场`,
    `- 残余维持局：${analysis.roleLoss.residualMaintenance} 场`,
    '',
    '## 11. 技能生态',
    skillTable(analysis.skillEcology),
    '',
    '## 12. AI 评分来源',
    aiTable(analysis.ai),
    '',
    '## 13. A/B 配对比较',
    experimentSection(result.experimentComparison, analysis.mechanics),
    '',
    '## 14. 问题归因矩阵',
    ...result.conclusions.map((item) => `- ${item.topic}：证据等级 ${item.evidenceLevel}（${item.evidenceLabel}），置信度${item.confidence}，允许动作 ${item.allowedAction}`),
    '',
    '## 15. 已排除原因',
    ...result.conclusions.map((item) => `- ${item.topic}：${item.counterEvidence}`),
    '',
    '## 16. 当前允许的设计动作',
    ...result.conclusions.map((item) => `- ${item.topic}：${item.allowedAction}`),
    '',
    '## 17. 代表 Seed',
    seedTable(result.representatives),
    '',
    '## 18. 仍不能确认',
    '- 自动策略结果不能替代真人体验结论。',
    '- 观察性机制响应不能单独证明因果；Formal Change 必须满足注册实验与同 Seed 对照。',
    '- 门禁失败时，报告只能用于工程排查。',
    '',
    '## 19. 技术附录',
    '- 完整配置、事件协议检查、机制组合、AI 决策样本与异常清单见 `report-debug.md`。',
    '- 机器可读结果见 `report.json`，代表局复现入口见 `representative-seeds.json`。',
    ''
  ];
  return lines.join('\n');
}

function renderDebugReport(result) {
  return [
    `# ${result.bossId}｜V2 技术调试附件`, '',
    '## 版本哈希',
    codeBlock(JSON.stringify({ metadata: result.metadata, metrics: result.metrics, mechanics: result.mechanics, experiment: { id: result.experiment.experimentId, hash: result.experiment.registryHash } }, null, 2)),
    '## 质量门禁完整问题',
    codeBlock(JSON.stringify(result.quality.gates, null, 2)),
    '## 机制完整响应组合',
    codeBlock(JSON.stringify(Object.fromEntries(result.analysis.mechanics.map((item) => [item.mechanicId, item.fullCombinationBreakdown])), null, 2)),
    '## 重叠归因',
    codeBlock(JSON.stringify(result.analysis.overlap, null, 2)),
    '## AI 评分来源样本',
    codeBlock(JSON.stringify((result.analysis.ai?.sources ?? []).flatMap((source) => source.examples.map((example) => ({ sourceId: source.sourceId, ...example }))), null, 2)),
    '## 代表 Seed',
    codeBlock(JSON.stringify(result.representatives, null, 2)),
    ''
  ].join('\n');
}

function compactResult(result) {
  return {
    schemaVersion: result.schemaVersion,
    reportVersion: result.reportVersion,
    generatedAt: result.generatedAt,
    bossId: result.bossId,
    bossMetadata: result.bossMetadata,
    metadata: result.metadata,
    metrics: result.metrics,
    metricDefinitions: result.metricDefinitions,
    mechanics: result.mechanics,
    experiment: result.experiment,
    diagnosticsVersion: result.diagnosticsVersion,
    quality: result.quality,
    analysis: result.analysis,
    experimentComparison: result.experimentComparison,
    conclusions: result.conclusions,
    representatives: result.representatives,
    groups: result.groups.map((group) => ({ id: group.id, label: group.label, policy: group.policy, playerTendency: group.playerTendency, runs: group.battles.length })),
    battles: result.battles.map((battle) => ({
      battleId: battle.battleId, seed: battle.seed, groupId: battle.groupId, team: battle.team,
      result: battle.result, victory: battle.victory, rounds: battle.rounds, finalHpRatio: battle.finalHpRatio,
      bossRemainingHpRatio: battle.bossRemainingHpRatio, metrics: battle.metrics,
      mechanicWindows: battle.mechanicWindows.map(compactWindow), roleLoss: battle.roleLoss,
      changePoints: battle.changePoints, longTail: battle.longTail, overlap: battle.overlap, errors: battle.errors
    }))
  };
}

function compactWindow(window) {
  const { config, ...value } = window;
  return value;
}

function summaryTable(rows) {
  return table(['组别', '样本', '胜率', '均回合', 'P90', '>20', '阵亡'], rows.map((row) => [row.label, row.samples, pct(row.winRate), num(row.averageRounds), num(row.p90Rounds), pct(row.over20Rate), num(row.averageDeaths)]));
}
function rosterTable(rows) { return table(['阵容', '样本', '胜率', '均回合', '>20'], rows.map((row) => [row.team, row.samples, pct(row.winRate), num(row.averageRounds), pct(row.over20Rate)])); }
function mechanicTable(rows) { return table(['机制', '窗口', '有效响应', '基线响应', '净变化', '忽略', '重叠'], rows.map((row) => [row.displayName, row.windows, pct(row.effectiveResponseRate), pct(row.baselineResponseRate), signedPct(row.netResponseRate), pct(row.ignoreRate), pct(row.overlapRate)])); }
function responseCategoryTable(rows) {
  const categories = ['仅攻击', '仅治疗', '仅防护', '治疗+防护', '换宠', '抢杀/阻止', '复合响应', '完全忽略'];
  return table(['机制', ...categories], rows.map((row) => {
    const counts = Object.fromEntries(categories.map((category) => [category, 0]));
    for (const [combination, count] of Object.entries(row.fullCombinationBreakdown ?? {})) {
      const category = responseCategory(combination);
      if (category) counts[category] += count;
    }
    return [row.displayName, ...categories.map((category) => counts[category])];
  }));
}
function responseCategory(value) {
  if (value === 'ignored') return '完全忽略';
  if (['invalid', 'incidental', 'no_opportunity'].includes(value)) return null;
  const heal = value.includes('heal');
  const shield = value.includes('shield');
  const swap = value.includes('swap');
  const attack = value.includes('attack');
  const kill = value.includes('kill') || value.includes('prevent') || value.includes('burst');
  const kinds = [heal, shield, swap, attack, kill].filter(Boolean).length;
  if (heal && shield && kinds === 2) return '治疗+防护';
  if (kinds > 1 || value.includes('+')) return '复合响应';
  if (heal) return '仅治疗';
  if (shield) return '仅防护';
  if (swap) return '换宠';
  if (kill) return '抢杀/阻止';
  if (attack) return '仅攻击';
  return null;
}
function overlapTable(rows, mechanics = []) {
  const names = new Map(mechanics.map((item) => [item.mechanicId, item.displayName]));
  return table(['组合', '事件', '场次', '占比'], rows.slice(0, 20).map((row) => [row.mechanicCombination.split('+').map((id) => names.get(id) ?? id).join('+'), row.events, row.battles, pct(row.share)]));
}
function skillTable(rows) { return table(['技能', '使用次数', '行为'], rows.map((row) => [row.displayName, row.uses, row.categories.map(behaviorLabel).join('/') || '-'])); }
function mechanicOutcomeTable(rows, definitions = []) {
  const names = new Map(definitions.map((item) => [item.metricId, item.displayName]));
  return table(['机制', '窗口结果均值', '后续影响均值'], rows.map((row) => [
    row.displayName,
    metricPairs(row.outcomes, names),
    metricPairs(row.postImpact, names)
  ]));
}
function aiTable(ai) {
  if (!ai?.decisions) return '- 无 AI 决策评分快照。';
  return table(['评分来源', '影响行动', '改变最终选择', '改变率'], (ai.sources ?? []).map((row) => [row.displayName, row.influencedActions, row.changedFinalChoice, pct(row.changeRate)]));
}
function seedTable(rows) { return table(['类型', 'Seed', '组别', '结果', '回合', '真实起点'], rows.map((row) => [row.type, row.seed, row.groupId, row.result, row.rounds, row.actualLoopStartRound ?? '-'])); }
function experimentSection(value, mechanics = []) {
  if (!value) return '- 本次为单实验诊断，没有 A/B 对照。';
  if (value.status !== 'passed') return `- 对照被阻断：${value.reason ?? value.status}`;
  const names = new Map(mechanics.map((item) => [item.mechanicId, item.displayName]));
  return [
    `- 同 Seed 对数：${value.pairs}；胜率 ${pct(value.winRate.control)} → ${pct(value.winRate.variant)}（${signedPoints(value.winRateDelta.absolute)}，相对${signedPct(value.winRateDelta.relative)}）；胜负翻转 ${pct(value.winFlipRate)}；平均回合变化 ${signed(value.roundDelta.mean)}（相对${signedPct(value.roundDelta.relative)}）。`,
    '',
    table(['可比条件', 'Control', 'Variant', '一致'], value.comparability.rows.map((row) => [comparisonField(row.field), row.control, row.variant, row.control === row.variant ? '是' : '否'])),
    '',
    `- 长尾转换：保持短局 ${value.longTailTransitions.stayedShort}；进入长尾 ${value.longTailTransitions.enteredLongTail}；退出长尾 ${value.longTailTransitions.exitedLongTail}；保持长尾 ${value.longTailTransitions.stayedLong}。`,
    '',
    table(['阵容', '样本', '胜率变化', '平均回合变化'], value.rosterHeterogeneity.map((row) => [row.team, row.samples, signedPoints(row.winRateDelta), signed(row.averageRoundDelta)])),
    '',
    table(['机制', '触发变化', '响应率变化'], value.mechanismChanges.map((row) => [names.get(row.mechanicId) ?? row.mechanicId, signed(row.triggerDelta), signedPoints(row.responseRateDelta)]))
  ].join('\n');
}
function table(headers, rows) { return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map((cell) => String(cell).replaceAll('|', '\\|')).join(' | ')} |`)].join('\n'); }
function codeBlock(value) { return `\n\`\`\`json\n${value}\n\`\`\`\n`; }
function pct(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '-'; }
function signedPct(value) { return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%` : '-'; }
function signedPoints(value) { return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}个百分点` : '-'; }
function num(value) { return Number.isFinite(value) ? Number(value).toFixed(2) : '-'; }
function signed(value) { return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${Number(value).toFixed(2)}` : '-'; }
function pairs(value) { const rows = Object.entries(value ?? {}); return rows.length ? rows.map(([key, count]) => `${key} ${count}`).join('；') : '无'; }
function metricPairs(value, names) { const rows = Object.entries(value ?? {}); return rows.length ? rows.map(([key, number]) => `${names.get(key) ?? key} ${num(number)}`).join('；') : '无'; }
function behaviorLabel(value) { return ({ attack: '攻击', protect: '防护', recover: '恢复', energy: '回能' })[value] ?? value; }
function comparisonField(value) { return ({ rulesetId: '规则版本', teamPoolId: '队伍池', aiPolicyId: 'AI策略', seedPlanId: 'Seed计划', initialStateId: '初始状态', sampleCount: '样本数' })[value] ?? value; }
function shortHash(value) { return value ? String(value).slice(0, 12) : '-'; }
