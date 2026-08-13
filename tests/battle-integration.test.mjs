import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');

test('battle integration exposes one stable mount boundary', async () => {
  const source = await readFile(path.join(projectRoot, 'src/battleIntegration.ts'), 'utf8');
  for (const contract of ['mountBattle', 'playerParticipants', 'onBattleEnd', 'onResultAction', 'createPlayerSnapshot', 'stop']) {
    assert.match(source, new RegExp(contract));
  }

  assert.match(source, /export function mountBattle/);
  assert.match(source, /new BattleGame/);
  assert.match(source, /new BattleUI/);
});

test('the demo flow consumes the same integration entry', async () => {
  const source = await readFile(path.join(projectRoot, 'src/main.ts'), 'utf8');
  assert.match(source, /import \{ mountBattle \} from '\.\/battleIntegration'/);
  assert.match(source, /const mountedBattle = mountBattle\(/);
  assert.match(source, /mountedBattle\.stop\(\)/);
});
