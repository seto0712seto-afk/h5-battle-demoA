import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXED_TEAMS } from './single-boss-config.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
  return [key, value];
}));
const runs = Math.max(1, Number(args.runs ?? 1000));
const seed = Number(args.seed ?? 2026072901) >>> 0;
const outputRoot = args.outputDir ?? 'validation-artifacts/targeted-boss-diagnostics-20260730';
const absoluteRoot = path.resolve(projectRoot, outputRoot);
const reuse = args.reuse === 'true';

await mkdir(absoluteRoot, { recursive: true });

const rangeDir = `${outputRoot}/range-over20`;
if (!reuse) {
  await runSimulation({
    boss: 'RANGE_BOSS_SHOOTER',
    runs,
    seed,
    roster: 'random',
    outputDir: rangeDir
  });
}
const rangeTraces = await readJson(path.resolve(projectRoot, rangeDir, 'diagnostic-trace.json'));
const rangeLongTail = rangeTraces.filter((battle) => battle.rounds > 20);
const rangeAnalysis = analyzeRangeLongTail(rangeLongTail, rangeTraces);

await Promise.all([
  writeFile(path.join(absoluteRoot, 'range-over20-samples.json'), JSON.stringify(rangeLongTail, null, 2), 'utf8'),
  writeFile(path.join(absoluteRoot, 'range-over20-sample-summary.csv'), renderCsv(rangeSampleRows(rangeLongTail)), 'utf8'),
  writeFile(path.join(absoluteRoot, 'range-over20-rounds.csv'), renderCsv(rangeRoundRows(rangeLongTail)), 'utf8'),
  writeFile(path.join(absoluteRoot, 'range-over20-round-aggregate.csv'), renderCsv(rangeAnalysis.perRound), 'utf8'),
  writeFile(path.join(absoluteRoot, 'range-over20-boss-cycle.csv'), renderCsv(rangeBossCycleRows(rangeLongTail)), 'utf8'),
  writeFile(path.join(absoluteRoot, 'range-over20-summary.md'), renderRangeMarkdown(rangeAnalysis, { runs, seed }), 'utf8')
]);

const mageTeams = [];
for (const teamId of Object.keys(FIXED_TEAMS)) {
  const outputDir = `${outputRoot}/mage-fixed/${teamId}`;
  if (!reuse) {
    await runSimulation({
      boss: 'MAGE_BOSS',
      runs,
      seed,
      roster: 'fixed',
      team: teamId,
      outputDir
    });
  }
  const traces = await readJson(path.resolve(projectRoot, outputDir, 'diagnostic-trace.json'));
  mageTeams.push(analyzeMageTeam(teamId, FIXED_TEAMS[teamId], traces));
}

await Promise.all([
  writeFile(path.join(absoluteRoot, 'mage-fixed-team-details.csv'), renderCsv(mageTeams.map(flattenMageTeam)), 'utf8'),
  writeFile(path.join(absoluteRoot, 'mage-fixed-team-summary.md'), renderMageMarkdown(mageTeams, { runs, seed }), 'utf8'),
  writeFile(path.join(absoluteRoot, 'diagnostic-manifest.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    seed,
    runsPerGroup: runs,
    policy: 'balanced-v3',
    range: {
      tuning: 'formal repository config (no RANGE-A/RANGE-B override)',
      allSamples: rangeTraces.length,
      over20Samples: rangeLongTail.length
    },
    mage: mageTeams
  }, null, 2), 'utf8')
]);

process.stdout.write(`REPORT_DIR=${absoluteRoot}\n`);
process.stdout.write(JSON.stringify({
  rangeOver20: rangeLongTail.length,
  rangeOver20Rate: ratio(rangeLongTail.length, rangeTraces.length),
  mage: mageTeams.map(({ teamId, wins, losses, winRate }) => ({ teamId, wins, losses, winRate }))
}, null, 2) + '\n');

async function runSimulation({ boss, runs: sampleCount, seed: seedBase, roster, team, outputDir }) {
  const normalized = outputDir.replaceAll('\\', '/');
  await mkdir(path.resolve(projectRoot, outputDir), { recursive: true });
  const childArgs = [
    'scripts/simulate-single-boss-v2.mjs',
    `--boss=${boss}`,
    `--runs=${sampleCount}`,
    `--seed=${seedBase}`,
    '--policy=balanced-v3',
    `--roster=${roster}`,
    `--output=../${normalized}/raw-summary.json`,
    `--artifactDir=../${normalized}/`,
    '--diagnostic-trace=true',
    `--diagnosticTraceOutput=../${normalized}/diagnostic-trace.json`
  ];
  if (team) childArgs.push(`--team=${team}`);
  await spawnChecked(process.execPath, childArgs);
}

