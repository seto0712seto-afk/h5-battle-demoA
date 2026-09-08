import { validateBattleMonsterAuthoringUpdate } from './battleMonsterAuthoring';
import type { BattleMonsterAuthoringDto, BattleMonsterAuthoringKind, ValidatedBattleMonsterAuthoringUpdate } from './battleMonsterAuthoring';

export interface BattleAuthoringBatchDiagnostic {
  severity: 'error';
  code: string;
  path: string;
  message: string;
}

export interface BattleAuthoringBatchRequest {
  kind: BattleMonsterAuthoringKind;
  sourceRevision: string;
  updates: { id: string; changes: Record<string, unknown> }[];
}

export type BattleAuthoringBatchResult =
  | { ok: true; kind: BattleMonsterAuthoringKind; sourceState: 'updated' | 'not-modified';
      sourceRevision: string; definitions: BattleMonsterAuthoringDto[]; diagnostics: []; recoveryPath: null }
  | { ok: false; reason: string; sourceState: 'not-modified' | 'original-restored' | 'unknown';
      diagnostics: BattleAuthoringBatchDiagnostic[]; recoveryPath: string | null; backupAvailable: boolean };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateBattleAuthoringBatchEnvelope(value: unknown):
  | { ok: true; request: BattleAuthoringBatchRequest }
  | { ok: false; reason: 'invalid-request' | 'unsupported-kind'; diagnostics: BattleAuthoringBatchDiagnostic[] } {
  const diagnostics: BattleAuthoringBatchDiagnostic[] = [];
  const add = (path: string, message: string) => diagnostics.push({ severity: 'error', code: 'INVALID_REQUEST', path, message });
  if (!record(value)) {
    add('$', 'Expected a batch request object.');
    return { ok: false, reason: 'invalid-request', diagnostics };
  }
  for (const key of Object.keys(value)) {
    if (!['kind', 'sourceRevision', 'updates'].includes(key)) add(key, 'Unexpected batch request field.');
  }
  if (!Object.hasOwn(value, 'kind')) add('kind', 'Missing kind.');
  if (!Object.hasOwn(value, 'sourceRevision') || typeof value.sourceRevision !== 'string' || !value.sourceRevision.length) {
    add('sourceRevision', 'Expected a non-empty source revision string.');
  }
  if (!Object.hasOwn(value, 'updates') || !Array.isArray(value.updates) || !value.updates.length) {
    add('updates', 'Expected a non-empty updates array.');
  } else {
    for (let index = 0; index < value.updates.length; index += 1) {
      const update = value.updates[index];
      const path = `updates[${index}]`;
      if (!record(update)) { add(path, 'Expected an update object.'); continue; }
      for (const key of Object.keys(update)) {
        if (key !== 'id' && key !== 'changes') add(`${path}.${key}`, 'Each update permits only id and changes.');
      }
      if (!Object.hasOwn(update, 'id') || typeof update.id !== 'string') add(`${path}.id`, 'Expected an own canonical ID string.');
      if (!Object.hasOwn(update, 'changes') || !record(update.changes)) add(`${path}.changes`, 'Expected an own changes object.');
    }
  }
  if (diagnostics.length) return { ok: false, reason: 'invalid-request', diagnostics };
  if (value.kind !== 'playerSpirit' && value.kind !== 'enemyMonster') {
    return { ok: false, reason: 'unsupported-kind', diagnostics: [{ severity: 'error', code: 'UNSUPPORTED_KIND', path: 'kind', message: 'Batch requires one supported kind.' }] };
  }
  return { ok: true, request: value as unknown as BattleAuthoringBatchRequest };
}

/** Only batch structure/duplicate rules are new; all field and ID rules use the existing validator. */
export function validateBattleAuthoringBatch(value: unknown):
  | { ok: true; kind: BattleMonsterAuthoringKind; sourceRevision: string; updates: ValidatedBattleMonsterAuthoringUpdate[] }
  | { ok: false; reason: string; diagnostics: BattleAuthoringBatchDiagnostic[] } {
  const envelope = validateBattleAuthoringBatchEnvelope(value);
  if (!envelope.ok) return envelope;
  const { kind, sourceRevision, updates } = envelope.request;
  const diagnostics: BattleAuthoringBatchDiagnostic[] = [];
  const validated: ValidatedBattleMonsterAuthoringUpdate[] = [];
  const seen = new Set<string>();
  updates.forEach((update, index) => {
    if (seen.has(update.id)) diagnostics.push({ severity: 'error', code: 'DUPLICATE_ID', path: `updates[${index}].id`, message: 'Definition ID occurs more than once in this batch.' });
    seen.add(update.id);
    const result = validateBattleMonsterAuthoringUpdate({ kind, id: update.id, changes: update.changes });
    if (result.ok) validated.push(result.update);
    else diagnostics.push(...result.diagnostics.map((entry) => ({ ...entry, path: `updates[${index}].${entry.path}` })));
  });
  if (diagnostics.length) return { ok: false, reason: diagnostics.some((entry) => entry.code === 'UNKNOWN_DEFINITION') ? 'unknown-definition' : 'validation-failure', diagnostics };
  return { ok: true, kind, sourceRevision, updates: validated };
}
