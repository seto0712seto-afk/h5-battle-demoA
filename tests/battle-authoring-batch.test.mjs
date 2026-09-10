import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import ts from 'typescript';
import { createServer } from 'vite';
import { loadBattleAuthoringGatewayHarness } from './support/battle-authoring-gateway-harness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
let vite, core, harness, production, authoring;
let protectedBefore;
before(async () => {
  protectedBefore = await Promise.all(['data.ts', 'monsterData.ts'].map((name) => readFile(path.join(root, 'src', name), 'utf8')));
  vite = await createServer({ configFile: false, cacheDir: '.vite-cache', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  [core, harness, production, authoring] = await Promise.all([
    vite.ssrLoadModule('/src/battleAuthoringBatchWriterCore.ts'),
    loadBattleAuthoringGatewayHarness(vite),
    vite.ssrLoadModule('/src/battleAuthoringBatchWriter.ts'),
    vite.ssrLoadModule('/src/battleMonsterAuthoring.ts')
  ]);
});
after(async () => {
  await vite?.close();
  assert.deepEqual(await Promise.all(['data.ts', 'monsterData.ts'].map((name) => readFile(path.join(root, 'src', name), 'utf8'))), protectedBefore);
});
async function fixture(t, kind) {
  const directory = await mkdtemp(path.join(tmpdir(), 's4c5b1-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('s4c5b1-'));
    await rm(resolved, { recursive: true, force: true });
  });
  await Promise.all(['data.ts', 'monsterData.ts', 'types.ts', 'monsterTypes.ts'].map((name) => copyFile(path.join(root, 'src', name), path.join(directory, name))));
  const playerSourcePath = path.join(directory, 'data.ts');
  const enemySourcePath = path.join(directory, 'monsterData.ts');
  const sourcePath = kind === 'playerSpirit' ? playerSourcePath : enemySourcePath;
  const original = await readFile(sourcePath, 'utf8');
  const read = () => kind === 'playerSpirit' ? harness.readPlayerSourceAtPath(sourcePath) : harness.readEnemySourceAtPath(sourcePath);
  const snapshot = (await read()).snapshot;
  const ids = kind === 'playerSpirit' ? snapshot.spirits.slice(0, 3).map((entry) => entry.id) : snapshot.definitions.slice(0, 3).map((entry) => entry.id);
  assert.equal(ids.length, 3);
  const batch = (updates) => ({ kind, sourceRevision: sha(original), updates });
  return { directory, playerSourcePath, enemySourcePath, sourcePath, original, snapshot, ids, batch, read, kind };
}
async function apply(f, updates, hooks) {
  return core.writeBattleAuthoringBatchAtPath({ sourcePath: f.sourcePath, batch: f.batch(updates), hooks });
}
async function gateway(t, f, hooks) {
  let batchCalls = 0;
  const adapter = harness.createFixtureAdapter(f);
  const server = await harness.start({
    ...adapter,
    writeBatch(batch) {
      batchCalls++;
      return core.writeBattleAuthoringBatchAtPath({
        sourcePath: batch.kind === 'playerSpirit' ? f.playerSourcePath : f.enemySourcePath, batch, hooks
      });
    }
  });
  t.after(() => server.close());
  return { ...server, calls: () => batchCalls };
}
async function post(g, body, options = {}) {
  const response = await fetch(g.url + (options.route ?? '/v1/batch-updates'), {
    method: options.method ?? 'POST',
    headers: { Origin: options.origin ?? 'http://127.0.0.1:5174', 'Content-Type': options.media ?? 'application/json' },
    body: options.raw ?? JSON.stringify(body)
  });
  return { response, body: await response.json() };
}
function dto(snapshot, kind, id) {
  return kind === 'playerSpirit' ? snapshot.spirits.find((entry) => entry.id === id)
    : authoring.createEnemyMonsterAuthoringDto(snapshot.definitions.find((entry) => entry.id === id));
}

for (const kind of ['playerSpirit', 'enemyMonster']) {
  test(kind + ': multiple changes and a no-op use one transaction and authoritative whole-source result', async (t) => {
    const f = await fixture(t, kind);
    const [a,b,c] = f.ids;
    let transactions = 0, replacements = 0;
    const changes = kind === 'playerSpirit' ? { name: '  batch, "A"  ', maxHp: -12.5, secondaryRole: null }
      : { name: 'batch enemy', coefficients: { speed: -1.25 }, role: null };
    const result = await apply(f, [{ id:a, changes }, { id:b, changes: {} }, { id:c, changes:{ name:'batch C' } }], {
      beforeTempWrite() { transactions++; },
      beforePostWriteVerification() { replacements++; }
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sourceState, 'updated');
    assert.equal(transactions, 1);
    assert.equal(replacements, 1);
    assert.equal(result.sourceRevision, sha(await readFile(f.sourcePath, 'utf8')));
    const final = (await f.read()).snapshot;
    const finalDtos = kind === 'playerSpirit' ? final.spirits : final.definitions.map(authoring.createEnemyMonsterAuthoringDto);
    assert.deepEqual(result.definitions, finalDtos);
    for (const entry of result.definitions) {
      const beforeDto = dto(f.snapshot, kind, entry.id);
      if (entry.id !== a && entry.id !== c) assert.deepEqual(entry, beforeDto);
      assert.ok(entry.readOnly);
      assert.deepEqual(entry.readOnly, beforeDto.readOnly);
    }
    const actualA = result.definitions.find((entry) => entry.id === a);
    assert.equal(actualA.editable.name, changes.name);
    if (kind === 'playerSpirit') {
      assert.equal(actualA.editable.maxHp, -12.5);
      assert.equal(Object.hasOwn(actualA.editable, 'secondaryRole'), false);
    } else {
      assert.deepEqual(actualA.editable.coefficients, { ...dto(f.snapshot, kind, a).editable.coefficients, speed: -1.25 });
      assert.equal(Object.hasOwn(actualA.editable, 'role'), false);
    }
    assert.equal(result.definitions.find((entry) => entry.id === c).editable.name, 'batch C');
    assert.deepEqual((await readdir(f.directory)).filter((name) => /\.(tmp|rollback)$/.test(name)), []);
  });

  test(kind + ': HTTP sets then removes a present optional value and returns final DTOs/revision', async (t) => {
    const f = await fixture(t, kind);
    const g = await gateway(t, f);
    const field = kind === 'playerSpirit' ? 'secondaryRole' : 'role';
    const value = authoring.BATTLE_MONSTER_AUTHORING_CONTRACT.definitionKinds[kind].fieldSchema[field].values[0];
    const [a,b] = f.ids;
    // Reverse source order to exercise offsets after preceding in-memory changes.
    const set = await post(g, f.batch([{id:b,changes:{name:'optional companion'}},{id:a,changes:{[field]:value}}]));
    assert.equal(set.response.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.definitions.find((entry)=>entry.id===a).editable[field], value);
    assert.equal(set.body.sourceRevision, sha(await readFile(f.sourcePath,'utf8')));
    const remove = await post(g, {kind,sourceRevision:set.body.sourceRevision,updates:[{id:b,changes:{}},{id:a,changes:{[field]:null}}]});
    assert.equal(remove.response.status, 200, JSON.stringify(remove.body));
    assert.equal(remove.body.sourceState, 'updated');
    assert.equal(Object.hasOwn(remove.body.definitions.find((entry)=>entry.id===a).editable,field), false);
    const final = (await f.read()).snapshot;
    assert.equal(remove.body.sourceRevision, final.revision);
    assert.deepEqual(remove.body.definitions, kind==='playerSpirit'?final.spirits:final.definitions.map(authoring.createEnemyMonsterAuthoringDto));
  });

  test(kind + ': temp failure and actual written-source tampering leave no surviving batch change', async (t) => {
    for (const afterReplacement of [false,true]) {
      const f = await fixture(t,kind);
      const updates = f.ids.slice(0,2).map((id)=>({id,changes:{name:'transaction test'}}));
      const result = await apply(f,updates,afterReplacement ? {
        async beforePostWriteVerification(){await writeFile(f.sourcePath,'export const broken = [');}
      } : {beforeTempWrite(){throw new Error('temp failure');}});
      assert.equal(result.ok,false);
      assert.equal(result.sourceState,afterReplacement?'original-restored':'not-modified');
      assert.equal(await readFile(f.sourcePath,'utf8'),f.original);
      assert.deepEqual((await readdir(f.directory)).filter((name)=>/\.(tmp|rollback)$/.test(name)),[]);
    }
  });

  test(kind + ': empty and equivalent patches are not-modified without filesystem transaction', async (t) => {
    const f = await fixture(t, kind);
    const [a,b] = f.ids;
    const result = await apply(f, [{id:a,changes:{}},{id:b,changes:{name:dto(f.snapshot,kind,b).editable.name}}], {
      beforeTempWrite() { assert.fail('no-op entered transaction'); }
    });
    assert.equal(result.ok,true);
    assert.equal(result.sourceState,'not-modified');
    assert.equal(result.sourceRevision,sha(f.original));
    assert.equal(await readFile(f.sourcePath,'utf8'),f.original);
  });

  test(kind + ': invalid middle update, readonly, enum, number, duplicate and unknown all reject before writing', async (t) => {
    const f = await fixture(t, kind);
    const [a,b,c] = f.ids;
    const badChanges = kind === 'playerSpirit'
      ? [{skillIds:[]},{primaryRole:'invalid'},{maxHp:Infinity},{maxHp:'12'},{secondaryRole:12},{other:1}]
      : [{skills:[]},{actionCycle:{}},{temporaryPowerResponse:{}},{category:'invalid'},{level:NaN},{coefficients:{speed:'2'}},{coefficients:{other:1}},{other:1}];
    const variants = badChanges.map((changes)=>[{id:a,changes:{name:'valid A'}},{id:b,changes},{id:c,changes:{name:'valid C'}}]);
    variants.push([{id:a,changes:{name:'first'}},{id:a,changes:{name:'duplicate'}}]);
    variants.push([{id:a,changes:{name:'valid'}},{id:'DOES_NOT_EXIST',changes:{name:'bad'}}]);
    for(const updates of variants) {
      const result = await apply(f,updates,{beforeTempWrite(){assert.fail('invalid batch reached transaction');}});
      assert.equal(result.ok,false);
      assert.equal(result.sourceState,'not-modified');
      assert.ok(result.diagnostics.length);
      assert.ok(result.diagnostics.every((entry)=>entry.path.startsWith('updates[')));
      assert.equal(Object.hasOwn(result,'definitions'),false);
      assert.equal(await readFile(f.sourcePath,'utf8'),f.original);
    }
  });

  test(kind + ': initial stale and second stale check preserve external source without surviving batch writes', async (t) => {
    const f = await fixture(t,kind);
    const updates = f.ids.slice(0,2).map((id)=>({id,changes:{name:'stale batch'}}));
    const external = f.original + '\n// external save\n';
    await writeFile(f.sourcePath,external);
    let result = await apply(f,updates,{beforeTempWrite(){assert.fail('initial stale entered transaction');}});
    assert.equal(result.reason,'stale-source');
    assert.equal(await readFile(f.sourcePath,'utf8'),external);
    await writeFile(f.sourcePath,f.original);
    let replaced = false;
    result = await apply(f,updates,{
      async beforeTempWrite(){await writeFile(f.sourcePath,external);},
      beforePostWriteVerification(){replaced=true;}
    });
    assert.equal(result.reason,'stale-source');
    assert.equal(result.sourceState,'not-modified');
    assert.equal(replaced,false);
    assert.equal(await readFile(f.sourcePath,'utf8'),external);
    assert.deepEqual((await readdir(f.directory)).filter((name)=>/\.(tmp|rollback)$/.test(name)),[]);
  });

  test(kind + ': post-write failure restores every batch change; failed recovery preserves backup and both diagnostics', async (t) => {
    for (const recoveryFails of [false,true]) {
      const f = await fixture(t,kind);
      const updates = f.ids.slice(0,2).map((id)=>({id,changes:{name:'rollback batch'}}));
      const result = await apply(f,updates,{
        beforePostWriteVerification(){throw new Error('injected verification failure');},
        beforeRollback(){if(recoveryFails)throw new Error('injected recovery failure');}
      });
      assert.equal(result.ok,false);
      assert.equal(result.sourceState,recoveryFails?'unknown':'original-restored');
      assert.equal(result.reason,recoveryFails?'rollback-failure':'post-write-verification-failure');
      assert.equal(Object.hasOwn(result,'definitions'),false);
      if(recoveryFails) {
        assert.deepEqual(result.diagnostics.map((entry)=>entry.code),['POST_WRITE_VERIFICATION_FAILURE','ROLLBACK_FAILURE']);
        assert.equal(await readFile(result.recoveryPath,'utf8'),f.original);
        assert.notEqual(await readFile(f.sourcePath,'utf8'),f.original);
      } else {
        assert.equal(await readFile(f.sourcePath,'utf8'),f.original);
        assert.equal(result.recoveryPath,null);
      }
    }
  });

  test(kind + ': a later target transform failure keeps earlier in-memory changes off disk', async (t) => {
    const f = await fixture(t,kind);
    const targetId = f.ids[1];
    const ast = ts.createSourceFile('fixture.ts',f.original,ts.ScriptTarget.Latest,true);
    let target;
    const walk = (node) => {
      if(ts.isObjectLiteralExpression(node) && node.properties.some((p)=>ts.isPropertyAssignment(p) && p.name.getText(ast)==='id' && ts.isStringLiteral(p.initializer) && p.initializer.text===targetId)) target=node;
      ts.forEachChild(node,walk);
    };
    walk(ast);
    assert.ok(target);
    let replacement, changes;
    if(kind==='playerSpirit') {
      const primary = target.properties.find((p)=>p.name.getText(ast)==='primaryRole');
      replacement = '{' + target.properties.filter((p)=>p!==primary && p.name.getText(ast)!=='secondaryRole').map((p)=>p.getText(ast)).join(',') + ',' + primary.getText(ast) + '}';
      changes={secondaryRole:'energy'};
    } else {
      replacement=target.getText(ast).replace(/coefficients:\s*({[^}]+})/, 'coefficients: Object.freeze($1)');
      changes={coefficients:{speed:9}};
    }
    const modified=f.original.slice(0,target.getStart(ast))+replacement+f.original.slice(target.getEnd());
    await writeFile(f.sourcePath,modified);
    const result=await core.writeBattleAuthoringBatchAtPath({
      sourcePath:f.sourcePath,
      batch:{kind,sourceRevision:sha(modified),updates:[{id:f.ids[0],changes:{name:'first prepared'}},{id:targetId,changes}]},
      hooks:{beforeTempWrite(){assert.fail('transform failure wrote source');}}
    });
    assert.equal(result.ok,false);
    assert.equal(result.reason,'source-transform-failure',JSON.stringify(result));
    assert.equal(await readFile(f.sourcePath,'utf8'),modified);
  });

  test(kind + ': HTTP batch returns authoritative DTOs and single/batch share revision serialization', async (t) => {
    const f=await fixture(t,kind);
    const g=await gateway(t,f);
    const batch=f.batch([{id:f.ids[0],changes:{name:'batch A'}},{id:f.ids[1],changes:{name:'batch B'}}]);
    const single={kind,id:f.ids[0],changes:{name:'single'},sourceRevision:batch.sourceRevision};
    const responses=await Promise.all([post(g,batch),post(g,single,{route:'/v1/updates'})]);
    assert.deepEqual(responses.map((r)=>r.response.status).sort(),[200,409]);
    const final=(await f.read()).snapshot;
    const successful=responses.find((r)=>r.response.status===200).body;
    assert.equal(successful.sourceRevision,final.revision);
    if(responses[0].response.status===200) {
      assert.equal(successful.definitions.find((entry)=>entry.id===f.ids[1]).editable.name,'batch B');
    } else {
      assert.deepEqual(dto(final,kind,f.ids[1]),dto(f.snapshot,kind,f.ids[1]));
    }
    assert.equal(responses.find((r)=>r.response.status===409).body.error.sourceState,'not-modified');
    assert.equal(g.calls(),1);
  });
}

test('HTTP envelope rejects empty, mixed-kind, duplicate, unknown and readonly attempts with zero source change',async(t)=>{
  const f=await fixture(t,'enemyMonster');
  const g=await gateway(t,f);
  const good=f.batch([{id:f.ids[0],changes:{name:'valid'}}]);
  for(const bad of [
    [], {...good,updates:[]}, {...good,kind:'mixed'}, {...good,sourcePath:'C:/outside.ts'},
    {...good,updates:[{...good.updates[0],kind:'playerSpirit'}]},
    {...good,updates:[{...good.updates[0],target:'data.ts'}]},
    {...good,updates:[good.updates[0],{id:f.ids[1],changes:{skills:[]}}]},
    {...good,updates:[good.updates[0],{id:f.ids[1],changes:{category:'INVALID'}}]},
    {...good,updates:[good.updates[0],good.updates[0]]},
    {...good,updates:[good.updates[0],{id:'NO_SUCH_ID',changes:{name:'bad'}}]}
  ]) {
    const result=await post(g,bad);
    assert.ok([400,404,422].includes(result.response.status),JSON.stringify(result.body));
    assert.equal(result.body.ok,false);
    assert.equal(result.body.error.sourceState,'not-modified');
    assert.equal(Object.hasOwn(result.body,'definitions'),false);
    assert.equal(await readFile(f.sourcePath,'utf8'),f.original);
  }
  const nonFinite=await post(g,good,{raw:JSON.stringify(good).replace('"valid"','1e999')});
  assert.equal(nonFinite.response.status,422);
  assert.equal(await readFile(f.sourcePath,'utf8'),f.original);
});

test('batch CORS and actual POST preserve exact origins, method, media, route and payload limits',async(t)=>{
  const f=await fixture(t,'playerSpirit');
  const g=await gateway(t,f);
  const body=f.batch([{id:f.ids[0],changes:{}}]);
  for(const origin of ['http://127.0.0.1:5174','http://127.0.0.1:4175']){
    const options=await fetch(g.url+'/v1/batch-updates',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Content-Type'}});
    assert.equal(options.status,204);
    assert.equal(options.headers.get('access-control-allow-origin'),origin);
    assert.equal(options.headers.get('access-control-allow-methods'),'POST');
    assert.equal(options.headers.get('access-control-allow-credentials'),null);
    const result=await post(g,body,{origin});
    assert.equal(result.response.status,200);
    assert.equal(result.response.headers.get('access-control-allow-origin'),origin);
    assert.equal(result.body.sourceState,'not-modified');
    assert.equal(result.body.sourceRevision,sha(f.original));
  }
  const calls=g.calls();
  for(const origin of ['http://localhost:5174','http://192.168.1.2:5174','null','*']){
    assert.equal((await post(g,body,{origin})).response.status,403);
  }
  for(const method of ['PUT','PATCH','DELETE'])assert.equal((await post(g,body,{method})).response.status,403);
  for(const media of ['text/plain','application/x-www-form-urlencoded'])assert.equal((await post(g,body,{media})).response.status,415);
  assert.equal((await post(g,body,{raw:'{'})).response.status,400);
  assert.equal((await post(g,body,{raw:' '.repeat(harness.maxBodyBytes+1)})).response.status,413);
  assert.equal((await post(g,body,{route:'/v1/other'})).response.status,403);
  for(const [method,headers] of [['PUT','Content-Type'],['POST','Authorization'],['POST','Content-Type, X-Extra']]){
    const response=await fetch(g.url+'/v1/batch-updates',{method:'OPTIONS',headers:{Origin:'http://127.0.0.1:5174','Access-Control-Request-Method':method,'Access-Control-Request-Headers':headers}});
    assert.equal(response.status,403);
  }
  assert.equal(g.calls(),calls);
  assert.equal(await readFile(f.sourcePath,'utf8'),f.original);
});

test('HTTP recovery outcomes are batch-level, preserve primary/recovery diagnostics and hide filesystem paths',async(t)=>{
  for(const recoveryFails of [false,true]){
    const f=await fixture(t,'enemyMonster');
    const g=await gateway(t,f,{
      beforePostWriteVerification(){throw new Error('verify '+f.sourcePath);},
      beforeRollback(){if(recoveryFails)throw new Error('rollback '+f.sourcePath);}
    });
    const result=await post(g,f.batch(f.ids.slice(0,2).map((id)=>({id,changes:{name:'failure'}}))));
    assert.equal(result.response.status,500);
    assert.equal(result.body.error.sourceState,recoveryFails?'unknown':'original-restored');
    assert.equal(result.body.error.recovery.required,recoveryFails);
    assert.equal(result.body.error.recovery.backupAvailable,recoveryFails);
    assert.equal(JSON.stringify(result.body).includes(f.directory),false);
    if(recoveryFails) assert.deepEqual(result.body.error.diagnostics.map((d)=>d.code),['POST_WRITE_VERIFICATION_FAILURE','ROLLBACK_FAILURE']);
    else assert.equal(await readFile(f.sourcePath,'utf8'),f.original);
  }
});

for (const kind of ['playerSpirit', 'enemyMonster']) {
  test(kind + ': recovery backup metadata matrix checks actual retained artifacts', { concurrency: false }, async (t) => {
    for (const mode of ['restored', 'rename-failure', 'restored-read-failure']) {
      await t.test(mode, async (t) => {
        const f = await fixture(t, kind);
        const originalRead = fsPromises.readFile;
        const originalRename = fsPromises.rename;
        let backupPath, internal, rollbackRenamed = false, failRestoredRead = false, readFailureInjected = false;
        const g = await harness.start({
          ...harness.createFixtureAdapter(f),
          async writeBatch(batch) {
            internal = await core.writeBattleAuthoringBatchAtPath({
              sourcePath: f.sourcePath, batch,
              hooks: { beforePostWriteVerification() { throw new Error('injected post-write verification failure'); } }
            });
            return internal;
          }
        });
        t.after(() => g.close());
        let result;
        // Process-local injection only. Other test files use separate Node processes;
        // restore both builtins before any filesystem assertions or fixture cleanup.
        try {
          fsPromises.rename = async (from, to) => {
            if (String(from).endsWith('.rollback') && String(to) === f.sourcePath) {
              backupPath = String(from);
              if (mode === 'rename-failure') {
                const error = new Error('injected rollback rename failure');
                error.code = 'EACCES';
                throw error;
              }
              await originalRename(from, to);
              rollbackRenamed = true;
              failRestoredRead = mode === 'restored-read-failure';
              return;
            }
            return originalRename(from, to);
          };
          fsPromises.readFile = async (file, ...args) => {
            if (failRestoredRead && String(file) === f.sourcePath) {
              failRestoredRead = false;
              readFailureInjected = true;
              const error = new Error('injected restored-source read failure');
              error.code = 'EACCES';
              throw error;
            }
            return originalRead(file, ...args);
          };
          syncBuiltinESMExports();
          result = await post(g, f.batch(f.ids.slice(0, 2).map((id) => ({ id, changes: { name: 'metadata matrix' } }))));
        } finally {
          fsPromises.readFile = originalRead;
          fsPromises.rename = originalRename;
          syncBuiltinESMExports();
        }
        const available = mode === 'rename-failure';
        const state = mode === 'restored' ? 'original-restored' : 'unknown';
        assert.equal(result.response.status, 500);
        assert.equal(internal.sourceState, state);
        assert.equal(internal.backupAvailable, available);
        assert.equal(result.body.error.sourceState, state);
        assert.equal(result.body.error.recovery.backupAvailable, available);
        assert.equal(result.body.error.recovery.required, state === 'unknown');
        assert.equal(rollbackRenamed, !available);
        assert.equal(readFailureInjected, mode === 'restored-read-failure');
        assert.equal(internal.recoveryPath, mode === 'restored' ? null : backupPath);
        assert.equal(typeof backupPath, 'string');
        if (available) {
          assert.equal(await readFile(backupPath, 'utf8'), f.original);
          assert.notEqual(await readFile(f.sourcePath, 'utf8'), f.original);
        } else {
          await assert.rejects(fsPromises.stat(backupPath), { code: 'ENOENT' });
          assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
        }
        assert.deepEqual(result.body.error.diagnostics.map((d) => d.code), mode === 'restored'
          ? ['POST_WRITE_VERIFICATION_FAILURE']
          : ['POST_WRITE_VERIFICATION_FAILURE', 'ROLLBACK_FAILURE']);
        assert.equal(JSON.stringify(result.body).includes('recoveryPath'), false);
        assert.equal(JSON.stringify(result.body).includes(JSON.stringify(f.directory).slice(1, -1)), false);
      });
    }
  });
}

test('production batch rejects caller paths and stale revisions without touching real sources',async()=>{
  const invalid=await production.writeBattleAuthoringBatch({kind:'playerSpirit',sourceRevision:'stale',updates:[{id:'P01',changes:{name:'must not write'}}],sourcePath:'C:/outside.ts'});
  assert.equal(invalid.reason,'invalid-request');
  for(const kind of ['playerSpirit','enemyMonster']){
    const id=kind==='playerSpirit'?'P01':'FORGE_GRUNT_WARRIOR';
    const result=await production.writeBattleAuthoringBatch({kind,sourceRevision:'intentionally-stale',updates:[{id,changes:{name:'must not write'}}]});
    assert.equal(result.reason,'stale-source');
    assert.equal(result.sourceState,'not-modified');
  }
});
