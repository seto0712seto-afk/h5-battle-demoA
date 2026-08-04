import { SINGLE_BOSS_IDS } from './single-boss-config.mjs';
import { percent, reportRow, runSingleBoss, value, writeReport } from './single-boss-suite-utils.mjs';

const args = parseArgs();
const runs = Number(args.runs ?? 1000);
const seed = Number(args.seed ?? 2026072901);
const root = args.outputDir ?? 'validation-artifacts/single-boss-v2/policy-paired';
const rows = [];
const skillRows = [];

for (const policy of ['balanced-v2', 'balanced-v3']) {
  for (const boss of SINGLE_BOSS_IDS) {
    const outputDir = `${root}/${policy}/${boss}`;
    const report = await runSingleBoss({ boss, runs, seed, policy, outputDir, debugDecisions: policy === 'balanced-v3' });
    rows.push(reportRow(`${policy} / ${boss}`, report));
    ['M02-S1', 'M06-S1', 'M06-S2', 'M06-S3', 'M08-S2'].forEach((skillId) => {
      const metric = report.skills[skillId];
      skillRows.push({ policy, boss, skillId, uses: metric.uses, share: metric.useShareOfOwnerSkillActions });
    });
  }
}

const markdown = `# Boss Policy Paired Comparison

- Seed：${seed}
- 每组样本：${runs}
- 队伍与 Seed 在两个策略、三个 Boss 间复用。

| 组别 | 胜率 | 平均回合 | 中位 | P90 | P95 | >20回合 | 核心机制 |
|---|---:|---:|---:|---:|---:|---:|---:|
${rows.map((row) => `| ${row.label} | ${percent(row.winRate)} | ${value(row.averageRounds)} | ${value(row.medianRounds)} | ${value(row.p90Rounds)} | ${value(row.p95Rounds)} | ${percent(row.over20)} | ${percent(row.coreMechanic)} |`).join('\n')}

## 关键技能估值

| 策略 | Boss | 技能ID | 使用次数 | 占持有者技能行动 |
|---|---|---|---:|---:|
${skillRows.map((row) => `| ${row.policy} | ${row.boss} | ${row.skillId} | ${row.uses} | ${percent(row.share)} |`).join('\n')}
`;
await writeReport(`${root}/boss-policy-comparison.md`, markdown);

function parseArgs() {
  return Object.fromEntries(process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
    return [key, value];
  }));
}
