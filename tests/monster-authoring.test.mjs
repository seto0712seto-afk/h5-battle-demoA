import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let server;
let authoring;
let data;
let monsterData;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  authoring = await server.ssrLoadModule('/src/battleMonsterAuthoring.ts');
  data = await server.ssrLoadModule('/src/data.ts');
  monsterData = await server.ssrLoadModule('/src/monsterData.ts');
});

after(async () => {
  await server?.close();
});

test('S4B-1 preserves its explicit editable and read-only field contract', () => {
  const { playerSpirit, enemyMonster } = authoring.BATTLE_MONSTER_AUTHORING_CONTRACT.definitionKinds;
  assert.equal(authoring.BATTLE_MONSTER_AUTHORING_CONTRACT.version, 'S4B-1');
  assert.deepEqual(playerSpirit.editableFields, [
    'name', 'primaryRole', 'secondaryRole', 'maxHp', 'physicalAttack', 'physicalDefense',
    'magicAttack', 'magicDefense', 'speed', 'accent', 'defaultPosition', 'shortDescription',
    'battleStyle', 'playTip'
  ]);
  assert.deepEqual(playerSpirit.readOnlyFields, ['id', 'skillIds']);
  assert.deepEqual(
    enemyMonster.editableFields,
    ['name', 'level', 'category', 'role', 'defaultPosition', 'coefficients', 'baseHp']
  );
  assert.deepEqual(
    enemyMonster.readOnlyFields,
    ['id', 'skills', 'actionCycle', 'temporaryPowerResponse']
  );
});

test('authoring DTOs are JSON-safe detached views of canonical definitions', () => {
  const spiritBefore = structuredClone(data.SPIRITS[0]);
  const mageBefore = structuredClone(monsterData.MONSTERS.MAGE_BOSS);
  const definitions = authoring.getBattleMonsterAuthoringDefinitions();
  const spirit = definitions.find((entry) => entry.kind === 'playerSpirit' && entry.id === 'P01');
  const mage = definitions.find((entry) => entry.kind === 'enemyMonster' && entry.id === 'MAGE_BOSS');

  assert.equal(definitions.length, data.SPIRITS.length + Object.keys(monsterData.MONSTERS).length);
  assert.doesNotThrow(() => JSON.stringify(definitions));
  assert.deepEqual(spirit.readOnly.skillIds, data.SPIRITS[0].skillIds);
  assert.deepEqual(mage.readOnly.skills, monsterData.MONSTERS.MAGE_BOSS.skills);
  assert.deepEqual(mage.readOnly.actionCycle, monsterData.MONSTERS.MAGE_BOSS.actionCycle);
  assert.deepEqual(mage.readOnly.temporaryPowerResponse, monsterData.MONSTERS.MAGE_BOSS.temporaryPowerResponse);

  spirit.editable.name = 'detached';
  spirit.readOnly.skillIds.push('detached');
  mage.editable.coefficients.speed = 999;
  mage.readOnly.skills[0].weight = 999;
  mage.readOnly.actionCycle.countedSkillIds.push('detached');

  assert.deepEqual(data.SPIRITS[0], spiritBefore);
  assert.deepEqual(monsterData.MONSTERS.MAGE_BOSS, mageBefore);
});

test('individual DTO lookup returns existing definitions and null for unknown IDs', () => {
  assert.equal(authoring.getPlayerSpiritAuthoringDefinition('P02').editable.name, '逐风隼');
  assert.equal(authoring.getEnemyMonsterAuthoringDefinition('FORGE_GRUNT_WARRIOR').editable.category, 'minor');
  assert.equal(authoring.getPlayerSpiritAuthoringDefinition('UNKNOWN'), null);
  assert.equal(authoring.getEnemyMonsterAuthoringDefinition('UNKNOWN'), null);
});

test('prototype-chain keys are never Enemy canonical IDs', () => {
  for (const id of ['constructor', 'toString', '__proto__']) {
    assert.equal(authoring.getEnemyMonsterAuthoringDefinition(id), null);

    const result = authoring.validateBattleMonsterAuthoringUpdate({
      kind: 'enemyMonster', id, changes: { name: 'x' }
    });
    assert.equal(result.ok, false);
    assert.equal(result.update, null);
    assert.deepEqual(result.diagnostics.map(({ code, path }) => ({ code, path })), [
      { code: 'UNKNOWN_DEFINITION', path: 'id' }
    ]);
  }
});

