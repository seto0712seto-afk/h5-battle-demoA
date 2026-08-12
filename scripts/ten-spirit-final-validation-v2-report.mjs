const SKILL_NAMES = {
  'M01-S1': '迅爪', 'M01-S2': '炽能连斩', 'M01-S3': '烈斩爆发',
  'M06-S1': '蓄能冲撞', 'M06-S2': '铁壁援护', 'M06-S3': '能量转移',
  'M08-S3': '灵铃庇佑', 'M09-S1': '引雷蓄能', 'M10-S3': '星能回流'
};

export function buildFinalValidationV2Report({ manifest, completed }) {
  const rows = completed.map(({ group, specialty }) => summarize(group, specialty));
  const p06 = rows.filter((row) => row.group.focus === 'p06');
  const p08 = rows.filter((row) => row.group.focus === 'p08');
  const mana = rows.filter((row) => row.group.focus === 'double-mana');
  const p06Rows = p06.map((row) => {
    const special = row.special.p06;
    const positiveSavingUses = positiveTransitionCount(special.costTransitions);
    return `| ${row.group.bossName} | ${pct(row.winRate)} | ${special.legalHighCostTargetOpportunities} | ${special.energyTransferUses} | ${pct(row.skillShare('M06-S3'))} | ${pairs(special.energyTransferTargets)} | ${pairs(special.discountedSkills)} | ${pairs(special.costTransitions)} | ${special.manaSaved} | ${special.energySavingUnredeemed} | ${special.highCostTargetButOtherChosen} | ${pct(ratio(special.discountedSkillUses, special.energyTransferUses))} | ${positiveSavingUses} / ${pct(ratio(positiveSavingUses, special.energyTransferUses))} | ${row.skillUses('M06-S2')} / ${pct(row.skillShare('M06-S2'))} | ${special.ironSupportEffectiveHealing} / ${special.ironSupportShieldGenerated} / ${special.ironSupportShieldAbsorbed} | ${row.skillUses('M06-S1')} / ${pct(row.skillShare('M06-S1'))} / ${row.skillMana('M06-S1').effective} |`;
  }).join('\n');
  const p08Rows = p08.map((row) => {
    const special = row.special.p08;
    return `| ${row.group.aiStrategy} | ${row.group.bossName} | ${pct(row.winRate)} | ${num(row.medianRounds)} | ${row.entries('P08')} | ${special.oneCostUses} | ${special.fourCostUses} | ${special.oneCostAfterOtherSkillUses} | ${special.refreshSwaps} | ${special.refreshedOneCostUses} | ${num(ratio(special.refreshSwaps, special.refreshedOneCostUses))} | ${special.manaSaved} | ${special.refreshedManaSaved} | ${special.effectiveHealing} | ${special.overhealing} | ${special.shieldGenerated} | ${special.shieldAbsorbed} |`;
  }).join('\n');
  const manaRows = mana.map((row) => {
    const burstFirst = row.skill('M01-S3')?.firstUseOwnActionIndexCounts ?? {};
    const p10 = row.special.p10;
    return `| ${row.group.teamLabel} | ${row.group.bossName} | ${pct(row.winRate)} | ${num(row.medianRounds)} | ${num(row.averageRounds)} | ${num(row.averageBossRemainingHp)} | ${num(row.averagePlayerDeaths)} | ${row.mana.total} / ${row.mana.effective} / ${row.mana.spent} / ${row.mana.overflow} / ${num(row.mana.end)} | ${pct(row.skillShare('M01-S1'))} / ${pct(row.skillShare('M01-S2'))} / ${pct(row.skillShare('M01-S3'))} | ${num(distributionMedian(burstFirst))} | ${[1, 2, 3, 4, 5, 6].map((index) => pct(ratio(burstFirst[index] ?? 0, distributionTotal(burstFirst)))).join(' / ')} | ${pct(row.skillShare('M09-S1'))} / ${row.skillMana('M09-S1').effective} / ${row.skillMana('M09-S1').overflow} | ${row.skillUses('M10-S3')} / ${pct(ratio(p10.firstZeroCostUses, row.battles))} / ${p10.effectiveGain} / ${p10.overflow} |`;
  }).join('\n');
  const verdict = doubleManaVerdict(mana);
  const p06Uses = p06.reduce((sum, row) => sum + row.special.p06.energyTransferUses, 0);
  const p06Opportunities = p06.reduce((sum, row) => sum + row.special.p06.legalHighCostTargetOpportunities, 0);
  const p06Redeemed = p06.reduce((sum, row) => sum + row.special.p06.discountedSkillUses, 0);
  const normalP08 = p08.filter((row) => row.group.aiStrategy === 'balanced');
  const refreshP08 = p08.filter((row) => row.group.aiStrategy === 'refresh_seek_test');
  const normalOneCost = normalP08.reduce((sum, row) => sum + row.special.p08.oneCostUses, 0);
  const normalAfterOther = normalP08.reduce((sum, row) => sum + row.special.p08.oneCostAfterOtherSkillUses, 0);
  const normalWinRate = avg(normalP08.map((row) => row.winRate));
  const refreshWinRate = avg(refreshP08.map((row) => row.winRate));
  return `# 十精灵第二次改动与最终专项验证报告 v2

生成时间：${manifest.generatedAt}

## 边界与版本

- 修改前基线：\`${manifest.baselineCommit}\`
- 修改后代码：\`${manifest.modifiedCommit}\`，运行时 dirty=${manifest.git.dirty}
- 仅修改：P06能量转移费用2→1；P08灵铃庇佑改为每次入场后第一次使用本技能时1费。
- TEST_ONLY Boss沿用上轮参数，没有重新校准；正式Boss、P01/P02/P03/P04/P05/P07/P09/P10均未平衡调整。

## 功能验收

| 项目 | 结果 |
|---|---|
${manifest.acceptance.map((item) => `| ${item.name} | ${item.result} |`).join('\n')}

## P06 能量转移

| Boss | 胜率 | 高费合法机会 | 转移次数 | 转移行动占比 | 目标 | 被减费技能 | 原费→实费 | 节省妖力 | 未兑现 | 有目标但选其他 | 资格消费率 | 正节省次数/比例 | 铁壁援护次数/占比 | 援护治疗/生盾/吸收 | 蓄能冲撞次数/占比/有效回能 |
|---|---:|---:|---:|---:|---|---|---|---:|---:|---:|---:|---:|---|---|---|
${p06Rows}

结论：能量转移在${p06Opportunities}次高费合法机会中使用${p06Uses}次，后续兑现${p06Redeemed}次。${p06Uses > 0 ? '已从0使用恢复出明确使用窗口。' : '仍未获得实际使用空间。'}该结论只描述当前AI与测试队伍，不触发自动调数。

## P08 灵铃庇佑

| AI | Boss | 胜率 | 中位回合 | 入场 | 1费 | 4费 | 先用其他技能后1费 | 刷新动作 | 刷新兑现 | 每兑现动作成本 | 总节省 | 刷新归因节省 | 有效治疗 | 过量治疗 | 生盾 | 吸收 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${p08Rows}

结论：正常AI共触发${normalOneCost}次1费灵铃庇佑，其中${normalAfterOther}次发生在本次入场先使用其他技能之后，符合修正规则。正常AI平均胜率${pct(normalWinRate)}，刻意刷新平均胜率${pct(refreshWinRate)}；${refreshWinRate > normalWinRate ? '刻意刷新在平均胜率上取得正收益，但仍需结合逐Boss行动成本判断是否稳定。' : '刻意刷新未在行动机会成本后形成稳定平均胜率收益。'}

## P09+P10 同壳对照

| 队伍 | Boss | 胜率 | 中位回合 | 平均回合 | Boss剩余HP | 玩家死亡 | 妖力总/有效/消费/溢出/剩余 | P01迅爪/连斩/爆发占比 | 爆发首用中位 | 爆发首用第1~6动 | P09蓄能占比/有效/溢出 | P10回流次数/首次0费率/有效/溢出 |
|---|---|---:|---:|---:|---:|---:|---|---|---:|---|---|---|
${manaRows}

### 机械裁决

- 判定口径：同一Boss下，A必须同时相对B/C/D胜率领先≥5个百分点、中位至少快1回合、妖力溢出率≤5%，且烈斩爆发首用中位至少提前1动，才记为该Boss满足。
- 满足Boss：${verdict.qualifyingBosses.length ? verdict.qualifyingBosses.join('、') : '无'}（${verdict.qualifyingBosses.length}/3）。
- 裁决标记：\`${verdict.flag}\`
- 该标记仅供设计裁决，不自动削弱P09/P10。

## 数据完整性

- 实验格：${manifest.groups.length}；每格${manifest.runsPerGrid}场；总计${manifest.totalBattles}场。
- Seed：${manifest.seedStrategy}
- 双回能A/B/C/D在同一Boss使用相同groupSeed，可按battle seed配对。
- 运行异常：${manifest.runtimeAnomalies}。
`;
}

