import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute } from 'node:path';
import {
  BATTLE_MONSTER_AUTHORING_CONTRACT
} from './battleMonsterAuthoring';
import type {
  BattleMonsterAuthoringDto,
  BattleMonsterAuthoringKind,
  EnemyMonsterAuthoringDto,
  PlayerSpiritAuthoringDto
} from './battleMonsterAuthoring';

export const BATTLE_AUTHORING_GATEWAY_API_VERSION = 'v1';
export const BATTLE_AUTHORING_GATEWAY_LOOPBACK_HOST = '127.0.0.1';
export const BATTLE_AUTHORING_GATEWAY_MAX_BODY_BYTES = 16 * 1024;

export type BattleAuthoringGatewayResourceKind = 'player-spirit' | 'enemy';
export type BattleAuthoringGatewaySourceState = 'not-modified' | 'updated' | 'original-restored' | 'unknown';

export interface BattleAuthoringGatewayDiagnostic {
  severity: 'error';
  code: string;
  path: string;
  message: string;
}

export type BattleAuthoringGatewayReadResult<TDefinition extends BattleMonsterAuthoringDto> =
  | {
      ok: true;
      sourceRevision: string;
      definitions: TDefinition[];
      diagnostics: [];
    }
  | {
      ok: false;
      reason: string;
      diagnostics: BattleAuthoringGatewayDiagnostic[];
    };

export type BattleAuthoringGatewayWriteResult<TDefinition extends BattleMonsterAuthoringDto> =
  | {
      ok: true;
      sourceState: 'not-modified' | 'updated';
      sourceRevision: string;
      definition: TDefinition;
      diagnostics: [];
    }
  | {
      ok: false;
      reason: string;
      sourceState: Exclude<BattleAuthoringGatewaySourceState, 'updated'>;
      diagnostics: BattleAuthoringGatewayDiagnostic[];
    };

export interface BattleAuthoringGatewayAdapter {
  readPlayerSpirits(): Promise<BattleAuthoringGatewayReadResult<PlayerSpiritAuthoringDto>>;
  readEnemies(): Promise<BattleAuthoringGatewayReadResult<EnemyMonsterAuthoringDto>>;
  writePlayerSpirit(request: {
    expectedRevision: string;
    candidate: unknown;
  }): Promise<BattleAuthoringGatewayWriteResult<PlayerSpiritAuthoringDto>>;
  writeEnemy(request: {
    expectedRevision: string;
    candidate: unknown;
  }): Promise<BattleAuthoringGatewayWriteResult<EnemyMonsterAuthoringDto>>;
}

export interface BattleAuthoringGatewayServerOptions {
  port?: number;
}

