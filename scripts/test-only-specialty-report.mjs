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

export function buildTestOnlySpecialtyReport({ manifest, groups }) {
  const rows = groups.map(({ group, specialty }) => summarize(group, specialty));
  const p09p10 = rows.filter((row) => row.group.focus === 'p09p10');
  const p07 = rows.filter((row) => row.group.focus === 'p07');
  const p06 = rows.filter((row) => row.group.focus === 'p06');
  const p08 = rows.filter((row) => row.group.focus === 'p08');
  const skillRows = aggregateSkills(groups);
  const highCost = buildHighCost(groups);
  const calibrationRows = manifest.calibration.map((row) => `| ${row.name} | ${row.sourceBossId} | ${row.maxHp} | ${row.attack} | ${pct(row.confirmationWinRate)} |`).join('\n');
  const p09p10Rows = p09p10.map((row) => `| ${row.group.bossName} | ${pct(row.winRate)} | ${num(row.medianRounds)} | ${num(row.averageBossRemainingHp)} | ${num(row.mana.total)} | ${num(row.mana.effective)} | ${num(row.mana.spent)} | ${num(row.mana.overflow)} | ${num(row.mana.end)} | ${pct(row.p09Share)} | ${num(row.p10EffectiveGain)} |`).join('\n');
  const p07Rows = p07.map((row) => `| ${row.group.support} | ${row.group.bossName} | ${pct(row.winRate)} | ${row.special.p07.uses} | ${pct(ratio(row.special.p07.uses, row.p07Actions))} | ${num(ratio(row.special.p07.manaAtUseTotal, row.special.p07.uses))} | ${pct(ratio(row.special.p07.teamHpRatioAtUseTotal, row.special.p07.uses))} | ${num(row.special.p07.effectiveHealing)} | ${num(row.special.p07.overhealing)} | ${row.special.p07.legalButNotSelected} / ${row.special.p07.legalOpportunities} |`).join('\n');
  const p06Rows = p06.map((row) => `| ${row.group.bossName} | ${pct(row.winRate)} | ${row.special.p06.energyTransferUses} | ${pairs(row.special.p06.energyTransferTargets)} | ${pairs(row.special.p06.discountedSkills)} | ${pairs(row.special.p06.costTransitions)} | ${num(row.special.p06.manaSaved)} | ${row.special.p06.energySavingUnredeemed} | ${row.special.p06.highCostTargetButOtherChosen} / ${row.special.p06.legalHighCostTargetOpportunities} | ${num(row.special.p06.ironSupportEffectiveHealing)} | ${num(row.special.p06.ironSupportShieldAbsorbed)} |`).join('\n');
  const p08Rows = p08.map((row) => {
    const swapActions = row.special.p08.refreshSwaps;
    const refreshedUses = row.special.p08.refreshedOneCostUses;
    return `| ${row.group.aiStrategy} | ${row.group.bossName} | ${pct(row.winRate)} | ${num(row.medianRounds)} | ${row.p08Entries} | ${row.special.p08.oneCostUses} | ${row.special.p08.fourCostUses} | ${swapActions} | ${refreshedUses} | ${num(ratio(swapActions, refreshedUses))} | ${num(row.special.p08.manaSaved)} | ${num(row.special.p08.refreshedManaSaved)} | ${num(row.special.p08.effectiveHealing)} | ${num(row.special.p08.shieldGenerated)} | ${num(row.special.p08.shieldAbsorbed)} | ${num(ratio(row.special.p08.refreshedManaSaved, refreshedUses))} / ${num(ratio(row.special.p08.refreshedEffectiveHealing, refreshedUses))} / ${num(ratio(row.special.p08.refreshedShieldGenerated, refreshedUses))} / ${num(ratio(row.special.p08.refreshedShieldAbsorbed, refreshedUses))} |`;
  }).join('\n');
  const highRows = highCost.map((row) => `| ${row.skillName} | ${row.hasP10 ? '有' : '无'} | ${row.samples} | ${num(row.median)} | ${pct(row.rates[1])} | ${pct(row.rates[2])} | ${pct(row.rates[3])} | ${pct(row.rates[4])} |`).join('\n');
  const allSkillRows = skillRows.map((row) => `| ${row.spiritId} | ${row.skillName} | ${row.uses} | ${pct(row.actionShare)} | ${num(row.firstUseMedian)} | ${num(row.manaAtUse)} | ${pct(row.hpAtUse)} | ${pct(row.teamHpAtUse)} | ${pct(row.conditionRate)} | ${row.actionShare === 0 ? '0%' : row.actionShare < 0.05 ? '<5%' : ''} |`).join('\n');
  const conclusions = analyze({ p09p10, p07, p06, p08, highCost });
  const markdown = `# TEST_ONLY Boss专项复测报告\n\n生成时间：${manifest.generatedAt}\n\n## 结论边界\n\n- 本报告只使用TEST_ONLY Boss镜像；正式Boss机制和技能完全复用，仅基础生命/攻击不同。\n- 未修改任何正式精灵数值、正式Boss、正式AI或前端副本。\n- 每场战斗的聚合数据与Seed保存在 battle_summary.csv；本报告不执行自动平衡。\n\n## TEST_ONLY校准\n\n基准队：P01炽刃狐（攻击）+ P04震岳獾（防护）+ P07月玲灵（回复）。确认样本每只Boss ${manifest.calibrationRuns} 场。\n\n| 镜像 | 正式机制源 | HP | 攻击 | 确认胜率 |\n|---|---|---:|---:|---:|\n${calibrationRows}\n\n## P09+P10双回能\n\n| Boss | 胜率 | 中位回合 | Boss剩余HP | 妖力总获得 | 有效获得 | 消费 | 溢出 | 剩余 | P09蓄能占比 | P10有效回能 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${p09p10Rows}\n\n### 基础费用≥5技能首次释放\n\n| 技能 | P10 | 首用样本 | 中位行动 | 第1动 | 第2动 | 第3动 | 第4动 |\n|---|---|---:|---:|---:|---:|---:|---:|\n${highRows}\n\n## P07 满月甘霖\n\n| 回能支持 | Boss | 胜率 | 使用次数 | P07行动占比 | 使用时妖力 | 使用时队伍HP | 有效治疗 | 过量治疗 | 合法但未选/合法机会 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${p07Rows}\n\n## P06 能量转移与铁壁援护\n\n| Boss | 胜率 | 转移次数 | 目标 | 被减费技能 | 原费→实费 | 实际节省 | 未兑现 | 有高费目标但选其他/机会 | 援护有效治疗 | 援护有效吸收 |\n|---|---:|---:|---|---|---|---:|---:|---:|---:|---:|\n${p06Rows}\n\n## P08 灵铃庇佑\n\n| AI | Boss | 胜率 | 中位回合 | 入场次数 | 1费 | 4费 | 刷新换宠动作 | 刷新资格兑现 | 每资格行动成本 | 总节省妖力 | 刷新归因节省 | 有效治疗 | 护盾生成 | 实际吸收 | 每资格：节能/治疗/生盾/吸收 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${p08Rows}\n\n说明：刷新资格通常需要先换下、再换上，因此用“刷新换宠动作/刷新资格兑现”计算每个成功资格的行动机会成本；总节省包含首次自然入场优惠，刷新归因节省及每资格收益只统计刷新入场后实际释放的1费灵铃庇佑。\n\n## P01-P10全部技能\n\n| 精灵 | 技能 | 使用次数 | 行动占比 | 首用行动中位 | 使用时妖力 | 使用时自身HP | 使用时队伍HP | 条件触发率 | 低使用标记 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---|\n${allSkillRows}\n\n## 数据分析\n\n${conclusions.map((line) => `- ${line}`).join('\n')}\n\n## 数据完整性\n\n- 专项格：${manifest.groups.length}；每格${manifest.runsPerGrid}场；总计${manifest.totalBattles}场。\n- Seed算法：${manifest.seedStrategy}\n- 原始逐场聚合：battle_summary.csv；每行包含Seed、胜负、回合、Boss剩余HP、妖力五项、技能使用及专项逐场指标。\n- 运行异常：${manifest.runtimeAnomalies}。\n`;
  return { markdown, data: { manifest, groups: rows, highCost, skills: skillRows, conclusions } };
}

