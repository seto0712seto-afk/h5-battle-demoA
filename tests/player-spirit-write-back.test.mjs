import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import ts from 'typescript';
import { createServer } from 'vite';
import { loadPlayerSpiritWriteBackHarness } from './support/player-spirit-write-back-harness.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const canonicalDataPath = path.join(projectRoot, 'src', 'data.ts');
const canonicalTypesPath = path.join(projectRoot, 'src', 'types.ts');
const fixtureDirectories = new Set();
let canonicalDataBefore;
let server;
let writer;
let writerHarness;

before(async () => {
  canonicalDataBefore = await readFile(canonicalDataPath, 'utf8');
  server = await createServer({ configFile: false, cacheDir: '.vite-cache', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  writer = await server.ssrLoadModule('/src/playerSpiritAuthoringWriter.ts');
  writerHarness = await loadPlayerSpiritWriteBackHarness(server);
});

afterEach(async () => {
  await Promise.all([...fixtureDirectories].map(async (directory) => {
    fixtureDirectories.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }));
});

after(async () => {
  await server?.close();
  assert.equal(await readFile(canonicalDataPath, 'utf8'), canonicalDataBefore);
});

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 's4b-2a-'));
  fixtureDirectories.add(directory);
  const sourcePath = path.join(directory, 'data.ts');
  await copyFile(canonicalDataPath, sourcePath);
  await copyFile(canonicalTypesPath, path.join(directory, 'types.ts'));
  return { directory, sourcePath };
}

async function readSnapshot(sourcePath) {
  const result = await writerHarness.readSourceAtPath(sourcePath);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.snapshot;
}

function spirit(snapshot, id) {
  return snapshot.spirits.find((definition) => definition.id === id);
}

function differingLineIndexes(before, after) {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const indexes = [];
  for (let index = 0; index < Math.max(beforeLines.length, afterLines.length); index += 1) {
    if (beforeLines[index] !== afterLines[index]) indexes.push(index);
  }
  return indexes;
}

