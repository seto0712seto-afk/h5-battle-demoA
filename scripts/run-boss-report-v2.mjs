import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeBossReportV2, combineBossReportV2Batches, compactBatchResultForMerge } from './boss-report-v2/engine.mjs';
import { loadExperimentRegistry, pairedExperimentComparison } from './boss-report-v2/experiment-registry.mjs';
import { loadMechanicDsl } from './boss-report-v2/mechanic-dsl.mjs';
import { loadMetricRegistry } from './boss-report-v2/metric-registry.mjs';
import { buildV2ReportArtifacts } from './boss-report-v2/report-renderer.mjs';
import { loadCombatRuntime } from './boss-report-v2/runtime-loader.mjs';
import { buildEvidenceConclusions } from './boss-report-v2/evidence-engine.mjs';
import { runSingleBoss } from './single-boss-suite-utils.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const args = parseArgs();
const bossId = args.boss ?? args.bossId;
if (!bossId) throw new Error('V2 Boss report requires --boss=<bossId>.');
const outputRoot = args.outputDir ?? `validation-artifacts/boss-report-v2/${bossId}`;
const reuseFrom = args.reuseFrom;
const seed = Number(args.seed ?? 2026073001);
const runs = Number(args.runs ?? args.randomRuns ?? 1400);
const experimentId = args.experimentId ?? 'CURRENT-BASELINE';
const batchSize = Math.max(1, Number(args.batchSize ?? (runs > 1000 ? 200 : runs)));

const paths = {
  metadata: path.resolve(projectRoot, args.metadata ?? 'config/combat-metadata-v2.json'),
  metrics: path.resolve(projectRoot, args.metrics ?? 'config/metrics-v2.json'),
  mechanics: path.resolve(projectRoot, args.mechanics ?? 'config/boss-mechanics-v2.json'),
  diagnostics: path.resolve(projectRoot, args.diagnostics ?? 'config/diagnostics-v2.json'),
  experiments: path.resolve(projectRoot, args.experiments ?? 'config/experiments-v2.json')
};
const metricRegistry = await loadMetricRegistry(paths.metrics);
const [mechanicDsl, experimentRegistry, diagnosticsConfig, runtime] = await Promise.all([
  loadMechanicDsl(paths.mechanics, metricRegistry),
  loadExperimentRegistry(paths.experiments),
  readJson(paths.diagnostics),
  loadCombatRuntime(projectRoot, paths.metadata)
]);
if (!runtime.monsters[bossId]) throw new Error(`Unknown Boss: ${bossId}`);

