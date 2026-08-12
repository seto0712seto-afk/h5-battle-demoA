import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FIXED_TEAMS } from './single-boss-config.mjs';
import { projectRoot, runSingleBoss } from './single-boss-suite-utils.mjs';
import { testOnlyBossId } from './test-only-boss-mirrors.mjs';
import { buildTestOnlySpecialtyReport } from './test-only-specialty-report.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
  return [key, value];
}));
const runs = Math.max(1, Number(args.runs ?? 10000));
const seedBase = Number(args.seed ?? 2026081201) >>> 0;
const outputRoot = args.outputDir ?? `validation-artifacts/test-only-specialty-${runs}-20260812`;
const outputDir = path.resolve(projectRoot, outputRoot);
const policy = 'balanced-v4-hunter-aware';
const reuse = args.reuse === 'true';
const rerunFocus = new Set(String(args.rerunFocus ?? '').split(',').filter(Boolean));
const calibrations = [
  { sourceBossId: 'FORGE_BOSS_WARRIOR', name: 'TEST_ONLY 熔核守卫', maxHp: 2100, attack: 180, confirmationWinRate: 0.4455 },
  { sourceBossId: 'RANGE_BOSS_SHOOTER', name: 'TEST_ONLY 灰羽猎王', maxHp: 1500, attack: 200, confirmationWinRate: 0.4995 },
  { sourceBossId: 'MAGE_BOSS', name: 'TEST_ONLY 炽印法主', maxHp: 2000, attack: 200, confirmationWinRate: 0.4885 }
];
const groups = buildGroups();
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'battle_summary.csv'), csv(['seed', 'source_boss_id', 'test_boss_id', 'boss_name', 'focus', 'team_id', 'ai_strategy', 'win', 'battle_rounds', 'boss_remaining_hp', 'boss_max_hp', 'mana_total', 'mana_effective', 'mana_spent', 'mana_overflow', 'mana_end', 'skill_uses_json', 'special_json']), 'utf8');

const completed = [];
let runtimeAnomalies = 0;
for (let index = 0; index < groups.length; index += 1) {
  const group = groups[index];
  const relative = `${outputRoot}/groups/${group.focus}/${group.teamId}/${group.aiStrategy}/${group.sourceBossId}`;
  process.stdout.write(`[${index + 1}/${groups.length}] ${group.focus} ${group.teamId} ${group.aiStrategy} ${group.sourceBossId}\n`);
  const specialtyFile = path.join(projectRoot, relative, 'specialty-summary.json');
  if (!reuse || !existsSync(specialtyFile) || rerunFocus.has(group.focus)) await runSingleBoss({
    boss: group.testBossId,
    runs,
    seed: group.seed,
    policy,
    playerTendency: 'balanced',
    roster: 'fixed',
    team: group.teamId,
    outputDir: relative,
    debugDecisions: true,
    decisionSampleLimit: 30,
    testStrategy: group.testStrategy,
    specialtyMetrics: true,
    aiStrategy: group.aiStrategy,
    testOnlySourceBossId: group.sourceBossId,
    testOnlyBossHp: group.maxHp,
    testOnlyBossAttack: group.attack
    ,experience: false
  });
  const [specialty, raw] = await Promise.all([
    readJson(specialtyFile),
    readJson(path.join(projectRoot, relative, 'raw-summary.json'))
  ]);
  runtimeAnomalies += raw.overview?.anomalyCount ?? raw.anomalies?.length ?? 0;
  completed.push({ group, specialty });
  const lines = specialty.battles.map((battle) => csv([
    battle.seed, group.sourceBossId, group.testBossId, group.bossName, group.focus, group.teamId, group.aiStrategy,
    battle.win, battle.battleRounds, battle.bossRemainingHp, battle.bossMaxHp, battle.teamManaGeneratedTotal,
    battle.teamManaGeneratedEffective, battle.teamManaSpent, battle.teamManaOverflow, battle.teamManaEnd,
    JSON.stringify(battle.skillUses), JSON.stringify(battle.special)
  ])).join('');
  await appendFile(path.join(outputDir, 'battle_summary.csv'), lines, 'utf8');
}

