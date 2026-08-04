import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeGenericBoss } from './boss-report/generic-engine.mjs';
import { analyzeBossReportV2 } from './boss-report-v2/engine.mjs';
import { loadExperimentRegistry } from './boss-report-v2/experiment-registry.mjs';
import { loadMechanicDsl } from './boss-report-v2/mechanic-dsl.mjs';
import { loadMetricRegistry } from './boss-report-v2/metric-registry.mjs';
import { buildV2ReportArtifacts } from './boss-report-v2/report-renderer.mjs';
import { loadCombatRuntime } from './boss-report-v2/runtime-loader.mjs';
import { runSingleBoss } from './single-boss-suite-utils.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((argument) => { const [key, value = 'true'] = argument.replace(/^--/, '').split('='); return [key, value]; }));
const runs = Number(args.runs ?? 10);
const seed = Number(args.seed ?? 2026073040);
const outputRoot = args.outputDir ?? 'validation-artifacts/boss-report-v2-regression';
const bosses = ['FORGE_BOSS_WARRIOR', 'RANGE_BOSS_SHOOTER', 'MAGE_BOSS'];
const [metricRegistry, experimentRegistry, diagnosticsConfig, v1Config] = await Promise.all([
  loadMetricRegistry(path.join(root, 'config/metrics-v2.json')),
  loadExperimentRegistry(path.join(root, 'config/experiments-v2.json')),
  readJson(path.join(root, 'config/diagnostics-v2.json')),
  readJson(path.join(root, 'config/boss-mechanics.json'))
]);
const [mechanicDsl, runtime] = await Promise.all([
  loadMechanicDsl(path.join(root, 'config/boss-mechanics-v2.json'), metricRegistry),
  loadCombatRuntime(root, path.join(root, 'config/combat-metadata-v2.json'))
]);

const rows = [];
for (let index = 0; index < bosses.length; index += 1) {
  const bossId = bosses[index];
  const destination = `${outputRoot}/${bossId}`;
  const group = { id: 'RANDOM', label: '随机阵容', runs, roster: 'random', policy: 'balanced-v3', playerTendency: 'balanced', seed: seed + index * 100000, traces: [] };
  await runSingleBoss({ boss: bossId, runs, seed: group.seed, policy: group.policy, roster: group.roster, outputDir: `${destination}/runs/RANDOM`, diagnosticTrace: true });
  group.traces = await readJson(path.join(root, destination, 'runs/RANDOM/diagnostic-trace.json'));
  const v2 = analyzeBossReportV2({ bossId, groups: [group], metadataRegistry: runtime.metadataRegistry, metricRegistry, mechanicDsl, diagnosticsConfig, experimentRegistry });
  const v1 = analyzeGenericBoss({ bossConfig: v1Config.bosses[bossId], defaults: v1Config.defaults, mainGroups: [group] });
  const artifacts = buildV2ReportArtifacts(v2);
  const folder = path.join(root, destination);
  await mkdir(folder, { recursive: true });
  await Promise.all([
    writeFile(path.join(folder, 'report.md'), artifacts.reportMarkdown, 'utf8'),
    writeFile(path.join(folder, 'report.json'), artifacts.reportJson, 'utf8'),
    writeFile(path.join(folder, 'report-debug.md'), artifacts.debugMarkdown, 'utf8'),
    writeFile(path.join(folder, 'representative-seeds.json'), artifacts.seedsJson, 'utf8')
  ]);
  const v1Result = v1.random.result;
  const v2Result = v2.analysis.overall;
  const metricConsistent = near(v1Result.winRate, v2Result.winRate) && near(v1Result.averageRounds, v2Result.averageRounds) && near(v1Result.longTailRate, v2Result.over20Rate);
  rows.push({
    bossId, bossName: v2.bossMetadata.displayName, samples: runs,
    v1Audit: v1.audit.passed, v2Quality: v2.quality.passed,
    v1WinRate: v1Result.winRate, v2WinRate: v2Result.winRate,
    v1AverageRounds: v1Result.averageRounds, v2AverageRounds: v2Result.averageRounds,
    v1LongTailRate: v1Result.longTailRate, v2LongTailRate: v2Result.over20Rate,
    strengthDirectionV1: strength(v1Result.winRate, v1Config.defaults),
    strengthDirectionV2: strength(v2Result.winRate, v1Config.defaults),
    metricConsistent,
    mechanismWindowCountsV1: Object.fromEntries(v1.mechanics.map((item) => [item.config.mechanicId, item.triggerCount])),
    mechanismWindowCountsV2: Object.fromEntries(v2.analysis.mechanics.map((item) => [item.mechanicId, item.windows]))
  });
}

const passed = rows.every((row) => row.v1Audit && row.v2Quality && row.metricConsistent && row.strengthDirectionV1 === row.strengthDirectionV2);
const destination = path.join(root, outputRoot);
await mkdir(destination, { recursive: true });
await writeFile(path.join(destination, 'regression.json'), JSON.stringify({ schemaVersion: '2.0.0', runsPerBoss: runs, passed, rows }, null, 2), 'utf8');
await writeFile(path.join(destination, 'regression.md'), render(rows, passed), 'utf8');
process.stdout.write(`V2_REGRESSION=${passed ? 'PASS' : 'FAIL'}\nREPORT=${path.join(destination, 'regression.md')}\n`);
if (!passed) process.exitCode = 1;

function strength(rate, defaults) { return rate > defaults.healthyWinRateMax ? '偏易' : rate < defaults.healthyWinRateMin ? '偏难' : '候选健康'; }
function near(left, right) { return Math.abs(Number(left) - Number(right)) < 1e-9; }
function pct(value) { return `${(Number(value) * 100).toFixed(2)}%`; }
function render(values, passed) {
  return [
    '# 通用战斗诊断与因果分析系统 V2｜三 Boss 工程回归', '',
    `- 结论：${passed ? '通过' : '失败'}`,
    `- 每个 Boss：${runs} 场工程样本`,
    '- 用途：验证事件、机制窗口、门禁和 V1/V2 基础结论一致性，不用于平衡裁定。', '',
    '| Boss | V1审计 | V2门禁 | V1/V2胜率 | V1/V2均回合 | V1/V2长尾 | 强度方向 | 结论冲突 |',
    '|---|---|---|---:|---:|---:|---|---|',
    ...values.map((row) => `| ${row.bossName} | ${row.v1Audit ? '通过' : '失败'} | ${row.v2Quality ? '通过' : '失败'} | ${pct(row.v1WinRate)} / ${pct(row.v2WinRate)} | ${row.v1AverageRounds.toFixed(2)} / ${row.v2AverageRounds.toFixed(2)} | ${pct(row.v1LongTailRate)} / ${pct(row.v2LongTailRate)} | ${row.strengthDirectionV1} / ${row.strengthDirectionV2} | ${row.metricConsistent && row.strengthDirectionV1 === row.strengthDirectionV2 ? '无' : '有'} |`),
    '', '## 机制窗口差异',
    ...values.map((row) => `- ${row.bossName}：V1 ${JSON.stringify(row.mechanismWindowCountsV1)}；V2 ${JSON.stringify(row.mechanismWindowCountsV2)}。V2 数量差异用于反映更严格的窗口边界，不直接视为设计结论冲突。`),
    '', '## 已知边界',
    '- 工程样本量小，只能确认管线一致性。',
    '- V2 的匹配基线、重叠归因和真实变化点是新增诊断，不要求与 V1 数值相同。',
    '- 自动策略不能替代真人体验。', ''
  ].join('\n');
}
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
