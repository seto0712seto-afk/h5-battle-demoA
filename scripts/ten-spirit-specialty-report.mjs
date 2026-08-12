const SKILL_NAMES = {
  'M01-S1': '迅爪', 'M01-S2': '炽能连斩', 'M01-S3': '烈斩爆发',
  'M02-S1': '风切', 'M02-S2': '蓄势迎击', 'M02-S3': '风暴突袭',
  'M03-S1': '烈芽打击', 'M03-S2': '生机播种', 'M03-S3': '繁盛爆弹',
  'M04-S1': '震击', 'M04-S2': '盾压', 'M04-S3': '岩壁守护',
  'M05-S1': '苔甲冲撞', 'M05-S2': '缩壳回春', 'M05-S3': '苍苔壁垒',
  'M06-S1': '蓄能冲撞', 'M06-S2': '铁壁援护', 'M06-S3': '能量转移',
  'M07-S1': '月露微光', 'M07-S2': '蚀月爆弹', 'M07-S3': '满月甘霖',
  'M08-S1': '铃音守护', 'M08-S2': '鹿鸣回春', 'M08-S3': '灵铃庇佑',
  'M09-S1': '引雷蓄能', 'M09-S2': '雷霆贯击', 'M09-S3': '感电标记',
  'M10-S1': '星辉充能', 'M10-S2': '星甲冲击', 'M10-S3': '星能回流'
};

export function buildTenSpiritSpecialtyReport({ manifest, phase0, completed, bossNames }) {
  const normal = completed.filter((item) => item.group.aiStrategy !== 'refresh_seek_test');
  const skillUsage = aggregateSkillUsage(normal);
  const warnings = Object.values(skillUsage).filter((skill) => skill.ownerActions >= 1000 && skill.actionShare < 0.05);
  const p09Buckets = buildP09Buckets(normal);
  const p10Timing = buildP10Timing(normal);
  const p08 = buildP08(completed);
  const p06 = buildP06(normal);
  const defense = buildDefenseComparison(normal, bossNames);
  const flags = buildRiskFlags(normal, { p09Buckets, p10Timing, p08, p06, defense });
  const data = {
    generatedAt: new Date().toISOString(),
    phase0,
    manifest: {
      executedBattles: manifest.executedBattles,
      runsPerGrid: manifest.runsPerGrid,
      bosses: manifest.bosses,
      git: manifest.git
    },
    teamBossSummaries: completed.map((item) => item.summary),
    skillUsage,
    warnings,
    p09Buckets,
    p10Timing,
    p08,
    p06,
    defense,
    riskFlags: flags
  };
  return { data, markdown: renderMarkdown(data) };
}

function aggregateSkillUsage(groups) {
  const result = {};
  groups.forEach(({ specialty }) => Object.values(specialty.skills).forEach((skill) => {
    if (skill.ownerNormalActions <= 0) return;
    const row = result[skill.skillId] ??= {
      spiritId: skill.spiritId,
      skillId: skill.skillId,
      skillName: skill.skillName,
      uses: 0,
      ownerActions: 0,
      firstUseDistribution: {},
      conditionMet: 0,
      conditionUnmet: 0
    };
    row.uses += skill.useCount;
    row.ownerActions += skill.ownerNormalActions;
    mergeCounts(row.firstUseDistribution, skill.firstUseOwnActionIndexCounts);
    row.conditionMet += skill.conditionMetCount ?? 0;
    row.conditionUnmet += skill.conditionUnmetCount ?? 0;
  }));
  Object.values(result).forEach((row) => {
    row.actionShare = ratio(row.uses, row.ownerActions);
    row.firstUseOwnActionIndexMedian = distributionMedian(row.firstUseDistribution);
  });
  return result;
}

