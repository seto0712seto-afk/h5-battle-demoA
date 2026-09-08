# Single-kind authoring batch API (S4C-5B-1)

POST /v1/batch-updates is a separate v1 surface. POST /v1/updates keeps its
existing single-definition envelope and behavior.

## Request

```json
{
  "kind": "playerSpirit",
  "sourceRevision": "<revision from the Player definitions GET>",
  "updates": [
    { "id": "P01", "changes": { "maxHp": 280 } },
    { "id": "P02", "changes": { "secondaryRole": null } }
  ]
}
```

The envelope permits only kind, sourceRevision and updates. Updates must be
nonempty; each entry permits only id and changes. The one kind is playerSpirit
or enemyMonster. Duplicate IDs fail the entire request. Canonical identity and
all field, enum, readonly, nested and optional-removal rules use the existing
battleMonsterAuthoring validator. Empty changes and semantic no-ops are allowed.
No path, file target, writer selection, Git command or per-item kind is accepted.

The production writer fixes playerSpirit to src/data.ts and enemyMonster to
src/monsterData.ts. One sourceRevision is the SHA-256 of that complete source
text, exactly as returned by the existing definitions GET. It is not a
definition-level revision.

## Success

```ts
{
  ok: true,
  apiVersion: 'v1',
  kind: 'playerSpirit' | 'enemyMonster',
  operation: 'updated' | 'not-modified',
  sourceState: 'updated' | 'not-modified',
  sourceRevision: string,
  definitions: BattleMonsterAuthoringDto[]
}
```

Definitions are the full authoritative collection for this kind, including
unchanged definitions, produced from the final verified source. They can replace
the caller's collection and revision together. They are not echoed changes.
A fully unchanged batch returns not-modified with the real current revision and
does not enter the filesystem transaction.

## Failure

Envelope/kind failures are HTTP 400. Existing authoring failures remain
404 unknown-definition, 422 validation-failure, 409 stale-source, and 500
operational/recovery failure. Error shape retains:

```ts
{
  ok: false,
  apiVersion: 'v1',
  kind?: 'playerSpirit' | 'enemyMonster',
  error: {
    reason: string,
    sourceState: 'not-modified' | 'original-restored' | 'unknown',
    diagnostics: { severity: 'error'; code: string; path: string; message: string }[],
    recovery?: { required: boolean; backupAvailable: boolean }
  }
}
```

Per-update validation diagnostic paths use updates[index].<existing path>.
There are no per-item success results. Recovery information is provided for
writer failures; the internal writer preserves recoveryPath and both primary
and recovery diagnostics. Absolute filesystem paths are not exposed by HTTP.
Unknown means recovery cannot be confirmed, and must not be presented as a
successful rollback. Gateway internal failures also report unknown for POST.

backupAvailable is supplied by the filesystem transaction authority. It is true
only when the retained backup can still be read and matches the original source.
A non-null internal recoveryPath records recovery information; it does not
guarantee that the artifact still exists. If rollback rename succeeds but the
subsequent verification fails, sourceState remains unknown and backupAvailable
is false because the backup has been consumed. HTTP never exposes recoveryPath.

## Transaction and concurrency boundary

The writer validates the entire batch, reads one original source snapshot,
checks its revision, and applies existing per-definition AST transforms only
to in-memory text. Each step is verified, followed by whole-source verification
against the original snapshot with the full target set. Unchanged definitions,
IDs/order, Player SKILLS, Enemy MONSTER_SKILLS, readonly values and Enemy source
representation remain protected by the existing verifiers.

A changed batch invokes runAuthoringSourceTransaction once. It retains the
temp file, rollback backup, second revision check before replacement, one
canonical rename, written-source verification and whole-file rollback.
A validation/transform/stale failure cannot persist earlier batch items.

Batch and single updates use the same Gateway operation queue, as do definition
reads. Two changed requests for the same file/revision cannot both succeed in
that Gateway instance. There is no retry, merge, refresh or compensation loop.
The existing transaction uses optimistic file revision checks, not a
cross-process lock or crash-recovery journal.

## Browser boundary and limits

Only exact browser Origins http://127.0.0.1:5174 and
http://127.0.0.1:4175 are allowed. OPTIONS permits only POST and Content-Type;
no credentials, wildcard, localhost alias or LAN Origin is added. Actual POST
independently checks the Origin, route, method, application/json and envelope.
The existing 16 KiB JSON body limit applies to the entire batch. Oversized
requests fail with 413; clients must not split one CSV into partial commits
to work around this limit.

## Integration boundary

S4C-5B-2 may submit one validated single-kind CSV candidate plus the revision
of its preview snapshot. On success, rebase that kind's DTO collection and
revision together. On stale, keep the failure explicit and require a new
preview/confirmation flow. Invalid and no-change CSVs require zero writes.

This stage adds no Aries UI/client, CSV file loader, Git behavior, Publish,
cross-kind transaction or multi-file coordinator. All write tests use temporary
fixtures; real canonical sources are protected.
