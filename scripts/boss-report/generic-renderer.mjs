import { number, percent, signedPoints } from './common.mjs';
import { roundBands } from './generic-engine.mjs';

const BEHAVIOR_LABELS = {
  attack: '攻击',
  highCostAttack: '高费攻击',
  recover: '治疗',
  protect: '防护',
  energy: '回能',
  swap: '换宠',
  position: '位置调整',
  averageResourceCost: '平均资源支付'
};

const METRIC_LABELS = {
  life_damage: '生命伤害',
  shield_absorb: '护盾吸收',
  kill: '击杀',
  replacement: '替补',
  boss_damage: 'Boss伤害',
  window_kill: '窗口击杀',
  resource_delta: '资源净变化',
  mechanic_prevented: '机制被阻止'
};

export function renderGenericBossReport(data, metadata = {}) {
  const { bossConfig, random, groups, tendencies, audit, mechanics, skillEcology, roster, longTail, aiComparison, attribution, conclusions } = data;
  const auditWarning = audit.passed ? '' : '\n> **数据审计失败：本报告仅供工程排查，不得用于平衡裁定。**\n';
  return `# ${bossConfig.bossName}｜通用单 Boss 自动测试报告

- 报告框架：generic-single-boss-v1
- 日期：${metadata.date ?? new Date().toISOString().slice(0, 10)}
- Boss ID：${bossConfig.bossId}
- 主样本：${groups.reduce((total, group) => total + group.result.samples, 0)}场
- AI对照：${data.ai.reduce((total, group) => total + group.result.samples, 0)}场
- 玩家倾向对照：${tendencies.reduce((total, group) => total + group.result.samples, 0)}场
- 总事件：${[...data.allBattles, ...data.ai.flatMap((group) => group.battles), ...tendencies.flatMap((group) => group.battles)].reduce((total, battle) => total + battle.events.length, 0)}条统一事件
- 长尾定义：第${data.defaults.longTailRound}回合及以上
${auditWarning}
## 一页结论

- 整体强度：${conclusions.strength.judgment}；${conclusions.strength.fact}。
- 整体节奏：${conclusions.pace.judgment}；${conclusions.pace.fact}。
- 机制数量：${mechanics.length}个；${mechanics.map((item) => `${item.config.displayName}：${item.conclusion.decision}`).join('；')}。
- 主样本长尾：${conclusions.longTail.exists ? '存在' : '未达到风险阈值'}，占${percent(conclusions.longTail.rate)}，主要类型为${conclusions.longTail.primaryType}。
- AI影响：${conclusions.ai.judgment}。
- 当前建议：数值${conclusions.recommendation.modifyNumbers}；机制${conclusions.recommendation.modifyMechanics}；AI${conclusions.recommendation.adjustAi}。

## 数据质量审计

| 检查项 | 结果 |
|---|---:|
| 总战斗 | ${audit.samples} |
| 统一事件字段错误 | ${audit.schemaIssues} |
| 模拟运行异常 | ${audit.runtimeErrors} |
| 缺失战斗起止事件 | ${audit.missingBattleBoundary} |
| 未闭合机制窗口 | ${audit.unclosedMechanism} |
| 组内重复Seed | ${audit.duplicateSeeds} |
| 未触发机制配置 | ${audit.unseenMechanics.join('、') || '无'} |
| 审计结论 | ${audit.passed ? '通过' : '失败'} |

## 整体强度与节奏

| 指标 | 结果 |
|---|---:|
${overallRows(random.result)}

## 回合分布

| 回合区间 | 战斗数 | 占比 | 胜率 | 剩余生命 | 减员 |
|---|---:|---:|---:|---:|---:|
${roundBands(random.battles).map((row) => `| ${row.label} | ${row.samples} | ${percent(row.share)} | ${percent(row.winRate)} | ${percent(row.finalHpRatio)} | ${number(row.casualties)} |`).join('\n')}

## 固定阵容对比

| 阵容 | 样本 | 胜率 | 平均回合 | P90 | >20回合 | 剩余生命 | 减员 | 替补 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${roster.fixedGroups.map(groupMetricRow).join('\n') || '| 未提供固定阵容 | 0 | - | - | - | - | - | - | - |'}

## 阶段与回合分段

${phaseSection(data.allBattles)}

## 机制列表

| 机制 | 类型 | 触发 | 有行动窗口 | 表面响应 | 成功兑现 | 造成伤害/击杀 | 决策判断 |
|---|---|---:|---:|---:|---:|---:|---|
${mechanics.map((item) => `| ${item.config.displayName} | ${item.config.type} | ${item.triggerCount} | ${item.legalActionCount} | ${item.surfaceResponseCount} | ${item.resolvedCount} | ${item.damageOrKillCount} | ${item.conclusion.decision} |`).join('\n')}

${mechanics.map(renderMechanic).join('\n\n')}

## 玩家技能生态

### 行为结构

| 行为类型 | 全部战斗 | 短局 | 长尾 |
|---|---:|---:|---:|
${['attack', 'recover', 'protect', 'energy'].map((key) => `| ${BEHAVIOR_LABELS[key]} | ${percent(skillEcology.behavior.all[key])} | ${percent(skillEcology.behavior.short[key])} | ${percent(skillEcology.behavior.long[key])} |`).join('\n')}

### 技能排行

| 技能 | 使用次数 | 行动占比 | Boss伤害 | 治疗 | 护盾 | 回能 | 重复率 | 最高连续 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${skillEcology.skills.slice(0, 20).map((skill) => `| ${skill.name ?? skill.skillId} | ${skill.uses} | ${percent(skill.actionShare)} | ${number(skill.damage)} | ${number(skill.healing)} | ${number(skill.shield)} | ${number(skill.resourceGain)} | ${percent(skill.repeatRate)} | ${skill.maxStreak} |`).join('\n')}

### 重复循环

| 指标 | 结果 |
|---|---:|
| 连续3次出现 | ${skillEcology.skills.reduce((total, skill) => total + skill.streak3, 0)} |
| 连续5次出现 | ${skillEcology.skills.reduce((total, skill) => total + skill.streak5, 0)} |
| 连续10次出现 | ${skillEcology.skills.reduce((total, skill) => total + skill.streak10, 0)} |
| 最高连续次数 | ${skillEcology.maxSkillStreak} |

## 长尾诊断

- 长尾样本：${longTail.samples}场，占${percent(longTail.rate)}。
- 长尾胜率：${percent(longTail.winRate)}；中位${number(longTail.medianRounds)}回合。
- 类型分布：${Object.entries(longTail.types).map(([type, count]) => `${type}${count}场`).join('、') || '无'}。

| 长尾触发事件 | 战斗数 | 中位首次回合 | 后续进入长尾比例 |
|---|---:|---:|---:|
${longTail.signals.map((item) => `| ${item.signal} | ${item.battles} | ${number(item.medianFirstRound)} | ${percent(item.subsequentLongTailRate)} |`).join('\n') || '| 未检出 | 0 | - | - |'}

## 长尾形成时点

自动统计以第${longTail.threshold}回合为统一观察点；明确可定位的死亡与重复技能使用实际首次事件回合，其余趋势信号使用观察点作为保守时点，不伪造更早的精确发生回合。

## 阵容与精灵关联

| 精灵 | 全部入选率 | 短局入选率 | 长尾入选率 | 胜率 | 平均回合 |
|---|---:|---:|---:|---:|---:|
${roster.spirits.map((spirit) => `| ${spirit.id} | ${percent(spirit.selectionRate)} | ${percent(spirit.shortSelectionRate)} | ${percent(spirit.longSelectionRate)} | ${percent(spirit.winRate)} | ${number(spirit.averageRounds)} |`).join('\n')}

| 组合 | 样本 | 胜率 | 平均回合 | >20回合 |
|---|---:|---:|---:|---:|
${roster.combinations.map((item) => `| ${item.team} | ${item.samples} | ${percent(item.winRate)} | ${number(item.averageRounds)} | ${percent(item.longTailRate)} |`).join('\n')}

## 玩家倾向对照

三组使用相同阵容生成Seed；差异仅来自合法行动评分中的均衡、进攻或防守倾向权重。

| 玩家倾向 | 样本 | 胜率 | 平均回合 | P90 | >20回合 | 攻击 | 防护 | 恢复 | 回能 | 重复率 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${tendencyRows(tendencies)}

## AI策略偏差

| 对照组 | 策略 | 胜率 | 平均回合 | >20回合 | 攻击 | 治疗+防护 | 重复率 |
|---|---|---:|---:|---:|---:|---:|---:|
${aiRows(aiComparison)}

${aiComparison.map((item) => `- ${item.pairKey}：${item.verdict}，胜率差${signedPoints(item.winDelta)}，平均回合差${number(item.roundDelta)}。`).join('\n') || '- 未提供full/neutral同Seed配对。'}

## 既有A/B结果

${bossConfig.existingAbResults?.length ? bossConfig.existingAbResults.map((item) => `- ${item}：配置中声明存在；本报告未读取外部A/B结论，避免把不同样本口径混入。`).join('\n') : '- 当前配置未附加既有A/B结果。'}

## 问题归因矩阵

| 候选原因 | 证据 | 反证 | 结论 | 置信度 |
|---|---|---|---|---|
${attribution.map((item) => `| ${item.cause} | ${item.evidence} | ${item.counterEvidence} | ${item.conclusion} | ${item.confidence} |`).join('\n')}

## 自动结论

### 整体强度
- 事实：${conclusions.strength.fact}。
- 判断：${conclusions.strength.judgment}。
- 置信度：${conclusions.strength.confidence}。

### 整体节奏
- 事实：${conclusions.pace.fact}。
- 判断：${conclusions.pace.judgment}。
- 置信度：${conclusions.pace.confidence}。

### 机制逐项结论
${conclusions.mechanics.map((item) => `#### ${item.displayName}\n- 触发次数：${item.triggerRate}。\n- 响应变化：${signedPoints(item.responseChange)}。\n- 处理效果：${item.handlingEffect}。\n- 是否形成决策：${item.decision}。\n- 是否存在问题：${item.issue}。\n- 置信度：${item.confidence}。`).join('\n\n')}

### 长尾
- 是否存在：${conclusions.longTail.exists ? '是' : '否'}。
- 形成时点：第${longTail.threshold}回合观察点。
- 主要类型：${conclusions.longTail.primaryType}。
- 主要关联：${longTail.signals.slice(0, 3).map((item) => item.signal).join('、') || '未检出'}。
- 置信度：${conclusions.longTail.confidence}。

### AI影响
- 判断：${conclusions.ai.judgment}。
- 置信度：${conclusions.ai.confidence}。

### 当前问题归因
- Boss数值：${attribution.find((item) => item.cause === 'Boss生命')?.conclusion}。
- Boss机制：${attribution.find((item) => item.cause === 'Boss机制结构')?.conclusion}。
- AI策略：${attribution.find((item) => item.cause === 'AI专属权重')?.conclusion}。
- 精灵组合：${attribution.find((item) => item.cause === '某精灵或组合')?.conclusion}。
- UI提示：无法由自动测试确认。

### 修改建议
- 是否修改数值：${conclusions.recommendation.modifyNumbers}。
- 是否修改机制：${conclusions.recommendation.modifyMechanics}。
- 是否调整AI：${conclusions.recommendation.adjustAi}。
- 是否需要额外样本：${conclusions.recommendation.extraSamples}。

## 代表Seed

| 类型 | Seed | 阵容 | 回合 | 结果 | 机制 | 选择理由 |
|---|---:|---|---:|---|---|---|
${data.representatives.map((item) => `| ${item.type} | ${item.seed} | ${item.team.join('/')} | ${item.rounds} | ${item.result === 'victory' ? '胜利' : '失败'} | ${item.mechanic} | ${item.reason} |`).join('\n')}

## 仍不能确认

- 真人玩家是否理解机制提示、目标锁定与窗口开始/结束；
- 观察性“处理/忽略”差异是否具有因果关系；
- 没有进入统一事件的数据，例如精灵正式职能标签，不能被报告反推；
- 跨战斗、跨关卡或多 Boss 共享机制仍需要扩展统一事件上下文。
`;
}

function overallRows(result) {
  return [
    ['玩家胜率', percent(result.winRate)], ['平均回合', number(result.averageRounds)], ['中位回合', number(result.medianRounds)],
    ['P75', number(result.p75Rounds)], ['P90', number(result.p90Rounds)], ['P95', number(result.p95Rounds)],
    ['>15回合', percent(result.over15Rate)], ['>20回合', percent(result.over20Rate)], ['>30回合', percent(result.over30Rate)],
    ['最长胜利', result.longestVictory], ['最长失败', result.longestDefeat]
  ].map(([label, value]) => `| ${label} | ${value} |`).join('\n');
}

function groupMetricRow(group) {
  const result = group.result;
  return `| ${group.label} | ${result.samples} | ${percent(result.winRate)} | ${number(result.averageRounds)} | ${number(result.p90Rounds)} | ${percent(result.over20Rate)} | ${percent(result.finalHpRatio)} | ${number(result.casualties)} | ${number(result.replacements)} |`;
}

function phaseSection(battles) {
  const phases = battles.flatMap((battle) => battle.events.filter((event) => event.eventType === 'phase_change'));
  if (!phases.length) return '当前样本没有 `phase_change` 事件；不臆造 Boss 阶段。回合分段以上一节统一区间为准。';
  const counts = {};
  phases.forEach((event) => { counts[event.phaseId ?? 'unknown'] = (counts[event.phaseId ?? 'unknown'] ?? 0) + 1; });
  return `| 阶段 | 进入次数 |\n|---|---:|\n${Object.entries(counts).map(([phase, count]) => `| ${phase} | ${count} |`).join('\n')}`;
}

function renderMechanic(item) {
  const metrics = item.config.outcomeMetrics;
  return `## 机制：${item.config.displayName}

- 机制ID：${item.config.mechanicId}
- 类型：${item.config.type}
- 目标范围：${item.config.targetScope}

### 事件漏斗

| 环节 | 次数 | 转化率 |
|---|---:|---:|
${funnel(item)}

### 行为变化

| 行为 | 普通阶段 | 机制窗口 | 绝对变化 | 相对变化 |
|---|---:|---:|---:|---:|
${behaviorRows(item)}

### 处理方式

| 处理方式 | 次数 | 占比 | ${metrics.map((metric) => METRIC_LABELS[metric] ?? metric).join(' | ')} |
|---|---:|---:|${metrics.map(() => '---:').join('|')}|
${Object.entries(item.responseBreakdown).map(([name, metric]) => `| ${name} | ${metric.samples} | ${percent(metric.share)} | ${metrics.map((key) => number(metric[key])).join(' | ')} |`).join('\n') || `| 无样本 | 0 | - | ${metrics.map(() => '-').join(' | ')} |`}

### 处理与忽略：窗口级

| 分组 | 样本 | ${metrics.map((metric) => METRIC_LABELS[metric] ?? metric).join(' | ')} |
|---|---:|${metrics.map(() => '---:').join('|')}|
${['handled', 'ignored'].map((key) => `| ${key === 'handled' ? '处理' : '忽略'} | ${item.handling[key].samples} | ${metrics.map((metric) => number(item.handling[key][metric])).join(' | ')} |`).join('\n')}

### 处理与忽略：战斗级

| 分组 | 战斗数 | 胜率 | 最终生命 | 回合 | 减员 | 总替补 |
|---|---:|---:|---:|---:|---:|---:|
${battleHandlingRows(item.battleHandling)}

### 机制后续影响

| 指标 | 结果 |
|---|---:|
| 玩家对Boss伤害 | ${number(item.postImpact.bossDamage)} |
| 玩家治疗 | ${number(item.postImpact.healing)} |
| 玩家护盾 | ${number(item.postImpact.shield)} |
| 玩家减员 | ${number(item.postImpact.casualties)} |
| 资源变化 | ${number(item.postImpact.resourceDelta)} |
| 进入长尾比例 | ${percent(item.postImpact.enteredLongTailRate)} |`;
}

function funnel(item) {
  const total = item.triggerCount;
  return [
    ['机制触发', total], ['玩家获得合法行动', item.legalActionCount], ['出现表面响应', item.surfaceResponseCount],
    ['估算净新增响应', Math.round(total * item.netResponseRate)], ['机制成功兑现', item.resolvedCount],
    ['造成伤害/击杀/替补', item.damageOrKillCount], ['机制后进入下一阶段/长尾', item.nextPhaseCount]
  ].map(([label, count]) => `| ${label} | ${count} | ${percent(total ? count / total : 0)} |`).join('\n');
}

function behaviorRows(item) {
  return ['attack', 'highCostAttack', 'recover', 'protect', 'energy', 'swap', 'position', 'averageResourceCost'].map((key) => {
    const baseline = item.baseline[key] ?? 0;
    const during = item.during[key] ?? 0;
    const difference = during - baseline;
    const relative = baseline ? difference / baseline : null;
    const isCost = key === 'averageResourceCost';
    return `| ${BEHAVIOR_LABELS[key]} | ${isCost ? number(baseline) : percent(baseline)} | ${isCost ? number(during) : percent(during)} | ${isCost ? number(difference) : signedPoints(difference)} | ${relative === null ? '-' : percent(relative)} |`;
  }).join('\n');
}

function battleHandlingRows(groups) {
  const labels = { 'all-handled': '全程处理', partial: '部分处理', 'all-ignored': '全程忽略', 'not-seen': '未遇到机制' };
  return Object.entries(groups).map(([key, result]) => `| ${labels[key]} | ${result.samples} | ${percent(result.winRate)} | ${percent(result.finalHpRatio)} | ${number(result.averageRounds)} | ${number(result.casualties)} | ${number(result.replacements)} |`).join('\n');
}

function aiRows(comparisons) {
  if (!comparisons.length) return '| 未提供 | - | - | - | - | - | - | - |';
  return comparisons.flatMap((item) => [item.full, item.neutral].map((group) => `| ${item.pairKey} | ${group.policyRole} | ${percent(group.result.winRate)} | ${number(group.result.averageRounds)} | ${percent(group.result.over20Rate)} | ${percent(group.behavior.attack)} | ${percent((group.behavior.recover ?? 0) + (group.behavior.protect ?? 0))} | ${percent(repeatRate(group.battles))} |`)).join('\n');
}

function tendencyRows(groups) {
  if (!groups.length) return '| 未提供 | 0 | - | - | - | - | - | - | - | - | - |';
  return groups.map((group) => `| ${group.label} | ${group.result.samples} | ${percent(group.result.winRate)} | ${number(group.result.averageRounds)} | ${number(group.result.p90Rounds)} | ${percent(group.result.over20Rate)} | ${percent(group.behavior.attack)} | ${percent(group.behavior.protect)} | ${percent(group.behavior.recover)} | ${percent(group.behavior.energy)} | ${percent(repeatRate(group.battles))} |`).join('\n');
}

function repeatRate(battles) {
  let repeated = 0;
  let total = 0;
  battles.forEach((battle) => {
    const previous = new Map();
    battle.actions.forEach((action) => {
      if (!action.skillId) return;
      total += 1;
      if (previous.get(action.actorId) === action.skillId) repeated += 1;
      previous.set(action.actorId, action.skillId);
    });
  });
  return total ? repeated / total : 0;
}