function analyzeRangeLongTail(longTail, allSamples) {
  const shortSamples = allSamples.filter((battle) => battle.rounds <= 20);
  const totalSkillActions = longTail.reduce((sum, battle) => sum + sumValues(battle.skillUses), 0);
  const repeatedSkillActions = longTail.reduce((sum, battle) => sum + battle.repeatedSkillActions, 0);
  const skillUses = mergeCountMaps(longTail.map((battle) => battle.skillUses));
  const lineups = countBy(longTail, (battle) => battle.team.join('>'));
  const starters = mergeCountMaps(longTail.map((battle) => Object.fromEntries(battle.team.slice(0, 3).map((id) => [id, 1]))));
  const benches = mergeCountMaps(longTail.map((battle) => Object.fromEntries(battle.team.slice(3).map((id) => [id, 1]))));
  const bossSequences = countBy(longTail, (battle) => battle.perRound
    .flatMap((entry) => entry.bossSkills.map((skill) => `${skill.skillId}${skill.telegraph ? '[预告]' : ''}`))
    .join('>'));
  const maxRound = Math.max(0, ...longTail.map((battle) => battle.rounds));
  const perRound = [];
  for (let round = 1; round <= maxRound; round += 1) {
    const active = longTail.filter((battle) => battle.rounds >= round);
    const entries = active.map((battle) => battle.perRound.find((entry) => entry.round === round));
    const bossSkills = mergeCountMaps(entries.map((entry) => Object.fromEntries(
      entry.bossSkills.map((skill) => [`${skill.skillId}${skill.telegraph ? '[预告]' : ''}`, 1])
    )));
    perRound.push({
      round,
      activeSamples: active.length,
      averageDamageToBoss: average(entries.map((entry) => entry.damageToBoss)),
      averageDamageToPlayers: average(entries.map((entry) => entry.damageToPlayers)),
      averagePlayerNetHpLoss: average(entries.map((entry) => entry.playerNetHpLoss)),
      averageNetDamageTrade: average(entries.map((entry) => entry.netDamageTrade)),
      averageEffectiveHealing: average(entries.map((entry) => entry.effectiveHealing)),
      averageEffectiveShield: average(entries.map((entry) => entry.effectiveShield)),
      averageShieldGranted: average(entries.map((entry) => entry.shieldGranted)),
      averagePlayerSkillActions: average(entries.map((entry) => entry.playerSkills.length)),
      bossSkills: formatCountMap(bossSkills)
    });
  }
  return {
    allSampleCount: allSamples.length,
    sampleCount: longTail.length,
    sampleRate: ratio(longTail.length, allSamples.length),
    wins: longTail.filter((battle) => battle.result === 'victory').length,
    losses: longTail.filter((battle) => battle.result === 'defeat').length,
    averageRounds: average(longTail.map((battle) => battle.rounds)),
    medianRounds: percentile(longTail.map((battle) => battle.rounds), 0.5),
    p90Rounds: percentile(longTail.map((battle) => battle.rounds), 0.9),
    totalSkillActions,
    repeatedSkillActions,
    repeatedSkillActionRate: ratio(repeatedSkillActions, totalSkillActions),
    maxSkillStreak: Math.max(0, ...longTail.map((battle) => battle.maxSkillStreak)),
    skillUses,
    lineups,
    starters,
    benches,
    bossSequences,
    perRound,
    windows: {
      rounds1To10: rangeWindow(longTail, 1, 10),
      rounds11To20: rangeWindow(longTail, 11, 20),
      rounds21Plus: rangeWindow(longTail, 21, Number.POSITIVE_INFINITY)
    },
    longTailProfile: rangeProfile(longTail),
    shortProfile: rangeProfile(shortSamples),
    compositionComparison: compositionComparison(longTail, shortSamples)
  };
}

function compositionComparison(longTail, shortSamples) {
  const ids = [...new Set([...longTail, ...shortSamples].flatMap((battle) => battle.team))].sort();
  return ids.map((spiritId) => {
    const longTailRate = ratio(longTail.filter((battle) => battle.team.includes(spiritId)).length, longTail.length);
    const shortRate = ratio(shortSamples.filter((battle) => battle.team.includes(spiritId)).length, shortSamples.length);
    return { spiritId, longTailRate, shortRate, lift: rounded(longTailRate - shortRate) };
  }).sort((a, b) => b.lift - a.lift);
}

