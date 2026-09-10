import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { createServer } from 'vite';
import { loadBattleAuthoringGatewayHarness } from './support/battle-authoring-gateway-harness.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const canonicalPlayerPath = path.join(projectRoot, 'src', 'data.ts');
const canonicalEnemyPath = path.join(projectRoot, 'src', 'monsterData.ts');
const fixtureDirectories = new Set();
const runningGateways = new Set();
let canonicalPlayerBefore;
let canonicalEnemyBefore;
let viteServer;
let gatewayHarness;
let productionGateway;
let authoringContract;

before(async () => {
  [canonicalPlayerBefore, canonicalEnemyBefore] = await Promise.all([
    readFile(canonicalPlayerPath, 'utf8'),
    readFile(canonicalEnemyPath, 'utf8')
  ]);
  viteServer = await createServer({ configFile: false, cacheDir: '.vite-cache', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  [gatewayHarness, productionGateway, authoringContract] = await Promise.all([
    loadBattleAuthoringGatewayHarness(viteServer),
    viteServer.ssrLoadModule('/src/battleAuthoringGateway.ts'),
    viteServer.ssrLoadModule('/src/battleMonsterAuthoring.ts')
  ]);
});

afterEach(async () => {
  await Promise.all([...runningGateways].map(async (gateway) => {
    runningGateways.delete(gateway);
    await gateway.close();
  }));
  await Promise.all([...fixtureDirectories].map(async (directory) => {
    fixtureDirectories.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }));
});

after(async () => {
  await viteServer?.close();
  assert.equal(await readFile(canonicalPlayerPath, 'utf8'), canonicalPlayerBefore);
  assert.equal(await readFile(canonicalEnemyPath, 'utf8'), canonicalEnemyBefore);
});

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 's4c-1-'));
  fixtureDirectories.add(directory);
  const playerSourcePath = path.join(directory, 'data.ts');
  const enemySourcePath = path.join(directory, 'monsterData.ts');
  await Promise.all([
    copyFile(canonicalPlayerPath, playerSourcePath),
    copyFile(canonicalEnemyPath, enemySourcePath),
    copyFile(path.join(projectRoot, 'src', 'types.ts'), path.join(directory, 'types.ts')),
    copyFile(path.join(projectRoot, 'src', 'monsterTypes.ts'), path.join(directory, 'monsterTypes.ts'))
  ]);
  return { directory, playerSourcePath, enemySourcePath };
}

async function startFixtureGateway(fixture, adapterOverride) {
  const adapter = gatewayHarness.createFixtureAdapter(fixture);
  const gateway = await gatewayHarness.start(adapterOverride ? { ...adapter, ...adapterOverride } : adapter);
  runningGateways.add(gateway);
  return { gateway, adapter };
}

async function requestJson(gateway, pathname, init) {
  const response = await fetch(`${gateway.url}${pathname}`, init);
  return { response, body: await response.json() };
}