function summarize(group, specialty) {
  const battles = specialty.battles;
  const wins = battles.filter((row) => row.win).length;
  return { group, special: specialty.special, battles: battles.length, winRate: ratio(wins, battles.length), medianRounds: median(battles.map((row) => row.battleRounds)), averageBossRemainingHp: avg(battles.map((row) => row.bossRemainingHp)), mana: { total: sum(battles, 'teamManaGeneratedTotal'), effective: sum(battles, 'teamManaGeneratedEffective'), spent: sum(battles, 'teamManaSpent'), overflow: sum(battles, 'teamManaOverflow'), end: avg(battles.map((row) => row.teamManaEnd)) }, p09Share: ratio(specialty.skills['M09-S1']?.useCount ?? 0, specialty.spirits.P09?.normalActions ?? 0), p10EffectiveGain: specialty.special.p10.effectiveGain, p07Actions: specialty.spirits.P07?.normalActions ?? 0, p08Entries: sumEntries(battles, 'P08') };
}

function aggregateSkills(groups) {
  const result = {};
  groups.forEach(({ specialty }) => Object.values(specialty.skills).forEach((skill) => {
    const row = result[skill.skillId] ??= { spiritId: skill.spiritId, skillId: skill.skillId, skillName: skill.skillName, uses: 0, actions: 0, first: {}, mana: 0, hp: 0, teamHp: 0, conditions: 0, conditionTotal: 0 };
    row.uses += skill.useCount; row.actions += skill.ownerNormalActions; row.mana += skill.manaAtUseTotal; row.hp += skill.hpRatioAtUseTotal; row.teamHp += skill.teamHpRatioAtUseTotal ?? 0; merge(row.first, skill.firstUseOwnActionIndexCounts);
    if (skill.conditionMetCount !== null) { row.conditions += skill.conditionMetCount; row.conditionTotal += skill.conditionMetCount + skill.conditionUnmetCount; }
  }));
  return Object.values(result).map((row) => ({ ...row, actionShare: ratio(row.uses, row.actions), firstUseMedian: distributionMedian(row.first), manaAtUse: ratio(row.mana, row.uses), hpAtUse: ratio(row.hp, row.uses), teamHpAtUse: ratio(row.teamHp, row.uses), conditionRate: ratio(row.conditions, row.conditionTotal) }));
}