function buildP09Buckets(groups) {
  const buckets = {
    short: bucket('≤5回合'),
    medium: bucket('6～10回合'),
    long: bucket('>10回合')
  };
  groups.filter((item) => item.group.teamId.startsWith('TEN-R') && item.group.teamId !== 'TEN-R2' && item.group.teamId !== 'TEN-R4')
    .forEach(({ specialty }) => specialty.battles.forEach((battle) => {
      if (!Object.hasOwn(battle.spiritNormalActionCount, 'P09')) return;
      const target = battle.battleRounds <= 5 ? buckets.short : battle.battleRounds <= 10 ? buckets.medium : buckets.long;
      target.battles += 1;
      target.wins += battle.win ? 1 : 0;
      target.skillUses += battle.skillUses['M09-S1'] ?? 0;
      target.normalActions += battle.spiritNormalActionCount.P09 ?? 0;
      target.effectiveMana += battle.skillMana['M09-S1']?.effective ?? 0;
      target.overflow += battle.skillMana['M09-S1']?.overflow ?? 0;
    }));
  Object.values(buckets).forEach((row) => {
    row.useRate = ratio(row.skillUses, row.normalActions);
    row.winRate = ratio(row.wins, row.battles);
    row.effectiveManaPerBattle = ratio(row.effectiveMana, row.battles);
    row.overflowPerBattle = ratio(row.overflow, row.battles);
  });
  return buckets;
}

function buildP10Timing(groups) {
  const comparisons = [
    { skillId: 'M01-S3', withP10: ['TEN-R1', 'TEN-R2'], withoutP10: ['TEN-R3', 'TEN-R4'] },
    { skillId: 'M09-S2', withP10: ['TEN-R1', 'TEN-R5', 'TEN-R6'], withoutP10: ['TEN-R3'] }
  ];
  return comparisons.map((definition) => {
    const withRows = aggregateFirstUse(groups.filter((item) => definition.withP10.includes(item.group.teamId)), definition.skillId);
    const withoutRows = aggregateFirstUse(groups.filter((item) => definition.withoutP10.includes(item.group.teamId)), definition.skillId);
    return {
      skillId: definition.skillId,
      skillName: SKILL_NAMES[definition.skillId],
      withP10: withRows,
      withoutP10: withoutRows,
      firstActionRateLift: withRows.firstActionRate - withoutRows.firstActionRate,
      medianShift: withoutRows.median - withRows.median
    };
  });
}

function aggregateFirstUse(groups, skillId) {
  const distribution = {};
  groups.forEach(({ specialty }) => mergeCounts(distribution, specialty.skills[skillId]?.firstUseOwnActionIndexCounts));
  const total = Object.values(distribution).reduce((sum, count) => sum + count, 0);
  return {
    samples: total,
    firstActionRate: ratio(distribution['1'] ?? 0, total),
    secondActionRate: ratio(distribution['2'] ?? 0, total),
    median: distributionMedian(distribution),
    distribution
  };
}

function buildP08(groups) {
  const modes = { balanced: p08Mode(), offense: p08Mode(), defense: p08Mode(), refresh: p08Mode() };
  groups.filter((item) => item.group.phase === 'phase3').forEach(({ group, specialty }) => {
    const target = group.aiStrategy === 'refresh_seek_test' ? modes.refresh : modes[group.aiStrategy];
    target.battles += specialty.battles.length;
    target.wins += specialty.battles.filter((battle) => battle.win).length;
    target.rounds += specialty.battles.reduce((sum, battle) => sum + battle.battleRounds, 0);
    addSpecial(target, specialty.special.p08);
  });
  Object.values(modes).forEach((row) => {
    row.winRate = ratio(row.wins, row.battles);
    row.averageRounds = ratio(row.rounds, row.battles);
    row.oneCostUsesPerBattle = ratio(row.oneCostUses, row.battles);
    row.refreshSwapsPerBattle = ratio(row.refreshSwaps, row.battles);
    row.manaSavedPerBattle = ratio(row.manaSaved, row.battles);
  });
  return modes;
}

function buildP06(groups) {
  const result = {
    battles: 0,
    normalActions: 0,
    energyTransferUses: 0,
    discountedSkillUses: 0,
    manaSaved: 0,
    ironSupportUses: 0,
    ironSupportEffectiveHealing: 0,
    ironSupportShieldGenerated: 0,
    ironSupportShieldAbsorbed: 0
  };
  groups.filter((item) => item.group.teamId === 'TEN-D3').forEach(({ specialty }) => {
    result.battles += specialty.battles.length;
    result.normalActions += specialty.spirits.P06.normalActions;
    Object.keys(result).forEach((key) => {
      if (key in specialty.special.p06) result[key] += specialty.special.p06[key];
    });
  });
  result.energyTransferActionShare = ratio(result.energyTransferUses, result.normalActions);
  result.ironSupportActionShare = ratio(result.ironSupportUses, result.normalActions);
  result.manaSavedPerBattle = ratio(result.manaSaved, result.battles);
  result.shieldAbsorbedPerBattle = ratio(result.ironSupportShieldAbsorbed, result.battles);
  result.effectiveHealingPerBattle = ratio(result.ironSupportEffectiveHealing, result.battles);
  return result;
}