async function postUpdate(gateway, body, origin, contentType = 'application/json') {
  const headers = { 'Content-Type': contentType };
  if (origin !== undefined) headers.Origin = origin;
  return requestJson(gateway, '/v1/updates', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

function assertReadableCors(response, origin) {
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
}

function definition(body, id) {
  return body.definitions.find((entry) => entry.id === id);
}

test('production startup defaults to 127.0.0.1:4176 and preserves safe port override', async () => {
  assert.deepEqual(Object.keys(productionGateway).sort(), [
    'BATTLE_AUTHORING_GATEWAY_API_VERSION',
    'BATTLE_AUTHORING_GATEWAY_DEFAULT_PORT',
    'BATTLE_AUTHORING_GATEWAY_HOST',
    'startBattleAuthoringGateway'
  ]);
  assert.equal(productionGateway.BATTLE_AUTHORING_GATEWAY_HOST, '127.0.0.1');
  assert.equal(productionGateway.BATTLE_AUTHORING_GATEWAY_DEFAULT_PORT, 4176);

  const defaultGateway = await productionGateway.startBattleAuthoringGateway();
  runningGateways.add(defaultGateway);
  assert.equal(defaultGateway.url, 'http://127.0.0.1:4176');
  assert.equal(defaultGateway.server.address().address, '127.0.0.1');
  runningGateways.delete(defaultGateway);
  await defaultGateway.close();

  const gateway = await productionGateway.startBattleAuthoringGateway({ port: 0, host: '0.0.0.0' });
  runningGateways.add(gateway);
  assert.equal(gateway.port, gateway.server.address().port);
  assert.equal(gateway.url, `http://127.0.0.1:${gateway.port}`);
  assert.equal(gateway.server.address().address, '127.0.0.1');
  assert.notEqual(gateway.server.address().address, '0.0.0.0');
  assert.notEqual(gateway.server.address().address, '::');
  const { response, body } = await requestJson(gateway, '/v1/health');
  assert.equal(response.status, 200);
  assert.equal(body.apiVersion, 'v1');
});

test('health, contract and definition reads expose DTOs with the correct per-source revisions', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);
  const [health, contract, players, enemies, playerSource, enemySource] = await Promise.all([
    requestJson(gateway, '/v1/health'),
    requestJson(gateway, '/v1/contract'),
    requestJson(gateway, '/v1/definitions/player-spirit'),
    requestJson(gateway, '/v1/definitions/enemy'),
    gatewayHarness.readPlayerSourceAtPath(fixture.playerSourcePath),
    gatewayHarness.readEnemySourceAtPath(fixture.enemySourcePath)
  ]);

  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body.supportedKinds, ['player-spirit', 'enemy']);
  assert.equal(contract.response.status, 200);
  assert.deepEqual(contract.body.contract, authoringContract.BATTLE_MONSTER_AUTHORING_CONTRACT);
  assert.deepEqual(
    Object.keys(contract.body.contract.definitionKinds.playerSpirit.fieldSchema),
    contract.body.contract.definitionKinds.playerSpirit.editableFields
  );
  assert.deepEqual(
    Object.keys(contract.body.contract.definitionKinds.enemyMonster.fieldSchema),
    contract.body.contract.definitionKinds.enemyMonster.editableFields
  );
  assert.deepEqual(
    contract.body.contract.definitionKinds.playerSpirit.fieldSchema.primaryRole.values,
    ['attack', 'protect', 'recover', 'energy', 'support']
  );
  assert.deepEqual(
    contract.body.contract.definitionKinds.enemyMonster.fieldSchema.coefficients.fields.speed,
    { type: 'number', finite: true, optional: false, nullable: false }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(contract.body.contract)),
    contract.body.contract
  );
  assert.equal(players.body.resourceKind, 'player-spirit');
  assert.equal(players.body.kind, 'playerSpirit');
  assert.equal(players.body.sourceRevision, playerSource.snapshot.revision);
  assert.equal(enemies.body.resourceKind, 'enemy');
  assert.equal(enemies.body.kind, 'enemyMonster');
  assert.equal(enemies.body.sourceRevision, enemySource.snapshot.revision);
  assert.equal(players.body.definitions.every((entry) => entry.kind === 'playerSpirit'), true);
  assert.equal(enemies.body.definitions.every((entry) => entry.kind === 'enemyMonster'), true);
  assert.equal(JSON.stringify([players.body, enemies.body]).includes(fixture.directory), false);
  assert.equal(JSON.stringify([players.body, enemies.body]).includes('sourcePath'), false);
});

test('exact local Aries origins can read the browser contract and definitions', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);
  const cases = [
    ['http://127.0.0.1:5174', '/v1/contract'],
    ['http://127.0.0.1:5174', '/v1/definitions/player-spirit'],
    ['http://127.0.0.1:4175', '/v1/definitions/enemy'],
    ['http://127.0.0.1:4175', '/v1/health']
  ];

  for (const [origin, pathname] of cases) {
    const { response, body } = await requestJson(gateway, pathname, { headers: { Origin: origin } });
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('vary'), 'Origin');
    assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
  }
});

test('non-allowlisted browser origins are rejected without wildcard or reflection', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);
  const origins = [
    'http://localhost:5174',
    'http://192.168.1.20:4175',
    'http://127.0.0.1:9999',
    'https://127.0.0.1:4175',
    'null',
    'http://127.0.0.1:4175.attacker.example',
    'http://127.0.0.1.evil.test:4175',
    'http://127.0.0.1:41750'
  ];

  for (const origin of origins) {
    const { response, body } = await requestJson(gateway, '/v1/definitions/enemy', {
      headers: { Origin: origin }
    });
    assert.equal(response.status, 403);
    assert.equal(body.error.reason, 'browser-origin-forbidden');
    assert.equal(body.error.sourceState, 'not-modified');
    assert.equal(body.error.diagnostics[0].code, 'BROWSER_ORIGIN_FORBIDDEN');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
    assert.notEqual(response.headers.get('access-control-allow-origin'), origin);
  }
});