function summarize(group, specialty) {
  const battles = specialty.battles;
  const skills = specialty.skills;
  return {
    group, special: specialty.special, battles: battles.length,
    winRate: ratio(battles.filter((battle) => battle.win).length, battles.length),
    medianRounds: median(battles.map((battle) => battle.battleRounds)),
    averageRounds: avg(battles.map((battle) => battle.battleRounds)),
    averageBossRemainingHp: avg(battles.map((battle) => battle.bossRemainingHp)),
    averagePlayerDeaths: avg(battles.map((battle) => Object.values(battle.deaths ?? {}).reduce((sum, count) => sum + count, 0))),
    mana: {
      total: sum(battles, 'teamManaGeneratedTotal'), effective: sum(battles, 'teamManaGeneratedEffective'),
      spent: sum(battles, 'teamManaSpent'), overflow: sum(battles, 'teamManaOverflow'), end: avg(battles.map((battle) => battle.teamManaEnd))
    },
    skill: (id) => skills[id],
    skillUses: (id) => skills[id]?.useCount ?? 0,
    skillShare: (id) => ratio(skills[id]?.useCount ?? 0, skills[id]?.ownerNormalActions ?? 0),
    skillMana: (id) => battles.reduce((acc, battle) => {
      const value = battle.skillMana?.[id];
      acc.effective += value?.effective ?? 0; acc.overflow += value?.overflow ?? 0; return acc;
    }, { effective: 0, overflow: 0 }),
    entries: (id) => battles.reduce((total, battle) => total + (battle.entries?.[id] ?? 0), 0)
  };
}