const groups = buildGroups(args, runs, seed);
const sharedAnalysisInput = {
  bossId, groups,
  metadataRegistry: runtime.metadataRegistry,
  metricRegistry, mechanicDsl, diagnosticsConfig, experimentRegistry,
  experimentId
};
let result;
if (groups.some((group) => group.runs > batchSize)) {
  const batches = [];
  for (const group of groups) {
    for (let offset = 0, batchIndex = 1; offset < group.runs; offset += batchSize, batchIndex += 1) {
      const count = Math.min(batchSize, group.runs - offset);
      const chunk = { ...group, runs: count, seed: (group.seed + Math.imul(offset, 7919)) >>> 0, traces: [] };
      const runRoot = `${outputRoot}/runs/${group.id}/batch-${String(batchIndex).padStart(4, '0')}`;
      const tracePath = reuseFrom
        ? path.resolve(projectRoot, reuseFrom, 'runs', group.id, `batch-${String(batchIndex).padStart(4, '0')}`, 'diagnostic-trace.json')
        : path.resolve(projectRoot, runRoot, 'diagnostic-trace.json');
      if (!reuseFrom) await simulateGroup(chunk, runRoot);
      chunk.traces = await readJson(tracePath);
      if (chunk.traces.length !== count) throw new Error(`${group.id} batch ${batchIndex}: expected ${count} traces, got ${chunk.traces.length}.`);
      const chunkResult = analyzeBossReportV2({ ...sharedAnalysisInput, groups: [chunk] });
      batches.push(compactBatchResultForMerge(chunkResult));
      process.stdout.write(`V2_BATCH=${group.id}:${batchIndex} BATTLES=${Math.min(offset + count, group.runs)}/${group.runs} QUALITY=${chunkResult.quality.passed ? 'PASS' : 'FAIL'}\n`);
    }
  }
  result = combineBossReportV2Batches({
    batches, bossId, metadataRegistry: runtime.metadataRegistry, metricRegistry,
    mechanicDsl, diagnosticsConfig, experimentRegistry, experimentId
  });
} else {
  for (const group of groups) {
    const runRoot = `${outputRoot}/runs/${group.id}`;
    const tracePath = reuseFrom
      ? path.resolve(projectRoot, reuseFrom, 'runs', group.id, 'diagnostic-trace.json')
      : path.resolve(projectRoot, runRoot, 'diagnostic-trace.json');
    if (!reuseFrom) await simulateGroup(group, runRoot);
    group.traces = await readJson(tracePath);
    if (group.traces.length !== group.runs) throw new Error(`${group.id}: expected ${group.runs} traces, got ${group.traces.length}.`);
  }
  result = analyzeBossReportV2(sharedAnalysisInput);
}
if (args.controlReport) {
  const control = await readJson(path.resolve(projectRoot, args.controlReport));
  const comparability = experimentRegistry.compareDefinitions(control.experiment.experimentId, experimentId, {
    control: { sampleCount: control.analysis.samples },
    variant: { sampleCount: result.analysis.samples }
  });
  const comparison = pairedExperimentComparison({
    controlBattles: control.battles,
    variantBattles: result.battles,
    comparability,
    longTailRound: diagnosticsConfig.longTailRound
  });
  result.experimentComparison = comparison;
  result.conclusions = buildEvidenceConclusions({
    analysis: result.analysis,
    quality: result.quality,
    experimentComparison: comparison,
    diagnosticsConfig,
    experiment: result.experiment
  });
}
const artifacts = buildV2ReportArtifacts(result);
const destination = path.resolve(projectRoot, outputRoot);
await mkdir(destination, { recursive: true });
await Promise.all([
  writeFile(path.join(destination, 'report.md'), artifacts.reportMarkdown, 'utf8'),
  writeFile(path.join(destination, 'report.json'), artifacts.reportJson, 'utf8'),
  writeFile(path.join(destination, 'report-debug.md'), artifacts.debugMarkdown, 'utf8'),
  writeFile(path.join(destination, 'representative-seeds.json'), artifacts.seedsJson, 'utf8')
]);
process.stdout.write(`BOSS_REPORT_V2=${path.join(destination, 'report.md')}\n`);
process.stdout.write(`QUALITY=${result.quality.passed ? 'PASS' : 'FAIL'}\n`);
process.stdout.write(`SAMPLES=${result.analysis.samples}\n`);

function buildGroups(values, randomRuns, baseSeed) {
  const policy = values.policy ?? 'balanced-v3';
  const specs = [
    group('RANDOM', '随机阵容', randomRuns, 'random', policy, baseSeed),
    group('TEAM-BALANCED', '标准均衡队', Number(values.balancedRuns ?? 0), 'fixed', policy, baseSeed + 100000, 'TEAM-BALANCED'),
    group('TEAM-OFFENSE', '高输出队', Number(values.offenseRuns ?? 0), 'fixed', policy, baseSeed + 200000, 'TEAM-OFFENSE'),
    group('TEAM-DEFENSE', '高防护队', Number(values.defenseRuns ?? 0), 'fixed', policy, baseSeed + 300000, 'TEAM-DEFENSE'),
    group('TEAM-LOW-MANA', '低资源队', Number(values.lowManaRuns ?? 0), 'fixed', policy, baseSeed + 400000, 'TEAM-LOW-MANA'),
    group('TENDENCY-OFFENSE', '进攻型玩家', Number(values.offenseTendencyRuns ?? 0), 'random', policy, baseSeed + 500000, undefined, 'offense'),
    group('TENDENCY-DEFENSE', '防守型玩家', Number(values.defenseTendencyRuns ?? 0), 'random', policy, baseSeed + 600000, undefined, 'defense')
  ];
  return specs.filter((item) => item.runs > 0);
}

function group(id, label, count, roster, policy, groupSeed, teamId, playerTendency = 'balanced') {
  return { id, label, runs: count, roster, policy, seed: groupSeed, teamId, playerTendency, traces: [] };
}
function parseArgs() { return Object.fromEntries(process.argv.slice(2).map((argument) => { const [key, value = 'true'] = argument.replace(/^--/, '').split('='); return [key, value]; })); }
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function simulateGroup(group, runRoot) {
  await runSingleBoss({
    boss: bossId, runs: group.runs, seed: group.seed, policy: group.policy,
    playerTendency: group.playerTendency, roster: group.roster,
    team: group.roster === 'fixed' ? group.teamId : undefined,
    outputDir: runRoot, diagnosticTrace: true, tuning: args.tuning
  });
}