const git = gitState();
const manifest = {
  schemaVersion: 1,
  taskVersion: 'TEST_ONLY-specialty-2026-08-12',
  generatedAt: new Date().toISOString(),
  git,
  gitHash: git.commit,
  policy,
  formalRulesUnchanged: true,
  rules: { initialMana: 0, manaCap: 10, actionStartMana: 1 },
  baselineTeam: FIXED_TEAMS['TEST-BASELINE'],
  calibrationRuns: 2000,
  calibration: calibrations,
  runsPerGrid: runs,
  groups,
  totalBattles: groups.length * runs,
  runtimeAnomalies,
  seedBase,
  seedStrategy: 'groupSeed=seedBase+groupIndex*1,000,000; battleSeed=groupSeed+(runIndex+1)*7919 (uint32)',
  snapshots: await snapshotInputs()
};
const report = buildTestOnlySpecialtyReport({ manifest, groups: completed });
await Promise.all([
  writeFile(path.join(outputDir, 'simulation_run_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8'),
  writeFile(path.join(outputDir, 'simulation_report_data.json'), JSON.stringify(report.data, null, 2), 'utf8'),
  writeFile(path.join(outputDir, 'simulation_report.md'), report.markdown, 'utf8'),
  writeFile(path.join(outputDir, 'special_mechanics.csv'), buildSpecialMechanicsCsv(completed), 'utf8'),
  writeFile(path.join(outputDir, 'skill_summary.csv'), buildSkillSummaryCsv(completed), 'utf8')
]);
process.stdout.write(`TEST_ONLY_REPORT=${path.join(outputDir, 'simulation_report.md')}\n`);

function buildGroups() {
  const definitions = [
    { focus: 'p09p10', teamId: 'TEST-P09-P10', support: 'P09+P10', highCostComparison: true, hasP10: true },
    { focus: 'p07', teamId: 'TEST-P07-NONE', support: '无回能' },
    { focus: 'p07', teamId: 'TEST-P07-P10', support: 'P10', highCostComparison: true, hasP10: true },
    { focus: 'p07', teamId: 'TEST-P07-P09', support: 'P09' },
    { focus: 'p07', teamId: 'TEST-P07-DUAL', support: 'P09+P10', highCostComparison: true, hasP10: true },
    { focus: 'p06', teamId: 'TEST-P06', support: 'P06专项' },
    { focus: 'p08', teamId: 'TEST-P08', support: '正常AI' },
    { focus: 'coverage', teamId: 'TEST-COVERAGE', support: 'P02/P03/P05覆盖' },
    { focus: 'coverage', teamId: 'TEST-HIGH-COST-NO-P10', support: '高费无P10', highCostComparison: true, hasP10: false },
    { focus: 'coverage', teamId: 'TEST-P07-HIGH-COST-NO-P10', support: 'P07高费无P10', highCostComparison: true, hasP10: false }
  ];
  const result = [];
  definitions.forEach((definition) => calibrations.forEach((boss) => result.push({
    ...definition,
    sourceBossId: boss.sourceBossId,
    testBossId: testOnlyBossId(boss.sourceBossId),
    bossName: boss.name,
    maxHp: boss.maxHp,
    attack: boss.attack,
    aiStrategy: 'balanced',
    testStrategy: 'none',
    seed: (seedBase + (result.length + 1) * 1_000_000) >>> 0
  })));
  calibrations.forEach((boss) => result.push({
    focus: 'p08', teamId: 'TEST-P08', support: '刻意刷新', sourceBossId: boss.sourceBossId,
    testBossId: testOnlyBossId(boss.sourceBossId), bossName: boss.name, maxHp: boss.maxHp, attack: boss.attack,
    aiStrategy: 'refresh_seek_test', testStrategy: 'refresh_seek_test', seed: (seedBase + (result.length + 1) * 1_000_000) >>> 0
  }));
  return result;
}

async function snapshotInputs() {
  const files = ['src/data.ts', 'src/monsterData.ts', 'src/battle.ts', 'src/battleTelemetry.ts', 'scripts/battle-policy.mjs', 'scripts/simulate-random-dungeon.mjs', 'scripts/ten-spirit-specialty-metrics.mjs', 'scripts/test-only-boss-mirrors.mjs'];
  const dir = path.join(outputDir, 'config-snapshots');
  await mkdir(dir, { recursive: true });
  const result = {};
  for (const relative of files) {
    const source = path.join(projectRoot, relative);
    const destination = path.join(dir, relative.replaceAll('/', '__'));
    const content = await readFile(source);
    await copyFile(source, destination);
    result[relative] = { path: path.relative(outputDir, destination).replaceAll('\\', '/'), sha256: createHash('sha256').update(content).digest('hex') };
  }
  return result;
}

function gitState() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: projectRoot, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' }).trim();
    return { commit, branch, dirty: Boolean(status), statusLines: status ? status.split(/\r?\n/) : [] };
  } catch (error) { return { commit: 'unknown', branch: 'unknown', dirty: true, error: String(error) }; }
}

