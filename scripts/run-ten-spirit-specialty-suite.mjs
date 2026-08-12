import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYER_TENDENCY_PROFILES } from './battle-policy.mjs';
import { FIXED_TEAMS, SINGLE_BOSS_IDS } from './single-boss-config.mjs';
import { projectRoot, runSingleBoss } from './single-boss-suite-utils.mjs';
import { buildTenSpiritSpecialtyReport } from './ten-spirit-specialty-report.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
  return [key, value];
}));
const runs = Math.max(1, Number(args.runs ?? 10000));
const seedBase = Number(args.seed ?? 2026081101) >>> 0;
const outputRoot = args.outputDir ?? `validation-artifacts/ten-spirit-specialty-${runs}-20260811`;
const outputDir = path.resolve(projectRoot, outputRoot);
const reuse = args.reuse === 'true';
const maxGroups = Math.max(0, Number(args.maxGroups ?? 0));
const policy = args.policy ?? 'balanced-v4-hunter-aware';
const bossConfig = JSON.parse(await readFile(path.join(projectRoot, 'config/boss-mechanics.json'), 'utf8'));
const bossNames = Object.fromEntries(Object.entries(bossConfig.bosses).map(([id, boss]) => [id, boss.bossName]));
const groups = buildGroups();
const selectedGroups = maxGroups > 0 ? groups.slice(0, maxGroups) : groups;

await mkdir(outputDir, { recursive: true });
if (!reuse) await runPhase0();
const phase0 = JSON.parse(await readFile(path.join(outputDir, 'phase0-result.json'), 'utf8'));
if (!phase0.passed) throw new Error('Phase 0 failed; specialty simulation stopped.');

