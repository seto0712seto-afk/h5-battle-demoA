import { fileURLToPath } from 'node:url';
import {
  readPlayerSpiritAuthoringSourceAtPath,
  writePlayerSpiritAuthoringUpdateAtPath
} from './playerSpiritAuthoringWriterCore';
import type {
  PlayerSpiritSourceReadResult,
  PlayerSpiritWriteBackResult
} from './playerSpiritAuthoringWriterCore';

export type {
  PlayerSpiritSourceReadResult,
  PlayerSpiritSourceSnapshot,
  PlayerSpiritWriteBackDiagnostic,
  PlayerSpiritWriteBackDiagnosticCode,
  PlayerSpiritWriteBackFailureReason,
  PlayerSpiritWriteBackResult,
  PlayerSpiritWriteBackSourceState
} from './playerSpiritAuthoringWriterCore';

export interface PlayerSpiritWriteBackRequest {
  expectedRevision: string;
  candidate: unknown;
}

export const PLAYER_SPIRIT_CANONICAL_SOURCE_PATH = fileURLToPath(new URL('./data.ts', import.meta.url));

export function readPlayerSpiritAuthoringSource(): Promise<PlayerSpiritSourceReadResult> {
  return readPlayerSpiritAuthoringSourceAtPath(PLAYER_SPIRIT_CANONICAL_SOURCE_PATH);
}

export function writePlayerSpiritAuthoringUpdate(
  request: PlayerSpiritWriteBackRequest
): Promise<PlayerSpiritWriteBackResult> {
  return writePlayerSpiritAuthoringUpdateAtPath({
    sourcePath: PLAYER_SPIRIT_CANONICAL_SOURCE_PATH,
    expectedRevision: request.expectedRevision,
    candidate: request.candidate
  });
}
