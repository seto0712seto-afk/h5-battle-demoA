import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let viteServer;
let authoring;
let monsterData;

before(async () => {
  viteServer = await createServer({
    configFile: false,
    cacheDir: '.vite-cache',
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent'
  });
  [authoring, monsterData] = await Promise.all([
    viteServer.ssrLoadModule('/src/battleMonsterAuthoring.ts'),
    viteServer.ssrLoadModule('/src/monsterData.ts')
  ]);
});

after(async () => {
  await viteServer?.close();
});

function validate(kind, id, changes) {
  return authoring.validateBattleMonsterAuthoringUpdate({ kind, id, changes });
}

function assertAccepted(kind, id, changes) {
  const result = validate(kind, id, changes);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.update;
}

function assertRejected(kind, id, changes, code, path) {
  const result = validate(kind, id, changes);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((entry) => entry.code === code && entry.path === path),
    JSON.stringify(result.diagnostics)
  );
}

function assertSchemaCompleteness(kind) {
  const metadata = authoring.BATTLE_MONSTER_AUTHORING_CONTRACT.definitionKinds[kind];
  const schemaFields = Object.keys(metadata.fieldSchema);
  assert.deepEqual(schemaFields, metadata.editableFields);
  assert.equal(new Set(schemaFields).size, schemaFields.length);
  assert.deepEqual(new Set(schemaFields), new Set(metadata.editableFields));
}

function assertScalarParity(kind, id, field, schema) {
  const path = `changes.${field}`;
  if (schema.type === 'string') {
    assertAccepted(kind, id, { [field]: '' });
    assertRejected(kind, id, { [field]: 1 }, 'INVALID_TYPE', path);
    return;
  }
  if (schema.type === 'number') {
    assert.equal(schema.finite, true);
    assertAccepted(kind, id, { [field]: -1.25 });
    assertAccepted(kind, id, { [field]: 0 });
    assertRejected(kind, id, { [field]: Infinity }, 'NON_FINITE_NUMBER', path);
    assertRejected(kind, id, { [field]: '1' }, 'INVALID_TYPE', path);
    return;
  }
  assert.equal(schema.type, 'enum');
  assert.ok(schema.values.length > 0);
  assert.equal(new Set(schema.values).size, schema.values.length);
  for (const value of schema.values) assertAccepted(kind, id, { [field]: value });
  const invalid = '__not_in_authoring_schema__';
  assert.equal(schema.values.includes(invalid), false);
  assertRejected(kind, id, { [field]: invalid }, 'INVALID_ENUM_VALUE', path);
  assertRejected(kind, id, { [field]: 1 }, 'INVALID_TYPE', path);
}

test('editableFields and fieldSchema are complete, ordered one-to-one sets for both kinds', () => {
  assertSchemaCompleteness('playerSpirit');
  assertSchemaCompleteness('enemyMonster');
});

test('Player string, finite-number and every enum descriptor match validator behavior', () => {
  const schema = authoring.BATTLE_MONSTER_AUTHORING_CONTRACT
    .definitionKinds.playerSpirit.fieldSchema;
  for (const [field, descriptor] of Object.entries(schema)) {
    assert.notEqual(descriptor.type, 'object');
    assertScalarParity('playerSpirit', 'P01', field, descriptor);
  }
  assert.strictEqual(
    schema.primaryRole.values,
    authoring.BATTLE_AUTHORING_ENUM_VALUES.battleBehavior
  );
  assert.strictEqual(
    schema.secondaryRole.values,
    authoring.BATTLE_AUTHORING_ENUM_VALUES.battleBehavior
  );
  assert.strictEqual(schema.defaultPosition.values, authoring.BATTLE_AUTHORING_ENUM_VALUES.row);
});

test('Enemy scalar and every enum descriptor match validator behavior', () => {
  const schema = authoring.BATTLE_MONSTER_AUTHORING_CONTRACT
    .definitionKinds.enemyMonster.fieldSchema;
  for (const [field, descriptor] of Object.entries(schema)) {
    if (descriptor.type === 'object') continue;
    assertScalarParity('enemyMonster', 'MAGE_BOSS', field, descriptor);
  }
  assert.strictEqual(schema.category.values, authoring.BATTLE_AUTHORING_ENUM_VALUES.monsterCategory);
  assert.strictEqual(schema.role.values, authoring.BATTLE_AUTHORING_ENUM_VALUES.monsterRole);
  assert.strictEqual(schema.defaultPosition.values, authoring.BATTLE_AUTHORING_ENUM_VALUES.row);
});

