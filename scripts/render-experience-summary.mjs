import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export async function writeExperienceArtifacts(report, artifactDirectory) {
  await mkdir(artifactDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(artifactDirectory, 'experience-summary.json'), JSON.stringify(report, null, 2), 'utf8'),
    writeFile(path.join(artifactDirectory, 'experience-summary.md'), renderExperienceMarkdown(report), 'utf8'),
    writeFile(path.join(artifactDirectory, 'spirit-usage.csv'), renderCsv(Object.values(report.spirits), SPIRIT_COLUMNS), 'utf8'),
    writeFile(path.join(artifactDirectory, 'skill-usage.csv'), renderCsv(Object.values(report.skills), SKILL_COLUMNS), 'utf8'),
    writeFile(path.join(artifactDirectory, 'mechanic-events.csv'), renderCsv((report.battleRecords ?? []).map(mechanicRow), MECHANIC_COLUMNS), 'utf8'),
    writeFile(path.join(artifactDirectory, 'outlier-seeds.json'), JSON.stringify(report.outliers, null, 2), 'utf8')
  ]);
}

export function renderExperienceMarkdown(report) {
  const warningLines = report.warnings.length
    ? report.warnings.slice(0, 30).map((item) => `- **${item.code}**｜${item.subject}｜当前 ${formatValue(item.value)}｜阈值 ${formatValue(item.threshold)}`).join('\n')
    : '- 未触发体验预警。';
  const stageRows = Object.entries(report.stages).map(([stage, item]) =>
    `| ${stage} | ${item.reached} | ${percent(item.clearRateFromReached)} | ${nullable(item.averageRounds)} | ${nullable(item.medianRounds)} | ${nullable(item.p75Rounds)} | ${nullable(item.p90Rounds)} | ${nullable(item.p95Rounds)} | ${percent(item.over20RoundsRate)} |`
  ).join('\n');
  const bossRows = Object.entries(report.bosses).map(([bossId, item]) =>
    `| ${bossId} | ${item.battlesReached} | ${nullable(item.bossActionsAverage)} | ${percent(item.coreMechanicSeenRate)} |`
  ).join('\n') || '| - | 0 | - | - |';
  const skillRows = Object.values(report.skills).map((item) =>
    `| ${item.spiritName} | ${item.skillName} | ${item.uses} | ${percent(item.useShareOfOwnerSkillActions)} | ${nullable(item.averageActualCost)} | ${percent(item.freeUseRate)} | ${nullable(item.averageDamage)} | ${nullable(item.averageEffectiveHealing)} | ${nullable(item.shieldGranted)} | ${nullable(item.shieldAbsorbed)} | ${percent(item.shieldUtilizationRate)} | ${nullable(item.energyGenerated)} | ${percent(ratio(item.energyOverflow, item.energyRequested))} |`
  ).join('\n');
  return `# Battle Experience Report

## 总览

| 指标 | 当前值 |
|---|---:|
| 样本数 | ${report.runs} |
| 总通关率 | ${percent(report.summary.clearRate)} |
| 妖力溢出率 | ${percent(report.energy.overflowRate)} |
| 行动开始零妖力比例 | ${percent(report.energy.zeroEnergyActionStartRate)} |
| 平均主动行动开始妖力 | ${nullable(report.energy.averageEnergyAtPlayerActionStart)} |
| 运行异常 | ${report.outliers.runtimeAnomalies.length} |

## 关卡节奏

| 关卡 | 到达 | 通关率 | 平均回合 | 中位回合 | P75 | P90 | P95 | >20回合 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${stageRows}

## 体验预警

${warningLines}

## 妖力节奏

- 尝试获得：${report.energy.attemptedGain}
- 实际获得：${report.energy.gained}
- 溢出：${report.energy.overflow}
- 技能支付：${report.energy.spent}
- 行动开始回能：${report.energy.actionStartGained}
- 技能回能：${report.energy.skillGained}

## Boss 机制出现率

| Boss ID | 到达 | 平均行动 | 核心机制体验率 |
|---|---:|---:|---:|
${bossRows}

## 精灵技能量化

| 精灵 | 技能 | 使用 | 占比 | 平均实费 | 免费率 | 平均伤害 | 平均有效治疗 | 护盾生成 | 护盾吸收 | 护盾利用率 | 实际回能 | 回能溢出率 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${skillRows}

## 指定技能专项指标

\`\`\`json
${JSON.stringify(report.skillValidation ?? {}, null, 2)}
\`\`\`

## 异常 Seed

${report.outliers.runtimeAnomalies.length ? report.outliers.runtimeAnomalies.slice(0, 20).map((item) => `- Seed ${item.seed}｜第 ${item.stage} 场｜${item.reason}`).join('\n') : '- 未发现运行异常。'}

## 基线

${report.baselineComparison === null ? '尚未建立策划基线。' : report.baselineComparison.compatible ? '已完成同版本基线比较。' : `基线不可比较：${report.baselineComparison.reason}`}

## 说明

- 固定 Seed 基准：${report.seedBase}
- Seed 公式：${report.seedFormula}
- 体验 Warning 不导致 CI 失败；运行异常会导致模拟命令返回非零。
`;
}

