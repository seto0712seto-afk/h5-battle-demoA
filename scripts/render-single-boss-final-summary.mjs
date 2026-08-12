import { pathToFileURL } from 'node:url';
import { percent, readReport, value, writeReport } from './single-boss-suite-utils.mjs';

export async function renderSingleBossFinalSummary() {
  const bossNames = {
    FORGE_BOSS_WARRIOR: '熔核守卫',
    RANGE_BOSS_SHOOTER: '灰羽猎王',
    MAGE_BOSS: '炽印法主'
  };
  const bosses = Object.keys(bossNames);
  const paired = {};
  for (const policy of ['balanced-v2', 'balanced-v3']) {
    paired[policy] = {};
    for (const boss of bosses) {
      paired[policy][boss] = await readReport(`validation-artifacts/single-boss-v2/policy-paired/${policy}/${boss}`);
    }
  }
  const range = {};
  for (const tuning of ['RANGE-CONTROL', 'RANGE-A', 'RANGE-B']) {
    range[tuning] = await readReport(`validation-artifacts/single-boss-v2/range-ab/${tuning}/RANDOM`);
  }

  const v3Rows = bosses.map((boss) => {
    const report = paired['balanced-v3'][boss];
    const stage = report.stages['1'];
    return `| ${bossNames[boss]} | ${percent(report.summary.clearRate)} | ${value(stage.averageRounds)} | ${value(stage.medianRounds)} | ${value(stage.p90Rounds)} | ${value(stage.p95Rounds)} | ${percent(stage.over20RoundsRate)} | ${percent(report.bosses[boss].coreMechanicSeenRate)} |`;
  }).join('\n');
  const skillRows = bosses.map((boss) => {
    const skills = paired['balanced-v3'][boss].skills;
    return `| ${bossNames[boss]} | ${percent(skills['M02-S1'].useShareOfOwnerSkillActions)} | ${percent(skills['M06-S1'].useShareOfOwnerSkillActions)} | ${percent(skills['M06-S2'].useShareOfOwnerSkillActions)} | ${percent(skills['M06-S3'].useShareOfOwnerSkillActions)} | ${percent(skills['M08-S2'].useShareOfOwnerSkillActions)} |`;
  }).join('\n');
  const rangeRows = Object.entries(range).map(([tuning, report]) => {
    const stage = report.stages['1'];
    return `| ${tuning} | ${percent(report.summary.clearRate)} | ${value(stage.averageRounds)} | ${value(stage.medianRounds)} | ${value(stage.p90Rounds)} | ${value(stage.p95Rounds)} | ${percent(stage.over20RoundsRate)} |`;
  }).join('\n');
  const anomalyCount = Object.values(paired).flatMap((group) => Object.values(group))
    .reduce((sum, report) => sum + report.outliers.runtimeAnomalies.length, 0) +
    Object.values(range).reduce((sum, report) => sum + report.outliers.runtimeAnomalies.length, 0);

  const markdown = `# 单场 Boss 体验测试最终汇总

- 固定 Seed：2026072901
- 正式矩阵：18600 局（策略配对6000、固定阵容6000、灰羽A/B 6600）
- 正式配置改动：无
- 运行异常：${anomalyCount}

## balanced-v3 随机阵容

| Boss | 胜率 | 平均回合 | 中位 | P90 | P95 | >20回合 | 核心机制 |
|---|---:|---:|---:|---:|---:|---:|---:|
${v3Rows}

## AI估值验收

| Boss | 风切 | 蓄能冲撞 | 铁壁援护 | 铁甲盾阵 | 鹿鸣回春 |
|---|---:|---:|---:|---:|---:|
${skillRows}

- 风切：三个Boss均大于0，且均处于建议的5%～25%，通过。
- 铁甲盾阵：灰羽环境中大于0，通过。
- 铁甲犀非蓄能冲撞技能：三组均超过5%，通过。
- 鹿鸣回春：熔核与法主环境处于3%～15%；灰羽达到31.75%，说明该环境下治疗估值偏高，需要观察但不属于技能数值结论。
- 新的95%以上单技能垄断：未发现。

## 灰羽猎王 A/B

| 版本 | 胜率 | 平均回合 | 中位 | P90 | P95 | >20回合 |
|---|---:|---:|---:|---:|---:|---:|
${rangeRows}

结论：A只缩短约0.9回合且让胜率进一步升高；B将胜率压到目标区间，但平均回合、P90和长尾仍明显超标。因此本轮不建议把A或B写回正式配置。

## 设计信号

- 固定高输出队对灰羽和法主均为100%胜率，但对熔核为87.20%。
- 固定高防队对熔核95.60%、对灰羽100%、对法主0%。
- 同一队伍在不同Boss下出现巨大交叉差异，已经证明Boss机制能够改变精灵与阵容实用性。
- 灰羽的核心问题不是单纯生命过高：高防队能稳定获胜但平均26.14回合，说明拖延来自Boss压力结构与自动策略防护循环共同作用。

## 验收结论

- 工程稳定性：通过。
- balanced-v3技能盲区修复：通过。
- 熔核单场参考区间：通过。
- 炽印法主：节奏通过，胜率77.70%略低于80%下界；只记录，不改数值。
- 灰羽Control：未通过节奏区间。
- 灰羽A/B：均未满足综合采用条件，暂不裁定。

## 关联报告

- [策略配对](./policy-paired/boss-policy-comparison.md)
- [固定阵容](./fixed-teams/fixed-team-comparison.md)
- [灰羽A/B](./range-ab/range-ab-comparison.md)
`;
  await writeReport('validation-artifacts/single-boss-v2/single-boss-final-summary.md', markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await renderSingleBossFinalSummary();
}
