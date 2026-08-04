import { FIXED_TEAMS, SINGLE_BOSS_IDS } from './single-boss-config.mjs';
import { percent, reportRow, runSingleBoss, value, writeReport } from './single-boss-suite-utils.mjs';

const args = parseArgs();
const runs = Number(args.runs ?? 500);
const seed = Number(args.seed ?? 2026072901);
const root = args.outputDir ?? 'validation-artifacts/single-boss-v2/fixed-teams';
const rows = [];

for (const team of Object.keys(FIXED_TEAMS)) {
  for (const boss of SINGLE_BOSS_IDS) {
    const outputDir = `${root}/${team}/${boss}`;
    const report = await runSingleBoss({ boss, runs, seed, policy: 'balanced-v3', roster: 'fixed', team, outputDir });
    rows.push(reportRow(`${team} / ${boss}`, report));
  }
}

const markdown = `# Fixed Team Comparison

- Seed：${seed}
- 每组样本：${runs}
- 三个 Boss 使用完全相同的固定队伍与 Seed。

| 队伍 / Boss | 胜率 | 平均回合 | 中位 | P90 | P95 | >20回合 |
|---|---:|---:|---:|---:|---:|---:|
${rows.map((row) => `| ${row.label} | ${percent(row.winRate)} | ${value(row.averageRounds)} | ${value(row.medianRounds)} | ${value(row.p90Rounds)} | ${value(row.p95Rounds)} | ${percent(row.over20)} |`).join('\n')}
`;
await writeReport(`${root}/fixed-team-comparison.md`, markdown);

function parseArgs() {
  return Object.fromEntries(process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
    return [key, value];
  }));
}
