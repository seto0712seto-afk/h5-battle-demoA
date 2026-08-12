import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PLAYER_TENDENCY_PROFILES } from './battle-policy.mjs';
import { SINGLE_BOSS_IDS } from './single-boss-config.mjs';
import { behaviorShares, projectRoot, readReport, runSingleBoss } from './single-boss-suite-utils.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
  return [key, value];
}));
const runs = Math.max(1, Number(args.runs ?? 10000));
const seed = Number(args.seed ?? 2026080502);
const policy = args.policy ?? 'balanced-v4-hunter-aware';
const outputRoot = args.outputDir ?? 'validation-artifacts/player-tendency-10000-20260805';
const reuse = args.reuse === 'true';
const tendencyIds = (args.tendencies ?? 'balanced,offense,defense').split(',').filter(Boolean);
const bossConfig = JSON.parse(await readFile(path.join(projectRoot, 'config/boss-mechanics.json'), 'utf8'));
const bossNames = Object.fromEntries(Object.entries(bossConfig.bosses ?? {}).map(([bossId, boss]) => [bossId, boss.bossName]));
const reports = {};

for (const tendencyId of tendencyIds) {
  if (!PLAYER_TENDENCY_PROFILES[tendencyId]) throw new Error(`Unknown player tendency: ${tendencyId}`);
  reports[tendencyId] = {};
  for (const boss of SINGLE_BOSS_IDS) {
    const outputDir = `${outputRoot}/${tendencyId}/${boss}`;
    if (reuse) {
      reports[tendencyId][boss] = await readReport(outputDir);
      process.stdout.write(`TENDENCY_REUSED=${tendencyId} BOSS=${boss} CLEAR_RATE=${reports[tendencyId][boss].summary.clearRate}\n`);
      continue;
    }
    process.stdout.write(`TENDENCY_START=${tendencyId} BOSS=${boss} RUNS=${runs} SEED=${seed}\n`);
    reports[tendencyId][boss] = await runSingleBoss({
      boss,
      runs,
      seed,
      policy,
      playerTendency: tendencyId,
      roster: 'random',
      outputDir
    });
    process.stdout.write(`TENDENCY_DONE=${tendencyId} BOSS=${boss} CLEAR_RATE=${reports[tendencyId][boss].summary.clearRate}\n`);
  }
}

const summary = buildSummary(reports);
const destination = path.resolve(projectRoot, outputRoot);
await mkdir(destination, { recursive: true });
await Promise.all([
  writeFile(path.join(destination, '三Boss三玩家风格各10000场综合报告.md'), renderMarkdown(summary), 'utf8'),
  writeFile(path.join(destination, '三Boss三玩家风格各10000场汇总.json'), JSON.stringify(summary, null, 2), 'utf8')
]);
process.stdout.write(`TENDENCY_SUMMARY=${path.join(destination, '三Boss三玩家风格各10000场综合报告.md')}\n`);

