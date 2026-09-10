import { SPIRITS } from './data';
import { MONSTERS } from './monsterData';
import type { MonsterDefinition, MonsterRole } from './monsterTypes';
import type { BattleBehavior, Row, SpiritData } from './types';

export interface PlayerSpiritEditableFields {
  name: string;
  primaryRole: BattleBehavior;
  secondaryRole?: BattleBehavior;
  maxHp: number;
  physicalAttack: number;
  physicalDefense: number;
  magicAttack: number;
  magicDefense: number;
  speed: number;
  accent: string;
  defaultPosition: Row;
  shortDescription: string;
  battleStyle: string;
  playTip: string;
}

export interface EnemyMonsterEditableFields {
  name: string;
  level: number;
  category: MonsterDefinition['category'];
  role?: MonsterRole;
  defaultPosition: Row;
  coefficients: MonsterDefinition['coefficients'];
  baseHp: number;
}

interface BattleAuthoringFieldSchemaBase {
  optional: boolean;
  nullable: boolean;
}

export interface BattleAuthoringStringFieldSchema extends BattleAuthoringFieldSchemaBase {
  type: 'string';
}

export interface BattleAuthoringNumberFieldSchema extends BattleAuthoringFieldSchemaBase {
  type: 'number';
  finite: true;
}

export interface BattleAuthoringEnumFieldSchema extends BattleAuthoringFieldSchemaBase {
  type: 'enum';
  values: readonly string[];
}

export type BattleAuthoringScalarFieldSchema =
  | BattleAuthoringStringFieldSchema
  | BattleAuthoringNumberFieldSchema
  | BattleAuthoringEnumFieldSchema;

export interface BattleAuthoringObjectFieldSchema extends BattleAuthoringFieldSchemaBase {
  type: 'object';
  fields: Readonly<Record<string, BattleAuthoringScalarFieldSchema>>;
  additionalFields: false;
}

export type BattleAuthoringFieldSchema =
  | BattleAuthoringScalarFieldSchema
  | BattleAuthoringObjectFieldSchema;

export const BATTLE_AUTHORING_ENUM_VALUES = {
  battleBehavior: ['attack', 'protect', 'recover', 'energy', 'support'],
  row: ['front', 'back'],
  monsterCategory: ['minor', 'elite', 'boss'],
  monsterRole: ['warrior', 'shooter', 'mage']
} as const satisfies {
  battleBehavior: readonly BattleBehavior[];
  row: readonly Row[];
  monsterCategory: readonly MonsterDefinition['category'][];
  monsterRole: readonly MonsterRole[];
};

export const PLAYER_SPIRIT_AUTHORING_FIELD_SCHEMA = {
  name: { type: 'string', optional: false, nullable: false },
  primaryRole: {
    type: 'enum',
    values: BATTLE_AUTHORING_ENUM_VALUES.battleBehavior,
    optional: false,
    nullable: false
  },
  secondaryRole: {
    type: 'enum',
    values: BATTLE_AUTHORING_ENUM_VALUES.battleBehavior,
    optional: true,
    nullable: false
  },
  maxHp: { type: 'number', finite: true, optional: false, nullable: false },
  physicalAttack: { type: 'number', finite: true, optional: false, nullable: false },
  physicalDefense: { type: 'number', finite: true, optional: false, nullable: false },
  magicAttack: { type: 'number', finite: true, optional: false, nullable: false },
  magicDefense: { type: 'number', finite: true, optional: false, nullable: false },
  speed: { type: 'number', finite: true, optional: false, nullable: false },
  accent: { type: 'string', optional: false, nullable: false },
  defaultPosition: {
    type: 'enum',
    values: BATTLE_AUTHORING_ENUM_VALUES.row,
    optional: false,
    nullable: false
  },
  shortDescription: { type: 'string', optional: false, nullable: false },
  battleStyle: { type: 'string', optional: false, nullable: false },
  playTip: { type: 'string', optional: false, nullable: false }
} as const satisfies {
  [Field in keyof PlayerSpiritEditableFields]-?: BattleAuthoringFieldSchema;
};