test('allowed local Aries origins receive only the minimal update preflight permission', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);

  for (const origin of ['http://127.0.0.1:5174', 'http://127.0.0.1:4175']) {
    const response = await fetch(`${gateway.url}/v1/updates`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type'
      }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-methods'), 'POST');
    assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type');
    assert.equal(
      response.headers.get('vary'),
      'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
    );
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
    assert.notEqual(response.headers.get('access-control-allow-methods'), '*');
    assert.notEqual(response.headers.get('access-control-allow-headers'), '*');
  }
});

test('invalid update preflights never receive method or header permission', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);
  const cases = [
    {
      pathname: '/v1/updates',
      origin: 'http://localhost:5174',
      method: 'POST',
      headers: 'content-type'
    },
    {
      pathname: '/v1/updates',
      origin: 'http://127.0.0.1:5174',
      method: 'PUT',
      headers: 'content-type'
    },
    {
      pathname: '/v1/updates',
      origin: 'http://127.0.0.1:5174',
      method: 'DELETE',
      headers: 'content-type'
    },
    {
      pathname: '/v1/updates',
      origin: 'http://127.0.0.1:5174',
      method: 'POST',
      headers: 'content-type, x-authoring-token'
    },
    {
      pathname: '/v1/contract',
      origin: 'http://127.0.0.1:5174',
      method: 'POST',
      headers: 'content-type'
    }
  ];

  for (const entry of cases) {
    const { response, body } = await requestJson(gateway, entry.pathname, {
      method: 'OPTIONS',
      headers: {
        Origin: entry.origin,
        'Access-Control-Request-Method': entry.method,
        'Access-Control-Request-Headers': entry.headers
      }
    });
    assert.equal(response.status, 403);
    assert.equal(body.error.sourceState, 'not-modified');
    assert.equal(response.headers.get('access-control-allow-methods'), null);
    assert.equal(response.headers.get('access-control-allow-headers'), null);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  }
});

test('allowed browser origins perform real Player and Enemy writes through the existing fixture adapter', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);
  const playerOrigin = 'http://127.0.0.1:5174';
  const enemyOrigin = 'http://127.0.0.1:4175';
  const playersBefore = (await requestJson(gateway, '/v1/definitions/player-spirit')).body;
  const enemiesBefore = (await requestJson(gateway, '/v1/definitions/enemy')).body;

  const player = await postUpdate(gateway, {
    kind: 'playerSpirit',
    id: 'P01',
    sourceRevision: playersBefore.sourceRevision,
    changes: { name: 'Browser Player Write', maxHp: 457 }
  }, playerOrigin);
  assert.equal(player.response.status, 200);
  assert.equal(player.body.operation, 'updated');
  assert.equal(player.body.definition.editable.name, 'Browser Player Write');
  assertReadableCors(player.response, playerOrigin);

  const enemy = await postUpdate(gateway, {
    kind: 'enemyMonster',
    id: 'FORGE_GRUNT_WARRIOR',
    sourceRevision: enemiesBefore.sourceRevision,
    changes: { name: 'Browser Enemy Write', coefficients: { speed: 1.32 } }
  }, enemyOrigin, 'application/json; charset=utf-8');
  assert.equal(enemy.response.status, 200);
  assert.equal(enemy.body.operation, 'updated');
  assert.equal(enemy.body.definition.editable.name, 'Browser Enemy Write');
  assertReadableCors(enemy.response, enemyOrigin);

  const noOp = await postUpdate(gateway, {
    kind: 'enemyMonster',
    id: 'FORGE_GRUNT_WARRIOR',
    sourceRevision: enemy.body.sourceRevision,
    changes: { name: 'Browser Enemy Write', coefficients: { speed: 1.32 } }
  }, enemyOrigin, 'application/json; charset=utf-8');
  assert.equal(noOp.response.status, 200);
  assert.equal(noOp.body.operation, 'not-modified');
  assertReadableCors(noOp.response, enemyOrigin);

  const playersAfter = (await requestJson(gateway, '/v1/definitions/player-spirit')).body;
  const enemiesAfter = (await requestJson(gateway, '/v1/definitions/enemy')).body;
  assert.equal(definition(playersAfter, 'P01').editable.name, 'Browser Player Write');
  assert.equal(definition(enemiesAfter, 'FORGE_GRUNT_WARRIOR').editable.name, 'Browser Enemy Write');
});