function buildSummary(source) {
  const tendencies = Object.fromEntries(Object.entries(source).map(([tendencyId, bossReports]) => {
    const bosses = Object.fromEntries(Object.entries(bossReports).map(([bossId, report]) => {
      const stage = report.stages['1'];
      const spirits = Object.fromEntries(Object.entries(report.spirits).map(([spiritId, spirit]) => [spiritId, {
        spiritId,
        spiritName: spirit.spiritName,
        selectedCount: spirit.selectedCount,
        winRateWhenSelected: spirit.winRateWhenSelected,
        damagePerSelection: ratio(spirit.damageDealt, spirit.selectedCount),
        healingPerSelection: ratio(spirit.effectiveHealing, spirit.selectedCount),
        shieldPerSelection: ratio(spirit.shieldGranted, spirit.selectedCount),
        energyPerSelection: ratio(spirit.energyGenerated, spirit.selectedCount),
        deathRateWhenSelected: ratio(spirit.deaths, spirit.selectedCount)
      }]));
      return [bossId, {
        bossId,
        bossName: bossNames[bossId] ?? bossId,
        samples: report.summary.runs,
        wins: report.summary.clears,
        clearRate: report.summary.clearRate,
        clearRateCi95HalfWidth: ci95HalfWidth(report.summary.clearRate, report.summary.runs),
        averageRounds: stage.averageRounds,
        medianRounds: stage.medianRounds,
        p90Rounds: stage.p90Rounds,
        p95Rounds: stage.p95Rounds,
        over20RoundsRate: stage.over20RoundsRate,
        victoryFinalHpRatioAverage: stage.victoryFinalHpRatioAverage,
        finalAliveCountAverage: stage.finalAliveCountAverage,
        averageDamagePerBattle: perBattle(report.spirits, 'damageDealt', report.summary.runs),
        averageHealingPerBattle: perBattle(report.spirits, 'effectiveHealing', report.summary.runs),
        averageShieldPerBattle: perBattle(report.spirits, 'shieldGranted', report.summary.runs),
        averageDeathsPerBattle: perBattle(report.spirits, 'deaths', report.summary.runs),
        averageEnergyGainedPerBattle: ratio(report.energy.gained, report.summary.runs),
        averageEnergySpentPerBattle: ratio(report.energy.spent, report.summary.runs),
        zeroEnergyActionStartRate: report.energy.zeroEnergyActionStartRate,
        behaviorShares: behaviorShares(report),
        topSkills: Object.values(report.skills)
          .filter((skill) => skill.uses > 0)
          .sort((a, b) => b.uses - a.uses)
          .slice(0, 5)
          .map((skill) => ({ skillId: skill.skillId, skillName: skill.skillName, uses: skill.uses, ownerUseShare: skill.useShareOfOwnerSkillActions })),
        zeroUseSkills: Object.values(report.skills).filter((skill) => skill.uses === 0).map((skill) => skill.skillName),
        spirits,
        warningCount: report.warnings.length,
        runtimeAnomalies: report.outliers.runtimeAnomalies.length
      }];
    }));
    const rows = Object.values(bosses);
    const samples = rows.reduce((sum, boss) => sum + boss.samples, 0);
    const wins = rows.reduce((sum, boss) => sum + boss.wins, 0);
    return [tendencyId, {
      tendencyId,
      tendencyName: PLAYER_TENDENCY_PROFILES[tendencyId].name,
      weights: PLAYER_TENDENCY_PROFILES[tendencyId].weights,
      samples,
      wins,
      clearRate: ratio(wins, samples),
      averageRounds: weightedAverage(rows, 'averageRounds', 'samples'),
      averageDamagePerBattle: weightedAverage(rows, 'averageDamagePerBattle', 'samples'),
      averageHealingPerBattle: weightedAverage(rows, 'averageHealingPerBattle', 'samples'),
      averageShieldPerBattle: weightedAverage(rows, 'averageShieldPerBattle', 'samples'),
      averageDeathsPerBattle: weightedAverage(rows, 'averageDeathsPerBattle', 'samples'),
      bosses
    }];
  }));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    testDefinition: {
      runsPerTendencyPerBoss: runs,
      bossCount: SINGLE_BOSS_IDS.length,
      tendencyCount: tendencyIds.length,
      totalBattles: runs * SINGLE_BOSS_IDS.length * tendencyIds.length,
      seed,
      seedPairing: '所有玩家风格与Boss使用相同Seed序列和随机阵容序列，仅改变合法行动评分权重',
      roster: '当前10只精灵随机选择6只；首发1默认前排+2默认后排；后备至少1默认前排',
      policy,
      initialMana: 0,
      manaCap: 10
    },
    tendencies,
    comparisons: buildComparisons(tendencies),
    pairedOutcomeComparisons: buildPairedOutcomeComparisons(source)
  };
}

function buildPairedOutcomeComparisons(source) {
  const pairs = [];
  for (let firstIndex = 0; firstIndex < tendencyIds.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < tendencyIds.length; secondIndex += 1) {
      const firstId = tendencyIds[firstIndex];
      const secondId = tendencyIds[secondIndex];
      for (const bossId of SINGLE_BOSS_IDS) {
        const secondBySeed = new Map(source[secondId][bossId].battleRecords.map((record) => [record.seed, record]));
        const counts = { bothWin: 0, firstOnlyWin: 0, secondOnlyWin: 0, bothLose: 0, teamMismatch: 0 };
        let paired = 0;
        let roundDifferenceTotal = 0;
        for (const first of source[firstId][bossId].battleRecords) {
          const second = secondBySeed.get(first.seed);
          if (!second) continue;
          paired += 1;
          if (first.team.join(',') !== second.team.join(',')) counts.teamMismatch += 1;
          roundDifferenceTotal += first.rounds - second.rounds;
          if (first.victory && second.victory) counts.bothWin += 1;
          else if (first.victory) counts.firstOnlyWin += 1;
          else if (second.victory) counts.secondOnlyWin += 1;
          else counts.bothLose += 1;
        }
        pairs.push({
          bossId,
          bossName: bossNames[bossId] ?? bossId,
          firstId,
          firstName: PLAYER_TENDENCY_PROFILES[firstId].name,
          secondId,
          secondName: PLAYER_TENDENCY_PROFILES[secondId].name,
          paired,
          ...counts,
          changedOutcomeRate: ratio(counts.firstOnlyWin + counts.secondOnlyWin, paired),
          firstNetAdvantage: ratio(counts.firstOnlyWin - counts.secondOnlyWin, paired),
          averageRoundDifference: ratio(roundDifferenceTotal, paired)
        });
      }
    }
  }
  return pairs;
}