export interface RunningBattleAuthoringGateway {
  readonly server: Server;
  readonly host: typeof BATTLE_AUTHORING_GATEWAY_LOOPBACK_HOST;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

const RESOURCE_KIND_BY_PATH = {
  '/v1/definitions/player-spirit': 'player-spirit',
  '/v1/definitions/enemy': 'enemy'
} as const;

const BATTLE_AUTHORING_GATEWAY_BROWSER_READ_ORIGINS = new Set([
  'http://127.0.0.1:5174',
  'http://127.0.0.1:4175'
]);

const BATTLE_AUTHORING_GATEWAY_BROWSER_READ_PATHS = new Set([
  '/v1/health',
  '/v1/contract',
  ...Object.keys(RESOURCE_KIND_BY_PATH)
]);

const OPERATIONAL_MESSAGES: Readonly<Record<string, string>> = {
  STALE_SOURCE: 'Canonical source revision is stale.',
  SOURCE_PARSE_FAILURE: 'Canonical source could not be parsed.',
  SOURCE_TRANSFORM_FAILURE: 'Canonical source could not be transformed safely.',
  POST_WRITE_VERIFICATION_FAILURE: 'Post-write verification failed.',
  ROLLBACK_FAILURE: 'Recovery failed; canonical source state is unknown.',
  FILESYSTEM_FAILURE: 'Canonical source filesystem operation failed.'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function publicDiagnostics(
  diagnostics: readonly BattleAuthoringGatewayDiagnostic[]
): BattleAuthoringGatewayDiagnostic[] {
  return diagnostics.map((entry) => ({
    severity: 'error',
    code: entry.code,
    path: isAbsolute(entry.path) ? '$source' : entry.path,
    message: OPERATIONAL_MESSAGES[entry.code] ?? entry.message
  }));
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(payload);
}

function gatewayFailure(
  response: ServerResponse,
  statusCode: number,
  reason: string,
  sourceState: Exclude<BattleAuthoringGatewaySourceState, 'updated'>,
  diagnostics: BattleAuthoringGatewayDiagnostic[],
  context: { kind?: BattleMonsterAuthoringKind; id?: string } = {}
): void {
  sendJson(response, statusCode, {
    ok: false,
    apiVersion: BATTLE_AUTHORING_GATEWAY_API_VERSION,
    ...context,
    error: {
      reason,
      sourceState,
      diagnostics: publicDiagnostics(diagnostics)
    }
  });
}

function envelopeDiagnostic(code: string, path: string, message: string): BattleAuthoringGatewayDiagnostic {
  return { severity: 'error', code, path, message };
}

async function readJsonBody(request: IncomingMessage): Promise<
  | { ok: true; value: unknown }
  | { ok: false; statusCode: number; reason: string; diagnostic: BattleAuthoringGatewayDiagnostic }
> {
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    request.resume();
    return {
      ok: false,
      statusCode: 415,
      reason: 'invalid-request',
      diagnostic: envelopeDiagnostic('UNSUPPORTED_MEDIA_TYPE', '$', 'Expected application/json request body.')
    };
  }

  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > BATTLE_AUTHORING_GATEWAY_MAX_BODY_BYTES) {
    request.resume();
    return {
      ok: false,
      statusCode: 413,
      reason: 'invalid-request',
      diagnostic: envelopeDiagnostic('PAYLOAD_TOO_LARGE', '$', 'Request body exceeds the authoring payload limit.')
    };
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > BATTLE_AUTHORING_GATEWAY_MAX_BODY_BYTES) {
      oversized = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (oversized) {
    return {
      ok: false,
      statusCode: 413,
      reason: 'invalid-request',
      diagnostic: envelopeDiagnostic('PAYLOAD_TOO_LARGE', '$', 'Request body exceeds the authoring payload limit.')
    };
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return {
      ok: false,
      statusCode: 400,
      reason: 'invalid-request',
      diagnostic: envelopeDiagnostic('MALFORMED_JSON', '$', 'Request body is not valid JSON.')
    };
  }
}

function validateUpdateEnvelope(value: unknown):
  | {
      ok: true;
      kind: BattleMonsterAuthoringKind;
      id: string;
      changes: Record<string, unknown>;
      sourceRevision: string;
    }
  | {
      ok: false;
      reason: 'invalid-request' | 'unsupported-kind';
      diagnostics: BattleAuthoringGatewayDiagnostic[];
    } {
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: 'invalid-request',
      diagnostics: [envelopeDiagnostic('INVALID_REQUEST', '$', 'Expected a JSON object.')]
    };
  }

  const diagnostics: BattleAuthoringGatewayDiagnostic[] = [];
  const allowedKeys = new Set(['kind', 'id', 'changes', 'sourceRevision']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      diagnostics.push(envelopeDiagnostic('INVALID_REQUEST', key, `Unexpected request field '${key}'.`));
    }
  }
  if (!hasOwn(value, 'kind')) diagnostics.push(envelopeDiagnostic('INVALID_REQUEST', 'kind', 'Missing kind.'));
  if (!hasOwn(value, 'id') || typeof value.id !== 'string') {
    diagnostics.push(envelopeDiagnostic('INVALID_REQUEST', 'id', 'Expected an own canonical ID string.'));
  }
  if (!hasOwn(value, 'changes') || !isRecord(value.changes)) {
    diagnostics.push(envelopeDiagnostic('INVALID_REQUEST', 'changes', 'Expected an own changes object.'));
  }
  if (!hasOwn(value, 'sourceRevision') || typeof value.sourceRevision !== 'string' || value.sourceRevision.length === 0) {
    diagnostics.push(envelopeDiagnostic('INVALID_REQUEST', 'sourceRevision', 'Expected a non-empty source revision string.'));
  }
  if (diagnostics.length > 0) return { ok: false, reason: 'invalid-request', diagnostics };

  if (value.kind !== 'playerSpirit' && value.kind !== 'enemyMonster') {
    return {
      ok: false,
      reason: 'unsupported-kind',
      diagnostics: [envelopeDiagnostic('UNSUPPORTED_KIND', 'kind', 'Gateway supports playerSpirit and enemyMonster only.')]
    };
  }

  return {
    ok: true,
    kind: value.kind,
    id: value.id as string,
    changes: value.changes as Record<string, unknown>,
    sourceRevision: value.sourceRevision as string
  };
}