function rangeProfile(samples) {
  const entries = samples.flatMap((battle) => battle.perRound);
  const totalSkillActions = samples.reduce((sum, battle) => sum + sumValues(battle.skillUses), 0);
  return {
    samples: samples.length,
    averageDamageToBossPerRound: average(entries.map((entry) => entry.damageToBoss)),
    averageDamageToPlayersPerRound: average(entries.map((entry) => entry.damageToPlayers)),
    averageEffectiveHealingPerRound: average(entries.map((entry) => entry.effectiveHealing)),
    averageEffectiveShieldPerRound: average(entries.map((entry) => entry.effectiveShield)),
    repeatedSkillActionRate: ratio(samples.reduce((sum, battle) => sum + battle.repeatedSkillActions, 0), totalSkillActions),
    bossSkillShares: bossSkillShares(samples)
  };
}

function rangeWindow(samples, minimumRound, maximumRound) {
  const entries = samples.flatMap((battle) => battle.perRound.filter((entry) => entry.round >= minimumRound && entry.round <= maximumRound));
  return {
    battleRounds: entries.length,
    damageToBoss: average(entries.map((entry) => entry.damageToBoss)),
    damageToPlayers: average(entries.map((entry) => entry.damageToPlayers)),
    playerNetHpLoss: average(entries.map((entry) => entry.playerNetHpLoss)),
    effectiveHealing: average(entries.map((entry) => entry.effectiveHealing)),
    effectiveShield: average(entries.map((entry) => entry.effectiveShield)),
    shieldGranted: average(entries.map((entry) => entry.shieldGranted)),
    playerSkillActions: average(entries.map((entry) => entry.playerSkills.length))
  };
}

function bossSkillShares(samples) {
  const counts = {};
  samples.flatMap((battle) => battle.perRound).forEach((entry) => entry.bossSkills.forEach((skill) => {
    counts[skill.skillId] = (counts[skill.skillId] ?? 0) + 1;
  }));
  const total = sumValues(counts);
  return Object.fromEntries(Object.entries(counts).map(([skillId, count]) => [skillId, ratio(count, total)]));
}

function analyzeMageTeam(teamId, team, traces) {
  const wins = traces.filter((battle) => battle.result === 'victory').length;
  const beforeAttacks = traces.reduce((sum, battle) => sum + battle.attacksBeforeSecondAmplification, 0);
  const beforeActions = traces.reduce((sum, battle) => sum + battle.skillActionsBeforeSecondAmplification, 0);
  const afterAttacks = traces.reduce((sum, battle) => sum + battle.attacksAfterSecondAmplification, 0);
  const afterActions = traces.reduce((sum, battle) => sum + battle.skillActionsAfterSecondAmplification, 0);
  const casualtyTiers = countBy(traces, (battle) => casualtyTierLabel(battle.firstCasualtyPowerTier));
  return {
    teamId,
    team,
    samples: traces.length,
    wins,
    losses: traces.length - wins,
    winRate: ratio(wins, traces.length),
    winRateWilson95: wilsonInterval(wins, traces.length),
    averageRounds: average(traces.map((battle) => battle.rounds)),
    medianRounds: percentile(traces.map((battle) => battle.rounds), 0.5),
    p90Rounds: percentile(traces.map((battle) => battle.rounds), 0.9),
    reachedSecondAmplification: traces.filter((battle) => battle.amplificationCount >= 2).length,
    casualtyTiers,
    beforeSecondAmplification: { attacks: beforeAttacks, skillActions: beforeActions, attackShare: ratio(beforeAttacks, beforeActions) },
    afterSecondAmplification: { attacks: afterAttacks, skillActions: afterActions, attackShare: ratio(afterAttacks, afterActions) }
  };
}

