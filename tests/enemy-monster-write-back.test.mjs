import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import ts from 'typescript';
import { createServer } from 'vite';
import { loadEnemyMonsterWriteBackHarness } from './support/enemy-monster-write-back-harness.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const canonicalMonsterDataPath = path.join(projectRoot, 'src', 'monsterData.ts');
const canonicalDataPath = path.join(projectRoot, 'src', 'data.ts');
const canonicalMonsterTypesPath = path.join(projectRoot, 'src', 'monsterTypes.ts');
const canonicalTypesPath = path.join(projectRoot, 'src', 'types.ts');
const fixtureDirectories = new Set();
let canonicalMonsterDataBefore;
let canonicalDataBefore;
let server;
let writer;
let writerHarness;

before(async () => {
  [canonicalMonsterDataBefore, canonicalDataBefore] = await Promise.all([
    readFile(canonicalMonsterDataPath, 'utf8'),
    readFile(canonicalDataPath, 'utf8')
  ]);
  server = await createServer({ configFile: false, cacheDir: '.vite-cache', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  writer = await server.ssrLoadModule('/src/enemyMonsterAuthoringWriter.ts');
  writerHarness = await loadEnemyMonsterWriteBackHarness(server);
});

afterEach(async () => {
  await Promise.all([...fixtureDirectories].map(async (directory) => {
    fixtureDirectories.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }));
});

after(async () => {
  await server?.close();
  assert.equal(await readFile(canonicalMonsterDataPath, 'utf8'), canonicalMonsterDataBefore);
  assert.equal(await readFile(canonicalDataPath, 'utf8'), canonicalDataBefore);
});

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 's4b-2b-2-'));
  fixtureDirectories.add(directory);
  const sourcePath = path.join(directory, 'monsterData.ts');
  await Promise.all([
    copyFile(canonicalMonsterDataPath, sourcePath),
    copyFile(canonicalMonsterTypesPath, path.join(directory, 'monsterTypes.ts')),
    copyFile(canonicalTypesPath, path.join(directory, 'types.ts'))
  ]);
  return { directory, sourcePath };
}

async function readSnapshot(sourcePath) {
  const result = await writerHarness.readSourceAtPath(sourcePath);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.snapshot;
}

function definition(snapshot, id) {
  return snapshot.definitions.find((entry) => entry.id === id);
}

async function writeFromSnapshot(sourcePath, snapshot, id, changes, hooks) {
  return writerHarness.writeUpdateAtPath({
    sourcePath,
    expectedRevision: snapshot.revision,
    candidate: { kind: 'enemyMonster', id, changes },
    hooks
  });
}

function assertOnlyTargetChanged(before, after, targetId) {
  assert.deepEqual(after.locations, before.locations);
  assert.deepEqual(after.monsterSkills, before.monsterSkills);
  for (const prior of before.definitions) {
    if (prior.id === targetId) continue;
    assert.deepEqual(definition(after, prior.id), prior, prior.id);
  }
}

function assertFixtureTypeChecks(sourcePath) {
  const directory = path.dirname(sourcePath);
  const program = ts.createProgram([
    sourcePath,
    path.join(directory, 'monsterTypes.ts'),
    path.join(directory, 'types.ts')
  ], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    []
  );
}