test('allowed browser origins can read structured validation, unknown-definition and stale failures', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);
  const origin = 'http://127.0.0.1:5174';
  const source = (await requestJson(gateway, '/v1/definitions/enemy')).body;

  const validation = await postUpdate(gateway, {
    kind: 'enemyMonster',
    id: 'FORGE_GRUNT_WARRIOR',
    sourceRevision: source.sourceRevision,
    changes: { skills: [] }
  }, origin);
  assert.equal(validation.response.status, 422);
  assert.equal(validation.body.error.diagnostics[0].code, 'READ_ONLY_FIELD');
  assertReadableCors(validation.response, origin);

  const unknown = await postUpdate(gateway, {
    kind: 'enemyMonster',
    id: 'ENEMY_404',
    sourceRevision: source.sourceRevision,
    changes: { name: 'x' }
  }, origin);
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.error.diagnostics[0].code, 'UNKNOWN_DEFINITION');
  assertReadableCors(unknown.response, origin);

  await writeFile(fixture.enemySourcePath, `${await readFile(fixture.enemySourcePath, 'utf8')}\n// browser stale\n`, 'utf8');
  const stale = await postUpdate(gateway, {
    kind: 'enemyMonster',
    id: 'FORGE_GRUNT_WARRIOR',
    sourceRevision: source.sourceRevision,
    changes: { name: 'stale' }
  }, origin);
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.reason, 'stale-source');
  assert.equal(stale.body.error.diagnostics[0].code, 'STALE_SOURCE');
  assertReadableCors(stale.response, origin);
});

test('disallowed Origin updates are rejected before any writer adapter is called', async () => {
  const fixture = await createFixture();
  let playerWrites = 0;
  let enemyWrites = 0;
  const { gateway } = await startFixtureGateway(fixture, {
    writePlayerSpirit: async () => {
      playerWrites += 1;
      throw new Error('browser-origin write reached player adapter');
    },
    writeEnemy: async () => {
      enemyWrites += 1;
      throw new Error('browser-origin write reached enemy adapter');
    }
  });
  const requestBody = JSON.stringify({
    kind: 'playerSpirit',
    id: 'P01',
    changes: { name: 'must-not-write' },
    sourceRevision: 'revision'
  });

  const origins = [
    'http://localhost:5174',
    'http://192.168.1.10:4175',
    'http://127.0.0.1:9999',
    'https://127.0.0.1:4175',
    'null',
    'http://127.0.0.1:4175.attacker.example',
    'http://127.0.0.1.evil.test:4175',
    'http://127.0.0.1:41750',
    'http://[::1]:4175'
  ];
  for (const origin of origins) {
    const { response, body } = await requestJson(gateway, '/v1/updates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: requestBody
    });
    assert.equal(response.status, 403);
    assert.equal(body.error.reason, 'browser-origin-forbidden');
    assert.equal(body.error.sourceState, 'not-modified');
    assert.equal(body.error.diagnostics[0].code, 'BROWSER_ORIGIN_FORBIDDEN');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(playerWrites, 0);
  assert.equal(enemyWrites, 0);
});

test('allowed Origin wrong route, method and media type are rejected before writer adapters', async () => {
  const fixture = await createFixture();
  let writes = 0;
  const { gateway } = await startFixtureGateway(fixture, {
    writePlayerSpirit: async () => {
      writes += 1;
      throw new Error('forbidden browser request reached writer');
    },
    writeEnemy: async () => {
      writes += 1;
      throw new Error('forbidden browser request reached writer');
    }
  });
  const origin = 'http://127.0.0.1:5174';
  const body = JSON.stringify({
    kind: 'playerSpirit', id: 'P01', changes: { name: 'x' }, sourceRevision: 'revision'
  });
  const cases = [
    ['/v1/contract', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body }],
    ['/v1/updates', { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body }],
    ['/v1/updates', { method: 'PATCH', headers: { Origin: origin, 'Content-Type': 'application/json' }, body }],
    ['/v1/updates', { method: 'DELETE', headers: { Origin: origin } }]
  ];
  for (const [pathname, init] of cases) {
    const { response, body: failure } = await requestJson(gateway, pathname, init);
    assert.equal(response.status, 403);
    assert.equal(failure.error.diagnostics[0].code, 'BROWSER_OPERATION_FORBIDDEN');
    assertReadableCors(response, origin);
  }

  const mediaType = await requestJson(gateway, '/v1/updates', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'text/plain' },
    body
  });
  assert.equal(mediaType.response.status, 415);
  assert.equal(mediaType.body.error.diagnostics[0].code, 'UNSUPPORTED_MEDIA_TYPE');
  assertReadableCors(mediaType.response, origin);
  assert.equal(writes, 0);
});