const SPIRIT_COLUMNS = [
  'spiritId', 'spiritName', 'selectedCount', 'starterCount', 'benchCount', 'enteredBattleCount', 'normalActions', 'extraActions',
  'winsWhenSelected', 'winRateWhenSelected', 'winsWhenStarter', 'winRateWhenStarter', 'winsWhenBench', 'winRateWhenBench', 'damageDealt', 'effectiveHealing', 'overheal',
  'shieldGranted', 'energyGenerated', 'switchedIn', 'switchedOut', 'deaths'
];

const MECHANIC_COLUMNS = [
  'bossId', 'policy', 'teamId', 'seed', 'victory', 'rounds', 'playerActions', 'bossActions',
  'firstCasualtyRound', 'survivingSpirits', 'finalHpRatio', 'bossRemainingHpRatio', 'finalMana',
  'forcedReplacements', 'tacticalSwaps', 'rowSwitches', 'over15Rounds', 'over20Rounds',
  'backRowDamageTotal', 'exposedWindowDamageTotal', 'lockCreatedCount', 'lockResponseSwapCount',
  'lockResponseRowSwitchCount', 'amplificationCount', 'firstCasualtyPowerTier', 'unresolvedTelegraphReasons'
];

function mechanicRow(record) {
  return {
    ...record,
    backRowDamageTotal: record.mechanics?.backRowDamageTotal ?? 0,
    exposedWindowDamageTotal: record.mechanics?.exposedWindowDamageTotal ?? 0,
    lockCreatedCount: record.mechanics?.lockCreatedCount ?? 0,
    lockResponseSwapCount: record.mechanics?.lockResponseSwapCount ?? 0,
    lockResponseRowSwitchCount: record.mechanics?.lockResponseRowSwitchCount ?? 0,
    amplificationCount: record.mechanics?.amplificationCount ?? 0,
    firstCasualtyPowerTier: record.mechanics?.firstCasualtyPowerTier ?? '',
    unresolvedTelegraphReasons: JSON.stringify(record.mechanics?.unresolvedTelegraphReasons ?? {})
  };
}

const SKILL_COLUMNS = [
  'spiritId', 'spiritName', 'skillId', 'skillName', 'uses', 'ownerSkillActions',
  'useShareOfOwnerSkillActions', 'repeatedUses', 'consecutiveRepeatRate', 'averageConfiguredCost', 'averageActualCost',
  'freeUses', 'freeUseRate', 'damageDealt', 'averageDamage', 'effectiveHealing', 'averageEffectiveHealing', 'overheal',
  'shieldGranted', 'shieldAbsorbed', 'shieldUtilizationRate', 'energyRequested', 'energyGenerated', 'energyOverflow',
  'enhancedAvailableCount', 'enhancedUseCount', 'enhancedConversionRate'
];

function renderCsv(rows, columns) {
  return '\uFEFF' + [columns.join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\n') + '\n';
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function percent(value) { return value === null || value === undefined ? '-' : `${(value * 100).toFixed(2)}%`; }
function ratio(value, total) { return total > 0 ? value / total : 0; }
function nullable(value) { return value === null || value === undefined ? '-' : value; }
function formatValue(value) { return typeof value === 'number' && Math.abs(value) <= 1 ? percent(value) : nullable(value); }

async function runCli() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }));
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  const input = path.resolve(projectRoot, args.input ?? 'validation-artifacts/experience-summary.json');
  const outputDirectory = path.resolve(projectRoot, args.outputDir ?? 'validation-artifacts');
  const report = JSON.parse(await readFile(input, 'utf8'));
  await writeExperienceArtifacts(report, outputDirectory);
  process.stdout.write(`REPORT_DIR=${outputDirectory}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