function doubleManaVerdict(rows) {
  const qualifyingBosses = [];
  for (const sourceBossId of [...new Set(rows.map((row) => row.group.sourceBossId))]) {
    const bossRows = rows.filter((row) => row.group.sourceBossId === sourceBossId);
    const a = bossRows.find((row) => row.group.teamCode === 'A');
    const alternatives = bossRows.filter((row) => row.group.teamCode !== 'A');
    if (!a || alternatives.length !== 3) continue;
    const aBurst = distributionMedian(a.skill('M01-S3')?.firstUseOwnActionIndexCounts ?? {});
    const winLead = alternatives.every((row) => a.winRate - row.winRate >= 0.05);
    const faster = alternatives.every((row) => a.medianRounds <= row.medianRounds - 1);
    const lowOverflow = ratio(a.mana.overflow, a.mana.total) <= 0.05;
    const earlierBurst = alternatives.every((row) => {
      const alternativeBurst = distributionMedian(row.skill('M01-S3')?.firstUseOwnActionIndexCounts ?? {});
      return aBurst > 0 && (alternativeBurst === 0 || aBurst <= alternativeBurst - 1);
    });
    if (winLead && faster && lowOverflow && earlierBurst) qualifyingBosses.push(a.group.bossName);
  }
  return { qualifyingBosses, flag: qualifyingBosses.length >= 2 ? 'DOUBLE_MANA_STRUCTURE_RISK_CONFIRMED' : 'DOUBLE_MANA_STRUCTURE_RISK_NOT_CONFIRMED' };
}

function sum(rows, key) { return rows.reduce((total, row) => total + (row[key] ?? 0), 0); }
function avg(values) { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0; }
function ratio(value, total) { return total > 0 ? value / total : 0; }
function median(values) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function distributionTotal(distribution = {}) { return Object.values(distribution).reduce((sumValue, count) => sumValue + count, 0); }
function distributionMedian(distribution = {}) { const total = distributionTotal(distribution); if (!total) return 0; let seen = 0; const target = (total + 1) / 2; for (const [index, count] of Object.entries(distribution).sort(([left], [right]) => Number(left) - Number(right))) { seen += count; if (seen >= target) return Number(index); } return 0; }
function positiveTransitionCount(transitions = {}) { return Object.entries(transitions).reduce((total, [transition, count]) => { const [before, after] = transition.split('->').map(Number); return total + (before > after ? count : 0); }, 0); }
function pairs(value = {}) { return Object.entries(value).map(([key, count]) => `${key}:${count}`).join('；') || '-'; }
function num(value) { return Number(value ?? 0).toFixed(2); }
function pct(value) { return `${(Number(value ?? 0) * 100).toFixed(2)}%`; }