test('Enemy coefficient object preserves nested field identity and finite-number behavior', () => {
  const schema = authoring.BATTLE_MONSTER_AUTHORING_CONTRACT
    .definitionKinds.enemyMonster.fieldSchema.coefficients;
  assert.deepEqual(Object.keys(schema.fields), [
    'physicalAttack', 'physicalDefense', 'magicAttack', 'magicDefense', 'speed'
  ]);
  assert.equal(schema.type, 'object');
  assert.equal(schema.optional, false);
  assert.equal(schema.nullable, false);
  assert.equal(schema.additionalFields, false);

  for (const [field, descriptor] of Object.entries(schema.fields)) {
    assert.deepEqual(descriptor, {
      type: 'number', finite: true, optional: false, nullable: false
    });
    assertAccepted('enemyMonster', 'MAGE_BOSS', { coefficients: { [field]: -0.5 } });
    assertRejected(
      'enemyMonster',
      'MAGE_BOSS',
      { coefficients: { [field]: Infinity } },
      'NON_FINITE_NUMBER',
      `changes.coefficients.${field}`
    );
  }
  assertRejected(
    'enemyMonster',
    'MAGE_BOSS',
    { coefficients: { unknownCoefficient: 1 } },
    'UNSUPPORTED_FIELD',
    'changes.coefficients.unknownCoefficient'
  );
  assertRejected('enemyMonster', 'MAGE_BOSS', { coefficients: null }, 'INVALID_TYPE', 'changes.coefficients');
});

test('optional describes canonical absence, nullable remains false, and patches remain partial', () => {
  const playerMetadata = authoring.BATTLE_MONSTER_AUTHORING_CONTRACT.definitionKinds.playerSpirit;
  const enemyMetadata = authoring.BATTLE_MONSTER_AUTHORING_CONTRACT.definitionKinds.enemyMonster;
  assert.deepEqual(
    { optional: playerMetadata.fieldSchema.secondaryRole.optional, nullable: playerMetadata.fieldSchema.secondaryRole.nullable },
    { optional: true, nullable: false }
  );
  assert.deepEqual(
    { optional: enemyMetadata.fieldSchema.role.optional, nullable: enemyMetadata.fieldSchema.role.nullable },
    { optional: true, nullable: false }
  );
  assert.equal(Object.hasOwn(authoring.getPlayerSpiritAuthoringDefinition('P01').editable, 'secondaryRole'), false);
  const enemyWithoutRole = authoring.createEnemyMonsterAuthoringDto({
    ...monsterData.MONSTERS.MAGE_BOSS,
    role: undefined
  });
  assert.equal(Object.hasOwn(enemyWithoutRole.editable, 'role'), false);
  assertAccepted('playerSpirit', 'P02', { secondaryRole: null });
  assertAccepted('enemyMonster', 'MAGE_BOSS', { role: null });

  assert.equal(playerMetadata.fieldSchema.name.optional, false);
  assert.equal(enemyMetadata.fieldSchema.level.optional, false);
  assertAccepted('playerSpirit', 'P01', {});
  assertAccepted('enemyMonster', 'MAGE_BOSS', {});
  assertRejected('playerSpirit', 'P01', { name: null }, 'INVALID_TYPE', 'changes.name');
  assertRejected('enemyMonster', 'MAGE_BOSS', { level: null }, 'INVALID_TYPE', 'changes.level');
});

test('schema adds no string, integer, range, sign, step or presentation constraints', () => {
  const contract = authoring.BATTLE_MONSTER_AUTHORING_CONTRACT;
  const descriptorKeys = new Set();
  const collectKeys = (value) => {
    if (typeof value !== 'object' || value === null) return;
    for (const [key, nested] of Object.entries(value)) {
      descriptorKeys.add(key);
      collectKeys(nested);
    }
  };
  collectKeys(contract.definitionKinds.playerSpirit.fieldSchema);
  collectKeys(contract.definitionKinds.enemyMonster.fieldSchema);
  for (const forbidden of [
    'maxLength', 'minLength', 'pattern', 'trim', 'integer', 'min', 'max',
    'step', 'unit', 'precision', 'label', 'group', 'widget', 'tooltip', 'css'
  ]) {
    assert.equal(descriptorKeys.has(forbidden), false, forbidden);
  }
  assertAccepted('playerSpirit', 'P01', { name: '', maxHp: -1.5 });
  assertAccepted('enemyMonster', 'MAGE_BOSS', { name: '', level: -2.5, baseHp: -3.5 });
});

test('contract schema is deterministic, JSON-safe and contains no TypeScript-only values', () => {
  const contract = authoring.BATTLE_MONSTER_AUTHORING_CONTRACT;
  const first = JSON.stringify(contract);
  const second = JSON.stringify(contract);
  assert.equal(first, second);
  assert.deepEqual(JSON.parse(first), contract);
});
