const forwarded = process.argv.slice(2).map((argument) => argument.startsWith('--boss=')
  ? argument.replace('--boss=', '--bossId=')
  : argument);

const values = Object.fromEntries(forwarded.map((argument) => {
  const [key, value = 'true'] = argument.replace(/^--/, '').split('=');
  return [key, value];
}));

if (!values.bossId) throw new Error('Single Boss simulation requires --boss.');
if (!values.output) forwarded.push(`--output=../validation-artifacts/single-boss-v2/${values.bossId}/${values.policy ?? 'balanced-v3'}/raw-summary.json`);
if (!values.artifactDir) forwarded.push(`--artifactDir=../validation-artifacts/single-boss-v2/${values.bossId}/${values.policy ?? 'balanced-v3'}/`);
if (!values.experience) forwarded.push('--experience=true');
if (!values.policy) forwarded.push('--policy=balanced-v3');

process.argv = [process.argv[0], process.argv[1], ...forwarded];
await import('./simulate-random-dungeon.mjs');
