import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SINGLE_BOSS_IDS } from './single-boss-config.mjs';
import { behaviorShares, projectRoot, readReport, runSingleBoss } from './single-boss-suite-utils.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
  return [key, value];
}));
const runs = Math.max(1, Number(args.runs ?? 10000));
const seed = Number(args.seed ?? 2026080501);
const policy = args.policy ?? 'balanced-v4-hunter-aware';
const outputRoot = args.outputDir ?? 'validation-artifacts/random-boss-10000-20260805';
const reuse = args.reuse === 'true';
const bossConfig = JSON.parse(await readFile(path.join(projectRoot, 'config/boss-mechanics.json'), 'utf8'));
const bossNames = Object.fromEntries(Object.entries(bossConfig.bosses ?? {}).map(([bossId, boss]) => [bossId, boss.bossName]));
const reports = {};

for (const boss of SINGLE_BOSS_IDS) {
  const outputDir = `${outputRoot}/${boss}`;
  if (reuse) {
    reports[boss] = await readReport(outputDir);
    process.stdout.write(`RANDOM_BOSS_REUSED=${boss} CLEAR_RATE=${reports[boss].summary.clearRate}\n`);
    continue;
  }
  process.stdout.write(`RANDOM_BOSS_START=${boss} RUNS=${runs} SEED=${seed} POLICY=${policy}\n`);
  reports[boss] = await runSingleBoss({
    boss,
    runs,
    seed,
    policy,
    roster: 'random',
    outputDir
  });
  process.stdout.write(`RANDOM_BOSS_DONE=${boss} CLEAR_RATE=${reports[boss].summary.clearRate}\n`);
}

const summary = buildSummary(reports, { runs, seed, policy, bossNames });
const destination = path.resolve(projectRoot, outputRoot);
await mkdir(destination, { recursive: true });
await Promise.all([
  writeFile(path.join(destination, '三Boss全随机阵容10000场总结.md'), renderMarkdown(summary), 'utf8'),
  writeFile(path.join(destination, '三Boss全随机阵容10000场汇总.json'), JSON.stringify(summary, null, 2), 'utf8')
]);
process.stdout.write(`RANDOM_BOSS_SUMMARY=${path.join(destination, '三Boss全随机阵容10000场总结.md')}\n`);

function buildSummary(source, context) {
  const bosses = Object.fromEntries(Object.entries(source).map(([bossId, report]) => {
    const stage = report.stages['1'];
    return [bossId, {
      bossId,
      bossName: context.bossNames[bossId] ?? bossId,
      samples: report.summary.runs,
      wins: report.summary.clears,
      clearRate: report.summary.clearRate,
      averageRounds: stage.averageRounds,
      medianRounds: stage.medianRounds,
      p90Rounds: stage.p90Rounds,
      p95Rounds: stage.p95Rounds,
      over15RoundsRate: stage.over15RoundsRate,
      over20RoundsRate: stage.over20RoundsRate,
      victoryFinalHpRatioAverage: stage.victoryFinalHpRatioAverage,
      defeatBossRemainingHpRatioAverage: stage.defeatBossRemainingHpRatioAverage,
      finalAliveCountAverage: stage.finalAliveCountAverage,
      behaviorShares: behaviorShares(report),
      warningCount: report.warnings.length,
      runtimeAnomalies: report.outliers.runtimeAnomalies.length,
      spirits: report.spirits,
      skills: report.skills,
      skillValidation: report.skillValidation,
      energy: report.energy,
      mechanics: Object.values(report.bosses)[0]?.mechanics ?? {}
    }];
  }));
  const crossBossSpiritComparison = buildSpiritComparison(bosses);
  const crossBossSkillComparison = buildSkillComparison(bosses);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    testDefinition: {
      runsPerBoss: context.runs,
      totalBattles: context.runs * Object.keys(bosses).length,
      seed: context.seed,
      seedPairing: '三只Boss使用相同Seed序列与随机阵容序列',
      roster: '从当前10只精灵中随机选择6只；首发1默认前排+2默认后排；后备至少1默认前排',
      policy: context.policy,
      playerTendency: 'balanced',
      initialMana: 0,
      manaCap: 10
    },
    bosses,
    crossBossSpiritComparison,
    crossBossSkillComparison,
    analysis: buildAnalysis(bosses, crossBossSpiritComparison, crossBossSkillComparison)
  };
}