export const ENEMY_MONSTER_COEFFICIENT_FIELD_SCHEMA = {
  physicalAttack: { type: 'number', finite: true, optional: false, nullable: false },
  physicalDefense: { type: 'number', finite: true, optional: false, nullable: false },
  magicAttack: { type: 'number', finite: true, optional: false, nullable: false },
  magicDefense: { type: 'number', finite: true, optional: false, nullable: false },
  speed: { type: 'number', finite: true, optional: false, nullable: false }
} as const satisfies {
  [Field in keyof MonsterDefinition['coefficients']]-?: BattleAuthoringNumberFieldSchema;
};

export const ENEMY_MONSTER_AUTHORING_FIELD_SCHEMA = {
  name: { type: 'string', optional: false, nullable: false },
  level: { type: 'number', finite: true, optional: false, nullable: false },
  category: {
    type: 'enum',
    values: BATTLE_AUTHORING_ENUM_VALUES.monsterCategory,
    optional: false,
    nullable: false
  },
  role: {
    type: 'enum',
    values: BATTLE_AUTHORING_ENUM_VALUES.monsterRole,
    optional: true,
    nullable: false
  },
  defaultPosition: {
    type: 'enum',
    values: BATTLE_AUTHORING_ENUM_VALUES.row,
    optional: false,
    nullable: false
  },
  coefficients: {
    type: 'object',
    fields: ENEMY_MONSTER_COEFFICIENT_FIELD_SCHEMA,
    additionalFields: false,
    optional: false,
    nullable: false
  },
  baseHp: { type: 'number', finite: true, optional: false, nullable: false }
} as const satisfies {
  [Field in keyof EnemyMonsterEditableFields]-?: BattleAuthoringFieldSchema;
};

function fieldNames<TSchema extends Readonly<Record<string, BattleAuthoringFieldSchema>>>(
  schema: TSchema
): Array<Extract<keyof TSchema, string>> {
  return Object.keys(schema) as Array<Extract<keyof TSchema, string>>;
}

export const BATTLE_MONSTER_AUTHORING_CONTRACT = {
  version: 'S4B-1',
  definitionKinds: {
    playerSpirit: {
      editableFields: fieldNames(PLAYER_SPIRIT_AUTHORING_FIELD_SCHEMA),
      readOnlyFields: ['id', 'skillIds'],
      fieldSchema: PLAYER_SPIRIT_AUTHORING_FIELD_SCHEMA
    },
    enemyMonster: {
      editableFields: fieldNames(ENEMY_MONSTER_AUTHORING_FIELD_SCHEMA),
      readOnlyFields: ['id', 'skills', 'actionCycle', 'temporaryPowerResponse'],
      fieldSchema: ENEMY_MONSTER_AUTHORING_FIELD_SCHEMA
    }
  }
} as const;

export type BattleMonsterAuthoringKind = keyof typeof BATTLE_MONSTER_AUTHORING_CONTRACT.definitionKinds;

export type PlayerSpiritAuthoringChanges = Partial<Omit<PlayerSpiritEditableFields, 'secondaryRole'>> & {
  secondaryRole?: BattleBehavior | null;
};

export type EnemyMonsterAuthoringChanges = Partial<Omit<EnemyMonsterEditableFields, 'role' | 'coefficients'>> & {
  role?: MonsterRole | null;
  coefficients?: Partial<MonsterDefinition['coefficients']>;
};

export interface PlayerSpiritAuthoringDto {
  kind: 'playerSpirit';
  id: string;
  editable: PlayerSpiritEditableFields;
  readOnly: {
    skillIds: string[];
  };
}

export interface EnemyMonsterAuthoringDto {
  kind: 'enemyMonster';
  id: string;
  editable: EnemyMonsterEditableFields;
  readOnly: {
    skills: MonsterDefinition['skills'];
    actionCycle?: MonsterDefinition['actionCycle'];
    temporaryPowerResponse?: MonsterDefinition['temporaryPowerResponse'];
  };
}

export type BattleMonsterAuthoringDto = PlayerSpiritAuthoringDto | EnemyMonsterAuthoringDto;

export interface BattleMonsterAuthoringUpdateCandidate {
  kind: BattleMonsterAuthoringKind;
  id: string;
  changes: Record<string, unknown>;
}

export type ValidatedBattleMonsterAuthoringUpdate =
  | {
      kind: 'playerSpirit';
      id: string;
      changes: PlayerSpiritAuthoringChanges;
    }
  | {
      kind: 'enemyMonster';
      id: string;
      changes: EnemyMonsterAuthoringChanges;
    };

