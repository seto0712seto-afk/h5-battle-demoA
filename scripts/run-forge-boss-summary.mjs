import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildForgeV2, renderForgeV2 } from './boss-report/forge-v2.mjs';
import { runSingleBoss } from './single-boss-suite-utils.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const args = parseArgs();
const outputRoot = args.outputDir ?? 'validation-artifacts/single-boss-v2/forge';
const seed = Number(args.seed ?? 2026073001);
const aiSeed = Number(args.aiSeed ?? 2026073002);
const reuse = args.reuse === 'true';
const groups = [
  group('RANDOM', '随机阵容', Number(args.randomRuns ?? 1400), 'random', 'balanced-v3', seed),
  group('TEAM-BALANCED', '标准均衡队', Number(args.balancedRuns ?? 600), 'fixed', 'balanced-v3', seed),
  group('TEAM-OFFENSE', '高输出队', Number(args.offenseRuns ?? 600), 'fixed', 'balanced-v3', seed),
  group('TEAM-DEFENSE', '高防护队', Number(args.defenseRuns ?? 800), 'fixed', 'balanced-v3', seed),
  group('TEAM-LOW-MANA', '低资源队', Number(args.lowManaRuns ?? 600), 'fixed', 'balanced-v3', seed)
];
const aiGroups = [
  group('AI-RANDOM-FULL', '随机阵容/full', Number(args.aiRandomFullRuns ?? 300), 'random', 'balanced-v3', aiSeed),
  group('AI-RANDOM-NEUTRAL', '随机阵容/neutral', Number(args.aiRandomNeutralRuns ?? 300), 'random', 'balanced-v3-neutral', aiSeed),
  group('AI-DEFENSE-FULL', '高防护队/full', Number(args.aiDefenseFullRuns ?? 200), 'fixed', 'balanced-v3', aiSeed, 'TEAM-DEFENSE'),
  group('AI-DEFENSE-NEUTRAL', '高防护队/neutral', Number(args.aiDefenseNeutralRuns ?? 200), 'fixed', 'balanced-v3-neutral', aiSeed, 'TEAM-DEFENSE')
];

for (const current of [...groups, ...aiGroups]) {
  const runDirectory = `${outputRoot}/runs/${current.id}`;
  const tracePath = path.resolve(projectRoot, runDirectory, 'diagnostic-trace.json');
  if (!reuse || !await exists(tracePath)) {
    await runSingleBoss({
      boss: 'FORGE_BOSS_WARRIOR',
      runs: current.runs,
      seed: current.seed,
      policy: current.policy,
      roster: current.roster,
      team: current.roster === 'fixed' ? current.teamId : undefined,
      outputDir: runDirectory,
      diagnosticTrace: true
    });
  }
  current.traces = JSON.parse(await readFile(tracePath, 'utf8'));
  if (current.traces.length !== current.runs) {
    throw new Error(`${current.id} expected ${current.runs} traces, received ${current.traces.length}.`);
  }
}

const thresholdConfig = JSON.parse(await readFile(path.resolve(projectRoot, 'config/boss-report-thresholds.json'), 'utf8'));
const analysis = buildForgeV2(groups, aiGroups, thresholdConfig.forge);
const report = renderForgeV2(analysis, {
  date: new Date().toISOString().slice(0, 10),
  seed,
  aiSeed,
  thresholds: thresholdConfig.forge
});
const reportPath = path.resolve(projectRoot, outputRoot, 'forge-final-summary.md');
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, report, 'utf8');
process.stdout.write(`FORGE_REPORT=${reportPath}\n`);

function group(id, label, runs, roster, policy, seedValue, teamId = id) {
  if (!Number.isInteger(runs) || runs <= 0) throw new Error(`${id} runs must be a positive integer.`);
  return { id, label, runs, roster, policy, seed: seedValue, teamId, traces: [] };
}

async function exists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseArgs() {
  return Object.fromEntries(process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
    return [key, value];
  }));
}
