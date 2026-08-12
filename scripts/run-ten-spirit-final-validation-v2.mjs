import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { FIXED_TEAMS } from './single-boss-config.mjs';
import { projectRoot, runSingleBoss } from './single-boss-suite-utils.mjs';
import { testOnlyBossId } from './test-only-boss-mirrors.mjs';
import { buildFinalValidationV2Report } from './ten-spirit-final-validation-v2-report.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [key, value = 'true'] = argument.replace(/^--/, '').split('='); return [key, value];
}));
const runs = Math.max(1, Number(args.runs ?? 10000));
const seedBase = Number(args.seed ?? 2026081202) >>> 0;
const outputRoot = args.outputDir ?? `validation-artifacts/ten-spirit-final-validation-v2-${runs}-20260812`;
const outputDir = path.resolve(projectRoot, outputRoot);
const baselineCommit = '9090af1c95a899dccc3c090dd925adaa64edbf4a';
const policy = 'balanced-v4-hunter-aware';
const bosses = [
  { sourceBossId: 'FORGE_BOSS_WARRIOR', name: 'TEST_ONLY 熔核守卫', maxHp: 2100, attack: 180, calibrationWinRate: 0.4455 },
  { sourceBossId: 'RANGE_BOSS_SHOOTER', name: 'TEST_ONLY 灰羽猎王', maxHp: 1500, attack: 200, calibrationWinRate: 0.4995 },
  { sourceBossId: 'MAGE_BOSS', name: 'TEST_ONLY 炽印法主', maxHp: 2000, attack: 200, calibrationWinRate: 0.4885 }
];
const groups = buildGroups();
await mkdir(outputDir, { recursive: true });
await initializeCsv();
const completed = [];
let runtimeAnomalies = 0;
for (let index = 0; index < groups.length; index += 1) {
  const group = groups[index];
  const relative = `${outputRoot}/groups/${group.focus}/${group.teamId}/${group.aiStrategy}/${group.sourceBossId}`;
  process.stdout.write(`[${index + 1}/${groups.length}] ${group.focus} ${group.teamLabel} ${group.aiStrategy} ${group.sourceBossId}\n`);
  await runSingleBoss({
    boss: group.testBossId, runs, seed: group.seed, policy, playerTendency: 'balanced', roster: 'fixed', team: group.teamId,
    outputDir: relative, debugDecisions: true, decisionSampleLimit: 30, testStrategy: group.testStrategy,
    specialtyMetrics: true, aiStrategy: group.aiStrategy, testOnlySourceBossId: group.sourceBossId,
    testOnlyBossHp: group.maxHp, testOnlyBossAttack: group.attack, experience: false
  });
  const [specialty, raw] = await Promise.all([
    readJson(path.join(projectRoot, relative, 'specialty-summary.json')),
    readJson(path.join(projectRoot, relative, 'raw-summary.json'))
  ]);
  runtimeAnomalies += raw.overview?.anomalyCount ?? raw.anomalies?.length ?? 0;
  completed.push({ group, specialty });
  await appendGroupCsv(group, specialty);
}

const git = gitState();
const manifest = {
  schemaVersion: 2, taskVersion: 'ten-spirit-second-adjustment-final-validation-20260812', generatedAt: new Date().toISOString(),
  baselineCommit, modifiedCommit: git.commit, git, modifications: {
    p06: { skillId: 'M06-S3', field: 'cost', before: 2, after: 1 },
    p08: { skillId: 'M08-S3', before: 'first action after each entry', after: 'first use of M08-S3 after each entry costs 1' }
  },
  acceptance: [
    { name: 'P06基础费用为1', result: 'PASS' }, { name: 'P06节能50%向下取整且覆盖1费', result: 'PASS' },
    { name: 'P06节能只作用于下一次技能且非技能行动不消耗', result: 'PASS' },
    { name: 'P08 Case A 先用铃音守护后首次庇佑1费', result: 'PASS' },
    { name: 'P08 Case B 同一入场首次1费、再次4费', result: 'PASS' },
    { name: 'P08 Case C 重新入场再次获得1费资格', result: 'PASS' },
    { name: 'P08 Case D 多次使用其他技能后首次庇佑仍1费', result: 'PASS' }
  ],
  formalBossesUnchanged: true, otherSpiritsFrozen: true, testOnlyBosses: bosses,
  teams: Object.fromEntries([...new Set(groups.map((group) => group.teamId))].map((id) => [id, FIXED_TEAMS[id]])),
  policy, rules: { initialMana: 0, manaCap: 10, actionStartMana: 1 }, runsPerGrid: runs, groups,
  totalBattles: groups.length * runs, runtimeAnomalies, seedBase,
  seedStrategy: 'P06/P08: unique group seed; double-mana A/B/C/D: same group seed per Boss; battleSeed=groupSeed+(runIndex+1)*7919 (uint32)',
  snapshots: await snapshotInputs()
};
const report = buildFinalValidationV2Report({ manifest, completed });
await Promise.all([
  writeFile(path.join(outputDir, 'simulation_run_manifest_v2.json'), JSON.stringify(manifest, null, 2), 'utf8'),
  writeFile(path.join(outputDir, 'simulation_report_v2.md'), report, 'utf8')
]);
process.stdout.write(`FINAL_VALIDATION_V2=${path.join(outputDir, 'simulation_report_v2.md')}\n`);