function rangeRoundRows(battles) {
  return battles.flatMap((battle) => battle.perRound.map((entry) => ({
    seed: battle.seed,
    result: battle.result,
    totalRounds: battle.rounds,
    team: battle.team.join('>'),
    round: entry.round,
    damageToBoss: entry.damageToBoss,
    damageToPlayers: entry.damageToPlayers,
    playerNetHpLoss: entry.playerNetHpLoss,
    netDamageTrade: entry.netDamageTrade,
    effectiveHealing: entry.effectiveHealing,
    effectiveShield: entry.effectiveShield,
    shieldGranted: entry.shieldGranted,
    playerSkills: entry.playerSkills.map((skill) => `${skill.actorId}:${skill.skillId}`).join('|'),
    bossSkills: entry.bossSkills.map((skill) => `${skill.skillId}${skill.telegraph ? '[预告]' : ''}:${skill.power}`).join('|'),
    defeatedUnits: entry.defeatedUnits.map((unit) => `${unit.side}:${unit.unitId}`).join('|')
  })));
}

function rangeSampleRows(battles) {
  return battles.map((battle) => ({
    seed: battle.seed,
    result: battle.result,
    rounds: battle.rounds,
    team: battle.team.join('>'),
    repeatedSkillActions: battle.repeatedSkillActions,
    totalSkillActions: sumValues(battle.skillUses),
    repeatedSkillActionRate: ratio(battle.repeatedSkillActions, sumValues(battle.skillUses)),
    maxSkillStreak: battle.maxSkillStreak,
    primarySkillLoop: topEntries(battle.skillUses, 5).map(([skillId, uses]) => `${skillId}:${uses}`).join('|')
  }));
}

function rangeBossCycleRows(battles) {
  return battles.flatMap((battle) => {
    let actionIndex = 0;
    return battle.perRound.flatMap((entry) => entry.bossSkills.map((skill) => ({
      seed: battle.seed,
      result: battle.result,
      totalRounds: battle.rounds,
      team: battle.team.join('>'),
      actionIndex: ++actionIndex,
      round: entry.round,
      skillId: skill.skillId,
      source: skill.source,
      telegraph: skill.telegraph,
      power: skill.power,
      targetIds: skill.targetIds.join('|')
    })));
  });
}

function flattenMageTeam(team) {
  return {
    teamId: team.teamId,
    team: team.team.join('>'),
    samples: team.samples,
    wins: team.wins,
    losses: team.losses,
    winRate: team.winRate,
    winRateWilson95Low: team.winRateWilson95.low,
    winRateWilson95High: team.winRateWilson95.high,
    averageRounds: team.averageRounds,
    medianRounds: team.medianRounds,
    p90Rounds: team.p90Rounds,
    reachedSecondAmplification: team.reachedSecondAmplification,
    firstCasualtyTiers: formatCountMap(team.casualtyTiers),
    attacksBeforeSecondAmplification: team.beforeSecondAmplification.attacks,
    skillActionsBeforeSecondAmplification: team.beforeSecondAmplification.skillActions,
    attackShareBeforeSecondAmplification: team.beforeSecondAmplification.attackShare,
    attacksAfterSecondAmplification: team.afterSecondAmplification.attacks,
    skillActionsAfterSecondAmplification: team.afterSecondAmplification.skillActions,
    attackShareAfterSecondAmplification: team.afterSecondAmplification.attackShare
  };
}

