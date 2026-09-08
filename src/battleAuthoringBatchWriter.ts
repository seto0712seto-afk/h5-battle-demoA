import { PLAYER_SPIRIT_CANONICAL_SOURCE_PATH } from './playerSpiritAuthoringWriter';
import { ENEMY_MONSTER_CANONICAL_SOURCE_PATH } from './enemyMonsterAuthoringWriter';
import { validateBattleAuthoringBatchEnvelope } from './battleAuthoringBatch';
import type { BattleAuthoringBatchResult } from './battleAuthoringBatch';
import { writeBattleAuthoringBatchAtPath } from './battleAuthoringBatchWriterCore';

export async function writeBattleAuthoringBatch(batch: unknown): Promise<BattleAuthoringBatchResult> {
  const envelope = validateBattleAuthoringBatchEnvelope(batch);
  if (!envelope.ok) return { ...envelope, sourceState: 'not-modified', recoveryPath: null, backupAvailable: false };
  return writeBattleAuthoringBatchAtPath({
    sourcePath: envelope.request.kind === 'playerSpirit' ? PLAYER_SPIRIT_CANONICAL_SOURCE_PATH : ENEMY_MONSTER_CANONICAL_SOURCE_PATH,
    batch: envelope.request
  });
}
