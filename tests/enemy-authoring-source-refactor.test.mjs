import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { createServer } from 'vite';

const EXPECTED_ENEMY_IDS = [
  'FORGE_GRUNT_WARRIOR', 'FORGE_GRUNT_SHOOTER', 'FORGE_GRUNT_MAGE',
  'FORGE_ELITE_WARRIOR', 'FORGE_ELITE_SHOOTER', 'FORGE_ELITE_MAGE',
  'RANGE_GRUNT_WARRIOR', 'RANGE_GRUNT_SHOOTER', 'RANGE_GRUNT_MAGE',
  'RANGE_ELITE_WARRIOR', 'RANGE_ELITE_SHOOTER', 'RANGE_ELITE_MAGE',
  'MAGE_GRUNT_WARRIOR', 'MAGE_GRUNT_SHOOTER', 'MAGE_GRUNT_MAGE',
  'MAGE_ELITE_WARRIOR', 'MAGE_ELITE_SHOOTER', 'MAGE_ELITE_MAGE',
  'FORGE_BOSS_WARRIOR', 'RANGE_BOSS_SHOOTER', 'MAGE_BOSS'
];
const LULI_ENEMY_IDS = ['E01', 'E02', 'E03', 'B01', 'B02'];

const THEME_ENEMY_SLOTS = [
  'gruntWarrior', 'gruntShooter', 'gruntMage',
  'eliteWarrior', 'eliteShooter', 'eliteMage'
];

const AUTHORING_FIELDS = [
  'id', 'name', 'level', 'category', 'role', 'defaultPosition', 'coefficients', 'baseHp'
];

const COEFFICIENT_FIELDS = [
  'physicalAttack', 'physicalDefense', 'magicAttack', 'magicDefense', 'speed'
];

let server;
let authoring;
let monsterData;
let monsterSystem;
let baseline;
let dtoBaseline;
let sourceFile;

