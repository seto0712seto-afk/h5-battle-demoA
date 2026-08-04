import { FIXED_TEAMS, RANGE_TUNINGS } from './single-boss-config.mjs';
import { behaviorShares, percent, reportRow, runSingleBoss, value, writeReport } from './single-boss-suite-utils.mjs';

const args = parseArgs();
const randomRuns = Number(args.runs ?? 1000);
const fixedRuns = Number(args.fixedRuns ?? 300);
const seed = Number(args.seed ?? 2026072901);
const root = args.outputDir ?? 'validation-artifacts/single-boss-v2/range-ab';
const randomRows = [];
const fixedRows = [];

for (const tuning of Object.keys(RANGE_TUNINGS)) {
  const randomReport = await runSingleBoss({
    boss: 'RANGE_BOSS_SHOOTER',
    runs: randomRuns,
    seed,
    policy: 'balanced-v3',
    tuning,
    outputDir: `${root}/${tuning}/RANDOM`
  });
  randomRows.push({ ...reportRow(tuning, randomReport), behaviors: behaviorShares(randomReport) });

  for (const team of Object.keys(FIXED_TEAMS)) {
    const report = await runSingleBoss({
      boss: 'RANGE_BOSS_SHOOTER',
      runs: fixedRuns,
      seed,
      policy: 'balanced-v3',
      roster: 'fixed',
      team,
      tuning,
      outputDir: `${root}/${tuning}/${team}`
    });
    fixedRows.push(reportRow(`${tuning} / ${team}`, report));
  }
}

const recommendation = recommend(randomRows);
const markdown = `# 灰羽猎王 A/B 对照

- 正式仓库基准：HP 2200 / 箭雨35 / 狙击60 / 贯射100。
- Control严格沿用仓库正式配置；A/B仅由测试参数注入。
- 随机阵容每组：${randomRuns}；固定阵容每组：${fixedRuns}；Seed：${seed}。

| 指标 | Control | A | B |
|---|---:|---:|---:|
${metricRow('玩家胜率', randomRows, (row) => percent(row.winRate))}
${metricRow('平均回合', randomRows, (row) => value(row.averageRounds))}
${metricRow('中位回合', randomRows, (row) => value(row.medianRounds))}
${metricRow('P90', randomRows, (row) => value(row.p90Rounds))}
${metricRow('P95', randomRows, (row) => value(row.p95Rounds))}
${metricRow('>15回合占比', randomRows, (row) => percent(row.over15))}
${metricRow('>20回合占比', randomRows, (row) => percent(row.over20))}
${metricRow('狙击击杀率', randomRows, (row) => percent(row.mechanics.snipeKillRate))}
${metricRow('贯射击杀率', randomRows, (row) => percent(row.mechanics.piercingShotKillRate))}
${metricRow('后排承伤占比', randomRows, (row) => percent(row.mechanics.backRowDamageShare))}
${metricRow('有效锁定响应率', randomRows, (row) => percent(row.mechanics.effectiveLockResponseRate))}
${metricRow('防护行为占比', randomRows, (row) => percent(row.behaviors.protect))}
${metricRow('回能行为占比', randomRows, (row) => percent(row.behaviors.energy))}

## 固定阵容

| 版本 / 队伍 | 胜率 | 平均回合 | P90 | >20回合 |
|---|---:|---:|---:|---:|
${fixedRows.map((row) => `| ${row.label} | ${percent(row.winRate)} | ${value(row.averageRounds)} | ${value(row.p90Rounds)} | ${percent(row.over20)} |`).join('\n')}

## 机械建议

- 推荐版本：${recommendation.version}
- 推荐理由：${recommendation.reason}
- 主要风险：自动策略只能作为配对实验代理，正式采用前仍需人工复核代表 Seed。
- 需要人工复核的代表 Seed：见各版本的 \`outlier-seeds.json\`。
`;

await writeReport(`${root}/range-ab-comparison.md`, markdown);

function metricRow(label, rows, format) {
  return `| ${label} | ${rows.map(format).join(' | ')} |`;
}

function recommend(rows) {
  const [, a, b] = rows;
  const inTarget = (row) => row.winRate >= 0.85 && row.winRate <= 0.9 && row.averageRounds >= 10 && row.averageRounds <= 12 && row.p90Rounds <= 17 && row.over20 <= 0.05;
  if (inTarget(a)) return { version: 'RANGE-A', reason: 'A已进入胜率与节奏参考区间，按任务书优先选择只缩短耐久的方案。' };
  if (inTarget(b)) return { version: 'RANGE-B（候选）', reason: 'A未同时满足压力与节奏区间，B更接近参考目标；仍需检查点杀是否出现无响应秒杀。' };
  return { version: '暂不自动裁定', reason: 'A与B均未同时满足参考区间，应保留实验数据并人工复核，而不是继续自动改数值。' };
}

function parseArgs() {
  return Object.fromEntries(process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
    return [key, value];
  }));
}