test('Player Spirit and Enemy Monster canonical ID spaces remain kind-isolated', () => {
  for (const candidate of [
    { kind: 'enemyMonster', id: 'P01', changes: { name: 'x' } },
    { kind: 'playerSpirit', id: 'MAGE_BOSS', changes: { name: 'x' } }
  ]) {
    const result = authoring.validateBattleMonsterAuthoringUpdate(candidate);
    assert.equal(result.ok, false);
    assert.equal(result.update, null);
    assert.deepEqual(result.diagnostics.map(({ code, path }) => ({ code, path })), [
      { code: 'UNKNOWN_DEFINITION', path: 'id' }
    ]);
  }
});

test('candidate control fields must be own properties', () => {
  const inheritedCandidate = Object.create({
    kind: 'enemyMonster', id: 'MAGE_BOSS', changes: { name: 'inherited' }
  });
  const result = authoring.validateBattleMonsterAuthoringUpdate(inheritedCandidate);

  assert.equal(result.ok, false);
  assert.equal(result.update, null);
  assert.deepEqual(result.diagnostics.map((entry) => entry.code), [
    'UNKNOWN_DEFINITION_KIND', 'INVALID_TYPE', 'INVALID_TYPE'
  ]);
});

test('valid Player Spirit candidates produce a controlled validated patch', () => {
  const candidate = {
    kind: 'playerSpirit',
    id: 'P01',
    changes: {
      name: '新名字',
      primaryRole: 'protect',
      secondaryRole: null,
      maxHp: -10,
      speed: 0,
      defaultPosition: 'front',
      accent: '#000000'
    }
  };
  const candidateBefore = structuredClone(candidate);
  const result = authoring.validateBattleMonsterAuthoringUpdate(candidate);

  assert.deepEqual(result, {
    ok: true,
    update: { kind: 'playerSpirit', id: 'P01', changes: candidate.changes },
    diagnostics: []
  });
  assert.deepEqual(candidate, candidateBefore);
});

test('valid Enemy Monster candidates accept partial coefficients without balance rules', () => {
  const candidate = {
    kind: 'enemyMonster',
    id: 'MAGE_BOSS',
    changes: {
      level: -3,
      category: 'elite',
      role: null,
      defaultPosition: 'front',
      coefficients: { magicAttack: -2, speed: 0 },
      baseHp: 0
    }
  };
  const candidateBefore = structuredClone(candidate);
  const canonicalBefore = structuredClone(monsterData.MONSTERS.MAGE_BOSS);
  const result = authoring.validateBattleMonsterAuthoringUpdate(candidate);

  assert.deepEqual(result, {
    ok: true,
    update: {
      kind: 'enemyMonster',
      id: 'MAGE_BOSS',
      changes: {
        level: -3,
        baseHp: 0,
        category: 'elite',
        role: null,
        defaultPosition: 'front',
        coefficients: { magicAttack: -2, speed: 0 }
      }
    },
    diagnostics: []
  });

  result.update.changes.coefficients.speed = 777;
  assert.deepEqual(candidate, candidateBefore);
  assert.deepEqual(monsterData.MONSTERS.MAGE_BOSS, canonicalBefore);
});

test('individual and listed Enemy DTO nested values do not alias canonical definitions', () => {
  const canonicalBefore = structuredClone(monsterData.MONSTERS.MAGE_BOSS);
  const individual = authoring.getEnemyMonsterAuthoringDefinition('MAGE_BOSS');
  const listed = authoring.getBattleMonsterAuthoringDefinitions()
    .find((entry) => entry.kind === 'enemyMonster' && entry.id === 'MAGE_BOSS');

  individual.editable.coefficients.magicAttack = 999;
  individual.readOnly.skills[0].weight = 999;
  individual.readOnly.actionCycle.countedSkillIds.push('individual');
  individual.readOnly.temporaryPowerResponse.reductionPerPlayerAttack = 999;
  listed.editable.coefficients.speed = 999;
  listed.readOnly.skills[0].weight = 999;
  listed.readOnly.actionCycle.countedSkillIds.push('listed');
  listed.readOnly.temporaryPowerResponse.reductionPerPlayerAttack = 999;

  assert.deepEqual(monsterData.MONSTERS.MAGE_BOSS, canonicalBefore);
});

test('unknown definitions are rejected with structured diagnostics', () => {
  for (const candidate of [
    { kind: 'playerSpirit', id: 'P404', changes: { name: 'x' } },
    { kind: 'enemyMonster', id: 'ENEMY_404', changes: { name: 'x' } }
  ]) {
    const result = authoring.validateBattleMonsterAuthoringUpdate(candidate);
    assert.equal(result.ok, false);
    assert.equal(result.update, null);
    assert.equal(result.diagnostics[0].severity, 'error');
    assert.equal(result.diagnostics[0].code, 'UNKNOWN_DEFINITION');
    assert.equal(result.diagnostics[0].path, 'id');
  }
});