export type AuthoringDiagnosticCode =
  | 'INVALID_CANDIDATE'
  | 'UNKNOWN_DEFINITION_KIND'
  | 'UNKNOWN_DEFINITION'
  | 'READ_ONLY_FIELD'
  | 'UNSUPPORTED_FIELD'
  | 'INVALID_TYPE'
  | 'INVALID_ENUM_VALUE'
  | 'NON_FINITE_NUMBER';

export interface AuthoringDiagnostic {
  severity: 'error';
  code: AuthoringDiagnosticCode;
  path: string;
  message: string;
}

export type BattleMonsterAuthoringValidationResult =
  | {
      ok: true;
      update: ValidatedBattleMonsterAuthoringUpdate;
      diagnostics: [];
    }
  | {
      ok: false;
      update: null;
      diagnostics: AuthoringDiagnostic[];
    };

const CANDIDATE_FIELDS = new Set(['kind', 'id', 'changes']);
const PLAYER_EDITABLE_FIELDS = new Set<string>(BATTLE_MONSTER_AUTHORING_CONTRACT.definitionKinds.playerSpirit.editableFields);
const PLAYER_READ_ONLY_FIELDS = new Set<string>(BATTLE_MONSTER_AUTHORING_CONTRACT.definitionKinds.playerSpirit.readOnlyFields);
const ENEMY_EDITABLE_FIELDS = new Set<string>(BATTLE_MONSTER_AUTHORING_CONTRACT.definitionKinds.enemyMonster.editableFields);
const ENEMY_READ_ONLY_FIELDS = new Set<string>(BATTLE_MONSTER_AUTHORING_CONTRACT.definitionKinds.enemyMonster.readOnlyFields);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function enemyDefinitionById(id: string): MonsterDefinition | null {
  return hasOwn(MONSTERS, id) ? MONSTERS[id] : null;
}

function playerEditableFields(spirit: SpiritData): PlayerSpiritEditableFields {
  const editable: PlayerSpiritEditableFields = {
    name: spirit.name,
    primaryRole: spirit.primaryRole,
    maxHp: spirit.maxHp,
    physicalAttack: spirit.physicalAttack,
    physicalDefense: spirit.physicalDefense,
    magicAttack: spirit.magicAttack,
    magicDefense: spirit.magicDefense,
    speed: spirit.speed,
    accent: spirit.accent,
    defaultPosition: spirit.defaultPosition,
    shortDescription: spirit.shortDescription,
    battleStyle: spirit.battleStyle,
    playTip: spirit.playTip
  };
  if (spirit.secondaryRole !== undefined) editable.secondaryRole = spirit.secondaryRole;
  return editable;
}

function enemyEditableFields(monster: MonsterDefinition): EnemyMonsterEditableFields {
  const editable: EnemyMonsterEditableFields = {
    name: monster.name,
    level: monster.level,
    category: monster.category,
    defaultPosition: monster.defaultPosition,
    coefficients: { ...monster.coefficients },
    baseHp: monster.baseHp
  };
  if (monster.role !== undefined) editable.role = monster.role;
  return editable;
}

export function createPlayerSpiritAuthoringDto(spirit: SpiritData): PlayerSpiritAuthoringDto {
  return {
    kind: 'playerSpirit',
    id: spirit.id,
    editable: playerEditableFields(spirit),
    readOnly: { skillIds: [...spirit.skillIds] }
  };
}

export function createEnemyMonsterAuthoringDto(monster: MonsterDefinition): EnemyMonsterAuthoringDto {
  return {
    kind: 'enemyMonster',
    id: monster.id,
    editable: enemyEditableFields(monster),
    readOnly: {
      skills: monster.skills.map((entry) => ({ ...entry })),
      ...(monster.actionCycle
        ? { actionCycle: { ...monster.actionCycle, countedSkillIds: [...monster.actionCycle.countedSkillIds] } }
        : {}),
      ...(monster.temporaryPowerResponse
        ? { temporaryPowerResponse: { ...monster.temporaryPowerResponse } }
        : {})
    }
  };
}

export function getBattleMonsterAuthoringDefinitions(): BattleMonsterAuthoringDto[] {
  return [
    ...SPIRITS.map(createPlayerSpiritAuthoringDto),
    ...Object.values(MONSTERS).map(createEnemyMonsterAuthoringDto)
  ];
}