function renderRangeMarkdown(report, metadata) {
  const topSkills = topEntries(report.skillUses, 10);
  const topLineups = topEntries(report.lineups, 10);
  const topSequences = topEntries(report.bossSequences, 10);
  const windows = report.windows;
  return `# 灰羽猎王超过20回合样本专项诊断

- 样本基数：${metadata.runs}
- Seed：${metadata.seed}
- 策略：balanced-v3
- 参数：仓库现行正式配置，未应用 RANGE-A / RANGE-B
- 超过20回合：${report.sampleCount}/${report.allSampleCount}（${percent(report.sampleRate)}）
- 长尾胜负：${report.wins}胜 / ${report.losses}负
- 长尾平均 / 中位 / P90：${report.averageRounds} / ${report.medianRounds} / ${report.p90Rounds} 回合

## 拖延来源判断

长尾主因是**玩家输出轴塌缩并转入高治疗/高护盾循环**，不是灰羽某一种技能异常高频：

- 长尾每回合对 Boss 伤害 ${report.longTailProfile.averageDamageToBossPerRound}，短样本为 ${report.shortProfile.averageDamageToBossPerRound}，下降 ${percent(1 - report.longTailProfile.averageDamageToBossPerRound / report.shortProfile.averageDamageToBossPerRound)}。
- 长尾每回合有效治疗 ${report.longTailProfile.averageEffectiveHealingPerRound}，短样本为 ${report.shortProfile.averageEffectiveHealingPerRound}；有效护盾 ${report.longTailProfile.averageEffectiveShieldPerRound}，短样本为 ${report.shortProfile.averageEffectiveShieldPerRound}。
- 同一精灵连续重复同一技能的比例由短样本 ${percent(report.shortProfile.repeatedSkillActionRate)} 上升到长尾 ${percent(report.longTailProfile.repeatedSkillActionRate)}。
- 灰羽四种行为在长尾与短样本中的占比接近，未发现单一 Boss 行为抽取偏斜足以解释长尾。

| 长尾阶段 | 有效战斗回合样本 | 对Boss伤害 | 玩家掉血 | 玩家净HP损失 | 有效治疗 | 有效护盾 | 授予护盾 | 玩家技能行动 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1-10回合 | ${windows.rounds1To10.battleRounds} | ${windows.rounds1To10.damageToBoss} | ${windows.rounds1To10.damageToPlayers} | ${windows.rounds1To10.playerNetHpLoss} | ${windows.rounds1To10.effectiveHealing} | ${windows.rounds1To10.effectiveShield} | ${windows.rounds1To10.shieldGranted} | ${windows.rounds1To10.playerSkillActions} |
| 11-20回合 | ${windows.rounds11To20.battleRounds} | ${windows.rounds11To20.damageToBoss} | ${windows.rounds11To20.damageToPlayers} | ${windows.rounds11To20.playerNetHpLoss} | ${windows.rounds11To20.effectiveHealing} | ${windows.rounds11To20.effectiveShield} | ${windows.rounds11To20.shieldGranted} | ${windows.rounds11To20.playerSkillActions} |
| 21回合后 | ${windows.rounds21Plus.battleRounds} | ${windows.rounds21Plus.damageToBoss} | ${windows.rounds21Plus.damageToPlayers} | ${windows.rounds21Plus.playerNetHpLoss} | ${windows.rounds21Plus.effectiveHealing} | ${windows.rounds21Plus.effectiveShield} | ${windows.rounds21Plus.shieldGranted} | ${windows.rounds21Plus.playerSkillActions} |

Boss技能占比（长尾）：${formatShareMap(report.longTailProfile.bossSkillShares)}

Boss技能占比（20回合内）：${formatShareMap(report.shortProfile.bossSkillShares)}

## 技能重复

- 玩家技能行动：${report.totalSkillActions}
- 与上一技能相同的连续行动：${report.repeatedSkillActions}（${percent(report.repeatedSkillActionRate)}）
- 单一技能最大连续次数：${report.maxSkillStreak}

| 技能ID | 使用次数 | 长尾技能占比 |
|---|---:|---:|
${topSkills.map(([id, count]) => `| ${id} | ${count} | ${percent(ratio(count, report.totalSkillActions))} |`).join('\n')}

## 阵容构成

| 精灵ID | 长尾入选率 | 20回合内入选率 | 差值 |
|---|---:|---:|---:|
${report.compositionComparison.map((row) => `| ${row.spiritId} | ${percent(row.longTailRate)} | ${percent(row.shortRate)} | ${signedPercent(row.lift)} |`).join('\n')}

| 完整阵容（前三首发） | 样本数 | 长尾样本占比 |
|---|---:|---:|
${topLineups.map(([team, count]) => `| ${team} | ${count} | ${percent(ratio(count, report.sampleCount))} |`).join('\n')}

- 首发出现次数：${formatCountMap(report.starters)}
- 后备出现次数：${formatCountMap(report.benches)}

## Boss技能循环

| 完整技能序列 | 样本数 |
|---|---:|
${topSequences.map(([sequence, count]) => `| ${sequence} | ${count} |`).join('\n')}

## 文件口径

- \`range-over20-rounds.csv\`：每个长尾样本、每回合的净伤害、有效治疗、有效护盾、双方技能和减员。
- \`range-over20-sample-summary.csv\`：每个长尾样本的技能重复率、最大连用和主要技能循环。
- \`range-over20-round-aggregate.csv\`：按回合聚合均值，并标注该回合仍存在的样本数。
- \`range-over20-boss-cycle.csv\`：按 Seed 和行动序号展开 Boss 的完整技能循环。
- \`range-over20-samples.json\`：保留完整长尾样本事件，供回查单个 Seed。
- \`netDamageTrade = 对Boss伤害 - 玩家承受HP伤害\`。
- \`playerNetHpLoss = 玩家承受HP伤害 - 有效治疗\`；有效护盾单列为实际吸收伤害，不与HP损失重复相减。
`;
}