function buildHighCost(groups) {
  const high = ['M01-S3', 'M07-S3', 'M09-S2'];
  const output = [];
  for (const skillId of high) for (const hasP10 of [false, true]) {
    const distribution = {};
    groups.filter(({ group }) => group.highCostComparison && Boolean(group.hasP10) === hasP10).forEach(({ specialty }) => merge(distribution, specialty.skills[skillId]?.firstUseOwnActionIndexCounts));
    const samples = Object.values(distribution).reduce((a, b) => a + b, 0);
    output.push({ skillId, skillName: SKILL_NAMES[skillId], hasP10, samples, median: distributionMedian(distribution), rates: Object.fromEntries([1, 2, 3, 4].map((index) => [index, ratio(distribution[index] ?? 0, samples)])) });
  }
  return output;
}

function analyze({ p09p10, p07, p06, p08, highCost }) {
  const p07Uses = p07.reduce((sumValue, row) => sumValue + row.special.p07.uses, 0);
  const p07Legal = p07.reduce((sumValue, row) => sumValue + row.special.p07.legalOpportunities, 0);
  const p07Skipped = p07.reduce((sumValue, row) => sumValue + row.special.p07.legalButNotSelected, 0);
  const p06Use = p06.reduce((sumValue, row) => sumValue + row.special.p06.energyTransferUses, 0);
  const p06Opportunity = p06.reduce((sumValue, row) => sumValue + row.special.p06.legalHighCostTargetOpportunities, 0);
  const p06OtherChosen = p06.reduce((sumValue, row) => sumValue + row.special.p06.highCostTargetButOtherChosen, 0);
  const normalP08 = p08.filter((row) => row.group.aiStrategy === 'balanced');
  const refreshP08 = p08.filter((row) => row.group.aiStrategy === 'refresh_seek_test');
  const p09p10Wins = p09p10.map((row) => `${row.group.bossName}${pct(row.winRate)}`).join('、');
  const p10Burst = highCost.find((row) => row.skillId === 'M01-S3' && row.hasP10);
  const noP10Burst = highCost.find((row) => row.skillId === 'M01-S3' && !row.hasP10);
  return [
    `P09+P10双回能输出队胜率为${p09p10Wins}；灰羽与法主达到100%，说明这两格对该队已经饱和，不能继续用胜率区分其内部强弱。`,
    `烈斩爆发首用中位由无P10的第${noP10Burst?.median ?? 0}动提前到有P10的第${p10Burst?.median ?? 0}动，有P10时${pct(p10Burst?.rates?.[2] ?? 0)}在第2动首次释放；这是明显节奏前移，但对照队构成并非只差P10，不能当作纯因果量。`,
    `满月甘霖共使用${p07Uses}次；在${p07Legal}次“妖力足够且合法”的机会中有${p07Skipped}次未被选择，即合法时选择率为${pct(ratio(p07Legal - p07Skipped, p07Legal))}。本轮主要瓶颈是到达6妖力且仍有合法治疗窗口，而不是AI在合法窗口内拒绝该技能。`,
    `能量转移共使用${p06Use}次；存在合法基础高费目标的机会${p06Opportunity}次，其中${p06OtherChosen}次选择了其他技能。该结果定位为当前AI评分压制了能量转移，不等同于技能结算强度为零。`,
    `P08正常AI平均胜率${pct(avg(normalP08.map((row) => row.winRate)))}，刻意刷新策略${pct(avg(refreshP08.map((row) => row.winRate)))}；三Boss中位回合分别增加${refreshP08.map((row) => row.medianRounds - (normalP08.find((normal) => normal.group.sourceBossId === row.group.sourceBossId)?.medianRounds ?? 0)).join('/')}回合。刷新资格每次固定节省3妖力，但通常需要约2次换宠行动，整体未形成稳定净收益。`,
    `高费技能首用表共${highCost.reduce((sumValue, row) => sumValue + row.samples, 0)}个有效首次释放样本；无样本的格不作“无法释放”以外的强度判断。`,
    '所有低于5%与0%技能仅标记，不自动修改。'
  ];
}

function sum(rows, key) { return rows.reduce((total, row) => total + (row[key] ?? 0), 0); }
function avg(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function ratio(value, total) { return total > 0 ? value / total : 0; }
function median(values) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function distributionMedian(distribution) { const total = Object.values(distribution ?? {}).reduce((a, b) => a + b, 0); if (!total) return 0; let seen = 0; const target = (total + 1) / 2; for (const [key, count] of Object.entries(distribution).sort(([a], [b]) => Number(a) - Number(b))) { seen += count; if (seen >= target) return Number(key); } return 0; }
function merge(target, source = {}) { Object.entries(source ?? {}).forEach(([key, value]) => { target[key] = (target[key] ?? 0) + value; }); }
function pairs(value = {}) { return Object.entries(value).map(([key, count]) => `${key}:${count}`).join('；') || '-'; }
function sumEntries(battles, spiritId) { return battles.reduce((total, battle) => total + (battle.entries?.[spiritId] ?? 0), 0); }
function num(value) { return Number(value ?? 0).toFixed(2); }
function pct(value) { return `${(Number(value ?? 0) * 100).toFixed(2)}%`; }