export function getPlayerSpiritAuthoringDefinition(id: string): PlayerSpiritAuthoringDto | null {
  const spirit = SPIRITS.find((definition) => definition.id === id);
  return spirit ? createPlayerSpiritAuthoringDto(spirit) : null;
}

export function getEnemyMonsterAuthoringDefinition(id: string): EnemyMonsterAuthoringDto | null {
  const monster = enemyDefinitionById(id);
  return monster ? createEnemyMonsterAuthoringDto(monster) : null;
}

function diagnostic(code: AuthoringDiagnosticCode, path: string, message: string): AuthoringDiagnostic {
  return { severity: 'error', code, path, message };
}

function validateScalarField(
  value: unknown,
  schema: BattleAuthoringScalarFieldSchema,
  path: string,
  diagnostics: AuthoringDiagnostic[]
): boolean {
  if (value === null && (schema.optional || schema.nullable)) return true;
  if (schema.type === 'string') {
    if (typeof value === 'string') return true;
    diagnostics.push(diagnostic('INVALID_TYPE', path, 'Expected a string.'));
    return false;
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number') {
      diagnostics.push(diagnostic('INVALID_TYPE', path, 'Expected a number.'));
      return false;
    }
    if (schema.finite && !Number.isFinite(value)) {
      diagnostics.push(diagnostic('NON_FINITE_NUMBER', path, 'Expected a finite number.'));
      return false;
    }
    return true;
  }
  if (typeof value !== 'string') {
    diagnostics.push(diagnostic('INVALID_TYPE', path, 'Expected a string enum value.'));
    return false;
  }
  if (!schema.values.includes(value)) {
    diagnostics.push(diagnostic('INVALID_ENUM_VALUE', path, `Expected one of: ${schema.values.join(', ')}.`));
    return false;
  }
  return true;
}

function validateScalarFieldsByType(
  changes: Record<string, unknown>,
  schema: Readonly<Record<string, BattleAuthoringFieldSchema>>,
  type: BattleAuthoringScalarFieldSchema['type'],
  diagnostics: AuthoringDiagnostic[],
  validated: Record<string, unknown>
) {
  for (const [field, fieldSchema] of Object.entries(schema)) {
    if (fieldSchema.type !== type || !hasOwn(changes, field)) continue;
    const value = changes[field];
    if (validateScalarField(value, fieldSchema, `changes.${field}`, diagnostics)) {
      validated[field] = value;
    }
  }
}

function rejectUnsupportedFields(
  changes: Record<string, unknown>,
  editableFields: ReadonlySet<string>,
  readOnlyFields: ReadonlySet<string>,
  diagnostics: AuthoringDiagnostic[]
) {
  for (const field of Object.keys(changes)) {
    if (editableFields.has(field)) continue;
    diagnostics.push(
      readOnlyFields.has(field)
        ? diagnostic('READ_ONLY_FIELD', `changes.${field}`, `Field '${field}' is read-only.`)
        : diagnostic('UNSUPPORTED_FIELD', `changes.${field}`, `Field '${field}' is not supported by S4B-1.`)
    );
  }
}

function validatePlayerChanges(changes: Record<string, unknown>, diagnostics: AuthoringDiagnostic[]) {
  const validated: Record<string, unknown> = {};
  rejectUnsupportedFields(changes, PLAYER_EDITABLE_FIELDS, PLAYER_READ_ONLY_FIELDS, diagnostics);

  validateScalarFieldsByType(changes, PLAYER_SPIRIT_AUTHORING_FIELD_SCHEMA, 'string', diagnostics, validated);
  validateScalarFieldsByType(changes, PLAYER_SPIRIT_AUTHORING_FIELD_SCHEMA, 'number', diagnostics, validated);
  validateScalarFieldsByType(changes, PLAYER_SPIRIT_AUTHORING_FIELD_SCHEMA, 'enum', diagnostics, validated);
  return validated as PlayerSpiritAuthoringChanges;
}