test('canonical IDs and battle-owned skill or AI structures are read-only', () => {
  const cases = [
    [{ kind: 'playerSpirit', id: 'P01', changes: { id: 'P02', skillIds: [] } }, ['id', 'skillIds']],
    [{
      kind: 'enemyMonster',
      id: 'MAGE_BOSS',
      changes: { id: 'OTHER', skills: [], actionCycle: {}, temporaryPowerResponse: {} }
    }, ['id', 'skills', 'actionCycle', 'temporaryPowerResponse']]
  ];

  for (const [candidate, fields] of cases) {
    const result = authoring.validateBattleMonsterAuthoringUpdate(candidate);
    assert.equal(result.ok, false);
    assert.equal(result.update, null);
    assert.deepEqual(result.diagnostics.map((entry) => entry.code), fields.map(() => 'READ_ONLY_FIELD'));
    assert.deepEqual(result.diagnostics.map((entry) => entry.path), fields.map((field) => `changes.${field}`));
  }
});

test('unsupported fields are rejected at candidate, changes, and coefficient levels', () => {
  const result = authoring.validateBattleMonsterAuthoringUpdate({
    kind: 'enemyMonster',
    id: 'MAGE_BOSS',
    changes: { ai: 'aggressive', stageIds: [], coefficients: { speed: 1, luck: 99 } },
    writeBack: true
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map(({ code, path }) => ({ code, path })), [
    { code: 'UNSUPPORTED_FIELD', path: 'writeBack' },
    { code: 'UNSUPPORTED_FIELD', path: 'changes.ai' },
    { code: 'UNSUPPORTED_FIELD', path: 'changes.stageIds' },
    { code: 'UNSUPPORTED_FIELD', path: 'changes.coefficients.luck' }
  ]);
});

test('non-finite numbers and illegal enum values are rejected', () => {
  const result = authoring.validateBattleMonsterAuthoringUpdate({
    kind: 'enemyMonster',
    id: 'MAGE_BOSS',
    changes: {
      level: Number.NaN,
      baseHp: Number.POSITIVE_INFINITY,
      category: 'legendary',
      role: 'healer',
      defaultPosition: 'middle',
      coefficients: { physicalAttack: Number.NEGATIVE_INFINITY }
    }
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map(({ code, path }) => ({ code, path })), [
    { code: 'NON_FINITE_NUMBER', path: 'changes.level' },
    { code: 'NON_FINITE_NUMBER', path: 'changes.baseHp' },
    { code: 'INVALID_ENUM_VALUE', path: 'changes.category' },
    { code: 'INVALID_ENUM_VALUE', path: 'changes.role' },
    { code: 'INVALID_ENUM_VALUE', path: 'changes.defaultPosition' },
    { code: 'NON_FINITE_NUMBER', path: 'changes.coefficients.physicalAttack' }
  ]);
});

test('malformed candidates return diagnostics instead of throwing', () => {
  for (const candidate of [null, [], 'bad']) {
    const result = authoring.validateBattleMonsterAuthoringUpdate(candidate);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, 'INVALID_CANDIDATE');
  }

  const result = authoring.validateBattleMonsterAuthoringUpdate({ kind: 'skill', id: 1, changes: [] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map((entry) => entry.code), [
    'UNKNOWN_DEFINITION_KIND', 'INVALID_TYPE', 'INVALID_TYPE'
  ]);
});

test('validation is side-effect free for canonical SPIRITS and MONSTERS', () => {
  const spiritsBefore = structuredClone(data.SPIRITS);
  const monstersBefore = structuredClone(monsterData.MONSTERS);

  const valid = authoring.validateBattleMonsterAuthoringUpdate({
    kind: 'playerSpirit', id: 'P01', changes: { maxHp: 99999 }
  });
  const invalid = authoring.validateBattleMonsterAuthoringUpdate({
    kind: 'enemyMonster', id: 'MAGE_BOSS', changes: { baseHp: Number.NaN, skills: [] }
  });
  valid.update.changes.maxHp = 1;
  invalid.diagnostics[0].message = 'mutated result';

  assert.deepEqual(data.SPIRITS, spiritsBefore);
  assert.deepEqual(monsterData.MONSTERS, monstersBefore);
});
