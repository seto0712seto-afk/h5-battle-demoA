import { SPIRITS } from './data';
import { MONSTERS } from './monsterData';
import type { MonsterDefinition, MonsterRole } from './monsterTypes';
import type { BattleBehavior, Row, SpiritData } from './types';

export const BATTLE_MONSTER_AUTHORING_CONTRACT = {
  version: 'S4B-1',
  definitionKinds: {
    playerSpirit: {
      editableFields: [
        'name',
        'primaryRole',
        'secondaryRole',
        'maxHp',
        'physicalAttack',
        'physicalDefense',
        'magicAttack',
        'magicDefense',
        'speed',
        'accent',
        'defaultPosition',
        'shortDescription',
        'battleStyle',
        'playTip'
      ],
      readOnlyFields: ['id', 'skillIds']
    },
    enemyMonster: {
      editableFields: ['name', 'level', 'category', 'role', 'defaultPosition', 'coefficients', 'baseHp'],
      readOnlyFields: ['id', 'skills', 'actionCycle', 'temporaryPowerResponse']
    }
  }
} as const;

export type BattleMonsterAuthoringKind = keyof typeof BATTLE_MONSTER_AUTHORING_CONTRACT.definitionKinds;

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

const PLAYER_STRING_FIELDS = ['name', 'accent', 'shortDescription', 'battleStyle', 'playTip'] as const;
const PLAYER_NUMBER_FIELDS = ['maxHp', 'physicalAttack', 'physicalDefense', 'magicAttack', 'magicDefense', 'speed'] as const;
const ENEMY_STRING_FIELDS = ['name'] as const;
const ENEMY_NUMBER_FIELDS = ['level', 'baseHp'] as const;
const COEFFICIENT_FIELDS = ['physicalAttack', 'physicalDefense', 'magicAttack', 'magicDefense', 'speed'] as const;
const BATTLE_BEHAVIORS: readonly BattleBehavior[] = ['attack', 'protect', 'recover', 'energy'];
const ROWS: readonly Row[] = ['front', 'back'];
const MONSTER_CATEGORIES: readonly MonsterDefinition['category'][] = ['minor', 'elite', 'boss'];
const MONSTER_ROLES: readonly MonsterRole[] = ['warrior', 'shooter', 'mage'];
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

function enemyDto(monster: MonsterDefinition): EnemyMonsterAuthoringDto {
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
    ...Object.values(MONSTERS).map(enemyDto)
  ];
}

export function getPlayerSpiritAuthoringDefinition(id: string): PlayerSpiritAuthoringDto | null {
  const spirit = SPIRITS.find((definition) => definition.id === id);
  return spirit ? createPlayerSpiritAuthoringDto(spirit) : null;
}

export function getEnemyMonsterAuthoringDefinition(id: string): EnemyMonsterAuthoringDto | null {
  const monster = enemyDefinitionById(id);
  return monster ? enemyDto(monster) : null;
}

function diagnostic(code: AuthoringDiagnosticCode, path: string, message: string): AuthoringDiagnostic {
  return { severity: 'error', code, path, message };
}

function validateString(value: unknown, path: string, diagnostics: AuthoringDiagnostic[]): value is string {
  if (typeof value === 'string') return true;
  diagnostics.push(diagnostic('INVALID_TYPE', path, 'Expected a string.'));
  return false;
}

function validateNumber(value: unknown, path: string, diagnostics: AuthoringDiagnostic[]): value is number {
  if (typeof value !== 'number') {
    diagnostics.push(diagnostic('INVALID_TYPE', path, 'Expected a number.'));
    return false;
  }
  if (!Number.isFinite(value)) {
    diagnostics.push(diagnostic('NON_FINITE_NUMBER', path, 'Expected a finite number.'));
    return false;
  }
  return true;
}