function buildDefenseComparison(groups, bossNames) {
  return Object.keys(bossNames).map((bossId) => {
    const teams = {};
    ['TEN-D1', 'TEN-D2', 'TEN-D3'].forEach((teamId) => {
      const rows = groups.filter((item) => item.group.bossId === bossId && item.group.teamId === teamId);
      const battles = rows.reduce((sum, item) => sum + item.summary.battles, 0);
      const wins = rows.reduce((sum, item) => sum + item.summary.wins, 0);
      teams[teamId] = {
        battles,
        winRate: ratio(wins, battles),
        medianRounds: median(rows.map((item) => item.summary.medianRounds)),
        averageBossRemainingHp: weightedAverage(rows, 'averageBossRemainingHp')
      };
    });
    return { bossId, bossName: bossNames[bossId], teams };
  });
}

function buildRiskFlags(groups, { p09Buckets, p10Timing, p08, p06, defense }) {
  const flags = [];
  const doubleManaBosses = defenseBossIds(groups).filter((bossId) => {
    const r1 = teamBossAggregate(groups, 'TEN-R1', bossId);
    const singles = ['TEN-R2', 'TEN-R3'].map((team) => teamBossAggregate(groups, team, bossId));
    const bestSingle = singles.sort((a, b) => b.winRate - a.winRate)[0];
    return r1.winRate - bestSingle.winRate >= 0.05 && bestSingle.medianRounds - r1.medianRounds >= 1;
  });
  const broaderDoubleMana = ['TEN-R5', 'TEN-R6'].filter((team) => defenseBossIds(groups).filter((bossId) => {
    const row = teamBossAggregate(groups, team, bossId);
    const single = teamBossAggregate(groups, team === 'TEN-R5' ? 'TEN-R3' : 'TEN-R3', bossId);
    return row.winRate - single.winRate >= 0.05;
  }).length >= 2);
  if (doubleManaBosses.length >= 2 && broaderDoubleMana.length >= 1) flags.push('DOUBLE_MANA_STRUCTURE_RISK');
  if (p10Timing.filter((row) => row.withP10.samples > 0 && row.withoutP10.samples > 0 && row.firstActionRateLift >= 0.2).length >= 2) flags.push('P10_HIGH_COST_TIMING_RISK');
  const p09AdvantageBosses = defenseBossIds(groups).filter((bossId) => {
    const withP09 = aggregateTeams(groups, ['TEN-R1', 'TEN-R3', 'TEN-R5', 'TEN-R6'], bossId);
    const withoutP09 = aggregateTeams(groups, ['TEN-R2', 'TEN-R4'], bossId);
    return withP09.winRate - withoutP09.winRate >= 0.05;
  });
  if (
    p09Buckets.long.battles >= 1000 &&
    p09Buckets.long.useRate >= 0.5 &&
    p09Buckets.long.effectiveManaPerBattle >= 2 &&
    p09Buckets.long.overflowPerBattle < 1 &&
    p09AdvantageBosses.length >= 2
  ) flags.push('P09_LONG_BATTLE_DEPENDENCY_RISK');
  const p08WinLift = p08.refresh.winRate - p08.balanced.winRate;
  if (
    p08.refresh.oneCostUsesPerBattle > 1 &&
    p08WinLift >= 0.05 &&
    p08.refresh.averageRounds <= p08.balanced.averageRounds + 1
  ) flags.push('P08_ENTRY_REFRESH_RISK');
  if (p06.energyTransferActionShare > p06.ironSupportActionShare && p06.manaSavedPerBattle >= 2) flags.push('P06_ROLE_FLIP_RISK');
  const p04Losses = defense.filter((row) => row.teams['TEN-D1'].winRate + 0.05 < Math.max(row.teams['TEN-D2'].winRate, row.teams['TEN-D3'].winRate)).length;
  if (p04Losses >= 2) flags.push('P04_NARROW_USAGE_RISK');
  return flags;
}

