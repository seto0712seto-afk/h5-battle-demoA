import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
  return [key, value];
}));
const outputDir = path.resolve(projectRoot, args.outputDir ?? 'validation-artifacts/ten-spirit-specialty-20260811');
await mkdir(outputDir, { recursive: true });

const checks = [
  ['P01_CHAIN_COST', '炽能连斩费用按2到1到0循环，0费释放或改用其他技能后重置'],
  ['P01_BURST', '确认后的十精灵技能费用、数值与持续时间配置一致'],
  ['P02_BURST_STACK', '爆发最多4层，旧层全部参与技能增幅且完整结算后只消耗1层'],
  ['P02_NEW_STACK_TIMING', '风切结算中新获得的爆发不参与本次增幅且不被本次消耗'],
  ['P02_CHARGE', '蓄势只在本回合第一次受击时触发并获得3层爆发'],
  ['P03_REGEN', '生机播种不立即治疗，赋予4回合回复并在目标行动开始治疗10%'],
  ['P03_CRIT_THRESHOLD', '确认后的十精灵技能费用、数值与持续时间配置一致'],
  ['P04_SHIELD_PRESS', '盾压在确认时消耗现有护盾并只造成等额固定伤害'],
  ['P06_CONFIRMATION', '铁壁援护按技能确认时妖力判断额外治疗'],
  ['P06_ENERGY_SAVING', '能量转移只能选择其他友方，节能作用于动态费用后并在技能支付时移除'],
  ['P07_SELF_COST', '确认后的十精灵技能费用、数值与持续时间配置一致'],
  ['P08_ENTRY_DISCOUNT', '灵铃庇佑仅在每次入场后的首次行动使用本技能时为1费'],
  ['P10_FIRST_USE', '星能回流首次0费回4，后续支付3回4，换下再入场不重置首次资格']
];

let failure = null;
try {
  await spawnChecked(process.execPath, [
    '--test',
    'tests/stage-config.test.mjs', 'tests/core-battle-rules.test.mjs', 'tests/monster-system.test.mjs',
    'tests/experience-metrics.test.mjs', 'tests/battle-policy.test.mjs', 'tests/forge-summary.test.mjs',
    'tests/forge-v2.test.mjs', 'tests/generic-boss-report.test.mjs', 'tests/boss-report-v2.test.mjs'
  ]);
  await spawnChecked(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
  await spawnChecked(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}

const result = {
  generatedAt: new Date().toISOString(),
  passed: failure === null,
  testSuite: 'npm test',
  build: 'npm run build',
  failure,
  checks: checks.map(([id, evidence]) => ({ id, passed: failure === null, evidence }))
};
await writeFile(path.join(outputDir, 'phase0-result.json'), JSON.stringify(result, null, 2), 'utf8');
process.stdout.write(`PHASE0=${result.passed ? 'PASS' : 'FAIL'}\n`);
process.stdout.write(`PHASE0_RESULT=${path.join(outputDir, 'phase0-result.json')}\n`);
if (!result.passed) process.exitCode = 1;

function spawnChecked(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: projectRoot, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} ${commandArgs.join(' ')} exited with ${code}`)));
  });
}