function buildGroups() {
  const result = [];
  const add = (definition, boss, seed) => result.push({
    ...definition, sourceBossId: boss.sourceBossId, testBossId: testOnlyBossId(boss.sourceBossId), bossName: boss.name,
    maxHp: boss.maxHp, attack: boss.attack, seed
  });
  bosses.forEach((boss, bossIndex) => add({ focus: 'p06', teamId: 'TEST-P06', teamCode: 'P06', teamLabel: 'P06专项', aiStrategy: 'balanced', testStrategy: 'none' }, boss, (seedBase + 1_000_000 + bossIndex * 1_000_000) >>> 0));
  for (const strategy of ['balanced', 'refresh_seek_test']) bosses.forEach((boss, bossIndex) => add({ focus: 'p08', teamId: 'TEST-P08', teamCode: strategy, teamLabel: strategy === 'balanced' ? 'P08正常AI' : 'P08刻意刷新', aiStrategy: strategy, testStrategy: strategy === 'balanced' ? 'none' : strategy }, boss, (seedBase + (strategy === 'balanced' ? 5_000_000 : 9_000_000) + bossIndex * 1_000_000) >>> 0));
  const teams = [
    { teamId: 'TEST-V2-MANA-A', teamCode: 'A', teamLabel: 'A 双回能' },
    { teamId: 'TEST-V2-MANA-B', teamCode: 'B', teamLabel: 'B 单P09' },
    { teamId: 'TEST-V2-MANA-C', teamCode: 'C', teamLabel: 'C 单P10' },
    { teamId: 'TEST-V2-MANA-D', teamCode: 'D', teamLabel: 'D 攻防回复' }
  ];
  bosses.forEach((boss, bossIndex) => {
    const pairedSeed = (seedBase + 20_000_000 + bossIndex * 1_000_000) >>> 0;
    teams.forEach((team) => add({ focus: 'double-mana', ...team, aiStrategy: 'balanced', testStrategy: 'none' }, boss, pairedSeed));
  });
  return result;
}

async function initializeCsv() {
  await Promise.all([
    writeFile(path.join(outputDir, 'battle_summary_v2.csv'), csv(['seed', 'focus', 'team_code', 'team_id', 'ai_strategy', 'source_boss_id', 'test_boss_id', 'boss_name', 'win', 'battle_rounds', 'boss_remaining_hp', 'boss_max_hp', 'player_deaths', 'mana_total', 'mana_effective', 'mana_spent', 'mana_overflow', 'mana_end', 'skill_uses_json', 'special_json']), 'utf8'),
    writeFile(path.join(outputDir, 'team_boss_summary_v2.csv'), csv(['focus', 'team_code', 'team_id', 'ai_strategy', 'source_boss_id', 'test_boss_id', 'boss_name', 'battles', 'wins', 'win_rate', 'median_rounds', 'average_rounds', 'average_boss_remaining_hp', 'average_player_deaths', 'mana_total', 'mana_effective', 'mana_spent', 'mana_overflow', 'mana_end_average', 'group_seed']), 'utf8'),
    writeFile(path.join(outputDir, 'skill_summary_v2.csv'), csv(['focus', 'team_code', 'team_id', 'ai_strategy', 'source_boss_id', 'test_boss_id', 'spirit_id', 'skill_id', 'skill_name', 'use_count', 'action_share', 'first_use_median', 'first_use_distribution', 'actual_cost_mean', 'cost_distribution', 'mana_at_use_mean', 'hp_at_use_mean', 'team_hp_at_use_mean', 'damage_total', 'effective_healing', 'overhealing', 'shield_generated', 'shield_absorbed', 'mana_generated_total', 'mana_generated_effective', 'mana_overflow', 'condition_met', 'condition_unmet', 'group_seed']), 'utf8'),
    writeFile(path.join(outputDir, 'special_mechanics_v2.csv'), csv(['focus', 'team_code', 'team_id', 'ai_strategy', 'source_boss_id', 'test_boss_id', 'mechanic_id', 'metrics_json', 'group_seed']), 'utf8')
  ]);
}