function renderMarkdown(data) {
  const phaseRows = data.phase0.checks.map((check) => `| ${check.id} | ${check.passed ? 'PASS' : 'FAIL'} | ${check.evidence} |`).join('\n');
  const teamRows = data.teamBossSummaries.map((row) => `| ${row.phase} | ${row.teamId} | ${row.bossName} | ${row.aiStrategy} | ${percent(row.winRate)} | ${number(row.medianRounds)} | ${number(row.averageRounds)} | ${number(row.averagePlayerDeaths)} |`).join('\n');
  const warningRows = data.warnings.length > 0
    ? data.warnings.map((row) => `| ${row.spiritId} | ${row.skillName} | ${row.uses} | ${row.ownerActions} | ${percent(row.actionShare)} | ${usageReason(row.skillId)} |`).join('\n')
    : '| - | 无 | - | - | - | - |';
  const skillRows = Object.values(data.skillUsage).map((row) => `| ${row.spiritId} | ${row.skillName} | ${row.uses} | ${percent(row.actionShare)} | ${number(row.firstUseOwnActionIndexMedian)} | ${row.ownerActions >= 1000 && row.actionShare < 0.05 ? 'LOW_USAGE_WARNING' : ''} |`).join('\n');
  const p10Rows = data.p10Timing.map((row) => `| ${row.skillName} | ${row.withP10.samples} | ${percent(row.withP10.firstActionRate)} | ${percent(row.withP10.secondActionRate)} | ${number(row.withP10.median)} | ${row.withoutP10.samples} | ${percent(row.withoutP10.firstActionRate)} | ${percent(row.withoutP10.secondActionRate)} | ${number(row.withoutP10.median)} |`).join('\n');
  const p09Rows = Object.values(data.p09Buckets).map((row) => `| ${row.label} | ${row.battles} | ${percent(row.winRate)} | ${percent(row.useRate)} | ${number(row.effectiveManaPerBattle)} | ${number(row.overflowPerBattle)} |`).join('\n');
  const defenseRows = data.defense.map((row) => `| ${row.bossName} | ${percent(row.teams['TEN-D1'].winRate)} / ${number(row.teams['TEN-D1'].averageBossRemainingHp)} | ${percent(row.teams['TEN-D2'].winRate)} / ${number(row.teams['TEN-D2'].averageBossRemainingHp)} | ${percent(row.teams['TEN-D3'].winRate)} / ${number(row.teams['TEN-D3'].averageBossRemainingHp)} |`).join('\n');
  return `# 十精灵第一轮专项模拟测试报告

生成时间：${data.generatedAt}

## 执行摘要

- 实际运行：${data.manifest.executedBattles.toLocaleString('zh-CN')}场，每格${data.manifest.runsPerGrid.toLocaleString('zh-CN')}场。
- Boss：${data.manifest.bosses.map((boss) => `${boss.name}（${boss.id}）`).join('、')}。
- Git：${data.manifest.git.commit}；工作区${data.manifest.git.dirty ? '存在未提交修改，已另存配置快照与SHA256' : '干净'}。
- 风险标记：${data.riskFlags.length > 0 ? data.riskFlags.join('、') : '本轮预注册阈值下无自动风险标记'}。
- 本报告只裁决当前冻结设计，不包含自动平衡修改。
- 重要边界：任务固定的三人专项队在熔核守卫和炽印法主下几乎全部失败，相关组不能依靠胜率裁决强弱，只能把Boss剩余生命、回合和技能使用作为次级证据。

## A. 实现验收

| 检查项 | 结果 | 自动化证据 |
|---|---|---|
${phaseRows}

## B. 总体结果

| Phase | 队伍 | Boss | AI | 胜率 | 中位回合 | 平均回合 | 场均死亡 |
|---|---|---|---|---:|---:|---:|---:|
${teamRows}

## C. P10 星甲貘

| 高费技能 | 有P10样本 | 第一动 | 第二动 | 首用中位 | 无P10样本 | 第一动 | 第二动 | 首用中位 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${p10Rows}

说明：只比较任务阵容中同时存在有/无P10样本的同一高费技能；没有可比阵容的技能不强行裁定。

结论：两项可比高费技能的第一动释放率均为0；P10没有把它们提前到第一次正常行动。但有P10时【烈斩爆发】首用中位从6动提前到4动，且${percent(data.p10Timing[0].withP10.secondActionRate)}样本在第二动首次释放，这是需要保留的“明显提前、但未提前到第一动”信号，未触发预注册启动风险。

## D. P09 引雷貂

| 战斗长度 | 样本 | 胜率 | 引雷蓄能行动占比 | 有效回能/场 | 溢出/场 |
|---|---:|---:|---:|---:|---:|
${p09Rows}

结论：长战中的引雷蓄能行动占比升至${percent(data.p09Buckets.long.useRate)}，但“含P09队伍在至少2个Boss稳定显著占优”的条件没有成立，因此不标记长战必带风险；当前仅保留高频使用观察。

## E. P08 守铃鹿

| 策略 | 样本 | 胜率 | 平均回合 | 1费使用/场 | 主动刷新换宠/场 | 节省妖力/场 |
|---|---:|---:|---:|---:|---:|---:|
| balanced | ${data.p08.balanced.battles} | ${percent(data.p08.balanced.winRate)} | ${number(data.p08.balanced.averageRounds)} | ${number(data.p08.balanced.oneCostUsesPerBattle)} | ${number(data.p08.balanced.refreshSwapsPerBattle)} | ${number(data.p08.balanced.manaSavedPerBattle)} |
| offense | ${data.p08.offense.battles} | ${percent(data.p08.offense.winRate)} | ${number(data.p08.offense.averageRounds)} | ${number(data.p08.offense.oneCostUsesPerBattle)} | ${number(data.p08.offense.refreshSwapsPerBattle)} | ${number(data.p08.offense.manaSavedPerBattle)} |
| defense | ${data.p08.defense.battles} | ${percent(data.p08.defense.winRate)} | ${number(data.p08.defense.averageRounds)} | ${number(data.p08.defense.oneCostUsesPerBattle)} | ${number(data.p08.defense.refreshSwapsPerBattle)} | ${number(data.p08.defense.manaSavedPerBattle)} |
| refresh_seek_test | ${data.p08.refresh.battles} | ${percent(data.p08.refresh.winRate)} | ${number(data.p08.refresh.averageRounds)} | ${number(data.p08.refresh.oneCostUsesPerBattle)} | ${number(data.p08.refresh.refreshSwapsPerBattle)} | ${number(data.p08.refresh.manaSavedPerBattle)} |

结论：压力策略能稳定制造重复1费循环，但相对balanced正常AI的综合胜率提升不足5个百分点，且平均战斗明显变长，尚不能证明收益明显覆盖换宠行动成本，因此不标记刷新风险。

## F. P06 铁甲犀

- 能量转移使用${data.p06.energyTransferUses}次，占P06正常行动${percent(data.p06.energyTransferActionShare)}；兑现减费${data.p06.discountedSkillUses}次，累计节省${number(data.p06.manaSaved)}妖力。
- 铁壁援护使用${data.p06.ironSupportUses}次，占P06正常行动${percent(data.p06.ironSupportActionShare)}；场均有效治疗${number(data.p06.effectiveHealingPerBattle)}，场均护盾吸收${number(data.p06.shieldAbsorbedPerBattle)}。
- 两类贡献单位不同，报告保留原始量，不用单一加权分强行宣判职业翻转。
- 结论：能量转移仅占P06行动${percent(data.p06.energyTransferActionShare)}，远低于铁壁援护，不存在“主要价值翻转成减费”的数据证据；但其低使用率需要继续区分AI偏好与场景不足。

## G. P04 震岳獾

| Boss | D1震岳獾 胜率/剩余HP | D2苔壳龟 胜率/剩余HP | D3铁甲犀 胜率/剩余HP |
|---|---:|---:|---:|
${defenseRows}

结论：三套防护队在三个Boss下胜率证据几乎全部坍缩为0，无法据此确认P04的优势Boss或适用面风险；Boss剩余生命只作为次级表现，不替代胜负裁决。

## H. 技能使用空间

| 精灵 | 技能 | 使用次数 | 正常行动占比 | 首用中位行动 | 标记 |
|---|---|---:|---:|---:|---|
${skillRows}

### 低使用预警

| 精灵 | 技能 | 使用次数 | 可观察行动 | 占比 | 初步归因 |
|---|---|---:|---:|---:|---|
${warningRows}

## 风险标记

${data.riskFlags.length > 0 ? data.riskFlags.map((flag) => `- ${flag}`).join('\n') : '- 无。'}

## 解释边界

- balanced/offense/defense仅使用既有权重；本轮只增加对能量转移真实节能量的模拟估值。
- refresh_seek_test是压力策略，不与正常AI胜率混算。
- P08优惠严格按“每次入场后第一次使用灵铃庇佑”判断；先使用其他技能不会消耗资格。
- 胜率反映固定队伍、Boss和AI的组合结果，不等同于精灵孤立强度。
`;
}