function renderMageMarkdown(teams, metadata) {
  return `# 炽印法主四套固定阵容专项诊断

- 每套阵容样本：${metadata.runs}
- Seed：${metadata.seed}
- 策略：balanced-v3
- 参数：仓库现行正式配置

## 胜率与节奏

| 阵容 | 构成（前三首发） | 胜/负 | 胜率 | 95% Wilson区间 | 平均回合 | 中位 | P90 |
|---|---|---:|---:|---:|---:|---:|---:|
${teams.map((team) => `| ${team.teamId} | ${team.team.join('>')} | ${team.wins}/${team.losses} | ${percent(team.winRate)} | ${percent(team.winRateWilson95.low)}-${percent(team.winRateWilson95.high)} | ${team.averageRounds} | ${team.medianRounds} | ${team.p90Rounds} |`).join('\n')}

## 首次减员强化档位

| 阵容 | 未强化（威力80） | 强化1次（160） | 强化2次（240） | 更高档 | 无减员 |
|---|---:|---:|---:|---:|---:|
${teams.map((team) => `| ${team.teamId} | ${team.casualtyTiers['0次强化（威力80）'] ?? 0} | ${team.casualtyTiers['1次强化（威力160）'] ?? 0} | ${team.casualtyTiers['2次强化（威力240）'] ?? 0} | ${sumHigherCasualtyTiers(team.casualtyTiers)} | ${team.casualtyTiers['无减员'] ?? 0} |`).join('\n')}

## 第二次强化前后攻击占比

| 阵容 | 到达第二次强化 | 强化前攻击/技能行动 | 强化前占比 | 强化后攻击/技能行动 | 强化后占比 | 变化 |
|---|---:|---:|---:|---:|---:|---:|
${teams.map((team) => `| ${team.teamId} | ${team.reachedSecondAmplification}/${team.samples} | ${team.beforeSecondAmplification.attacks}/${team.beforeSecondAmplification.skillActions} | ${percent(team.beforeSecondAmplification.attackShare)} | ${team.afterSecondAmplification.attacks}/${team.afterSecondAmplification.skillActions} | ${percent(team.afterSecondAmplification.attackShare)} | ${signedPercent(team.afterSecondAmplification.attackShare - team.beforeSecondAmplification.attackShare)} |`).join('\n')}

说明：攻击占比沿用现有体验雷达口径，只统计已确认的玩家技能行动；换宠、换排不进入分母。第二次强化行动本身完成后，后续玩家技能计入“强化后”。
`;
}

function casualtyTierLabel(power) {
  if (power === null || power === undefined) return '无减员';
  const count = Math.max(0, Math.round((power - 80) / 80));
  return `${count}次强化（威力${power}）`;
}

function sumHigherCasualtyTiers(tiers) {
  return Object.entries(tiers)
    .filter(([label]) => /^([3-9]|\d{2,})次强化/.test(label))
    .reduce((sum, [, count]) => sum + count, 0);
}

function mergeCountMaps(maps) {
  const merged = {};
  maps.forEach((map) => Object.entries(map ?? {}).forEach(([key, count]) => {
    merged[key] = (merged[key] ?? 0) + count;
  }));
  return merged;
}

function countBy(items, keyFor) {
  const counts = {};
  items.forEach((item) => {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
  });
  return counts;
}

function topEntries(map, limit) {
  return Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

function formatCountMap(map) {
  return topEntries(map, Number.MAX_SAFE_INTEGER).map(([key, count]) => `${key}:${count}`).join(' | ');
}

function formatShareMap(map) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([key, share]) => `${key}:${percent(share)}`).join(' | ');
}

function sumValues(map) {
  return Object.values(map ?? {}).reduce((sum, value) => sum + value, 0);
}

function average(values) {
  return values.length > 0 ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function percentile(values, point) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * point;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return rounded(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? rounded(numerator / denominator) : 0;
}

function rounded(value) {
  return Math.round(value * 10000) / 10000;
}

function wilsonInterval(successes, total) {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return { low: rounded(Math.max(0, center - margin)), high: rounded(Math.min(1, center + margin)) };
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function signedPercent(value) {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}个百分点`;
}

function renderCsv(rows) {
  if (rows.length === 0) return '\uFEFF';
  const columns = Object.keys(rows[0]);
  return '\uFEFF' + [columns.join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\n') + '\n';
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function spawnChecked(command, childArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, childArgs, { cwd: projectRoot, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${childArgs[0]} exited with ${code}`)));
  });
}