function buildSpecialMechanicsCsv(completedGroups) {
  const rows = [csv([
    'phase', 'boss', 'team', 'ai_strategy', 'mechanic_id', 'metrics_json',
    'focus', 'support', 'source_boss_id', 'test_boss_id', 'test_boss_name', 'test_strategy', 'group_seed', 'battles'
  ])];
  for (const { group, specialty } of completedGroups) {
    for (const [mechanicId, metrics] of Object.entries(specialty.special)) rows.push(csv([
      group.focus, group.testBossId, group.teamId, group.aiStrategy, mechanicId, JSON.stringify(metrics),
      group.focus, group.support, group.sourceBossId, group.testBossId, group.bossName, group.testStrategy,
      group.seed, specialty.battles.length
    ]));
  }
  return rows.join('');
}

function buildSkillSummaryCsv(completedGroups) {
  const rows = [csv([
    'phase', 'boss', 'team', 'ai_strategy', 'spirit_id', 'skill_id', 'skill_name', 'use_count', 'action_share',
    'first_use_own_action_index_median', 'actual_cost_mean', 'actual_cost_distribution', 'use_mana_mean',
    'use_hp_ratio_mean', 'damage_total', 'effective_healing', 'overhealing', 'shield_generated', 'shield_absorbed',
    'mana_generated_total', 'mana_generated_effective', 'mana_overflow', 'condition_met_count', 'condition_unmet_count',
    'use_team_hp_ratio_mean', 'condition_trigger_rate', 'enhanced_use_count', 'enhanced_use_rate',
    'first_use_own_action_index_distribution', 'focus', 'support', 'source_boss_id', 'test_boss_id', 'test_boss_name',
    'test_strategy', 'group_seed', 'battles'
  ])];
  for (const { group, specialty } of completedGroups) {
    for (const skill of Object.values(specialty.skills).filter((item) => item.ownerNormalActions > 0)) {
      const conditionTotal = (skill.conditionMetCount ?? 0) + (skill.conditionUnmetCount ?? 0);
      rows.push(csv([
        group.focus, group.testBossId, group.teamId, group.aiStrategy, skill.spiritId, skill.skillId, skill.skillName,
        skill.useCount, ratio(skill.useCount, skill.ownerNormalActions), distributionMedian(skill.firstUseOwnActionIndexCounts),
        ratio(skill.actualCostTotal, skill.useCount), JSON.stringify(skill.actualCostDistribution),
        ratio(skill.manaAtUseTotal, skill.useCount), ratio(skill.hpRatioAtUseTotal, skill.useCount), skill.damageTotal,
        skill.effectiveHealing, skill.overhealing, skill.shieldGenerated, skill.shieldAbsorbed, skill.manaGeneratedTotal,
        skill.manaGeneratedEffective, skill.manaOverflow, skill.conditionMetCount ?? '', skill.conditionUnmetCount ?? '',
        ratio(skill.teamHpRatioAtUseTotal, skill.useCount), ratio(skill.conditionMetCount ?? 0, conditionTotal),
        skill.enhancedUseCount ?? 0, ratio(skill.enhancedUseCount ?? 0, skill.useCount),
        JSON.stringify(skill.firstUseOwnActionIndexCounts), group.focus, group.support, group.sourceBossId,
        group.testBossId, group.bossName, group.testStrategy, group.seed, specialty.battles.length
      ]));
    }
  }
  return rows.join('');
}

function ratio(value, total) { return total > 0 ? value / total : 0; }
function distributionMedian(distribution = {}) {
  const total = Object.values(distribution).reduce((sum, count) => sum + count, 0);
  if (!total) return 0;
  const target = (total + 1) / 2;
  let seen = 0;
  for (const [index, count] of Object.entries(distribution).sort(([left], [right]) => Number(left) - Number(right))) {
    seen += count;
    if (seen >= target) return Number(index);
  }
  return 0;
}

function csv(values) { return `${values.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')}\n`; }
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