before(async () => {
  const baselinePath = fileURLToPath(new URL('./fixtures/enemy-authoring-pre-refactor-baseline.json', import.meta.url));
  const dtoBaselinePath = fileURLToPath(new URL('./fixtures/enemy-authoring-pre-refactor-dtos.json', import.meta.url));
  const sourcePath = fileURLToPath(new URL('../src/monsterData.ts', import.meta.url));
  const [baselineText, dtoBaselineText, sourceText] = await Promise.all([
    readFile(baselinePath, 'utf8'),
    readFile(dtoBaselinePath, 'utf8'),
    readFile(sourcePath, 'utf8')
  ]);
  baseline = JSON.parse(baselineText);
  dtoBaseline = JSON.parse(dtoBaselineText);
  sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  server = await createServer({ configFile: false, cacheDir: '.vite-cache', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  authoring = await server.ssrLoadModule('/src/battleMonsterAuthoring.ts');
  monsterData = await server.ssrLoadModule('/src/monsterData.ts');
  monsterSystem = await server.ssrLoadModule('/src/monsterSystem.ts');
});

after(async () => {
  await server?.close();
});

function propertyName(property) {
  if (ts.isIdentifier(property) || ts.isStringLiteralLike(property) || ts.isNumericLiteral(property)) {
    return property.text;
  }
  return null;
}

function propertyAssignment(object, name) {
  return object.properties.find((property) =>
    ts.isPropertyAssignment(property) && propertyName(property.name) === name
  );
}

function objectProperty(object, name) {
  const property = propertyAssignment(object, name);
  assert.ok(property, `missing '${name}' property`);
  assert.ok(ts.isObjectLiteralExpression(property.initializer), `'${name}' must be an object literal`);
  return property.initializer;
}

function directPropertyNames(object) {
  return object.properties.map((property) => {
    assert.ok(ts.isPropertyAssignment(property), 'canonical authoring fields must be direct property assignments');
    const name = propertyName(property.name);
    assert.notEqual(name, null, 'canonical authoring property must have a static name');
    return name;
  });
}

function topLevelCalls(name) {
  return sourceFile.statements
    .filter(ts.isExpressionStatement)
    .map((statement) => statement.expression)
    .filter((expression) =>
      ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === name
    );
}

function descendants(root, predicate) {
  const matches = [];
  const visit = (node) => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

test('pre-refactor baseline remains intact and the current registry appends five Liuli enemies', () => {
  assert.equal(baseline.capturedFromCommit, 'feecbed');
  assert.deepEqual(Object.keys(baseline.monsters), EXPECTED_ENEMY_IDS);
  assert.deepEqual(Object.keys(monsterData.MONSTERS), [...EXPECTED_ENEMY_IDS, ...LULI_ENEMY_IDS]);
  assert.equal(new Set(Object.keys(monsterData.MONSTERS)).size, 26);
});

test('all 21 final MONSTERS definitions retain full pre-refactor semantics', () => {
  assert.deepEqual(Object.fromEntries(EXPECTED_ENEMY_IDS.map((id) => [id, monsterData.MONSTERS[id]])), baseline.monsters);
});

test('MONSTER_SKILLS content and registration order retain pre-refactor semantics', () => {
  const baselineSkillIds = Object.keys(baseline.monsterSkills);
  assert.deepEqual(Object.keys(monsterData.MONSTER_SKILLS).slice(0, baselineSkillIds.length), baselineSkillIds);
  assert.deepEqual(Object.fromEntries(baselineSkillIds.map((id) => [id, monsterData.MONSTER_SKILLS[id]])), baseline.monsterSkills);
});

test('all 18 Theme Enemies own independent canonical A-class literals', () => {
  const invocations = topLevelCalls('addThemeEnemies');
  assert.equal(invocations.length, 3);

  const sourceNodesById = new Map();
  for (const invocation of invocations) {
    assert.equal(invocation.arguments.length, 1);
    const config = invocation.arguments[0];
    assert.ok(ts.isObjectLiteralExpression(config));
    const enemies = objectProperty(config, 'enemies');
    assert.deepEqual(directPropertyNames(enemies).sort(), [...THEME_ENEMY_SLOTS].sort());

    for (const slot of THEME_ENEMY_SLOTS) {
      const definition = objectProperty(enemies, slot);
      assert.deepEqual(directPropertyNames(definition).sort(), [...AUTHORING_FIELDS].sort());

      for (const field of ['id', 'name', 'category', 'role', 'defaultPosition']) {
        assert.ok(ts.isStringLiteralLike(propertyAssignment(definition, field).initializer));
      }
      for (const field of ['level', 'baseHp']) {
        assert.ok(ts.isNumericLiteral(propertyAssignment(definition, field).initializer));
      }

      const coefficients = objectProperty(definition, 'coefficients');
      assert.deepEqual(directPropertyNames(coefficients).sort(), [...COEFFICIENT_FIELDS].sort());
      for (const field of COEFFICIENT_FIELDS) {
        assert.ok(ts.isNumericLiteral(propertyAssignment(coefficients, field).initializer));
      }

      const id = propertyAssignment(definition, 'id').initializer.text;
      assert.equal(sourceNodesById.has(id), false, `duplicate canonical source node for ${id}`);
      sourceNodesById.set(id, definition);
    }
  }

  assert.equal(sourceNodesById.size, 18);
  assert.deepEqual([...sourceNodesById.keys()], EXPECTED_ENEMY_IDS.slice(0, 18));
});

test('all three Bosses retain unique direct addMonster source nodes', () => {
  const calls = topLevelCalls('addMonster').filter((call) => {
    const definition = call.arguments[0];
    if (!ts.isObjectLiteralExpression(definition)) return false;
    const id = propertyAssignment(definition, 'id')?.initializer;
    return ts.isStringLiteralLike(id) && EXPECTED_ENEMY_IDS.slice(18).includes(id.text);
  });
  assert.equal(calls.length, 3);

  const bossIds = calls.map((call) => {
    assert.equal(call.arguments.length, 1);
    const definition = call.arguments[0];
    assert.ok(ts.isObjectLiteralExpression(definition));
    for (const field of AUTHORING_FIELDS) {
      assert.ok(propertyAssignment(definition, field), `Boss definition must directly own '${field}'`);
    }
    const id = propertyAssignment(definition, 'id').initializer;
    assert.ok(ts.isStringLiteralLike(id));
    return id.text;
  });

  assert.deepEqual(bossIds, EXPECTED_ENEMY_IDS.slice(18));
  assert.equal(new Set([...EXPECTED_ENEMY_IDS.slice(0, 18), ...bossIds]).size, 21);
});

test('Theme builder consumes one per-enemy config and keeps only shared skill wiring', () => {
  const builder = sourceFile.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'addThemeEnemies'
  );
  assert.ok(builder?.body);

  const calls = descendants(builder.body, (node) =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'addMonster'
  );
  assert.equal(calls.length, 6);

  const consumedSlots = [];
  for (const call of calls) {
    assert.equal(call.arguments.length, 1);
    const definition = call.arguments[0];
    assert.ok(ts.isObjectLiteralExpression(definition));
    const spreads = definition.properties.filter(ts.isSpreadAssignment);
    assert.equal(spreads.length, 1);
    const match = /^config\.enemies\.(\w+)$/.exec(spreads[0].expression.getText(sourceFile));
    assert.ok(match, 'Theme definition must spread exactly one per-enemy canonical config');
    consumedSlots.push(match[1]);

    const constructedFields = definition.properties
      .filter(ts.isPropertyAssignment)
      .map((property) => propertyName(property.name));
    assert.deepEqual(constructedFields, ['skills']);
  }
  assert.deepEqual(consumedSlots.sort(), [...THEME_ENEMY_SLOTS].sort());
});

test('derived stats retain pre-refactor results at default and alternate levels', () => {
  for (const id of EXPECTED_ENEMY_IDS) {
    const before = baseline.monsters[id];
    const after = monsterData.MONSTERS[id];
    assert.deepEqual(monsterSystem.calculateMonsterStats(after), monsterSystem.calculateMonsterStats(before), id);
    assert.deepEqual(monsterSystem.calculateMonsterStats(after, 7), monsterSystem.calculateMonsterStats(before, 7), `${id}@7`);
  }
});

test('S4B-1 Enemy authoring DTOs retain pre-refactor semantics', () => {
  const current = authoring.getBattleMonsterAuthoringDefinitions()
    .filter((definition) => definition.kind === 'enemyMonster' && EXPECTED_ENEMY_IDS.includes(definition.id));
  assert.deepEqual(current, dtoBaseline.enemyAuthoringDtos);
});