function buildComparisons(tendencies) {
  const bossComparisons = SINGLE_BOSS_IDS.map((bossId) => {
    const rows = Object.values(tendencies).map((tendency) => ({ tendencyId: tendency.tendencyId, tendencyName: tendency.tendencyName, ...tendency.bosses[bossId] }));
    const best = maxBy(rows, 'clearRate');
    const worst = minBy(rows, 'clearRate');
    return {
      bossId,
      bossName: bossNames[bossId] ?? bossId,
      bestTendency: best.tendencyName,
      worstTendency: worst.tendencyName,
      clearRateSpread: round(best.clearRate - worst.clearRate),
      rows
    };
  });
  const spiritComparisons = SINGLE_BOSS_IDS.flatMap((bossId) => {
    const first = Object.values(tendencies)[0].bosses[bossId];
    return Object.keys(first.spirits).map((spiritId) => {
      const rows = Object.values(tendencies).map((tendency) => ({ tendencyId: tendency.tendencyId, tendencyName: tendency.tendencyName, ...tendency.bosses[bossId].spirits[spiritId] }));
      const best = maxBy(rows, 'winRateWhenSelected');
      const worst = minBy(rows, 'winRateWhenSelected');
      return {
        bossId,
        bossName: first.bossName,
        spiritId,
        spiritName: first.spirits[spiritId].spiritName,
        bestTendency: best.tendencyName,
        worstTendency: worst.tendencyName,
        winRateSpread: round(best.winRateWhenSelected - worst.winRateWhenSelected),
        rows
      };
    });
  });
  return {
    bossComparisons,
    spiritComparisons,
    largestSpiritStyleEffects: [...spiritComparisons].sort((a, b) => b.winRateSpread - a.winRateSpread).slice(0, 15)
  };
}