function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  diagnostics: AuthoringDiagnostic[]
): value is T {
  if (typeof value !== 'string') {
    diagnostics.push(diagnostic('INVALID_TYPE', path, 'Expected a string enum value.'));
    return false;
  }
  if (!allowed.includes(value as T)) {
    diagnostics.push(diagnostic('INVALID_ENUM_VALUE', path, `Expected one of: ${allowed.join(', ')}.`));
    return false;
  }
  return true;
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
  const validated: PlayerSpiritAuthoringChanges = {};
  rejectUnsupportedFields(changes, PLAYER_EDITABLE_FIELDS, PLAYER_READ_ONLY_FIELDS, diagnostics);

  for (const field of PLAYER_STRING_FIELDS) {
    if (!hasOwn(changes, field)) continue;
    const value = changes[field];
    if (validateString(value, `changes.${field}`, diagnostics)) validated[field] = value;
  }
  for (const field of PLAYER_NUMBER_FIELDS) {
    if (!hasOwn(changes, field)) continue;
    const value = changes[field];
    if (validateNumber(value, `changes.${field}`, diagnostics)) validated[field] = value;
  }
  if (hasOwn(changes, 'primaryRole') && validateEnum(changes.primaryRole, BATTLE_BEHAVIORS, 'changes.primaryRole', diagnostics)) {
    validated.primaryRole = changes.primaryRole;
  }
  if (hasOwn(changes, 'secondaryRole')) {
    if (changes.secondaryRole === null) validated.secondaryRole = null;
    else if (validateEnum(changes.secondaryRole, BATTLE_BEHAVIORS, 'changes.secondaryRole', diagnostics)) {
      validated.secondaryRole = changes.secondaryRole;
    }
  }
  if (hasOwn(changes, 'defaultPosition') && validateEnum(changes.defaultPosition, ROWS, 'changes.defaultPosition', diagnostics)) {
    validated.defaultPosition = changes.defaultPosition;
  }
  return validated;
}

function validateCoefficients(value: unknown, diagnostics: AuthoringDiagnostic[]) {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic('INVALID_TYPE', 'changes.coefficients', 'Expected an object.'));
    return null;
  }

  const validated: Partial<MonsterDefinition['coefficients']> = {};
  for (const field of Object.keys(value)) {
    if (!COEFFICIENT_FIELDS.includes(field as typeof COEFFICIENT_FIELDS[number])) {
      diagnostics.push(diagnostic('UNSUPPORTED_FIELD', `changes.coefficients.${field}`, `Coefficient '${field}' is not supported.`));
    }
  }
  for (const field of COEFFICIENT_FIELDS) {
    if (!hasOwn(value, field)) continue;
    const coefficient = value[field];
    if (validateNumber(coefficient, `changes.coefficients.${field}`, diagnostics)) validated[field] = coefficient;
  }
  return validated;
}

function validateEnemyChanges(changes: Record<string, unknown>, diagnostics: AuthoringDiagnostic[]) {
  const validated: EnemyMonsterAuthoringChanges = {};
  rejectUnsupportedFields(changes, ENEMY_EDITABLE_FIELDS, ENEMY_READ_ONLY_FIELDS, diagnostics);

  for (const field of ENEMY_STRING_FIELDS) {
    if (!hasOwn(changes, field)) continue;
    const value = changes[field];
    if (validateString(value, `changes.${field}`, diagnostics)) validated[field] = value;
  }
  for (const field of ENEMY_NUMBER_FIELDS) {
    if (!hasOwn(changes, field)) continue;
    const value = changes[field];
    if (validateNumber(value, `changes.${field}`, diagnostics)) validated[field] = value;
  }
  if (hasOwn(changes, 'category') && validateEnum(changes.category, MONSTER_CATEGORIES, 'changes.category', diagnostics)) {
    validated.category = changes.category;
  }
  if (hasOwn(changes, 'role')) {
    if (changes.role === null) validated.role = null;
    else if (validateEnum(changes.role, MONSTER_ROLES, 'changes.role', diagnostics)) validated.role = changes.role;
  }
  if (hasOwn(changes, 'defaultPosition') && validateEnum(changes.defaultPosition, ROWS, 'changes.defaultPosition', diagnostics)) {
    validated.defaultPosition = changes.defaultPosition;
  }
  if (hasOwn(changes, 'coefficients')) {
    const coefficients = validateCoefficients(changes.coefficients, diagnostics);
    if (coefficients) validated.coefficients = coefficients;
  }
  return validated;
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