test('Player Spirit HTTP update writes the fixture and returns the disk-reread DTO and revision', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);
  const before = (await requestJson(gateway, '/v1/definitions/player-spirit')).body;
  const result = await postUpdate(gateway, {
    kind: 'playerSpirit',
    id: 'P01',
    sourceRevision: before.sourceRevision,
    changes: { name: 'Gateway "Spirit"\\测试', maxHp: 456 }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.operation, 'updated');
  assert.equal(result.body.definition.editable.name, 'Gateway "Spirit"\\测试');
  assert.equal(result.body.definition.editable.maxHp, 456);

  const reread = (await requestJson(gateway, '/v1/definitions/player-spirit')).body;
  assert.equal(reread.sourceRevision, result.body.sourceRevision);
  assert.deepEqual(definition(reread, 'P01'), result.body.definition);
});

test('Enemy Theme multi-field update is isolated and returns the disk-reread DTO', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);
  const before = (await requestJson(gateway, '/v1/definitions/enemy')).body;
  const untouched = definition(before, 'RANGE_GRUNT_WARRIOR');
  const result = await postUpdate(gateway, {
    kind: 'enemyMonster',
    id: 'FORGE_GRUNT_WARRIOR',
    sourceRevision: before.sourceRevision,
    changes: { name: 'Gateway Theme', baseHp: 678, coefficients: { speed: 1.31 } }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.definition.editable.name, 'Gateway Theme');
  assert.equal(result.body.definition.editable.baseHp, 678);
  assert.equal(result.body.definition.editable.coefficients.speed, 1.31);

  const reread = (await requestJson(gateway, '/v1/definitions/enemy')).body;
  assert.deepEqual(definition(reread, 'FORGE_GRUNT_WARRIOR'), result.body.definition);
  assert.deepEqual(definition(reread, 'RANGE_GRUNT_WARRIOR'), untouched);
});

test('Enemy Boss update and semantic no-op preserve writer source-state semantics', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);
  const before = (await requestJson(gateway, '/v1/definitions/enemy')).body;
  const updated = await postUpdate(gateway, {
    kind: 'enemyMonster',
    id: 'MAGE_BOSS',
    sourceRevision: before.sourceRevision,
    changes: { name: 'Gateway Boss', coefficients: { magicAttack: 2.81 } }
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.operation, 'updated');

  const bytesBeforeNoOp = await readFile(fixture.enemySourcePath, 'utf8');
  const noOp = await postUpdate(gateway, {
    kind: 'enemyMonster',
    id: 'MAGE_BOSS',
    sourceRevision: updated.body.sourceRevision,
    changes: { name: 'Gateway Boss', coefficients: { magicAttack: 2.81 } }
  });
  assert.equal(noOp.response.status, 200);
  assert.equal(noOp.body.operation, 'not-modified');
  assert.equal(noOp.body.sourceRevision, updated.body.sourceRevision);
  assert.equal(await readFile(fixture.enemySourcePath, 'utf8'), bytesBeforeNoOp);
});

