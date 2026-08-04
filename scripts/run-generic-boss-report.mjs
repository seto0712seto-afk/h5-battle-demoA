import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeGenericBoss, validateBossMechanicConfig } from './boss-report/generic-engine.mjs';
import { renderGenericBossReport } from './boss-report/generic-renderer.mjs';
import { runSingleBoss } from './single-boss-suite-utils.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const args = parseArgs();
const configPath = path.resolve(projectRoot, args.config ?? 'config/boss-mechanics.json');
const configRoot = JSON.parse(await readFile(configPath, 'utf8'));
const bossId = args.boss ?? args.bossId;
if (!bossId) throw new Error('Generic Boss report requires --boss=<bossId>.');
const bossConfig = configRoot.bosses[bossId];
if (!bossConfig) throw new Error(`Boss mechanism config not found: ${bossId}`);
const configIssues = validateBossMechanicConfig(bossConfig);
if (configIssues.length) throw new Error(`Invalid Boss mechanism config: ${configIssues.join(', ')}`);

const outputRoot = args.outputDir ?? `validation-artifacts/generic-boss/${bossId}`;
const reuseFrom = args.reuseFrom;
const seed = Number(args.seed ?? 2026073001);
const aiSeed = Number(args.aiSeed ?? 2026073002);
const tendencySeed = Number(args.tendencySeed ?? 2026073003);
const mainGroups = [
  group('RANDOM', '随机阵容', Number(args.randomRuns ?? 1400), 'random', 'balanced-v3', seed),
  group('TEAM-BALANCED', '标准均衡队', Number(args.balancedRuns ?? 600), 'fixed', 'balanced-v3', seed),
  group('TEAM-OFFENSE', '高输出队', Number(args.offenseRuns ?? 600), 'fixed', 'balanced-v3', seed),
  group('TEAM-DEFENSE', '高防护队', Number(args.defenseRuns ?? 800), 'fixed', 'balanced-v3', seed),
  group('TEAM-LOW-MANA', '低资源队', Number(args.lowManaRuns ?? 600), 'fixed', 'balanced-v3', seed)
];
const aiGroups = [
  group('AI-RANDOM-FULL', '随机阵容/full', Number(args.aiRandomFullRuns ?? 300), 'random', 'balanced-v3', aiSeed, undefined, 'random', 'full'),
  group('AI-RANDOM-NEUTRAL', '随机阵容/neutral', Number(args.aiRandomNeutralRuns ?? 300), 'random', 'balanced-v3-neutral', aiSeed, undefined, 'random', 'neutral'),
  group('AI-DEFENSE-FULL', '高防护队/full', Number(args.aiDefenseFullRuns ?? 200), 'fixed', 'balanced-v3', aiSeed, 'TEAM-DEFENSE', 'defense', 'full'),
  group('AI-DEFENSE-NEUTRAL', '高防护队/neutral', Number(args.aiDefenseNeutralRuns ?? 200), 'fixed', 'balanced-v3-neutral', aiSeed, 'TEAM-DEFENSE', 'defense', 'neutral')
];
const tendencyRuns = Number(args.tendencyRuns ?? 0);
const tendencySpecs = [
  ['TENDENCY-BALANCED', '均衡型玩家', Number(args.balancedTendencyRuns ?? tendencyRuns), 'balanced'],
  ['TENDENCY-OFFENSE', '进攻型玩家', Number(args.offenseTendencyRuns ?? tendencyRuns), 'offense'],
  ['TENDENCY-DEFENSE', '防守型玩家', Number(args.defenseTendencyRuns ?? tendencyRuns), 'defense']
];
const tendencyGroups = tendencySpecs
  .filter(([, , runs]) => runs > 0)
  .map(([id, label, runs, playerTendency]) => group(id, label, runs, 'random', 'balanced-v3', tendencySeed, undefined, null, null, playerTendency));
for (const cohort of bossConfig.customCohorts ?? []) {
  const target = cohort.scope === 'ai' ? aiGroups : mainGroups;
  target.push(group(
    cohort.id,
    cohort.label ?? cohort.id,
    Number(args[`${cohort.id}Runs`] ?? cohort.runs),
    cohort.roster,
    cohort.policy,
    (cohort.scope === 'ai' ? aiSeed : seed) + (cohort.seedOffset ?? 0),
    cohort.teamId,
    cohort.pairKey ?? null,
    cohort.policyRole ?? null
  ));
}

for (const current of [...mainGroups, ...aiGroups, ...tendencyGroups]) {
  const tracePath = reuseFrom
    ? path.resolve(projectRoot, reuseFrom, 'runs', current.id, 'diagnostic-trace.json')
    : path.resolve(projectRoot, outputRoot, 'runs', current.id, 'diagnostic-trace.json');
  if (!reuseFrom) {
    await runSingleBoss({
      boss: bossId,
      runs: current.runs,
      seed: current.seed,
      policy: current.policy,
      playerTendency: current.playerTendency,
      roster: current.roster,
      team: current.roster === 'fixed' ? current.teamId : undefined,
      outputDir: `${outputRoot}/runs/${current.id}`,
      diagnosticTrace: true
    });
  }
  current.traces = JSON.parse(await readFile(tracePath, 'utf8'));
  if (current.traces.length !== current.runs) {
    throw new Error(`${current.id} expected ${current.runs} traces, received ${current.traces.length}. Adjust run arguments when reusing a different sample set.`);
  }
}

const analysis = analyzeGenericBoss({ bossConfig, defaults: configRoot.defaults, mainGroups, aiGroups, tendencyGroups });
const report = renderGenericBossReport(analysis, { date: new Date().toISOString().slice(0, 10) });
const reportPath = path.resolve(projectRoot, outputRoot, 'generic-boss-report.md');
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, report, 'utf8');
process.stdout.write(`GENERIC_BOSS_REPORT=${reportPath}\n`);
process.stdout.write(`AUDIT=${analysis.audit.passed ? 'PASS' : 'FAIL'}\n`);

function group(id, label, runs, roster, policy, seedValue, teamId = id, pairKey = null, policyRole = null, playerTendency = 'balanced') {
  if (!Number.isInteger(runs) || runs <= 0) throw new Error(`${id} runs must be a positive integer.`);
  return { id, label, runs, roster, policy, playerTendency, seed: seedValue, teamId, pairKey, policyRole, traces: [] };
}

function parseArgs() {
  return Object.fromEntries(process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
    return [key, value];
  }));
}
