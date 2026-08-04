import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCombatEventsV2, validateCombatEventsV2 } from './boss-report-v2/event-v2.mjs';
import { loadCombatRuntime } from './boss-report-v2/runtime-loader.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
  return [key, value];
}));
if (!args.input || !args.output) throw new Error('Usage: node scripts/migrate-v1-trace-to-v2.mjs --input=<diagnostic-trace.json> --output=<combat-events-v2.json>');

const input = path.resolve(projectRoot, args.input);
const output = path.resolve(projectRoot, args.output);
const metadata = path.resolve(projectRoot, args.metadata ?? 'config/combat-metadata-v2.json');
const runtime = await loadCombatRuntime(projectRoot, metadata);
const traces = JSON.parse(await readFile(input, 'utf8'));
const battles = traces.map((trace, index) => {
  const battleId = String(trace.battleId ?? `${args.groupId ?? 'MIGRATED'}:${trace.seed ?? index + 1}`);
  const events = toCombatEventsV2({ ...trace, battleId }, {
    rulesetId: args.rulesetId ?? 'system1-current',
    experimentId: args.experimentId ?? 'CURRENT-BASELINE',
    groupId: args.groupId ?? 'MIGRATED'
  }, runtime.metadataRegistry);
  return { battleId, seed: trace.seed, events, validationIssues: validateCombatEventsV2(events) };
});
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ schemaVersion: '2.0.0', source: input, metadataHash: runtime.metadataRegistry.hash, battles }, null, 2), 'utf8');
const issueCount = battles.reduce((sum, battle) => sum + battle.validationIssues.length, 0);
process.stdout.write(`MIGRATED_BATTLES=${battles.length}\nVALIDATION_ISSUES=${issueCount}\nOUTPUT=${output}\n`);