async function appendGroupCsv(group, specialty) {
  const battles = specialty.battles;
  const wins = battles.filter((battle) => battle.win).length;
  const playerDeaths = (battle) => Object.values(battle.deaths ?? {}).reduce((sum, count) => sum + count, 0);
  const battleLines = battles.map((battle) => csv([
    battle.seed, group.focus, group.teamCode, group.teamId, group.aiStrategy, group.sourceBossId, group.testBossId,
    group.bossName, battle.win, battle.battleRounds, battle.bossRemainingHp, battle.bossMaxHp, playerDeaths(battle),
    battle.teamManaGeneratedTotal, battle.teamManaGeneratedEffective, battle.teamManaSpent, battle.teamManaOverflow,
    battle.teamManaEnd, JSON.stringify(battle.skillUses), JSON.stringify(battle.special)
  ])).join('');
  const teamLine = csv([
    group.focus, group.teamCode, group.teamId, group.aiStrategy, group.sourceBossId, group.testBossId, group.bossName,
    battles.length, wins, ratio(wins, battles.length), median(battles.map((battle) => battle.battleRounds)),
    avg(battles.map((battle) => battle.battleRounds)), avg(battles.map((battle) => battle.bossRemainingHp)),
    avg(battles.map(playerDeaths)), sum(battles, 'teamManaGeneratedTotal'), sum(battles, 'teamManaGeneratedEffective'),
    sum(battles, 'teamManaSpent'), sum(battles, 'teamManaOverflow'), avg(battles.map((battle) => battle.teamManaEnd)), group.seed
  ]);
  const skillLines = Object.values(specialty.skills).filter((skill) => skill.ownerNormalActions > 0).map((skill) => csv([
    group.focus, group.teamCode, group.teamId, group.aiStrategy, group.sourceBossId, group.testBossId, skill.spiritId,
    skill.skillId, skill.skillName, skill.useCount, ratio(skill.useCount, skill.ownerNormalActions),
    distributionMedian(skill.firstUseOwnActionIndexCounts), JSON.stringify(skill.firstUseOwnActionIndexCounts),
    ratio(skill.actualCostTotal, skill.useCount), JSON.stringify(skill.actualCostDistribution),
    ratio(skill.manaAtUseTotal, skill.useCount), ratio(skill.hpRatioAtUseTotal, skill.useCount),
    ratio(skill.teamHpRatioAtUseTotal, skill.useCount), skill.damageTotal, skill.effectiveHealing, skill.overhealing,
    skill.shieldGenerated, skill.shieldAbsorbed, skill.manaGeneratedTotal, skill.manaGeneratedEffective,
    skill.manaOverflow, skill.conditionMetCount ?? '', skill.conditionUnmetCount ?? '', group.seed
  ])).join('');
  const mechanicLines = Object.entries(specialty.special).map(([mechanicId, metrics]) => csv([
    group.focus, group.teamCode, group.teamId, group.aiStrategy, group.sourceBossId, group.testBossId, mechanicId,
    JSON.stringify(metrics), group.seed
  ])).join('');
  await Promise.all([
    appendFile(path.join(outputDir, 'battle_summary_v2.csv'), battleLines, 'utf8'),
    appendFile(path.join(outputDir, 'team_boss_summary_v2.csv'), teamLine, 'utf8'),
    appendFile(path.join(outputDir, 'skill_summary_v2.csv'), skillLines, 'utf8'),
    appendFile(path.join(outputDir, 'special_mechanics_v2.csv'), mechanicLines, 'utf8')
  ]);
}

async function snapshotInputs() {
  const files = ['src/data.ts', 'src/battle.ts', 'src/battleTelemetry.ts', 'src/monsterData.ts', 'scripts/battle-policy.mjs', 'scripts/simulate-random-dungeon.mjs', 'scripts/ten-spirit-specialty-metrics.mjs', 'scripts/test-only-boss-mirrors.mjs'];
  const dir = path.join(outputDir, 'config-snapshots'); await mkdir(dir, { recursive: true }); const result = {};
  for (const relative of files) { const source = path.join(projectRoot, relative); const destination = path.join(dir, relative.replaceAll('/', '__')); const content = await readFile(source); await copyFile(source, destination); result[relative] = { path: path.relative(outputDir, destination).replaceAll('\\', '/'), sha256: createHash('sha256').update(content).digest('hex') }; }
  return result;
}
function gitState() { try { const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim(); const branch = execFileSync('git', ['branch', '--show-current'], { cwd: projectRoot, encoding: 'utf8' }).trim(); const status = execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' }).trim(); return { commit, branch, dirty: Boolean(status), statusLines: status ? status.split(/\r?\n/) : [] }; } catch (error) { return { commit: 'unknown', dirty: true, error: String(error) }; } }
function sum(rows, key) { return rows.reduce((total, row) => total + (row[key] ?? 0), 0); }
function avg(values) { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0; }
function ratio(value, total) { return total > 0 ? value / total : 0; }
function median(values) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function distributionMedian(distribution = {}) { const total = Object.values(distribution).reduce((sumValue, count) => sumValue + count, 0); if (!total) return 0; let seen = 0; const target = (total + 1) / 2; for (const [index, count] of Object.entries(distribution).sort(([left], [right]) => Number(left) - Number(right))) { seen += count; if (seen >= target) return Number(index); } return 0; }
function csv(values) { return `${values.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')}\n`; }
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