function assertFixtureTypeChecks(sourcePath) {
  const program = ts.createProgram([sourcePath, path.join(path.dirname(sourcePath), 'types.ts')], {
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

async function writeFromSnapshot(sourcePath, snapshot, id, changes, hooks) {
  return writerHarness.writeUpdateAtPath({
    sourcePath,
    expectedRevision: snapshot.revision,
    candidate: { kind: 'playerSpirit', id, changes },
    hooks
  });
}

test('production API owns src/data.ts and ignores caller-supplied source paths', async () => {
  const { sourcePath } = await createFixture();
  const canonicalBefore = await readFile(canonicalDataPath, 'utf8');
  const fixtureOnlyText = `${await readFile(sourcePath, 'utf8')}\r\n// fixture-only revision\r\n`;
  await writeFile(sourcePath, fixtureOnlyText, 'utf8');
  const fixtureSnapshot = await readSnapshot(sourcePath);
  const productionSnapshot = await writer.readPlayerSpiritAuthoringSource();

  assert.equal(productionSnapshot.ok, true);
  assert.equal(productionSnapshot.snapshot.sourcePath, path.resolve(canonicalDataPath));
  assert.equal(writer.PLAYER_SPIRIT_CANONICAL_SOURCE_PATH, path.resolve(canonicalDataPath));
  assert.deepEqual(
    Object.keys(writer).sort(),
    ['PLAYER_SPIRIT_CANONICAL_SOURCE_PATH', 'readPlayerSpiritAuthoringSource', 'writePlayerSpiritAuthoringUpdate']
  );

  const result = await writer.writePlayerSpiritAuthoringUpdate({
    sourcePath,
    expectedRevision: fixtureSnapshot.revision,
    candidate: { kind: 'playerSpirit', id: 'P01', changes: { name: 'must-not-write-fixture' } }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale-source');
  assert.equal(result.sourceState, 'not-modified');
  assert.equal(await readFile(canonicalDataPath, 'utf8'), canonicalBefore);
  assert.equal(await readFile(sourcePath, 'utf8'), fixtureOnlyText);
});

test('writes one Player Spirit text field with a one-line source diff', async () => {
  const { sourcePath } = await createFixture();
  const beforeText = await readFile(sourcePath, 'utf8');
  const before = await readSnapshot(sourcePath);
  const beforeP01 = structuredClone(spirit(before, 'P01'));

  const result = await writeFromSnapshot(sourcePath, before, 'P01', { name: '炽刃狐·测试' });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.sourceState, 'updated');

  const afterText = await readFile(sourcePath, 'utf8');
  const afterP01 = spirit(result.snapshot, 'P01');
  assert.equal(afterP01.editable.name, '炽刃狐·测试');
  assert.equal(afterP01.id, beforeP01.id);
  assert.deepEqual(afterP01.readOnly.skillIds, beforeP01.readOnly.skillIds);
  assert.equal(differingLineIndexes(beforeText, afterText).length, 1);
  assert.equal(afterText.slice(afterText.indexOf('export const SKILLS')), beforeText.slice(beforeText.indexOf('export const SKILLS')));
});

test('round-trips authoring strings through AST, disk, TypeScript and DTO semantics', async (t) => {
  const cases = [
    ['double quote', '双引号 "内容"'],
    ['single quote', "单引号 '内容'"],
    ['backslash', '路径 C:\\Battle\\Spirits\\P01'],
    ['real LF newline', `第一行
第二行`],
    ['CRLF content', '甲行\r\n乙行'],
    ['Unicode', '月玲灵✨𠮷野家族e\u0301'],
    ['combined', `组合 "双引号"、'单引号'、C:\\Battle\\P01\r\n第二行
第三行✨𠮷e\u0301`]
  ];

  for (const [label, input] of cases) {
    await t.test(label, async () => {
      const { sourcePath } = await createFixture();
      const snapshot = await readSnapshot(sourcePath);
      const result = await writeFromSnapshot(sourcePath, snapshot, 'P01', { playTip: input });
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(spirit(result.snapshot, 'P01').editable.playTip, input);

      const diskSnapshot = await readSnapshot(sourcePath);
      assert.equal(spirit(diskSnapshot, 'P01').editable.playTip, input);
      assertFixtureTypeChecks(sourcePath);
    });
  }
});

test('writes one stat and reloads the exact value from disk', async () => {
  const { sourcePath } = await createFixture();
  const before = await readSnapshot(sourcePath);
  const result = await writeFromSnapshot(sourcePath, before, 'P02', { maxHp: 321 });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const reloaded = await readSnapshot(sourcePath);
  assert.equal(spirit(reloaded, 'P02').editable.maxHp, 321);
  assert.equal(reloaded.revision, result.snapshot.revision);
});

test('writes multiple allowed fields while preserving IDs, skillIds, other Spirits and SKILLS', async () => {
  const { sourcePath } = await createFixture();
  const beforeText = await readFile(sourcePath, 'utf8');
  const before = await readSnapshot(sourcePath);
  const result = await writeFromSnapshot(sourcePath, before, 'P01', {
    primaryRole: 'protect',
    secondaryRole: 'energy',
    physicalDefense: 144,
    defaultPosition: 'front',
    playTip: '隔离 fixture 测试。'
  });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const after = await readSnapshot(sourcePath);
  const changed = spirit(after, 'P01');
  assert.equal(changed.id, 'P01');
  assert.deepEqual(changed.readOnly.skillIds, spirit(before, 'P01').readOnly.skillIds);
  assert.equal(changed.editable.secondaryRole, 'energy');
  assert.equal(changed.editable.physicalDefense, 144);
  for (const definition of before.spirits.filter((entry) => entry.id !== 'P01')) {
    assert.deepEqual(spirit(after, definition.id), definition);
  }
  const afterText = await readFile(sourcePath, 'utf8');
  assert.equal(afterText.slice(afterText.indexOf('export const SKILLS')), beforeText.slice(beforeText.indexOf('export const SKILLS')));
  assertFixtureTypeChecks(sourcePath);
});

test('removes optional secondaryRole through a structured property edit', async () => {
  const { sourcePath } = await createFixture();
  const before = await readSnapshot(sourcePath);
  const result = await writeFromSnapshot(sourcePath, before, 'P02', { secondaryRole: null });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const reloaded = await readSnapshot(sourcePath);
  assert.equal(Object.hasOwn(spirit(reloaded, 'P02').editable, 'secondaryRole'), false);
  assertFixtureTypeChecks(sourcePath);
});

test('S4B-1 validation blocks forbidden, unsupported, unknown and non-finite updates before writing', async () => {
  const { sourcePath } = await createFixture();
  const beforeText = await readFile(sourcePath, 'utf8');
  const snapshot = await readSnapshot(sourcePath);
  const cases = [
    [{ kind: 'playerSpirit', id: 'P01', changes: { skillIds: [] } }, 'validation-failure', 'READ_ONLY_FIELD'],
    [{ kind: 'playerSpirit', id: 'P01', changes: { unknownField: true } }, 'validation-failure', 'UNSUPPORTED_FIELD'],
    [{ kind: 'playerSpirit', id: 'P404', changes: { name: 'x' } }, 'unknown-definition', 'UNKNOWN_DEFINITION'],
    [{ kind: 'playerSpirit', id: 'P01', changes: { speed: Number.POSITIVE_INFINITY } }, 'validation-failure', 'NON_FINITE_NUMBER']
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
    assert.equal(result.recoveryPath, null);
    assert.equal(result.diagnostics[0].code, code);
    assert.equal(await readFile(sourcePath, 'utf8'), beforeText);
  }
});

test('rejects Enemy validated updates at the S4B-2A writer boundary', async () => {
  const { sourcePath } = await createFixture();
  const beforeText = await readFile(sourcePath, 'utf8');
  const snapshot = await readSnapshot(sourcePath);
  const result = await writerHarness.writeUpdateAtPath({
    sourcePath,
    expectedRevision: snapshot.revision,
    candidate: { kind: 'enemyMonster', id: 'MAGE_BOSS', changes: { name: 'x' } }
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'validation-failure');
  assert.equal(result.sourceState, 'not-modified');
  assert.equal(result.diagnostics[0].code, 'UNSUPPORTED_DEFINITION_KIND');
  assert.equal(await readFile(sourcePath, 'utf8'), beforeText);
});

test('simulated temp write failure leaves canonical fixture byte-identical', async () => {
  const { directory, sourcePath } = await createFixture();
  const beforeText = await readFile(sourcePath, 'utf8');
  const snapshot = await readSnapshot(sourcePath);
  const result = await writeFromSnapshot(sourcePath, snapshot, 'P01', { maxHp: 999 }, {
    beforeTempWrite() {
      throw new Error('simulated temp write failure');
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'filesystem-failure');
  assert.equal(result.diagnostics[0].code, 'FILESYSTEM_FAILURE');
  assert.equal(result.sourceState, 'not-modified');
  assert.equal(result.recoveryPath, null);
  assert.equal(await readFile(sourcePath, 'utf8'), beforeText);
  assert.deepEqual((await readdir(directory)).sort(), ['data.ts', 'types.ts']);
});

test('post-write verification failure atomically restores the original fixture', async () => {
  const { directory, sourcePath } = await createFixture();
  const beforeText = await readFile(sourcePath, 'utf8');
  const snapshot = await readSnapshot(sourcePath);
  const result = await writeFromSnapshot(sourcePath, snapshot, 'P01', { maxHp: 999 }, {
    beforePostWriteVerification() {
      throw new Error('simulated post-write verification failure');
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'post-write-verification-failure');
  assert.equal(result.diagnostics[0].code, 'POST_WRITE_VERIFICATION_FAILURE');
  assert.equal(result.sourceState, 'original-restored');
  assert.equal(result.recoveryPath, null);
  assert.equal(await readFile(sourcePath, 'utf8'), beforeText);
  assert.deepEqual((await readdir(directory)).sort(), ['data.ts', 'types.ts']);
});

test('rollback failure reports unknown final state and preserves both diagnostics', async () => {
  const { sourcePath } = await createFixture();
  const beforeText = await readFile(sourcePath, 'utf8');
  const snapshot = await readSnapshot(sourcePath);
  const result = await writeFromSnapshot(sourcePath, snapshot, 'P01', { maxHp: 999 }, {
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
  assert.notEqual(await readFile(sourcePath, 'utf8'), beforeText);
  assert.equal((await readFile(result.recoveryPath, 'utf8')), beforeText);
});

test('stale revision rejects overwrite and preserves the external source content', async () => {
  const { sourcePath } = await createFixture();
  const snapshot = await readSnapshot(sourcePath);
  const externallyChanged = `${await readFile(sourcePath, 'utf8')}\r\n// external edit\r\n`;
  await writeFile(sourcePath, externallyChanged, 'utf8');

  const result = await writeFromSnapshot(sourcePath, snapshot, 'P01', { name: 'stale overwrite' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale-source');
  assert.equal(result.diagnostics[0].code, 'STALE_SOURCE');
  assert.equal(result.sourceState, 'not-modified');
  assert.equal(await readFile(sourcePath, 'utf8'), externallyChanged);
});

test('malformed canonical source returns a structured parse failure without modification', async () => {
  const { sourcePath } = await createFixture();
  const malformed = 'export const SPIRITS = [';
  await writeFile(sourcePath, malformed, 'utf8');
  const revision = createHash('sha256').update(malformed, 'utf8').digest('hex');

  const result = await writerHarness.writeUpdateAtPath({
    sourcePath,
    expectedRevision: revision,
    candidate: { kind: 'playerSpirit', id: 'P01', changes: { name: 'x' } }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'source-parse-failure');
  assert.equal(result.diagnostics[0].code, 'SOURCE_PARSE_FAILURE');
  assert.equal(result.sourceState, 'not-modified');
  assert.equal(await readFile(sourcePath, 'utf8'), malformed);
});
