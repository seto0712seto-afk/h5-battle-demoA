import { fileURLToPath } from 'node:url';
import {
  readEnemyMonsterAuthoringSourceAtPath,
  writeEnemyMonsterAuthoringUpdateAtPath
} from './enemyMonsterAuthoringWriterCore';
import type {
  EnemyMonsterSourceReadResult,
  EnemyMonsterWriteBackResult
} from './enemyMonsterAuthoringWriterCore';

export type {
  EnemyMonsterSourceLocation,
  EnemyMonsterSourceReadResult,
  EnemyMonsterSourceSnapshot,
  EnemyMonsterWriteBackDiagnostic,
  EnemyMonsterWriteBackDiagnosticCode,
  EnemyMonsterWriteBackFailureReason,
  EnemyMonsterWriteBackResult,
  EnemyMonsterWriteBackSourceState
} from './enemyMonsterAuthoringWriterCore';

export interface EnemyMonsterWriteBackRequest {
  expectedRevision: string;
  candidate: unknown;
}

export const ENEMY_MONSTER_CANONICAL_SOURCE_PATH = fileURLToPath(new URL('./monsterData.ts', import.meta.url));

export function readEnemyMonsterAuthoringSource(): Promise<EnemyMonsterSourceReadResult> {
  return readEnemyMonsterAuthoringSourceAtPath(ENEMY_MONSTER_CANONICAL_SOURCE_PATH);
}

export function writeEnemyMonsterAuthoringUpdate(
  request: EnemyMonsterWriteBackRequest
): Promise<EnemyMonsterWriteBackResult> {
  return writeEnemyMonsterAuthoringUpdateAtPath({
    sourcePath: ENEMY_MONSTER_CANONICAL_SOURCE_PATH,
    expectedRevision: request.expectedRevision,
    candidate: request.candidate
  });
}