function buildAnalysis(bosses, spiritComparison, skillComparison) {
  const bossRows = Object.values(bosses);
  const hardest = minBy(bossRows, 'clearRate');
  const easiest = maxBy(bossRows, 'clearRate');
  const longestTail = maxBy(bossRows, 'over20RoundsRate');
  const differentiatedSpirits = [...spiritComparison]
    .filter((item) => item.winRateSpread >= 0.12)
    .sort((a, b) => b.winRateSpread - a.winRateSpread);
  const matchupOutliers = spiritComparison.flatMap((spirit) => spirit.bosses
    .map((row) => ({
      spiritId: spirit.spiritId,
      spiritName: spirit.spiritName,
      bossId: row.bossId,
      bossName: row.bossName,
      winRateWhenSelected: row.winRateWhenSelected,
      deltaFromBossAverage: round(row.winRateWhenSelected - bosses[row.bossId].clearRate)
    })))
    .filter((item) => Math.abs(item.deltaFromBossAverage) >= 0.12)
    .sort((a, b) => Math.abs(b.deltaFromBossAverage) - Math.abs(a.deltaFromBossAverage));
  const zeroUseSkills = skillComparison
    .filter((skill) => skill.bosses.every((row) => row.uses === 0))
    .map((skill) => ({ skillId: skill.skillId, skillName: skill.skillName }));
  const dominantSkills = bossRows.map((boss) => ({
    bossId: boss.bossId,
    bossName: boss.bossName,
    skills: Object.values(boss.skills)
      .filter((skill) => skill.useShareOfOwnerSkillActions >= 0.65)
      .sort((a, b) => b.useShareOfOwnerSkillActions - a.useShareOfOwnerSkillActions)
      .map((skill) => ({ skillId: skill.skillId, skillName: skill.skillName, useShare: skill.useShareOfOwnerSkillActions }))
  }));
  const validationGaps = [];
  if (zeroUseSkills.length > 0) {
    validationGaps.push(`三名Boss中均未被策略选用的技能：${zeroUseSkills.map((skill) => skill.skillName).join('、')}。这些技能的实战效果尚未被本批随机样本覆盖。`);
  }
  if (bossRows.every((boss) => boss.skillValidation.starReturn.paidUses === 0)) {
    validationGaps.push('星能回流仅覆盖首次0费使用，三名Boss中付费版本均为0次，不能据此判断付费版本价值。');
  }
  if (bossRows.every((boss) => boss.skillValidation.regeneration.applications === 0)) {
    validationGaps.push('回复状态没有产生样本，相关持续、覆盖和重复持有规则仍未获得随机策略验证。');
  }
  const rockFollowups = bossRows.reduce((total, boss) => total + boss.skillValidation.shieldPress.afterRockGuardUses, 0);
  validationGaps.push(`岩卫蓄势后衔接盾压合计仅${rockFollowups}次，核心连携覆盖不足。`);
  return {
    hardestBoss: { bossId: hardest.bossId, bossName: hardest.bossName, clearRate: hardest.clearRate },
    easiestBoss: { bossId: easiest.bossId, bossName: easiest.bossName, clearRate: easiest.clearRate },
    longestTailBoss: { bossId: longestTail.bossId, bossName: longestTail.bossName, over20RoundsRate: longestTail.over20RoundsRate, p90Rounds: longestTail.p90Rounds },
    differentiatedSpirits,
    matchupOutliers,
    zeroUseSkills,
    dominantSkills,
    validationGaps,
    interpretationBoundary: '入选胜率反映随机队伍中的相关性，不等同于精灵的孤立因果强度；队伍组合、首发位置与策略选择仍会共同影响结果。'
  };
}

function buildSpiritComparison(bosses) {
  const spiritIds = Object.keys(Object.values(bosses)[0]?.spirits ?? {});
  return spiritIds.map((spiritId) => {
    const rows = Object.values(bosses).map((boss) => {
      const metric = boss.spirits[spiritId];
      return {
        bossId: boss.bossId,
        bossName: boss.bossName,
        selectedCount: metric.selectedCount,
        winRateWhenSelected: metric.winRateWhenSelected,
        damagePerSelection: ratio(metric.damageDealt, metric.selectedCount),
        healingPerSelection: ratio(metric.effectiveHealing, metric.selectedCount),
        shieldPerSelection: ratio(metric.shieldGranted, metric.selectedCount),
        energyPerSelection: ratio(metric.energyGenerated, metric.selectedCount),
        deathRateWhenSelected: ratio(metric.deaths, metric.selectedCount)
      };
    });
    return {
      spiritId,
      spiritName: Object.values(bosses)[0].spirits[spiritId].spiritName,
      bestWinRateBoss: maxBy(rows, 'winRateWhenSelected')?.bossName,
      worstWinRateBoss: minBy(rows, 'winRateWhenSelected')?.bossName,
      winRateSpread: round(Math.max(...rows.map((row) => row.winRateWhenSelected)) - Math.min(...rows.map((row) => row.winRateWhenSelected))),
      bosses: rows
    };
  });
}