const git = gitState();
const snapshots = await snapshotInputs();
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  taskVersion: '2026-08-11-first-specialty',
  git,
  rules: { initialMana: 0, manaCap: 10, actionStartMana: 1 },
  policy,
  tendencies: Object.fromEntries(Object.entries(PLAYER_TENDENCY_PROFILES).map(([id, profile]) => [id, profile.weights])),
  bosses: SINGLE_BOSS_IDS.map((id) => ({ id, name: bossNames[id] })),
  teams: Object.fromEntries([...new Set(groups.map((group) => group.teamId))].map((id) => [id, FIXED_TEAMS[id]])),
  seedStrategy: '同一Boss×AI对照格共用seedBase；runSeed=groupSeed+(index+1)*7919(uint32)。refresh_seek_test使用独立策略Seed块。',
  seedBase,
  runsPerGrid: runs,
  plannedGroups: groups.length,
  executedGroups: selectedGroups.length,
  plannedBattles: groups.length * runs,
  executedBattles: selectedGroups.length * runs,
  snapshots,
  groups: selectedGroups
};
await writeFile(path.join(outputDir, 'simulation_run_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
await initializeCsvFiles();

const completed = [];
for (let index = 0; index < selectedGroups.length; index += 1) {
  const group = selectedGroups[index];
  const relativeDir = `${outputRoot}/groups/${group.phase}/${group.teamId}/${group.aiStrategy}/${group.bossId}`;
  const specialtyPath = path.resolve(projectRoot, relativeDir, 'specialty-summary.json');
  process.stdout.write(`[${index + 1}/${selectedGroups.length}] ${group.phase} ${group.teamId} ${group.aiStrategy} ${group.bossId}\n`);
  if (!reuse || !existsSync(specialtyPath)) {
    await runSingleBoss({
      boss: group.bossId,
      runs,
      seed: group.seed,
      policy,
      playerTendency: group.playerTendency,
      roster: 'fixed',
      team: group.teamId,
      outputDir: relativeDir,
      debugDecisions: true,
      decisionSampleLimit: 20,
      testStrategy: group.testStrategy,
      specialtyMetrics: true,
      aiStrategy: group.aiStrategy
    });
  }
  const specialty = JSON.parse(await readFile(specialtyPath, 'utf8'));
  const groupSummary = summarizeGroup(group, specialty);
  completed.push({ group, specialty, summary: groupSummary, relativeDir });
  await appendGroupCsv(group, specialty, groupSummary);
}

const reportData = buildTenSpiritSpecialtyReport({ manifest, phase0, completed, bossNames });
await Promise.all([
  writeFile(path.join(outputDir, 'simulation_report.md'), reportData.markdown, 'utf8'),
  writeFile(path.join(outputDir, 'simulation_report_data.json'), JSON.stringify(reportData.data, null, 2), 'utf8')
]);
process.stdout.write(`SPECIALTY_REPORT=${path.join(outputDir, 'simulation_report.md')}\n`);

function buildGroups() {
  const normalStrategies = ['balanced', 'offense', 'defense'];
  const definitions = [
    ...['TEN-R1', 'TEN-R2', 'TEN-R3', 'TEN-R4', 'TEN-R5', 'TEN-R6'].map((teamId) => ({ phase: 'phase1', teamId })),
    ...['TEN-D1', 'TEN-D2', 'TEN-D3'].map((teamId) => ({ phase: 'phase2', teamId })),
    { phase: 'phase3', teamId: 'TEN-S1' }
  ];
  const rows = [];
  definitions.forEach((definition) => {
    normalStrategies.forEach((aiStrategy, strategyIndex) => {
      SINGLE_BOSS_IDS.forEach((bossId, bossIndex) => rows.push({
        ...definition,
        bossId,
        bossName: bossNames[bossId],
        aiStrategy,
        playerTendency: aiStrategy,
        testStrategy: 'none',
        seed: pairedSeed(bossIndex, strategyIndex, false)
      }));
    });
  });
  SINGLE_BOSS_IDS.forEach((bossId, bossIndex) => rows.push({
    phase: 'phase3',
    teamId: 'TEN-S1',
    bossId,
    bossName: bossNames[bossId],
    aiStrategy: 'refresh_seek_test',
    playerTendency: 'balanced',
    testStrategy: 'refresh_seek_test',
    seed: pairedSeed(bossIndex, 0, true)
  }));
  return rows;
}

function pairedSeed(bossIndex, strategyIndex, refresh) {
  return (seedBase + bossIndex * 1_000_000 + strategyIndex * 100_000 + (refresh ? 9_000_000 : 0)) >>> 0;
}

async function runPhase0() {
  await spawnChecked(process.execPath, ['scripts/run-ten-spirit-phase0.mjs', `--outputDir=${outputRoot}`]);
}

async function initializeCsvFiles() {
  await Promise.all([
    writeFile(path.join(outputDir, 'battle_summary.csv'), csvLine([
      'seed', 'boss_id', 'boss_name', 'team_id', 'ai_strategy', 'win', 'battle_rounds', 'boss_remaining_hp', 'boss_max_hp',
      'spirit_alive_json', 'spirit_normal_action_count_json', 'active_swap_count', 'death_replacement_count',
      'team_mana_generated_total', 'team_mana_generated_effective', 'team_mana_overflow', 'team_mana_spent', 'team_mana_end',
      'skill_uses_json', 'entries_json', 'swaps_out_json', 'deaths_json'
    ]), 'utf8'),
    writeFile(path.join(outputDir, 'team_boss_summary.csv'), csvLine([
      'phase', 'team_id', 'boss_id', 'boss_name', 'ai_strategy', 'battles', 'wins', 'win_rate', 'median_rounds',
      'average_rounds', 'average_boss_remaining_hp', 'average_player_deaths', 'mana_generated_total',
      'mana_generated_effective', 'mana_overflow', 'mana_spent', 'mana_end_average'
    ]), 'utf8'),
    writeFile(path.join(outputDir, 'spirit_summary.csv'), csvLine([
      'phase', 'boss', 'team', 'ai_strategy', 'spirit_id', 'battles', 'selected_battles', 'wins', 'deaths', 'normal_actions',
      'damage_total', 'effective_healing', 'overhealing', 'shield_generated', 'shield_absorbed', 'shield_remaining_at_battle_end',
      'mana_generated_total', 'mana_generated_effective', 'mana_overflow', 'mana_saved_by_cost_reduction', 'active_swaps_out', 'entries'
    ]), 'utf8'),
    writeFile(path.join(outputDir, 'skill_summary.csv'), csvLine([
      'phase', 'boss', 'team', 'ai_strategy', 'spirit_id', 'skill_id', 'skill_name', 'use_count', 'action_share',
      'first_use_own_action_index_median', 'actual_cost_mean', 'actual_cost_distribution', 'use_mana_mean', 'use_hp_ratio_mean',
      'damage_total', 'effective_healing', 'overhealing', 'shield_generated', 'shield_absorbed', 'mana_generated_total',
      'mana_generated_effective', 'mana_overflow', 'condition_met_count', 'condition_unmet_count'
    ]), 'utf8'),
    writeFile(path.join(outputDir, 'special_mechanics.csv'), csvLine(['phase', 'boss', 'team', 'ai_strategy', 'mechanic_id', 'metrics_json']), 'utf8')
  ]);
}

async function appendGroupCsv(group, specialty, summary) {
  const battleLines = specialty.battles.map((battle) => csvLine([
    battle.seed, battle.bossId, battle.bossName, battle.teamId, battle.aiStrategy, battle.win, battle.battleRounds,
    battle.bossRemainingHp, battle.bossMaxHp, json(battle.spiritAlive), json(battle.spiritNormalActionCount),
    battle.activeSwapCount, battle.deathReplacementCount, battle.teamManaGeneratedTotal, battle.teamManaGeneratedEffective,
    battle.teamManaOverflow, battle.teamManaSpent, battle.teamManaEnd, json(battle.skillUses), json(battle.entries),
    json(battle.swapsOut), json(battle.deaths)
  ])).join('');
  const teamLine = csvLine([
    group.phase, group.teamId, group.bossId, group.bossName, group.aiStrategy, summary.battles, summary.wins,
    summary.winRate, summary.medianRounds, summary.averageRounds, summary.averageBossRemainingHp,
    summary.averagePlayerDeaths, summary.manaGeneratedTotal, summary.manaGeneratedEffective, summary.manaOverflow,
    summary.manaSpent, summary.manaEndAverage
  ]);
  const spiritLines = Object.values(specialty.spirits).filter((spirit) => spirit.selectedBattles > 0).map((spirit) => csvLine([
    group.phase, group.bossId, group.teamId, group.aiStrategy, spirit.spiritId, spirit.battles, spirit.selectedBattles,
    spirit.wins, spirit.deaths, spirit.normalActions, spirit.damageTotal, spirit.effectiveHealing, spirit.overhealing,
    spirit.shieldGenerated, spirit.shieldAbsorbed, spirit.shieldRemainingAtBattleEnd, spirit.manaGeneratedTotal,
    spirit.manaGeneratedEffective, spirit.manaOverflow, spirit.manaSavedByCostReduction, spirit.activeSwapsOut, spirit.entries
  ])).join('');
  const skillLines = Object.values(specialty.skills).filter((skill) => skill.ownerNormalActions > 0).map((skill) => csvLine([
    group.phase, group.bossId, group.teamId, group.aiStrategy, skill.spiritId, skill.skillId, skill.skillName,
    skill.useCount, ratio(skill.useCount, skill.ownerNormalActions), distributionMedian(skill.firstUseOwnActionIndexCounts),
    ratio(skill.actualCostTotal, skill.useCount), json(skill.actualCostDistribution), ratio(skill.manaAtUseTotal, skill.useCount),
    ratio(skill.hpRatioAtUseTotal, skill.useCount), skill.damageTotal, skill.effectiveHealing, skill.overhealing,
    skill.shieldGenerated, skill.shieldAbsorbed, skill.manaGeneratedTotal, skill.manaGeneratedEffective, skill.manaOverflow,
    skill.conditionMetCount, skill.conditionUnmetCount
  ])).join('');
  const specialLines = Object.entries(specialty.special).map(([mechanicId, metrics]) => csvLine([
    group.phase, group.bossId, group.teamId, group.aiStrategy, mechanicId, json(metrics)
  ])).join('');
  await Promise.all([
    appendFile(path.join(outputDir, 'battle_summary.csv'), battleLines, 'utf8'),
    appendFile(path.join(outputDir, 'team_boss_summary.csv'), teamLine, 'utf8'),
    appendFile(path.join(outputDir, 'spirit_summary.csv'), spiritLines, 'utf8'),
    appendFile(path.join(outputDir, 'skill_summary.csv'), skillLines, 'utf8'),
    appendFile(path.join(outputDir, 'special_mechanics.csv'), specialLines, 'utf8')
  ]);
}

function summarizeGroup(group, specialty) {
  const battles = specialty.battles;
  const wins = battles.filter((battle) => battle.win).length;
  return {
    phase: group.phase,
    teamId: group.teamId,
    bossId: group.bossId,
    bossName: group.bossName,
    aiStrategy: group.aiStrategy,
    battles: battles.length,
    wins,
    winRate: ratio(wins, battles.length),
    medianRounds: median(battles.map((battle) => battle.battleRounds)),
    averageRounds: average(battles.map((battle) => battle.battleRounds)),
    averageBossRemainingHp: average(battles.map((battle) => battle.bossRemainingHp)),
    averagePlayerDeaths: average(battles.map((battle) => Object.values(battle.deaths).reduce((sum, value) => sum + value, 0))),
    manaGeneratedTotal: sum(battles, 'teamManaGeneratedTotal'),
    manaGeneratedEffective: sum(battles, 'teamManaGeneratedEffective'),
    manaOverflow: sum(battles, 'teamManaOverflow'),
    manaSpent: sum(battles, 'teamManaSpent'),
    manaEndAverage: average(battles.map((battle) => battle.teamManaEnd))
  };
}

async function snapshotInputs() {
  const files = ['src/data.ts', 'src/battle.ts', 'src/coreBattleRules.ts', 'scripts/battle-policy.mjs', 'config/boss-mechanics.json'];
  const snapshotDir = path.join(outputDir, 'config-snapshots');
  await mkdir(snapshotDir, { recursive: true });
  const result = {};
  for (const relative of files) {
    const source = path.join(projectRoot, relative);
    const destination = path.join(snapshotDir, relative.replaceAll('/', '__'));
    await copyFile(source, destination);
    const content = await readFile(source);
    result[relative] = { path: path.relative(outputDir, destination).replaceAll('\\', '/'), sha256: createHash('sha256').update(content).digest('hex') };
  }
  return result;
}

function gitState() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: projectRoot, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' }).trim();
    return { commit, branch, dirty: status.length > 0, statusLines: status ? status.split(/\r?\n/) : [] };
  } catch (error) {
    return { commit: 'unknown', branch: 'unknown', dirty: true, error: error instanceof Error ? error.message : String(error) };
  }
}

function spawnChecked(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: projectRoot, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${commandArgs[0]} exited with ${code}`)));
  });
}

function csvLine(values) {
  return `${values.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')}\n`;
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function ratio(value, total) {
  return total > 0 ? value / total : 0;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (row[key] ?? 0), 0);
}

function average(values) {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function distributionMedian(distribution) {
  const values = [];
  Object.entries(distribution ?? {}).forEach(([value, count]) => {
    for (let index = 0; index < count; index += 1) values.push(Number(value));
  });
  return median(values);
}