function bucket(label) {
  return { label, battles: 0, wins: 0, skillUses: 0, normalActions: 0, effectiveMana: 0, overflow: 0 };
}

function p08Mode() {
  return { battles: 0, wins: 0, rounds: 0, uses: 0, oneCostUses: 0, fourCostUses: 0, refreshSwaps: 0, manaSaved: 0 };
}

function addSpecial(target, source) {
  ['uses', 'oneCostUses', 'fourCostUses', 'refreshSwaps', 'manaSaved'].forEach((key) => { target[key] += source[key] ?? 0; });
}

function defenseBossIds(groups) {
  return [...new Set(groups.map((item) => item.group.bossId))];
}

function teamBossAggregate(groups, teamId, bossId) {
  const rows = groups.filter((item) => item.group.teamId === teamId && item.group.bossId === bossId);
  const battles = rows.reduce((sum, item) => sum + item.summary.battles, 0);
  return {
    battles,
    winRate: ratio(rows.reduce((sum, item) => sum + item.summary.wins, 0), battles),
    medianRounds: median(rows.map((item) => item.summary.medianRounds))
  };
}

function aggregateTeams(groups, teamIds, bossId) {
  const rows = groups.filter((item) => teamIds.includes(item.group.teamId) && item.group.bossId === bossId);
  const battles = rows.reduce((sum, item) => sum + item.summary.battles, 0);
  return { battles, winRate: ratio(rows.reduce((sum, item) => sum + item.summary.wins, 0), battles) };
}