test('HTTP validation preserves S4B-1 structured diagnostics without touching fixture source', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);
  const beforeText = await readFile(fixture.enemySourcePath, 'utf8');
  const source = (await requestJson(gateway, '/v1/definitions/enemy')).body;
  const cases = [
    [{ kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { unknownField: true } }, 422, 'UNSUPPORTED_FIELD'],
    [{ kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { id: 'RENAMED' } }, 422, 'READ_ONLY_FIELD'],
    [{ kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { skills: [] } }, 422, 'READ_ONLY_FIELD'],
    [{ kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { category: 'legendary' } }, 422, 'INVALID_ENUM_VALUE'],
    [{ kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { level: 'NaN' } }, 422, 'INVALID_TYPE'],
    [{ kind: 'enemyMonster', id: 'ENEMY_404', changes: { name: 'x' } }, 404, 'UNKNOWN_DEFINITION']
  ];
  for (const [candidate, status, code] of cases) {
    const result = await postUpdate(gateway, { ...candidate, sourceRevision: source.sourceRevision });
    assert.equal(result.response.status, status);
    assert.equal(result.body.error.sourceState, 'not-modified');
    assert.equal(result.body.error.diagnostics[0].code, code);
  }

  const nonFinite = await requestJson(gateway, '/v1/updates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: `{"kind":"enemyMonster","id":"FORGE_GRUNT_WARRIOR","sourceRevision":"${source.sourceRevision}","changes":{"baseHp":1e999}}`
  });
  assert.equal(nonFinite.response.status, 422);
  assert.equal(nonFinite.body.error.diagnostics[0].code, 'NON_FINITE_NUMBER');
  assert.equal(await readFile(fixture.enemySourcePath, 'utf8'), beforeText);
});

test('malformed, oversized, unsupported-kind, extra-path and unsupported routes are rejected', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);
  const malformed = await requestJson(gateway, '/v1/updates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{'
  });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.error.diagnostics[0].code, 'MALFORMED_JSON');

  const wrongMediaType = await requestJson(gateway, '/v1/updates', { method: 'POST', body: '{}' });
  assert.equal(wrongMediaType.response.status, 415);
  assert.equal(wrongMediaType.body.error.diagnostics[0].code, 'UNSUPPORTED_MEDIA_TYPE');

  const oversized = await requestJson(gateway, '/v1/updates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(gatewayHarness.maxBodyBytes) })
  });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.error.diagnostics[0].code, 'PAYLOAD_TOO_LARGE');

  const unsupported = await postUpdate(gateway, {
    kind: 'skill', id: 'SKILL_1', changes: {}, sourceRevision: 'revision'
  });
  assert.equal(unsupported.response.status, 400);
  assert.equal(unsupported.body.error.reason, 'unsupported-kind');

  const pathInjection = await postUpdate(gateway, {
    kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: {}, sourceRevision: 'revision', sourcePath: 'C:\\outside.ts'
  });
  assert.equal(pathInjection.response.status, 400);
  assert.equal(pathInjection.body.error.diagnostics[0].path, 'sourcePath');

  const wrongMethod = await requestJson(gateway, '/v1/health', { method: 'POST' });
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get('allow'), 'GET');
  const missing = await requestJson(gateway, '/not-a-route');
  assert.equal(missing.response.status, 404);
});

test('gateway reports internal adapter failures without exposing stack or filesystem details', async () => {
  const fixture = await createFixture();
  const baseAdapter = gatewayHarness.createFixtureAdapter(fixture);
  const gateway = await gatewayHarness.start({
    ...baseAdapter,
    writeEnemy: async () => {
      throw new Error(`private failure at ${fixture.enemySourcePath}`);
    }
  });
  runningGateways.add(gateway);
  const result = await postUpdate(gateway, {
    kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { name: 'x' }, sourceRevision: 'revision'
  });
  assert.equal(result.response.status, 500);
  assert.equal(result.body.error.reason, 'internal-gateway-failure');
  assert.equal(result.body.error.sourceState, 'unknown');
  assert.equal(result.body.error.diagnostics[0].code, 'INTERNAL_GATEWAY_FAILURE');
  assert.equal(JSON.stringify(result.body).includes(fixture.directory), false);
  assert.equal(JSON.stringify(result.body).includes('stack'), false);
});

test('an occupied loopback port fails instead of falling back to another interface', async () => {
  const fixture = await createFixture();
  const adapter = gatewayHarness.createFixtureAdapter(fixture);
  const gateway = await gatewayHarness.start(adapter);
  runningGateways.add(gateway);
  await assert.rejects(
    () => gatewayHarness.start(adapter, gateway.port),
    (error) => error?.code === 'EADDRINUSE'
  );
});