function writerFailureStatus(reason: string): number {
  if (reason === 'unknown-definition') return 404;
  if (reason === 'validation-failure') return 422;
  if (reason === 'stale-source') return 409;
  return 500;
}

function methodNotAllowed(request: IncomingMessage, response: ServerResponse, allowed: string): void {
  request.resume();
  sendJson(response, 405, {
    ok: false,
    apiVersion: BATTLE_AUTHORING_GATEWAY_API_VERSION,
    error: {
      reason: 'method-not-allowed',
      sourceState: 'not-modified',
      diagnostics: [envelopeDiagnostic('METHOD_NOT_ALLOWED', '$', `Expected ${allowed}.`)]
    }
  }, { Allow: allowed });
}

function createAuthoringOperationQueue() {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function createBattleAuthoringGatewayServer(adapter: BattleAuthoringGatewayAdapter): Server {
  const enqueueAuthoringOperation = createAuthoringOperationQueue();
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const origin = request.headers.origin;
      if (origin !== undefined) {
        const isAllowedRead = request.method === 'GET'
          && BATTLE_AUTHORING_GATEWAY_BROWSER_READ_PATHS.has(pathname)
          && BATTLE_AUTHORING_GATEWAY_BROWSER_READ_ORIGINS.has(origin);
        if (!isAllowedRead) {
          request.resume();
          return gatewayFailure(
            response,
            403,
            'browser-origin-forbidden',
            'not-modified',
            [envelopeDiagnostic(
              'BROWSER_ORIGIN_FORBIDDEN',
              '$',
              'Browser origin is not permitted for this authoring operation.'
            )]
          );
        }
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }

      if (pathname === '/v1/health') {
        if (request.method !== 'GET') return methodNotAllowed(request, response, 'GET');
        return sendJson(response, 200, {
          ok: true,
          service: 'Battle Authoring Gateway',
          apiVersion: BATTLE_AUTHORING_GATEWAY_API_VERSION,
          supportedKinds: ['player-spirit', 'enemy']
        });
      }

      if (pathname === '/v1/contract') {
        if (request.method !== 'GET') return methodNotAllowed(request, response, 'GET');
        return sendJson(response, 200, {
          ok: true,
          apiVersion: BATTLE_AUTHORING_GATEWAY_API_VERSION,
          resources: [
            { resourceKind: 'player-spirit', candidateKind: 'playerSpirit' },
            { resourceKind: 'enemy', candidateKind: 'enemyMonster' }
          ],
          contract: BATTLE_MONSTER_AUTHORING_CONTRACT
        });
      }

      if (hasOwn(RESOURCE_KIND_BY_PATH, pathname)) {
        if (request.method !== 'GET') return methodNotAllowed(request, response, 'GET');
        const resourceKind = RESOURCE_KIND_BY_PATH[pathname as keyof typeof RESOURCE_KIND_BY_PATH];
        const result = await enqueueAuthoringOperation<
          BattleAuthoringGatewayReadResult<PlayerSpiritAuthoringDto>
          | BattleAuthoringGatewayReadResult<EnemyMonsterAuthoringDto>
        >(() => resourceKind === 'player-spirit'
          ? adapter.readPlayerSpirits()
          : adapter.readEnemies());
        if (!result.ok) {
          return gatewayFailure(response, 500, result.reason, 'not-modified', result.diagnostics);
        }
        return sendJson(response, 200, {
          ok: true,
          apiVersion: BATTLE_AUTHORING_GATEWAY_API_VERSION,
          resourceKind,
          kind: resourceKind === 'player-spirit' ? 'playerSpirit' : 'enemyMonster',
          sourceRevision: result.sourceRevision,
          definitions: result.definitions
        });
      }

      if (pathname === '/v1/updates') {
        if (request.method !== 'POST') return methodNotAllowed(request, response, 'POST');
        const body = await readJsonBody(request);
        if (!body.ok) {
          return gatewayFailure(response, body.statusCode, body.reason, 'not-modified', [body.diagnostic]);
        }
        const envelope = validateUpdateEnvelope(body.value);
        if (!envelope.ok) {
          return gatewayFailure(response, 400, envelope.reason, 'not-modified', envelope.diagnostics);
        }

        const candidate = { kind: envelope.kind, id: envelope.id, changes: envelope.changes };
        const result = await enqueueAuthoringOperation<
          BattleAuthoringGatewayWriteResult<PlayerSpiritAuthoringDto>
          | BattleAuthoringGatewayWriteResult<EnemyMonsterAuthoringDto>
        >(() => envelope.kind === 'playerSpirit'
          ? adapter.writePlayerSpirit({ expectedRevision: envelope.sourceRevision, candidate })
          : adapter.writeEnemy({ expectedRevision: envelope.sourceRevision, candidate }));
        if (!result.ok) {
          return gatewayFailure(
            response,
            writerFailureStatus(result.reason),
            result.reason,
            result.sourceState,
            result.diagnostics,
            { kind: envelope.kind, id: envelope.id }
          );
        }
        return sendJson(response, 200, {
          ok: true,
          apiVersion: BATTLE_AUTHORING_GATEWAY_API_VERSION,
          operation: result.sourceState,
          kind: envelope.kind,
          id: envelope.id,
          sourceState: result.sourceState,
          sourceRevision: result.sourceRevision,
          definition: result.definition
        });
      }

      return gatewayFailure(
        response,
        404,
        'route-not-found',
        'not-modified',
        [envelopeDiagnostic('ROUTE_NOT_FOUND', '$', 'No authoring route matches this request.')]
      );
    } catch {
      return gatewayFailure(
        response,
        500,
        'internal-gateway-failure',
        request.method === 'POST' ? 'unknown' : 'not-modified',
        [envelopeDiagnostic('INTERNAL_GATEWAY_FAILURE', '$', 'Internal gateway failure.')]
      );
    }
  });
}

export async function startBattleAuthoringGatewayServer(
  adapter: BattleAuthoringGatewayAdapter,
  options: BattleAuthoringGatewayServerOptions = {}
): Promise<RunningBattleAuthoringGateway> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Authoring gateway port must be an integer from 0 to 65535.');
  }
  const server = createBattleAuthoringGatewayServer(adapter);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error) => rejectPromise(error);
    server.once('error', onError);
    server.listen(port, BATTLE_AUTHORING_GATEWAY_LOOPBACK_HOST, () => {
      server.off('error', onError);
      resolvePromise();
    });
  });
  const address = server.address() as AddressInfo;
  const actualPort = address.port;
  return {
    server,
    host: BATTLE_AUTHORING_GATEWAY_LOOPBACK_HOST,
    port: actualPort,
    url: `http://${BATTLE_AUTHORING_GATEWAY_LOOPBACK_HOST}:${actualPort}`,
    close: () => new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => error ? rejectPromise(error) : resolvePromise());
    })
  };
}