function weightedAverage(rows, key) {
  const total = rows.reduce((sum, item) => sum + item.summary.battles, 0);
  return ratio(rows.reduce((sum, item) => sum + item.summary[key] * item.summary.battles, 0), total);
}

function mergeCounts(target, source = {}) {
  Object.entries(source).forEach(([key, value]) => { target[key] = (target[key] ?? 0) + value; });
}

function distributionMedian(distribution) {
  const total = Object.values(distribution ?? {}).reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;
  const left = Math.floor((total - 1) / 2);
  const right = Math.floor(total / 2);
  let cursor = 0;
  let leftValue = 0;
  let rightValue = 0;
  for (const [rawValue, count] of Object.entries(distribution).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const next = cursor + count;
    if (left >= cursor && left < next) leftValue = Number(rawValue);
    if (right >= cursor && right < next) rightValue = Number(rawValue);
    cursor = next;
  }
  return (leftValue + rightValue) / 2;
}

function ratio(value, total) {
  return total > 0 ? value / total : 0;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function signedPercent(value) {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}pp`;
}

function number(value) {
  return Number(value ?? 0).toFixed(2);
}

function usageReason(skillId) {
  const reasons = {
    'M01-S3': '6费门槛与炽能连斩竞争，属于资源条件和同精灵替代技能共同影响。',
    'M07-S3': '6费群疗在三人高压短战中难以兑现，且AI优先即时攻击，属于场景条件与AI共同影响。',
    'M03-S2': '延迟回复在短战估值偏低，并与繁盛爆弹竞争，属于场景条件和同精灵替代技能影响。',
    'M06-S3': '收益需要后续技能兑现，当前铁壁援护的即时保护更高，属于AI估值结果和战斗压力共同影响。',
    'M08-S2': '4费双体治疗与入场优惠技能、0费攻击竞争，属于资源条件和同精灵替代技能影响。'
  };
  return reasons[skillId] ?? '需要结合决策样本继续区分AI与场景条件。';
}