test('stale HTTP update preserves the newer fixture and returns conflict diagnostics without paths', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);
  const before = (await requestJson(gateway, '/v1/definitions/player-spirit')).body;
  const external = `${await readFile(fixture.playerSourcePath, 'utf8')}\n// external change\n`;
  await writeFile(fixture.playerSourcePath, external, 'utf8');
  const result = await postUpdate(gateway, {
    kind: 'playerSpirit', id: 'P01', changes: { name: 'stale' }, sourceRevision: before.sourceRevision
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.reason, 'stale-source');
  assert.equal(result.body.error.sourceState, 'not-modified');
  assert.equal(result.body.error.diagnostics[0].code, 'STALE_SOURCE');
  assert.equal(result.body.error.diagnostics[0].path, '$source');
  assert.equal(JSON.stringify(result.body).includes(fixture.directory), false);
  assert.equal(await readFile(fixture.playerSourcePath, 'utf8'), external);
});

test('gateway preserves original-restored and rollback-failure unknown recovery states', async (t) => {
  const fixture = await createFixture();
  const baseAdapter = gatewayHarness.createFixtureAdapter(fixture);
  const cases = [
    {
      name: 'original restored',
      writeResult: {
        ok: false,
        reason: 'post-write-verification-failure',
        sourceState: 'original-restored',
        recoveryPath: null,
        diagnostics: [{ severity: 'error', code: 'POST_WRITE_VERIFICATION_FAILURE', path: fixture.enemySourcePath, message: 'private path detail' }]
      },
      expectedCodes: ['POST_WRITE_VERIFICATION_FAILURE'],
      expectedState: 'original-restored'
    },
    {
      name: 'rollback failed',
      writeResult: {
        ok: false,
        reason: 'rollback-failure',
        sourceState: 'unknown',
        recoveryPath: `${fixture.enemySourcePath}.rollback`,
        diagnostics: [
          { severity: 'error', code: 'POST_WRITE_VERIFICATION_FAILURE', path: fixture.enemySourcePath, message: 'primary private detail' },
          { severity: 'error', code: 'ROLLBACK_FAILURE', path: fixture.enemySourcePath, message: 'recovery private detail' }
        ]
      },
      expectedCodes: ['POST_WRITE_VERIFICATION_FAILURE', 'ROLLBACK_FAILURE'],
      expectedState: 'unknown'
    }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const gateway = await gatewayHarness.start({ ...baseAdapter, writeEnemy: async () => entry.writeResult });
      runningGateways.add(gateway);
      const result = await postUpdate(gateway, {
        kind: 'enemyMonster', id: 'FORGE_GRUNT_WARRIOR', changes: { name: 'x' }, sourceRevision: 'revision'
      }, 'http://127.0.0.1:4175');
      assert.equal(result.response.status, 500);
      assert.equal(result.body.error.sourceState, entry.expectedState);
      assert.deepEqual(result.body.error.diagnostics.map((diagnostic) => diagnostic.code), entry.expectedCodes);
      assert.equal(result.body.error.diagnostics.every((diagnostic) => diagnostic.path === '$source'), true);
      assert.equal(Object.hasOwn(result.body, 'recoveryPath'), false);
      assert.equal(JSON.stringify(result.body).includes(fixture.directory), false);
      assertReadableCors(result.response, 'http://127.0.0.1:4175');
      runningGateways.delete(gateway);
      await gateway.close();
    });
  }
});

test('same-process updates sharing one revision are serialized so only one can replace source', async () => {
  const fixture = await createFixture();
  const { gateway } = await startFixtureGateway(fixture);
  const before = (await requestJson(gateway, '/v1/definitions/enemy')).body;
  const request = (name) => postUpdate(gateway, {
    kind: 'enemyMonster', id: 'FORGE_GRUNT_MAGE', changes: { name }, sourceRevision: before.sourceRevision
  });
  const results = await Promise.all([request('concurrent-a'), request('concurrent-b')]);
  assert.deepEqual(results.map((entry) => entry.response.status).sort(), [200, 409]);
  const successful = results.find((entry) => entry.response.status === 200).body;
  const stale = results.find((entry) => entry.response.status === 409).body;
  assert.equal(successful.sourceState, 'updated');
  assert.equal(stale.error.reason, 'stale-source');
  const reread = (await requestJson(gateway, '/v1/definitions/enemy')).body;
  assert.equal(definition(reread, 'FORGE_GRUNT_MAGE').editable.name, successful.definition.editable.name);
});
