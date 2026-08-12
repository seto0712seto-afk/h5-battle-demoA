import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { PLAYER_TENDENCY_PROFILES } from './battle-policy.mjs';
import { SINGLE_BOSS_IDS } from './single-boss-config.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = path.join(projectRoot, 'validation-artifacts/player-tendency-10000-20260805');
const packageRoot = path.join(projectRoot, 'validation-artifacts/packages/三Boss三玩家风格90000场_GPT数据交接包_20260805');
const tendencyIds = ['balanced', 'offense', 'defense'];
const bossNames = {
  FORGE_BOSS_WARRIOR: '熔核守卫',
  RANGE_BOSS_SHOOTER: '灰羽猎王',
  MAGE_BOSS: '炽印法主'
};
const requiredGroupFiles = [
  'experience-summary.json',
  'experience-summary.md',
  'raw-summary.json',
  'mechanic-events.csv',
  'decision-samples.json',
  'outlier-seeds.json',
  'skill-usage.csv',
  'spirit-usage.csv'
];

try {
  await stat(packageRoot);
  throw new Error(`Package directory already exists: ${packageRoot}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

await mkdir(packageRoot, { recursive: true });
const sourceMap = [];
const groups = [];

for (const tendencyId of tendencyIds) {
  for (const bossId of SINGLE_BOSS_IDS) {
    const sourceDirectory = path.join(sourceRoot, tendencyId, bossId);
    const destinationDirectory = path.join(packageRoot, 'groups', tendencyId, bossId);
    await mkdir(destinationDirectory, { recursive: true });
    for (const filename of requiredGroupFiles) {
      const source = path.join(sourceDirectory, filename);
      await stat(source);
      const packagedName = filename === 'experience-summary.json'
        ? 'report.json'
        : filename === 'experience-summary.md'
          ? 'report-debug.md'
          : filename;
      const destination = path.join(destinationDirectory, packagedName);
      await cp(source, destination);
      sourceMap.push({
        source: relative(sourceRoot, source),
        packagedAs: relative(packageRoot, destination),
        contentModified: false
      });
    }
    const report = JSON.parse(await readFile(path.join(sourceDirectory, 'experience-summary.json'), 'utf8'));
    const raw = JSON.parse(await readFile(path.join(sourceDirectory, 'raw-summary.json'), 'utf8'));
    if (report.summary.runs !== 10000 || raw.metadata.runs !== 10000) {
      throw new Error(`Unexpected run count: ${tendencyId}/${bossId}`);
    }
    groups.push({
      tendencyId,
      tendencyName: PLAYER_TENDENCY_PROFILES[tendencyId].name,
      bossId,
      bossName: bossNames[bossId],
      runs: report.summary.runs,
      seed: raw.metadata.seed,
      policy: raw.metadata.policy,
      playerTendency: raw.metadata.playerTendency,
      report: `groups/${tendencyId}/${bossId}/report.json`,
      reportDebug: `groups/${tendencyId}/${bossId}/report-debug.md`,
      rawSummary: `groups/${tendencyId}/${bossId}/raw-summary.json`,
      mechanicEvents: `groups/${tendencyId}/${bossId}/mechanic-events.csv`
    });
  }
}

await mkdir(path.join(packageRoot, 'combined'), { recursive: true });
for (const filename of ['三Boss三玩家风格各10000场综合报告.md', '三Boss三玩家风格各10000场汇总.json']) {
  const source = path.join(sourceRoot, filename);
  const destination = path.join(packageRoot, 'combined', filename);
  await cp(source, destination);
  sourceMap.push({ source: relative(sourceRoot, source), packagedAs: relative(packageRoot, destination), contentModified: false });
}

await mkdir(path.join(packageRoot, 'configuration/source'), { recursive: true });
await cp(path.join(projectRoot, 'config'), path.join(packageRoot, 'configuration/source/config'), { recursive: true });
for (const filename of [
  'src/data.ts',
  'src/monsterData.ts',
  'src/types.ts',
  'src/battle.ts',
  'src/coreBattleRules.ts',
  'src/battleTelemetry.ts',
  'src/battleSystems.ts',
  'src/stages.ts',
  'scripts/battle-policy.mjs',
  'scripts/single-boss-config.mjs'
]) {
  const destination = path.join(packageRoot, 'configuration/source', filename);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(projectRoot, filename), destination);
}

const vite = await createServer({ root: projectRoot, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
  const playerData = await vite.ssrLoadModule('/src/data.ts');
  const monsterData = await vite.ssrLoadModule('/src/monsterData.ts');
  const bosses = Object.values(monsterData.MONSTERS).filter((monster) => SINGLE_BOSS_IDS.includes(monster.id));
  const bossSkillIds = new Set(bosses.flatMap((boss) => boss.skills.map((entry) => entry.skillId)));
  const bossSkills = Object.values(monsterData.MONSTER_SKILLS).filter((skill) => bossSkillIds.has(skill.id));
  await writeJson(path.join(packageRoot, 'configuration/精灵技能配置.snapshot.json'), {
    teamManaInitial: playerData.TEAM_MANA_INITIAL,
    teamManaMax: playerData.TEAM_MANA_MAX,
    baseActionSpeed: playerData.BASE_ACTION_SPEED,
    spirits: playerData.SPIRITS,
    skills: playerData.SKILLS
  });
  await writeJson(path.join(packageRoot, 'configuration/Boss战斗配置.snapshot.json'), { bosses, bossSkills });
} finally {
  await vite.close();
}
await writeJson(path.join(packageRoot, 'configuration/玩家风格评分权重.snapshot.json'), PLAYER_TENDENCY_PROFILES);

await mkdir(path.join(packageRoot, 'generator'), { recursive: true });
for (const filename of [
  'package.json',
  'package-lock.json',
  'scripts/run-three-boss-tendency-suite.mjs',
  'scripts/single-boss-suite-utils.mjs',
  'scripts/simulate-single-boss-v2.mjs',
  'scripts/simulate-random-dungeon.mjs',
  'scripts/experience-metrics.mjs',
  'scripts/render-experience-summary.mjs',
  'scripts/package-player-tendency-artifacts.mjs'
]) {
  const source = path.join(projectRoot, filename);
  const destination = path.join(packageRoot, 'generator', filename);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
}

const gitHead = git(['rev-parse', 'HEAD']).trim();
const gitBranch = git(['branch', '--show-current']).trim();
const gitStatus = git(['status', '--porcelain=v1']);
const gitDiff = git(['diff', '--binary', '--no-ext-diff']);
await mkdir(path.join(packageRoot, 'provenance'), { recursive: true });
await writeFile(path.join(packageRoot, 'provenance/git-status.txt'), gitStatus, 'utf8');
await writeFile(path.join(packageRoot, 'provenance/uncommitted-changes.patch'), gitDiff, 'utf8');
await writeJson(path.join(packageRoot, 'provenance/run-manifest.json'), {
  artifactType: 'existing-test-output-package',
  sourceOutputDirectory: relative(projectRoot, sourceRoot),
  testsRerunDuringPackaging: false,
  testDataModifiedDuringPackaging: false,
  runsPerTendencyPerBoss: 10000,
  totalRuns: 90000,
  seed: 2026080502,
  seedFormula: 'seedBase + (index + 1) * 7919 (uint32)',
  initialMana: 0,
  manaCap: 10,
  policy: 'balanced-v4-hunter-aware',
  tendencies: tendencyIds,
  bossIds: SINGLE_BOSS_IDS,
  git: {
    head: gitHead,
    branch: gitBranch,
    dirtyAtPackaging: gitStatus.trim().length > 0,
    note: '测试运行使用了未提交工作树；HEAD仅表示基线提交，实际差异见uncommitted-changes.patch及包内源文件快照。'
  },
  eventArtifacts: {
    existing: '每组mechanic-events.csv；每组report.json内含10000条battleRecords',
    absent: '本次运行未生成逐行动完整事件流或压缩事件文件，未在打包时补造。'
  },
  groups
});
await writeJson(path.join(packageRoot, 'provenance/source-file-map.json'), sourceMap);

await writeFile(path.join(packageRoot, 'README_数据交接说明.md'), `# 三Boss三玩家风格90,000场数据交接包\n\n- 本包仅复制并整理现有测试产物，未复跑、未修改测试数据。\n- 九组目录位于 \`groups/<玩家风格>/<Boss ID>/\`。\n- 原 \`experience-summary.json\` 原样复制为 \`report.json\`。\n- 原 \`experience-summary.md\` 原样复制为 \`report-debug.md\`。\n- 每组 \`report.json\` 包含10,000条 \`battleRecords\`；\`mechanic-events.csv\`为本次已有机制事件表。\n- 本次没有生成逐行动完整事件流或压缩事件文件，因此包内不补造不存在的产物。\n- 配置快照、运行参数、Git基线与未提交差异分别位于 \`configuration/\` 和 \`provenance/\`。\n- 文件来源重命名映射见 \`provenance/source-file-map.json\`，完整性校验见 \`SHA256SUMS.txt\`。\n`, 'utf8');

const files = await walk(packageRoot);
const checksumLines = [];
for (const filename of files.sort()) {
  const data = await readFile(filename);
  checksumLines.push(`${createHash('sha256').update(data).digest('hex')}  ${relative(packageRoot, filename)}`);
}
await writeFile(path.join(packageRoot, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`, 'utf8');
process.stdout.write(`PACKAGE_DIRECTORY=${packageRoot}\nFILES=${files.length + 1}\nGROUPS=${groups.length}\n`);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}
async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function git(arguments_) {
  return execFileSync('git', arguments_, { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function relative(root, filename) {
  return path.relative(root, filename).replaceAll('\\', '/');
}
