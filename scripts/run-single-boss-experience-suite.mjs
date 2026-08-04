import { spawn } from 'node:child_process';
import { projectRoot } from './single-boss-suite-utils.mjs';
import { renderSingleBossFinalSummary } from './render-single-boss-final-summary.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
  return [key, value];
}));
const seed = Number(args.seed ?? 2026072901);

await run('scripts/run-boss-policy-paired.mjs', [`--runs=${Number(args.policyRuns ?? 1000)}`, `--seed=${seed}`]);
await run('scripts/run-boss-fixed-teams.mjs', [`--runs=${Number(args.fixedRuns ?? 500)}`, `--seed=${seed}`]);
await run('scripts/run-range-boss-ab.mjs', [
  `--runs=${Number(args.rangeRuns ?? 1000)}`,
  `--fixedRuns=${Number(args.rangeFixedRuns ?? 300)}`,
  `--seed=${seed}`
]);

await renderSingleBossFinalSummary();

function run(script, extraArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...extraArgs], { cwd: projectRoot, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${script} exited with ${code}`)));
  });
}