test('production API is fixed to canonical monsterData.ts and exposes no arbitrary path writer', async () => {
  const { sourcePath } = await createFixture();
  const fixtureOnlyText = `${await readFile(sourcePath, 'utf8')}\r\n// fixture-only revision\r\n`;
  await writeFile(sourcePath, fixtureOnlyText, 'utf8');
  const fixtureSnapshot = await readSnapshot(sourcePath);
  const productionRead = await writer.readEnemyMonsterAuthoringSource();

  assert.equal(productionRead.ok, true, JSON.stringify(productionRead.diagnostics));
  assert.equal(productionRead.snapshot.sourcePath, path.resolve(canonicalMonsterDataPath));
  assert.equal(writer.ENEMY_MONSTER_CANONICAL_SOURCE_PATH, path.resolve(canonicalMonsterDataPath));
  assert.deepEqual(
    Object.keys(writer).sort(),
    ['ENEMY_MONSTER_CANONICAL_SOURCE_PATH', 'readEnemyMonsterAuthoringSource', 'writeEnemyMonsterAuthoringUpdate']
  );

  const result = await writer.writeEnemyMonsterAuthoringUpdate({
    sourcePath,
    expectedRevision: fixtureSnapshot.revision,
    candidate: { kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { name: 'must-not-write-fixture' } }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale-source');
  assert.equal(result.sourceState, 'not-modified');
  assert.equal(await readFile(canonicalMonsterDataPath, 'utf8'), canonicalMonsterDataBefore);
  assert.equal(await readFile(sourcePath, 'utf8'), fixtureOnlyText);
});

test('all 26 canonical IDs have one structured Theme or direct source locator', async () => {
  const { sourcePath } = await createFixture();
  const snapshot = await readSnapshot(sourcePath);
  assert.equal(snapshot.definitions.length, 26);
  assert.equal(snapshot.locations.length, 26);
  assert.equal(new Set(snapshot.locations.map((entry) => entry.id)).size, 26);
  assert.equal(snapshot.locations.filter((entry) => entry.sourceKind === 'theme-config').length, 18);
  assert.equal(snapshot.locations.filter((entry) => entry.sourceKind === 'direct-boss').length, 8);
  assert.deepEqual(
    snapshot.locations.map((entry) => entry.id),
    snapshot.definitions.map((entry) => entry.id)
  );
});

test('writes every Enemy field class to one Theme config without changing any other content', async () => {
  const { sourcePath } = await createFixture();
  const before = await readSnapshot(sourcePath);
  const input = `组合 "双引号"、'单引号'、C:\\Battle\\Enemy\r\n第二行
第三行✨𠮷e\u0301`;
  const changes = {
    name: input,
    level: 7,
    category: 'elite',
    role: 'shooter',
    defaultPosition: 'back',
    baseHp: 777,
    coefficients: {
      physicalAttack: 1.11,
      physicalDefense: 1.22,
      magicAttack: 1.33,
      magicDefense: 1.44,
      speed: 1.55
    }
  };
  const result = await writeFromSnapshot(sourcePath, before, 'FORGE_GRUNT_WARRIOR', changes);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.sourceState, 'updated');

  const after = await readSnapshot(sourcePath);
  const target = definition(after, 'FORGE_GRUNT_WARRIOR');
  for (const [field, value] of Object.entries(changes)) assert.deepEqual(target[field], value, field);
  assert.deepEqual(target.skills, definition(before, 'FORGE_GRUNT_WARRIOR').skills);
  assertOnlyTargetChanged(before, after, 'FORGE_GRUNT_WARRIOR');
  assert.equal(definition(after, 'RANGE_GRUNT_WARRIOR').name, definition(before, 'RANGE_GRUNT_WARRIOR').name);
  assert.equal(definition(after, 'MAGE_GRUNT_WARRIOR').baseHp, definition(before, 'MAGE_GRUNT_WARRIOR').baseHp);
  assertFixtureTypeChecks(sourcePath);
});

test('writes representative Theme nodes from other themes and archetypes independently', async (t) => {
  const cases = [
    ['RANGE_ELITE_MAGE', { name: '裂风后继', coefficients: { speed: 1.23 } }],
    ['MAGE_GRUNT_SHOOTER', { level: 9, baseHp: 654, defaultPosition: 'front' }]
  ];
  for (const [id, changes] of cases) {
    await t.test(id, async () => {
      const { sourcePath } = await createFixture();
      const before = await readSnapshot(sourcePath);
      const result = await writeFromSnapshot(sourcePath, before, id, changes);
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      const after = await readSnapshot(sourcePath);
      assertOnlyTargetChanged(before, after, id);
      assertFixtureTypeChecks(sourcePath);
    });
  }
});

test('writes a direct Boss text, number and nested coefficient without changing other definitions', async () => {
  const { sourcePath } = await createFixture();
  const before = await readSnapshot(sourcePath);
  const result = await writeFromSnapshot(sourcePath, before, 'MAGE_BOSS', {
    name: '炽印法主·校验',
    baseHp: 2400,
    coefficients: { magicAttack: 2.75 }
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const after = await readSnapshot(sourcePath);
  assert.equal(definition(after, 'MAGE_BOSS').name, '炽印法主·校验');
  assert.equal(definition(after, 'MAGE_BOSS').baseHp, 2400);
  assert.equal(definition(after, 'MAGE_BOSS').coefficients.magicAttack, 2.75);
  assert.deepEqual(definition(after, 'MAGE_BOSS').skills, definition(before, 'MAGE_BOSS').skills);
  assert.deepEqual(definition(after, 'MAGE_BOSS').actionCycle, definition(before, 'MAGE_BOSS').actionCycle);
  assert.deepEqual(
    definition(after, 'MAGE_BOSS').temporaryPowerResponse,
    definition(before, 'MAGE_BOSS').temporaryPowerResponse
  );
  assertOnlyTargetChanged(before, after, 'MAGE_BOSS');
  assertFixtureTypeChecks(sourcePath);
});

test('removes and restores optional role through structured property edits', async () => {
  const { sourcePath } = await createFixture();
  const before = await readSnapshot(sourcePath);
  const removed = await writeFromSnapshot(sourcePath, before, 'FORGE_ELITE_WARRIOR', { role: null });
  assert.equal(removed.ok, true, JSON.stringify(removed.diagnostics));
  assert.equal(Object.hasOwn(definition(removed.snapshot, 'FORGE_ELITE_WARRIOR'), 'role'), false);
  assertFixtureTypeChecks(sourcePath);

  const restored = await writeFromSnapshot(sourcePath, removed.snapshot, 'FORGE_ELITE_WARRIOR', { role: 'warrior' });
  assert.equal(restored.ok, true, JSON.stringify(restored.diagnostics));
  assert.equal(definition(restored.snapshot, 'FORGE_ELITE_WARRIOR').role, 'warrior');
  assertFixtureTypeChecks(sourcePath);
});

test('semantic no-op preserves source bytes and revision without entering the transaction', async () => {
  const { sourcePath } = await createFixture();
  const beforeText = await readFile(sourcePath, 'utf8');
  const before = await readSnapshot(sourcePath);
  const target = definition(before, 'RANGE_GRUNT_MAGE');
  const result = await writeFromSnapshot(sourcePath, before, target.id, {
    name: target.name,
    coefficients: { speed: target.coefficients.speed }
  }, {
    beforeTempWrite() {
      throw new Error('no-op must not enter filesystem transaction');
    }
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.sourceState, 'not-modified');
  assert.equal(result.snapshot.revision, before.revision);
  assert.equal(await readFile(sourcePath, 'utf8'), beforeText);
});

test('S4B-1 validation rejects forbidden, invalid, non-finite, unknown and wrong-kind candidates before writing', async () => {
  const { sourcePath } = await createFixture();
  const beforeText = await readFile(sourcePath, 'utf8');
  const snapshot = await readSnapshot(sourcePath);
  const cases = [
    [{ kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { unknownField: true } }, 'validation-failure', 'UNSUPPORTED_FIELD'],
    [{ kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { id: 'RENAMED' } }, 'validation-failure', 'READ_ONLY_FIELD'],
    [{ kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { skills: [] } }, 'validation-failure', 'READ_ONLY_FIELD'],
    [{ kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { actionCycle: {} } }, 'validation-failure', 'READ_ONLY_FIELD'],
    [{ kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { aiPolicy: 'new' } }, 'validation-failure', 'UNSUPPORTED_FIELD'],
    [{ kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { level: '2' } }, 'validation-failure', 'INVALID_TYPE'],
    [{ kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { category: 'legendary' } }, 'validation-failure', 'INVALID_ENUM_VALUE'],
    [{ kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { baseHp: Number.POSITIVE_INFINITY } }, 'validation-failure', 'NON_FINITE_NUMBER'],
    [{ kind: 'enemyMonster', id: 'ENEMY_404', changes: { name: 'x' } }, 'unknown-definition', 'UNKNOWN_DEFINITION'],
    [{ kind: 'enemyMonster', id: 'constructor', changes: { name: 'x' } }, 'unknown-definition', 'UNKNOWN_DEFINITION'],
    [{ kind: 'enemyMonster', id: 'toString', changes: { name: 'x' } }, 'unknown-definition', 'UNKNOWN_DEFINITION'],
    [{ kind: 'enemyMonster', id: '__proto__', changes: { name: 'x' } }, 'unknown-definition', 'UNKNOWN_DEFINITION'],
    [{ kind: 'playerSpirit', id: 'P01', changes: { name: 'x' } }, 'validation-failure', 'UNSUPPORTED_DEFINITION_KIND']
  ];

  for (const [candidate, reason, code] of cases) {
    const result = await writerHarness.writeUpdateAtPath({
      sourcePath,
      expectedRevision: snapshot.revision,
      candidate
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(result.sourceState, 'not-modified');
    assert.equal(result.diagnostics[0].code, code);
    assert.equal(await readFile(sourcePath, 'utf8'), beforeText);
  }
});

test('stale revision rejects overwrite and preserves external source content', async () => {
  const { sourcePath } = await createFixture();
  const snapshot = await readSnapshot(sourcePath);
  const external = `${await readFile(sourcePath, 'utf8')}\n// external fixture revision\n`;
  await writeFile(sourcePath, external, 'utf8');
  const result = await writeFromSnapshot(sourcePath, snapshot, 'FORGE_GRUNT_MAGE', { name: 'stale' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale-source');
  assert.equal(result.sourceState, 'not-modified');
  assert.equal(await readFile(sourcePath, 'utf8'), external);
});

test('failure before replacement leaves the fixture byte-identical', async () => {
  const { sourcePath } = await createFixture();
  const beforeText = await readFile(sourcePath, 'utf8');
  const snapshot = await readSnapshot(sourcePath);
  const result = await writeFromSnapshot(sourcePath, snapshot, 'RANGE_ELITE_WARRIOR', { baseHp: 901 }, {
    beforeTempWrite() {
      throw new Error('simulated temp write failure');
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'filesystem-failure');
  assert.equal(result.sourceState, 'not-modified');
  assert.equal(result.recoveryPath, null);
  assert.equal(await readFile(sourcePath, 'utf8'), beforeText);
});

test('post-write verification failure restores the original fixture', async () => {
  const { directory, sourcePath } = await createFixture();
  const beforeText = await readFile(sourcePath, 'utf8');
  const snapshot = await readSnapshot(sourcePath);
  const result = await writeFromSnapshot(sourcePath, snapshot, 'RANGE_BOSS_SHOOTER', { baseHp: 2201 }, {
    beforePostWriteVerification() {
      throw new Error('simulated post-write verification failure');
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'post-write-verification-failure');
  assert.equal(result.sourceState, 'original-restored');
  assert.equal(result.recoveryPath, null);
  assert.equal(await readFile(sourcePath, 'utf8'), beforeText);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.tmp') || name.endsWith('.rollback')), []);
});

test('rollback failure reports unknown state and preserves both diagnostics and recovery copy', async () => {
  const { sourcePath } = await createFixture();
  const beforeText = await readFile(sourcePath, 'utf8');
  const snapshot = await readSnapshot(sourcePath);
  const result = await writeFromSnapshot(sourcePath, snapshot, 'RANGE_BOSS_SHOOTER', { baseHp: 2201 }, {
    beforePostWriteVerification() {
      throw new Error('simulated post-write verification failure');
    },
    beforeRollback() {
      throw new Error('simulated rollback failure');
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rollback-failure');
  assert.equal(result.sourceState, 'unknown');
  assert.deepEqual(result.diagnostics.map((entry) => entry.code), [
    'POST_WRITE_VERIFICATION_FAILURE', 'ROLLBACK_FAILURE'
  ]);
  assert.equal(typeof result.recoveryPath, 'string');
  assert.equal(await readFile(result.recoveryPath, 'utf8'), beforeText);
});

test('malformed fixture returns structured parse failure without modification', async () => {
  const { sourcePath } = await createFixture();
  const malformed = 'export const MONSTERS = {';
  await writeFile(sourcePath, malformed, 'utf8');
  const result = await writerHarness.readSourceAtPath(sourcePath);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'source-parse-failure');
  assert.equal(result.diagnostics[0].code, 'SOURCE_PARSE_FAILURE');
  assert.equal(await readFile(sourcePath, 'utf8'), malformed);
});
