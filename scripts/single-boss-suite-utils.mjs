import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export async function runSingleBoss({
  boss,
  runs,
  seed,
  policy,
  playerTendency = 'balanced',
  roster = 'random',
  team,
  tuning,
  outputDir,
  debugDecisions = false,
  diagnosticTrace = false
}) {
  await mkdir(path.resolve(projectRoot, outputDir), { recursive: true });
  const args = [
    'scripts/simulate-single-boss-v2.mjs',
    `--boss=${boss}`,
    `--runs=${runs}`,
    `--seed=${seed}`,
    `--policy=${policy}`,
    `--playerTendency=${playerTendency}`,
    `--roster=${roster}`,
    `--output=../${normalize(outputDir)}/raw-summary.json`,
    `--artifactDir=../${normalize(outputDir)}/`,
    `--debug-decisions=${debugDecisions}`
  ];
  if (diagnosticTrace) {
    args.push('--diagnostic-trace=true');
    args.push(`--diagnosticTraceOutput=../${normalize(outputDir)}/diagnostic-trace.json`);
  }
  if (team) args.push(`--team=${team}`);
  if (tuning) args.push(`--tuning=${tuning}`);
  await spawnChecked(process.execPath, args);
  return readReport(outputDir);
}

export async function readReport(outputDir) {
  return JSON.parse(await readFile(path.resolve(projectRoot, outputDir, 'experience-summary.json'), 'utf8'));
}

export async function writeReport(relativePath, content) {
  const destination = path.resolve(projectRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, 'utf8');
}

export function reportRow(label, report) {
  const stage = report.stages['1'];
  const boss = Object.values(report.bosses)[0];
  return {
    label,
    winRate: report.summary.clearRate,
    averageRounds: stage.averageRounds,
    medianRounds: stage.medianRounds,
    p90Rounds: stage.p90Rounds,
    p95Rounds: stage.p95Rounds,
    over15: stage.over15RoundsRate,
    over20: stage.over20RoundsRate,
    coreMechanic: boss?.coreMechanicSeenRate,
    mechanics: boss?.mechanics ?? {},
    report
  };
}

export function percent(value) {
  return value === null || value === undefined ? '-' : `${(value * 100).toFixed(2)}%`;
}

export function value(number) {
  return number === null || number === undefined ? '-' : number;
}

export function behaviorShares(report) {
  const totals = { attack: 0, protect: 0, recover: 0, energy: 0 };
  Object.values(report.skills).forEach((metric) => {
    const skill = metric.skillId;
    const behavior = behaviorBySkillId(skill);
    if (behavior) totals[behavior] += metric.uses;
  });
  const all = Object.values(totals).reduce((sum, count) => sum + count, 0);
  return Object.fromEntries(Object.entries(totals).map(([key, count]) => [key, all > 0 ? count / all : 0]));
}

function behaviorBySkillId(skillId) {
  const explicit = {
    'M01-S1': 'energy', 'M01-S2': 'attack', 'M01-S3': 'attack',
    'M02-S1': 'attack', 'M02-S2': 'attack', 'M02-S3': 'attack',
    'M03-S1': 'attack', 'M03-S2': 'recover', 'M03-S3': 'attack',
    'M04-S1': 'attack', 'M04-S2': 'attack', 'M04-S3': 'protect',
    'M05-S1': 'protect', 'M05-S2': 'recover', 'M05-S3': 'protect',
    'M06-S1': 'energy', 'M06-S2': 'protect', 'M06-S3': 'protect',
    'M07-S1': 'recover', 'M07-S2': 'attack', 'M07-S3': 'recover',
    'M08-S1': 'recover', 'M08-S2': 'recover', 'M08-S3': 'recover',
    'M09-S1': 'energy', 'M09-S2': 'attack', 'M09-S3': 'attack',
    'M10-S1': 'energy', 'M10-S2': 'attack', 'M10-S3': 'protect'
  };
  return explicit[skillId];
}

function spawnChecked(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${args[0]} exited with ${code}`)));
  });
}

function normalize(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}