function buildSkillComparison(bosses) {
  const skillIds = Object.keys(Object.values(bosses)[0]?.skills ?? {});
  return skillIds.map((skillId) => {
    const rows = Object.values(bosses).map((boss) => {
      const metric = boss.skills[skillId];
      return {
        bossId: boss.bossId,
        bossName: boss.bossName,
        uses: metric.uses,
        useShare: metric.useShareOfOwnerSkillActions,
        averageActualCost: metric.averageActualCost,
        averageDamage: metric.averageDamage,
        averageEffectiveHealing: metric.averageEffectiveHealing,
        shieldUtilizationRate: metric.shieldUtilizationRate,
        energyGenerated: metric.energyGenerated,
        energyOverflow: metric.energyOverflow
      };
    });
    return {
      skillId,
      skillName: Object.values(bosses)[0].skills[skillId].skillName,
      spiritId: Object.values(bosses)[0].skills[skillId].spiritId,
      bosses: rows
    };
  });
}

function renderMarkdown(summary) {
  const bossRows = Object.values(summary.bosses).map((boss) => `| ${boss.bossName} | ${boss.samples} | ${percent(boss.clearRate)} | ${number(boss.averageRounds)} | ${number(boss.medianRounds)} | ${number(boss.p90Rounds)} | ${percent(boss.over20RoundsRate)} | ${percent(boss.victoryFinalHpRatioAverage)} | ${number(boss.finalAliveCountAverage)} |`).join('\n');
  const behaviorRows = Object.values(summary.bosses).map((boss) => `| ${boss.bossName} | ${percent(boss.behaviorShares.attack)} | ${percent(boss.behaviorShares.protect)} | ${percent(boss.behaviorShares.recover)} | ${percent(boss.behaviorShares.energy)} |`).join('\n');
  const spiritSections = Object.values(summary.bosses).map((boss) => {
    const rows = Object.values(boss.spirits)
      .sort((a, b) => b.winRateWhenSelected - a.winRateWhenSelected)
      .map((metric) => `| ${metric.spiritName} | ${metric.selectedCount} | ${percent(metric.winRateWhenSelected)} | ${number(ratio(metric.damageDealt, metric.selectedCount))} | ${number(ratio(metric.effectiveHealing, metric.selectedCount))} | ${number(ratio(metric.shieldGranted, metric.selectedCount))} | ${number(ratio(metric.energyGenerated, metric.selectedCount))} | ${percent(ratio(metric.deaths, metric.selectedCount))} |`)
      .join('\n');
    return `### ${boss.bossName}\n\n| 精灵 | 入选 | 入选胜率 | 场均伤害 | 场均有效治疗 | 场均护盾生成 | 场均技能回能 | 入选死亡率 |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${rows}`;
  }).join('\n\n');
  const crossRows = [...summary.crossBossSpiritComparison]
    .sort((a, b) => b.winRateSpread - a.winRateSpread)
    .map((item) => `| ${item.spiritName} | ${item.bestWinRateBoss} | ${item.worstWinRateBoss} | ${percent(item.winRateSpread)} | ${item.bosses.map((row) => `${row.bossName}:${percent(row.winRateWhenSelected)}`).join(' / ')} |`)
    .join('\n');
  const validationSections = Object.values(summary.bosses).map((boss) => `### ${boss.bossName}\n\n\`\`\`json\n${JSON.stringify(boss.skillValidation, null, 2)}\n\`\`\``).join('\n\n');
  const differentiatedRows = summary.analysis.differentiatedSpirits
    .map((item) => `| ${item.spiritName} | ${item.bestWinRateBoss} | ${item.worstWinRateBoss} | ${percent(item.winRateSpread)} |`)
    .join('\n');
  const outlierRows = summary.analysis.matchupOutliers
    .map((item) => `| ${item.spiritName} | ${item.bossName} | ${percent(item.winRateWhenSelected)} | ${signedPercent(item.deltaFromBossAverage)} |`)
    .join('\n');
  const dominanceLines = summary.analysis.dominantSkills.map((boss) => `- ${boss.bossName}：${boss.skills.map((skill) => `${skill.skillName} ${percent(skill.useShare)}`).join('；') || '无单技能超过65%'}`).join('\n');
  return `# 三Boss全随机阵容10000场战斗总结\n\n生成时间：${summary.generatedAt}\n\n## 执行结论\n\n- 共完成${summary.testDefinition.totalBattles}场战斗，三名Boss运行异常均为0。\n- 难度最高：${summary.analysis.hardestBoss.bossName}，胜率${percent(summary.analysis.hardestBoss.clearRate)}；难度最低：${summary.analysis.easiestBoss.bossName}，胜率${percent(summary.analysis.easiestBoss.clearRate)}。\n- 长尾最明显：${summary.analysis.longestTailBoss.bossName}，P90为${number(summary.analysis.longestTailBoss.p90Rounds)}回合，超过20回合占${percent(summary.analysis.longestTailBoss.over20RoundsRate)}。\n- 精灵跨Boss实用性差异已经形成：${summary.analysis.differentiatedSpirits.length}只精灵的入选胜率极差达到12个百分点以上。\n- 当前最显著的单一对局优势是${summary.analysis.matchupOutliers[0].spiritName}对${summary.analysis.matchupOutliers[0].bossName}：入选胜率${percent(summary.analysis.matchupOutliers[0].winRateWhenSelected)}，高于该Boss总体${signedPercent(summary.analysis.matchupOutliers[0].deltaFromBossAverage)}。\n- ${summary.analysis.interpretationBoundary}\n\n## 测试口径\n\n- 每只Boss：${summary.testDefinition.runsPerBoss}场，总计${summary.testDefinition.totalBattles}场。\n- Seed：${summary.testDefinition.seed}；${summary.testDefinition.seedPairing}。\n- 阵容：${summary.testDefinition.roster}。\n- 策略：${summary.testDefinition.policy}，玩家倾向：均衡。\n- 团队妖力：初始${summary.testDefinition.initialMana}，上限${summary.testDefinition.manaCap}。\n\n## Boss总体结果\n\n| Boss | 样本 | 胜率 | 平均回合 | 中位回合 | P90回合 | P95回合 | 超20回合 | 胜场剩余生命率 | 平均存活数 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${Object.values(summary.bosses).map((boss) => `| ${boss.bossName} | ${boss.samples} | ${percent(boss.clearRate)} | ${number(boss.averageRounds)} | ${number(boss.medianRounds)} | ${number(boss.p90Rounds)} | ${number(boss.p95Rounds)} | ${percent(boss.over20RoundsRate)} | ${percent(boss.victoryFinalHpRatioAverage)} | ${number(boss.finalAliveCountAverage)} |`).join('\n')}\n\n## 四类行为占比\n\n| Boss | 攻击 | 防护 | 恢复 | 回能 |\n|---|---:|---:|---:|---:|\n${behaviorRows}\n\n## 关键对局差异\n\n| 精灵 | 最佳Boss | 最弱Boss | 胜率极差 |\n|---|---|---|---:|\n${differentiatedRows}\n\n### 显著偏离Boss总体胜率的组合\n\n| 精灵 | Boss | 入选胜率 | 相对Boss总体 |\n|---|---|---:|---:|\n${outlierRows}\n\n## 技能选择诊断\n\n单只精灵的技能行动占比达到65%视为明显集中：\n\n${dominanceLines}\n\n### 未充分验证内容\n\n${summary.analysis.validationGaps.map((item) => `- ${item}`).join('\n')}\n\n这些项目代表自动策略没有充分触发，不代表技能或结算代码必然存在错误。\n\n## 精灵分Boss表现\n\n${spiritSections}\n\n## 精灵跨Boss差异全表\n\n按入选胜率的三Boss极差降序，仅用于识别适用性差异，不直接作为平衡裁决。\n\n| 精灵 | 最佳Boss | 最弱Boss | 胜率极差 | 三Boss入选胜率 |\n|---|---|---|---:|---|\n${crossRows}\n\n## 专项技能验证数据\n\n${validationSections}\n\n## 数据质量\n\n${Object.values(summary.bosses).map((boss) => `- ${boss.bossName}：警告${boss.warningCount}项，运行异常${boss.runtimeAnomalies}项。`).join('\n')}\n`;
}

function maxBy(rows, key) { return rows.reduce((best, row) => !best || row[key] > best[key] ? row : best, null); }
function minBy(rows, key) { return rows.reduce((best, row) => !best || row[key] < best[key] ? row : best, null); }
function ratio(value, total) { return total > 0 ? round(value / total) : 0; }
function round(value) { return Math.round((Number(value) || 0) * 10000) / 10000; }
function percent(value) { return `${(Number(value) * 100).toFixed(2)}%`; }
function signedPercent(value) { return `${Number(value) >= 0 ? '+' : ''}${(Number(value) * 100).toFixed(2)}%`; }
function number(value) { return Number(value).toFixed(2); }