function validateCoefficients(
  value: unknown,
  schema: BattleAuthoringObjectFieldSchema,
  diagnostics: AuthoringDiagnostic[]
) {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('INVALID_TYPE', 'changes.coefficients', 'Expected an object.'));
    return null;
  }

  const validated: Record<string, number> = {};
  for (const field of Object.keys(value)) {
    if (!hasOwn(schema.fields, field)) {
      diagnostics.push(diagnostic('UNSUPPORTED_FIELD', `changes.coefficients.${field}`, `Coefficient '${field}' is not supported.`));
    }
  }
  for (const [field, fieldSchema] of Object.entries(schema.fields)) {
    if (!hasOwn(value, field)) continue;
    const coefficient = value[field];
    if (validateScalarField(coefficient, fieldSchema, `changes.coefficients.${field}`, diagnostics)) {
      validated[field] = coefficient as number;
    }
  }
  return validated as Partial<MonsterDefinition['coefficients']>;
}

function validateEnemyChanges(changes: Record<string, unknown>, diagnostics: AuthoringDiagnostic[]) {
  const validated: Record<string, unknown> = {};
  rejectUnsupportedFields(changes, ENEMY_EDITABLE_FIELDS, ENEMY_READ_ONLY_FIELDS, diagnostics);

  validateScalarFieldsByType(changes, ENEMY_MONSTER_AUTHORING_FIELD_SCHEMA, 'string', diagnostics, validated);
  validateScalarFieldsByType(changes, ENEMY_MONSTER_AUTHORING_FIELD_SCHEMA, 'number', diagnostics, validated);
  validateScalarFieldsByType(changes, ENEMY_MONSTER_AUTHORING_FIELD_SCHEMA, 'enum', diagnostics, validated);
  if (hasOwn(changes, 'coefficients')) {
    const coefficients = validateCoefficients(
      changes.coefficients,
      ENEMY_MONSTER_AUTHORING_FIELD_SCHEMA.coefficients,
      diagnostics
    );
    if (coefficients) validated.coefficients = coefficients;
  }
  return validated as EnemyMonsterAuthoringChanges;
}

export function validateBattleMonsterAuthoringUpdate(candidate: unknown): BattleMonsterAuthoringValidationResult {
  const diagnostics: AuthoringDiagnostic[] = [];
  if (!isRecord(candidate)) {
    return {
      ok: false,
      update: null,
      diagnostics: [diagnostic('INVALID_CANDIDATE', '$', 'Expected an authoring update candidate object.')]
    };
  }

  for (const field of Object.keys(candidate)) {
    if (!CANDIDATE_FIELDS.has(field)) {
      diagnostics.push(diagnostic('UNSUPPORTED_FIELD', field, `Candidate field '${field}' is not supported.`));
    }
  }

  if (!hasOwn(candidate, 'kind') || (candidate.kind !== 'playerSpirit' && candidate.kind !== 'enemyMonster')) {
    diagnostics.push(diagnostic('UNKNOWN_DEFINITION_KIND', 'kind', 'Unknown authoring definition kind.'));
  }
  if (!hasOwn(candidate, 'id') || typeof candidate.id !== 'string') {
    diagnostics.push(diagnostic('INVALID_TYPE', 'id', 'Expected an own canonical ID string.'));
  }
  if (!hasOwn(candidate, 'changes') || !isRecord(candidate.changes)) {
    diagnostics.push(diagnostic('INVALID_TYPE', 'changes', 'Expected an own changes object.'));
  }
  if (diagnostics.some((entry) => entry.path === 'kind' || entry.path === 'id' || entry.path === 'changes')) {
    return { ok: false, update: null, diagnostics };
  }

  const kind = candidate.kind as BattleMonsterAuthoringKind;
  const id = candidate.id as string;
  const changes = candidate.changes as Record<string, unknown>;

  if (kind === 'playerSpirit') {
    if (!SPIRITS.some((definition) => definition.id === id)) {
      diagnostics.push(diagnostic('UNKNOWN_DEFINITION', 'id', `Unknown Player Spirit definition '${id}'.`));
    }
    const validatedChanges = validatePlayerChanges(changes, diagnostics);
    return diagnostics.length > 0
      ? { ok: false, update: null, diagnostics }
      : { ok: true, update: { kind, id, changes: validatedChanges }, diagnostics: [] };
  }

  if (!enemyDefinitionById(id)) {
    diagnostics.push(diagnostic('UNKNOWN_DEFINITION', 'id', `Unknown Enemy Monster definition '${id}'.`));
  }
  const validatedChanges = validateEnemyChanges(changes, diagnostics);
  return diagnostics.length > 0
    ? { ok: false, update: null, diagnostics }
    : { ok: true, update: { kind, id, changes: validatedChanges }, diagnostics: [] };
}
