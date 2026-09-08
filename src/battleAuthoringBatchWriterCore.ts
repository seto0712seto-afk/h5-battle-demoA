import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { authoringSourceRevision, runAuthoringSourceTransaction } from './authoringSourceTransaction';
import type { AuthoringSourceTransactionHooks } from './authoringSourceTransaction';
import { validateBattleAuthoringBatch } from './battleAuthoringBatch';
import type { BattleAuthoringBatchDiagnostic, BattleAuthoringBatchResult } from './battleAuthoringBatch';
import { createEnemyMonsterAuthoringDto } from './battleMonsterAuthoring';
import type { BattleMonsterAuthoringDto } from './battleMonsterAuthoring';
import { preparePlayerSpiritAuthoringBatch } from './playerSpiritAuthoringWriterCore';
import { prepareEnemyMonsterAuthoringBatch } from './enemyMonsterAuthoringWriterCore';

export interface BattleAuthoringBatchCoreRequest {
  sourcePath: string;
  batch: unknown;
  hooks?: AuthoringSourceTransactionHooks;
}

function failure(reason: string, diagnostics: BattleAuthoringBatchDiagnostic[]): BattleAuthoringBatchResult {
  return { ok: false, reason, sourceState: 'not-modified', diagnostics, recoveryPath: null, backupAvailable: false };
}

/** Test-path entry point. Production path selection is fixed by battleAuthoringBatchWriter. */
export async function writeBattleAuthoringBatchAtPath(request: BattleAuthoringBatchCoreRequest): Promise<BattleAuthoringBatchResult> {
  const validation = validateBattleAuthoringBatch(request.batch);
  if (!validation.ok) return failure(validation.reason, validation.diagnostics);
  const sourcePath = resolve(request.sourcePath);
  let originalText: string;
  try { originalText = await readFile(sourcePath, 'utf8'); }
  catch { return failure('filesystem-failure', [{ severity: 'error', code: 'FILESYSTEM_FAILURE', path: '$source', message: 'Canonical source could not be read.' }]); }
  if (authoringSourceRevision(originalText) !== validation.sourceRevision) {
    return failure('stale-source', [{ severity: 'error', code: 'STALE_SOURCE', path: '$source', message: 'Canonical source revision is stale.' }]);
  }
  type Snapshot = { revision: string; definitions: BattleMonsterAuthoringDto[] };
  let prepared: { changed: boolean; transformedSourceText: string; snapshot: Snapshot; verifyWrittenSource: (path: string, text: string) => Snapshot };
  try {
    if (validation.kind === 'playerSpirit') {
      const updates = validation.updates.filter((update) => update.kind === 'playerSpirit');
      const player = preparePlayerSpiritAuthoringBatch(sourcePath, originalText, updates);
      const map = (snapshot: typeof player.snapshot): Snapshot => ({ revision: snapshot.revision, definitions: snapshot.spirits });
      prepared = { ...player, snapshot: map(player.snapshot), verifyWrittenSource: (path, text) => map(player.verifyWrittenSource(path, text)) };
    } else {
      const updates = validation.updates.filter((update) => update.kind === 'enemyMonster');
      const enemy = prepareEnemyMonsterAuthoringBatch(sourcePath, originalText, updates);
      const map = (snapshot: typeof enemy.snapshot): Snapshot => ({ revision: snapshot.revision, definitions: snapshot.definitions.map(createEnemyMonsterAuthoringDto) });
      prepared = { ...enemy, snapshot: map(enemy.snapshot), verifyWrittenSource: (path, text) => map(enemy.verifyWrittenSource(path, text)) };
    }
  } catch (error) {
    const writerError = error as { reason?: string; diagnostic?: BattleAuthoringBatchDiagnostic };
    return failure(writerError.reason ?? 'source-transform-failure', [writerError.diagnostic ?? { severity: 'error', code: 'SOURCE_TRANSFORM_FAILURE', path: '$source', message: 'Batch source could not be transformed safely.' }]);
  }
  if (!prepared.changed) return { ok: true, kind: validation.kind, sourceState: 'not-modified', sourceRevision: prepared.snapshot.revision, definitions: prepared.snapshot.definitions, diagnostics: [], recoveryPath: null };
  const result = await runAuthoringSourceTransaction({
    sourcePath, expectedRevision: validation.sourceRevision, originalSourceText: originalText,
    transformedSourceText: prepared.transformedSourceText, verifyWrittenSource: prepared.verifyWrittenSource, hooks: request.hooks
  });
  if (!result.ok) return { ok: false, reason: result.reason, sourceState: result.sourceState, diagnostics: result.diagnostics, recoveryPath: result.recoveryPath, backupAvailable: result.backupAvailable };
  return { ok: true, kind: validation.kind, sourceState: 'updated', sourceRevision: result.snapshot.revision, definitions: result.snapshot.definitions, diagnostics: [], recoveryPath: null };
}