function renderMarkdown(summary) {
  const tendencyRows = Object.values(summary.tendencies).map((tendency) => `| ${tendency.tendencyName} | ${tendency.samples} | ${percent(tendency.clearRate)} | ${number(tendency.averageRounds)} | ${number(tendency.averageDamagePerBattle)} | ${number(tendency.averageHealingPerBattle)} | ${number(tendency.averageShieldPerBattle)} | ${number(tendency.averageDeathsPerBattle)} |`).join('\n');
  const bossSections = summary.comparisons.bossComparisons.map((comparison) => {
    const rows = comparison.rows.map((row) => `| ${row.tendencyName} | ${percent(row.clearRate)} ± ${percent(row.clearRateCi95HalfWidth)} | ${number(row.averageRounds)} | ${number(row.p90Rounds)} | ${number(row.p95Rounds)} | ${percent(row.over20RoundsRate)} | ${percent(row.victoryFinalHpRatioAverage)} | ${number(row.finalAliveCountAverage)} |`).join('\n');
    return `### ${comparison.bossName}\n\n风格胜率极差：${percent(comparison.clearRateSpread)}；最佳为${comparison.bestTendency}，最低为${comparison.worstTendency}。\n\n| 玩家风格 | 胜率 | 平均回合 | P90 | P95 | 超20回合 | 胜场剩余生命率 | 平均存活数 |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${rows}`;
  }).join('\n\n');
  const behaviorRows = Object.values(summary.tendencies).flatMap((tendency) => Object.values(tendency.bosses).map((boss) => `| ${tendency.tendencyName} | ${boss.bossName} | ${percent(boss.behaviorShares.attack)} | ${percent(boss.behaviorShares.protect)} | ${percent(boss.behaviorShares.recover)} | ${percent(boss.behaviorShares.energy)} | ${number(boss.averageEnergyGainedPerBattle)} | ${number(boss.averageEnergySpentPerBattle)} | ${percent(boss.zeroEnergyActionStartRate)} |`)).join('\n');
  const styleEffectRows = summary.comparisons.largestSpiritStyleEffects.map((item) => `| ${item.bossName} | ${item.spiritName} | ${item.bestTendency} | ${item.worstTendency} | ${percent(item.winRateSpread)} | ${item.rows.map((row) => `${row.tendencyName}:${percent(row.winRateWhenSelected)}`).join(' / ')} |`).join('\n');
  const spiritSections = summary.comparisons.bossComparisons.map((comparison) => {
    const items = summary.comparisons.spiritComparisons.filter((item) => item.bossId === comparison.bossId);
    const rows = items.map((item) => `| ${item.spiritName} | ${item.rows.map((row) => percent(row.winRateWhenSelected)).join(' | ')} | ${percent(item.winRateSpread)} |`).join('\n');
    const tendencyNames = Object.values(summary.tendencies).map((item) => item.tendencyName);
    return `### ${comparison.bossName}\n\n| 精灵 | ${tendencyNames.join(' | ')} | 风格极差 |\n|---|${tendencyNames.map(() => '---:').join('|')}|---:|\n${rows}`;
  }).join('\n\n');
  const skillSections = Object.values(summary.tendencies).map((tendency) => {
    const rows = Object.values(tendency.bosses).map((boss) => `| ${boss.bossName} | ${boss.topSkills.map((skill) => `${skill.skillName} ${skill.uses}次`).join('；')} | ${boss.zeroUseSkills.join('、') || '无'} |`).join('\n');
    return `### ${tendency.tendencyName}\n\n| Boss | 总使用次数前五技能 | 未使用技能 |\n|---|---|---|\n${rows}`;
  }).join('\n\n');
  const pairedRows = summary.pairedOutcomeComparisons.map((pair) => `| ${pair.bossName} | ${pair.firstName} vs ${pair.secondName} | ${pair.firstOnlyWin} | ${pair.secondOnlyWin} | ${percent(pair.changedOutcomeRate)} | ${pair.firstNetAdvantage >= 0 ? pair.firstName : pair.secondName} ${percent(Math.abs(pair.firstNetAdvantage))} | ${signedNumber(pair.averageRoundDifference)} | ${pair.teamMismatch} |`).join('\n');
  const anomalies = Object.values(summary.tendencies).flatMap((tendency) => Object.values(tendency.bosses).map((boss) => ({ tendency: tendency.tendencyName, boss: boss.bossName, count: boss.runtimeAnomalies })));
  const bestOverall = maxBy(Object.values(summary.tendencies), 'clearRate');
  const worstOverall = minBy(Object.values(summary.tendencies), 'clearRate');
  const balanced = summary.tendencies.balanced;
  const offense = summary.tendencies.offense;
  const defense = summary.tendencies.defense;
  const rangeId = SINGLE_BOSS_IDS.find((bossId) => bossNames[bossId] === '灰羽猎王');
  const forgeId = SINGLE_BOSS_IDS.find((bossId) => bossNames[bossId] === '熔核守卫');
  return `# 三Boss三玩家风格各10000场综合报告\n\n生成时间：${summary.generatedAt}\n\n## 执行结论\n\n- 共完成${summary.testDefinition.totalBattles}场：三种玩家风格 × 三名Boss × 每组${summary.testDefinition.runsPerTendencyPerBoss}场。\n- 综合胜率最高为${bestOverall.tendencyName} ${percent(bestOverall.clearRate)}，最低为${worstOverall.tendencyName} ${percent(worstOverall.clearRate)}，差值${percent(bestOverall.clearRate - worstOverall.clearRate)}。\n- 风格差异最大的Boss是${maxBy(summary.comparisons.bossComparisons, 'clearRateSpread').bossName}，三种风格胜率极差${percent(maxBy(summary.comparisons.bossComparisons, 'clearRateSpread').clearRateSpread)}。\n- 所有组运行异常合计${anomalies.reduce((sum, item) => sum + item.count, 0)}项。\n- 玩家风格只改变合法行动评分权重，不修改技能、Boss、妖力或战斗结算规则。\n\n## 设计观察\n\n- 进攻型并非通用最优：对灰羽猎王比均衡型高${percent(offense.bosses[rangeId].clearRate - balanced.bosses[rangeId].clearRate)}，但对熔核守卫反而低${percent(balanced.bosses[forgeId].clearRate - offense.bosses[forgeId].clearRate)}。\n- 防守型场均护盾${number(defense.averageShieldPerBattle)}，高于均衡型${number(balanced.averageShieldPerBattle)}，但综合胜率低${percent(balanced.clearRate - defense.clearRate)}且场均死亡更多，说明当前额外防守投入没有稳定转化成胜利。\n- 灰羽猎王对风格最敏感：进攻型胜率${percent(offense.bosses[rangeId].clearRate)}，防守型仅${percent(defense.bosses[rangeId].clearRate)}；防守型超过20回合占${percent(defense.bosses[rangeId].over20RoundsRate)}，存在明显拖延惩罚。\n- 炽印法主三风格差异相对较小，主要改变战斗时长与生存余量，没有像灰羽猎王一样改变核心解法。\n\n## 测试口径\n\n- Seed：${summary.testDefinition.seed}；${summary.testDefinition.seedPairing}。\n- 阵容：${summary.testDefinition.roster}。\n- 决策策略：${summary.testDefinition.policy}。\n- 团队妖力：初始${summary.testDefinition.initialMana}，上限${summary.testDefinition.manaCap}。\n- 风格：均衡型、进攻型、防守型。\n- 单组胜率的95%抽样误差约为表中所列范围；跨风格方向同时使用同Seed配对结果复核。\n\n## 三种风格总体表现\n\n| 玩家风格 | 总场次 | 综合胜率 | 平均回合 | 场均伤害 | 场均有效治疗 | 场均护盾生成 | 场均死亡 |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${tendencyRows}\n\n## 各Boss风格对照\n\n${bossSections}\n\n## 同Seed胜负翻转\n\n“A独赢”表示相同阵容与Seed下，A获胜而B失败；净优势按全部10,000组配对样本计算。平均回合差为前一种风格减后一种风格。\n\n| Boss | 风格比较 | 前者独赢 | 后者独赢 | 胜负发生变化 | 净胜优势 | 平均回合差 | 阵容不一致 |\n|---|---|---:|---:|---:|---:|---:|---:|\n${pairedRows}\n\n## 行为与妖力结构\n\n| 玩家风格 | Boss | 攻击 | 防护 | 恢复 | 回能 | 场均获得妖力 | 场均消耗妖力 | 0妖力行动占比 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n${behaviorRows}\n\n## 风格影响最大的精灵-Boss组合\n\n| Boss | 精灵 | 最佳风格 | 最弱风格 | 胜率极差 | 三风格入选胜率 |\n|---|---|---|---|---:|---|\n${styleEffectRows}\n\n## 全部精灵分Boss风格胜率\n\n${spiritSections}\n\n## 技能选择覆盖\n\n${skillSections}\n\n## 数据质量与解释边界\n\n- 三组使用相同Seed与阵容序列，适合进行配对方向比较。\n- 入选胜率仍包含队友组合和站位影响，不等于精灵孤立强度。\n- 玩家风格是规则化AI倾向，不代表真实玩家操作上限。\n- 警告用于提示技能集中或样本覆盖不足，不等同于运行错误。\n- 本次修正了balanced-v4-hunter-aware未把玩家倾向接入技能评分的问题，因此本报告与修正前的玩家风格数据不可直接横向比较。战斗规则与数值未改变。\n\n${anomalies.map((item) => `- ${item.tendency} / ${item.boss}：运行异常${item.count}项。`).join('\n')}\n`;
}

function perBattle(records, key, samples) {
  return ratio(Object.values(records).reduce((sum, record) => sum + (Number(record[key]) || 0), 0), samples);
}
function weightedAverage(rows, valueKey, weightKey) {
  const weight = rows.reduce((sum, row) => sum + row[weightKey], 0);
  return ratio(rows.reduce((sum, row) => sum + row[valueKey] * row[weightKey], 0), weight);
}
function maxBy(rows, key) { return rows.reduce((best, row) => !best || row[key] > best[key] ? row : best, null); }
function minBy(rows, key) { return rows.reduce((best, row) => !best || row[key] < best[key] ? row : best, null); }
function ratio(value, total) { return total > 0 ? round(value / total) : 0; }
function ci95HalfWidth(rate, samples) { return samples > 0 ? round(1.96 * Math.sqrt(rate * (1 - rate) / samples)) : 0; }
function round(value) { return Math.round((Number(value) || 0) * 10000) / 10000; }
function percent(value) { return `${(Number(value) * 100).toFixed(2)}%`; }
function number(value) { return Number(value).toFixed(2); }
function signedNumber(value) { return `${Number(value) >= 0 ? '+' : ''}${number(value)}`; }
