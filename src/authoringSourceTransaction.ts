import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export type AuthoringSourceTransactionState = 'updated' | 'original-restored' | 'unknown';

export type AuthoringSourceTransactionFailureReason =
  | 'stale-source'
  | 'post-write-verification-failure'
  | 'rollback-failure'
  | 'filesystem-failure';

export type AuthoringSourceTransactionDiagnosticCode =
  | 'STALE_SOURCE'
  | 'POST_WRITE_VERIFICATION_FAILURE'
  | 'ROLLBACK_FAILURE'
  | 'FILESYSTEM_FAILURE';

export interface AuthoringSourceTransactionDiagnostic {
  severity: 'error';
  code: AuthoringSourceTransactionDiagnosticCode;
  path: string;
  message: string;
}

export interface AuthoringSourceTransactionHooks {
  beforeTempWrite?: () => void | Promise<void>;
  beforePostWriteVerification?: () => void | Promise<void>;
  beforeRollback?: () => void | Promise<void>;
}

export interface AuthoringSourceTransactionRequest<TSnapshot> {
  sourcePath: string;
  expectedRevision: string;
  originalSourceText: string;
  transformedSourceText: string;
  verifyWrittenSource: (sourcePath: string, sourceText: string) => TSnapshot | Promise<TSnapshot>;
  hooks?: AuthoringSourceTransactionHooks;
}

export type AuthoringSourceTransactionResult<TSnapshot> =
  | {
      ok: true;
      snapshot: TSnapshot;
      sourceState: 'updated';
      recoveryPath: null;
      diagnostics: [];
    }
  | {
      ok: false;
      snapshot: null;
      reason: AuthoringSourceTransactionFailureReason;
      sourceState: 'not-modified' | 'original-restored' | 'unknown';
      recoveryPath: string | null;
      diagnostics: AuthoringSourceTransactionDiagnostic[];
    };

function diagnostic(
  code: AuthoringSourceTransactionDiagnosticCode,
  path: string,
  message: string
): AuthoringSourceTransactionDiagnostic {
  return { severity: 'error', code, path, message };
}

function failure<TSnapshot>(
  reason: AuthoringSourceTransactionFailureReason,
  diagnostics: AuthoringSourceTransactionDiagnostic | AuthoringSourceTransactionDiagnostic[],
  sourceState: 'not-modified' | 'original-restored' | 'unknown' = 'not-modified',
  recoveryPath: string | null = null
): AuthoringSourceTransactionResult<TSnapshot> {
  return {
    ok: false,
    snapshot: null,
    reason,
    sourceState,
    recoveryPath,
    diagnostics: Array.isArray(diagnostics) ? diagnostics : [diagnostics]
  };
}

export function authoringSourceRevision(sourceText: string): string {
  return createHash('sha256').update(sourceText, 'utf8').digest('hex');
}

async function writeTempFile(path: string, sourceText: string, mode: number): Promise<void> {
  const handle = await open(path, 'wx', mode);
  try {
    await handle.writeFile(sourceText, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function runAuthoringSourceTransaction<TSnapshot>(
  request: AuthoringSourceTransactionRequest<TSnapshot>
): Promise<AuthoringSourceTransactionResult<TSnapshot>> {
  const sourcePath = resolve(request.sourcePath);
  if (authoringSourceRevision(request.originalSourceText) !== request.expectedRevision) {
    return failure(
      'stale-source',
      diagnostic('STALE_SOURCE', sourcePath, 'Canonical source changed after the authoring snapshot was read.')
    );
  }

  const directory = dirname(sourcePath);
  const name = basename(sourcePath);
  const tempPath = join(directory, `.${name}.${randomUUID()}.tmp`);
  const backupPath = join(directory, `.${name}.${randomUUID()}.rollback`);
  let replaced = false;
  let preserveBackup = false;
  try {
    const sourceStat = await stat(sourcePath);
    await request.hooks?.beforeTempWrite?.();
    await writeTempFile(tempPath, request.transformedSourceText, sourceStat.mode);
    await writeTempFile(backupPath, request.originalSourceText, sourceStat.mode);

    const immediatelyCurrent = await readFile(sourcePath, 'utf8');
    if (authoringSourceRevision(immediatelyCurrent) !== request.expectedRevision) {
      await removeIfPresent(tempPath);
      await removeIfPresent(backupPath);
      return failure(
        'stale-source',
        diagnostic('STALE_SOURCE', sourcePath, 'Canonical source changed before atomic replacement.')
      );
    }

    await rename(tempPath, sourcePath);
    replaced = true;
    try {
      await request.hooks?.beforePostWriteVerification?.();
      const writtenText = await readFile(sourcePath, 'utf8');
      const snapshot = await request.verifyWrittenSource(sourcePath, writtenText);
      if (writtenText !== request.transformedSourceText) {
        throw new Error('Written source does not match the verified transformation.');
      }
      await removeIfPresent(backupPath);
      return { ok: true, snapshot, sourceState: 'updated', recoveryPath: null, diagnostics: [] };
    } catch (postWriteError) {
      const postWriteDiagnostic = diagnostic(
        'POST_WRITE_VERIFICATION_FAILURE',
        sourcePath,
        postWriteError instanceof Error ? postWriteError.message : 'Post-write verification failed.'
      );
      try {
        await request.hooks?.beforeRollback?.();
        await rename(backupPath, sourcePath);
        replaced = false;
        const restored = await readFile(sourcePath, 'utf8');
        if (restored !== request.originalSourceText) throw new Error('Rollback content does not match the original source.');
        return failure('post-write-verification-failure', postWriteDiagnostic, 'original-restored');
      } catch (rollbackError) {
        preserveBackup = true;
        return failure(
          'rollback-failure',
          [
            postWriteDiagnostic,
            diagnostic(
              'ROLLBACK_FAILURE',
              sourcePath,
              rollbackError instanceof Error ? rollbackError.message : 'Rollback failed.'
            )
          ],
          'unknown',
          backupPath
        );
      }
    }
  } catch (error) {
    if (replaced) {
      try {
        await request.hooks?.beforeRollback?.();
        await rename(backupPath, sourcePath);
        replaced = false;
        const restored = await readFile(sourcePath, 'utf8');
        if (restored !== request.originalSourceText) throw new Error('Rollback content does not match the original source.');
      } catch (rollbackError) {
        preserveBackup = true;
        return failure(
          'rollback-failure',
          [
            diagnostic(
              'FILESYSTEM_FAILURE',
              sourcePath,
              error instanceof Error ? error.message : 'Write failed after canonical replacement.'
            ),
            diagnostic(
              'ROLLBACK_FAILURE',
              sourcePath,
              rollbackError instanceof Error ? rollbackError.message : 'Rollback failed.'
            )
          ],
          'unknown',
          backupPath
        );
      }
    }
    return failure(
      'filesystem-failure',
      diagnostic('FILESYSTEM_FAILURE', sourcePath, error instanceof Error ? error.message : 'Atomic write failed.')
    );
  } finally {
    await Promise.allSettled([
      removeIfPresent(tempPath),
      ...(preserveBackup ? [] : [removeIfPresent(backupPath)])
    ]);
  }
}
