import { createEnemyMonsterAuthoringDto } from './battleMonsterAuthoring';
import type {
  EnemyMonsterAuthoringDto,
  PlayerSpiritAuthoringDto
} from './battleMonsterAuthoring';
import type { BattleAuthoringGatewayAdapter, BattleAuthoringGatewayDiagnostic } from './battleAuthoringGatewayCore';
import type {
  EnemyMonsterSourceReadResult,
  EnemyMonsterWriteBackResult
} from './enemyMonsterAuthoringWriterCore';
import type {
  PlayerSpiritSourceReadResult,
  PlayerSpiritWriteBackResult
} from './playerSpiritAuthoringWriterCore';

export interface BattleAuthoringGatewayWriterDependencies {
  readPlayerSpirits(): Promise<PlayerSpiritSourceReadResult>;
  readEnemies(): Promise<EnemyMonsterSourceReadResult>;
  writePlayerSpirit(request: { expectedRevision: string; candidate: unknown }): Promise<PlayerSpiritWriteBackResult>;
  writeEnemy(request: { expectedRevision: string; candidate: unknown }): Promise<EnemyMonsterWriteBackResult>;
}

function diagnostics(
  entries: readonly { severity: 'error'; code: string; path: string; message: string }[]
): BattleAuthoringGatewayDiagnostic[] {
  return entries.map((entry) => ({ ...entry }));
}

function missingDefinition(kind: string, id: string): never {
  throw new Error(`Successful ${kind} writer result omitted '${id}'.`);
}

export function createBattleAuthoringGatewayAdapter(
  dependencies: BattleAuthoringGatewayWriterDependencies
): BattleAuthoringGatewayAdapter {
  return {
    async readPlayerSpirits() {
      const result = await dependencies.readPlayerSpirits();
      if (!result.ok) return { ok: false, reason: result.reason, diagnostics: diagnostics(result.diagnostics) };
      return {
        ok: true,
        sourceRevision: result.snapshot.revision,
        definitions: result.snapshot.spirits,
        diagnostics: []
      };
    },

    async readEnemies() {
      const result = await dependencies.readEnemies();
      if (!result.ok) return { ok: false, reason: result.reason, diagnostics: diagnostics(result.diagnostics) };
      return {
        ok: true,
        sourceRevision: result.snapshot.revision,
        definitions: result.snapshot.definitions.map(createEnemyMonsterAuthoringDto),
        diagnostics: []
      };
    },

    async writePlayerSpirit(request) {
      const result = await dependencies.writePlayerSpirit(request);
      if (!result.ok) {
        return {
          ok: false,
          reason: result.reason,
          sourceState: result.sourceState,
          diagnostics: diagnostics(result.diagnostics)
        };
      }
      const candidate = request.candidate as { id?: unknown };
      const definition = result.snapshot.spirits.find((entry) => entry.id === candidate.id)
        ?? missingDefinition('Player Spirit', String(candidate.id));
      return {
        ok: true,
        sourceState: result.sourceState,
        sourceRevision: result.snapshot.revision,
        definition: definition as PlayerSpiritAuthoringDto,
        diagnostics: []
      };
    },

    async writeEnemy(request) {
      const result = await dependencies.writeEnemy(request);
      if (!result.ok) {
        return {
          ok: false,
          reason: result.reason,
          sourceState: result.sourceState,
          diagnostics: diagnostics(result.diagnostics)
        };
      }
      const candidate = request.candidate as { id?: unknown };
      const runtimeDefinition = result.snapshot.definitions.find((entry) => entry.id === candidate.id)
        ?? missingDefinition('Enemy', String(candidate.id));
      return {
        ok: true,
        sourceState: result.sourceState,
        sourceRevision: result.snapshot.revision,
        definition: createEnemyMonsterAuthoringDto(runtimeDefinition) as EnemyMonsterAuthoringDto,
        diagnostics: []
      };
    }
  };
}
