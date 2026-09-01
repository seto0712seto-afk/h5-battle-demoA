import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { authoringPropertyName, printAuthoringLiteral } from './authoringSourceAst';
import {
  authoringSourceRevision,
  runAuthoringSourceTransaction
} from './authoringSourceTransaction';
import type { AuthoringSourceTransactionHooks } from './authoringSourceTransaction';
import {
  BATTLE_MONSTER_AUTHORING_CONTRACT,
  createPlayerSpiritAuthoringDto,
  validateBattleMonsterAuthoringUpdate
} from './battleMonsterAuthoring';
import type {
  AuthoringDiagnostic,
  PlayerSpiritAuthoringChanges,
  PlayerSpiritAuthoringDto
} from './battleMonsterAuthoring';
import type { SpiritData } from './types';

export type PlayerSpiritWriteBackFailureReason =
  | 'validation-failure'
  | 'unknown-definition'
  | 'stale-source'
  | 'source-parse-failure'
  | 'source-transform-failure'
  | 'post-write-verification-failure'
  | 'rollback-failure'
  | 'filesystem-failure';

export type PlayerSpiritWriteBackSourceState = 'not-modified' | 'updated' | 'original-restored' | 'unknown';

export type PlayerSpiritWriteBackDiagnosticCode =
  | AuthoringDiagnostic['code']
  | 'UNSUPPORTED_DEFINITION_KIND'
  | 'STALE_SOURCE'
  | 'SOURCE_PARSE_FAILURE'
  | 'SOURCE_TRANSFORM_FAILURE'
  | 'POST_WRITE_VERIFICATION_FAILURE'
  | 'ROLLBACK_FAILURE'
  | 'FILESYSTEM_FAILURE';

export interface PlayerSpiritWriteBackDiagnostic {
  severity: 'error';
  code: PlayerSpiritWriteBackDiagnosticCode;
  path: string;
  message: string;
}

export interface PlayerSpiritSourceSnapshot {
  sourcePath: string;
  revision: string;
  spirits: PlayerSpiritAuthoringDto[];
}

export type PlayerSpiritSourceReadResult =
  | { ok: true; snapshot: PlayerSpiritSourceSnapshot; diagnostics: [] }
  | {
      ok: false;
      snapshot: null;
      reason: 'source-parse-failure' | 'filesystem-failure';
      diagnostics: PlayerSpiritWriteBackDiagnostic[];
    };

interface PlayerSpiritWriteBackTestHooks extends AuthoringSourceTransactionHooks {}

export interface PlayerSpiritWriteBackCoreRequest {
  sourcePath: string;
  expectedRevision: string;
  candidate: unknown;
  hooks?: PlayerSpiritWriteBackTestHooks;
}

export type PlayerSpiritWriteBackResult =
  | {
      ok: true;
      snapshot: PlayerSpiritSourceSnapshot;
      sourceState: 'updated';
      recoveryPath: null;
      diagnostics: [];
    }
  | {
      ok: false;
      snapshot: null;
      reason: PlayerSpiritWriteBackFailureReason;
      sourceState: Exclude<PlayerSpiritWriteBackSourceState, 'updated'>;
      recoveryPath: string | null;
      diagnostics: PlayerSpiritWriteBackDiagnostic[];
    };

interface ParsedSpirit {
  id: string;
  values: Record<string, unknown>;
  node: ts.ObjectLiteralExpression;
}

interface ParsedDataSource {
  sourceFile: ts.SourceFile;
  spiritsArray: ts.ArrayLiteralExpression;
  spirits: ParsedSpirit[];
  skillsText: string;
}

interface TransformResult {
  sourceText: string;
  targetStart: number;
  targetEnd: number;
}

class WriterFailure extends Error {
  constructor(
    readonly reason: PlayerSpiritWriteBackFailureReason,
    readonly diagnostic: PlayerSpiritWriteBackDiagnostic
  ) {
    super(diagnostic.message);
  }
}

const PLAYER_EDITABLE_FIELDS = new Set<string>(
  BATTLE_MONSTER_AUTHORING_CONTRACT.definitionKinds.playerSpirit.editableFields
);

function writerDiagnostic(
  code: PlayerSpiritWriteBackDiagnosticCode,
  path: string,
  message: string
): PlayerSpiritWriteBackDiagnostic {
  return { severity: 'error', code, path, message };
}

function failure(
  reason: PlayerSpiritWriteBackFailureReason,
  diagnostic: PlayerSpiritWriteBackDiagnostic | PlayerSpiritWriteBackDiagnostic[],
  sourceState: Exclude<PlayerSpiritWriteBackSourceState, 'updated'> = 'not-modified',
  recoveryPath: string | null = null
): PlayerSpiritWriteBackResult {
  return {
    ok: false,
    snapshot: null,
    reason,
    sourceState,
    recoveryPath,
    diagnostics: Array.isArray(diagnostic) ? diagnostic : [diagnostic]
  };
}

function propertyName(property: ts.PropertyName, sourceFile: ts.SourceFile): string | null {
  void sourceFile;
  return authoringPropertyName(property);
}

function literalValue(node: ts.Expression, sourceFile: ts.SourceFile): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text);
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => literalValue(element, sourceFile));
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) throw new Error('Only property assignments are supported.');
      const name = propertyName(property.name, sourceFile);
      if (name === null || Object.prototype.hasOwnProperty.call(value, name)) {
        throw new Error('Unsupported or duplicate property name.');
      }
      value[name] = literalValue(property.initializer, sourceFile);
    }
    return value;
  }
  throw new Error(`Unsupported expression '${node.getText(sourceFile)}'.`);
}

function findVariableInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer ?? null;
    }
  }
  return null;
}

function validateParsedSpirit(values: Record<string, unknown>): void {
  const id = values.id;
  if (typeof id !== 'string') throw new Error('Every Spirit requires a string ID.');
  if (!Array.isArray(values.skillIds) || values.skillIds.some((skillId) => typeof skillId !== 'string')) {
    throw new Error(`Spirit '${id}' requires a string skillIds array.`);
  }

  const changes: Record<string, unknown> = {};
  for (const field of BATTLE_MONSTER_AUTHORING_CONTRACT.definitionKinds.playerSpirit.editableFields) {
    if (field === 'secondaryRole' && !Object.prototype.hasOwnProperty.call(values, field)) continue;
    if (!Object.prototype.hasOwnProperty.call(values, field)) {
      throw new Error(`Spirit '${id}' is missing required field '${field}'.`);
    }
    changes[field] = values[field];
  }
  const validation = validateBattleMonsterAuthoringUpdate({ kind: 'playerSpirit', id, changes });
  if (!validation.ok) {
    throw new Error(`Spirit '${id}' failed S4B-1 validation: ${validation.diagnostics[0]?.message ?? 'unknown error'}`);
  }
}

function parseDataSource(sourcePath: string, sourceText: string): ParsedDataSource {
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const message = ts.flattenDiagnosticMessageText(parseDiagnostics[0].messageText, '\n');
    throw new WriterFailure(
      'source-parse-failure',
      writerDiagnostic('SOURCE_PARSE_FAILURE', '$', `TypeScript parse failed: ${message}`)
    );
  }

  const spiritsInitializer = findVariableInitializer(sourceFile, 'SPIRITS');
  const skillsInitializer = findVariableInitializer(sourceFile, 'SKILLS');
  if (!spiritsInitializer || !ts.isArrayLiteralExpression(spiritsInitializer) || !skillsInitializer) {
    throw new WriterFailure(
      'source-parse-failure',
      writerDiagnostic('SOURCE_PARSE_FAILURE', '$', 'Expected SPIRITS array and SKILLS initializer in canonical source.')
    );
  }

  const spirits: ParsedSpirit[] = [];
  const ids = new Set<string>();
  try {
    for (const element of spiritsInitializer.elements) {
      if (!ts.isObjectLiteralExpression(element)) throw new Error('Every SPIRITS element must be an object literal.');
      const values = literalValue(element, sourceFile);
      if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error('Invalid Spirit object.');
      const id = (values as Record<string, unknown>).id;
      if (typeof id !== 'string' || ids.has(id)) throw new Error('Every Spirit requires a unique string ID.');
      validateParsedSpirit(values as Record<string, unknown>);
      ids.add(id);
      spirits.push({ id, values: values as Record<string, unknown>, node: element });
    }
  } catch (error) {
    throw new WriterFailure(
      'source-parse-failure',
      writerDiagnostic('SOURCE_PARSE_FAILURE', 'SPIRITS', error instanceof Error ? error.message : 'Invalid SPIRITS source.')
    );
  }

  return {
    sourceFile,
    spiritsArray: spiritsInitializer,
    spirits,
    skillsText: sourceText.slice(skillsInitializer.getStart(sourceFile), skillsInitializer.getEnd())
  };
}

function asSpiritData(values: Record<string, unknown>): SpiritData {
  return values as unknown as SpiritData;
}

function snapshotFromParsed(sourcePath: string, sourceText: string, parsed: ParsedDataSource): PlayerSpiritSourceSnapshot {
  return {
    sourcePath,
    revision: authoringSourceRevision(sourceText),
    spirits: parsed.spirits.map((spirit) => createPlayerSpiritAuthoringDto(asSpiritData(spirit.values)))
  };
}

async function readSourceText(sourcePath: string): Promise<string> {
  return readFile(sourcePath, 'utf8');
}

export async function readPlayerSpiritAuthoringSourceAtPath(sourcePath: string): Promise<PlayerSpiritSourceReadResult> {
  const canonicalPath = resolve(sourcePath);
  try {
    const sourceText = await readSourceText(canonicalPath);
    const parsed = parseDataSource(canonicalPath, sourceText);
    return { ok: true, snapshot: snapshotFromParsed(canonicalPath, sourceText, parsed), diagnostics: [] };
  } catch (error) {
    if (error instanceof WriterFailure) {
      return { ok: false, snapshot: null, reason: 'source-parse-failure', diagnostics: [error.diagnostic] };
    }
    return {
      ok: false,
      snapshot: null,
      reason: 'filesystem-failure',
      diagnostics: [writerDiagnostic('FILESYSTEM_FAILURE', canonicalPath, error instanceof Error ? error.message : 'Read failed.')]
    };
  }
}

function objectProperties(
  object: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile
): Map<string, ts.PropertyAssignment> {
  const properties = new Map<string, ts.PropertyAssignment>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'SPIRITS', 'Target Spirit contains a non-property assignment.')
      );
    }
    const name = propertyName(property.name, sourceFile);
    if (name === null || properties.has(name)) {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'SPIRITS', 'Target Spirit contains an unsupported or duplicate property.')
      );
    }
    properties.set(name, property);
  }
  return properties;
}

function transformPlayerSpirit(
  sourceText: string,
  parsed: ParsedDataSource,
  id: string,
  changes: PlayerSpiritAuthoringChanges
): TransformResult {
  const target = parsed.spirits.find((spirit) => spirit.id === id);
  if (!target) {
    throw new WriterFailure(
      'source-transform-failure',
      writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'id', `Player Spirit '${id}' is absent from the selected source.`)
    );
  }

  const properties = objectProperties(target.node, parsed.sourceFile);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const [field, value] of Object.entries(changes)) {
    if (!PLAYER_EDITABLE_FIELDS.has(field)) {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', `changes.${field}`, 'Validated patch contains a non-editable field.')
      );
    }
    const property = properties.get(field);
    if (field === 'secondaryRole' && value === null) {
      if (!property) continue;
      const index = target.node.properties.indexOf(property);
      const next = target.node.properties[index + 1];
      if (!next || sourceText[property.getEnd()] !== ',') {
        throw new WriterFailure(
          'source-transform-failure',
          writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'changes.secondaryRole', 'Cannot safely remove secondaryRole.')
        );
      }
      edits.push({ start: property.getFullStart(), end: property.getEnd() + 1, text: '' });
      continue;
    }

    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', `changes.${field}`, 'Validated field is not a writable literal.')
      );
    }
    const replacement = printAuthoringLiteral(value, parsed.sourceFile);
    if (property) {
      edits.push({ start: property.initializer.getStart(parsed.sourceFile), end: property.initializer.getEnd(), text: replacement });
      continue;
    }
    if (field !== 'secondaryRole') {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', `changes.${field}`, `Required field '${field}' is absent from source.`)
      );
    }

    const primaryRole = properties.get('primaryRole');
    if (!primaryRole) {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'changes.secondaryRole', 'Cannot safely insert secondaryRole.')
      );
    }
    const primaryIndex = target.node.properties.indexOf(primaryRole);
    const next = target.node.properties[primaryIndex + 1];
    if (!next || sourceText[primaryRole.getEnd()] !== ',') {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'changes.secondaryRole', 'Cannot safely insert secondaryRole.')
      );
    }
    const leadingTrivia = sourceText.slice(next.getFullStart(), next.getStart(parsed.sourceFile));
    edits.push({
      start: next.getFullStart(),
      end: next.getFullStart(),
      text: `${leadingTrivia}secondaryRole: ${replacement},`
    });
  }

  edits.sort((left, right) => right.start - left.start);
  let transformed = sourceText;
  let previousStart = sourceText.length + 1;
  for (const edit of edits) {
    if (edit.end > previousStart) {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'changes', 'Source edits overlap.')
      );
    }
    transformed = transformed.slice(0, edit.start) + edit.text + transformed.slice(edit.end);
    previousStart = edit.start;
  }
  return { sourceText: transformed, targetStart: target.node.getStart(parsed.sourceFile), targetEnd: target.node.getEnd() };
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectedTarget(before: Record<string, unknown>, changes: PlayerSpiritAuthoringChanges): Record<string, unknown> {
  const expected = cloneValue(before);
  for (const [field, value] of Object.entries(changes)) {
    if (field === 'secondaryRole' && value === null) delete expected.secondaryRole;
    else expected[field] = value;
  }
  return expected;
}

function normalizedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizedValue(nested)])
    );
  }
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizedValue(left)) === JSON.stringify(normalizedValue(right));
}

function verifyTransformedSource(
  sourcePath: string,
  original: ParsedDataSource,
  transformedText: string,
  id: string,
  changes: PlayerSpiritAuthoringChanges
): ParsedDataSource {
  let transformed: ParsedDataSource;
  try {
    transformed = parseDataSource(sourcePath, transformedText);
  } catch (error) {
    if (error instanceof WriterFailure) {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', '$', error.diagnostic.message)
      );
    }
    throw error;
  }
  if (original.spirits.length !== transformed.spirits.length || original.skillsText !== transformed.skillsText) {
    throw new WriterFailure(
      'source-transform-failure',
      writerDiagnostic('SOURCE_TRANSFORM_FAILURE', '$', 'Spirit count or SKILLS source changed unexpectedly.')
    );
  }

  for (let index = 0; index < original.spirits.length; index += 1) {
    const before = original.spirits[index];
    const after = transformed.spirits[index];
    if (before.id !== after.id) {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', `SPIRITS[${index}].id`, 'Canonical ID changed unexpectedly.')
      );
    }
    const expected = before.id === id ? expectedTarget(before.values, changes) : before.values;
    if (!sameValue(after.values, expected)) {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', `SPIRITS.${before.id}`, 'Unexpected Spirit source change detected.')
      );
    }
  }
  return transformed;
}

async function currentSourceOrFailure(sourcePath: string): Promise<{ text: string; parsed: ParsedDataSource }> {
  let text: string;
  try {
    text = await readSourceText(sourcePath);
  } catch (error) {
    throw new WriterFailure(
      'filesystem-failure',
      writerDiagnostic('FILESYSTEM_FAILURE', sourcePath, error instanceof Error ? error.message : 'Read failed.')
    );
  }
  return { text, parsed: parseDataSource(sourcePath, text) };
}

export async function writePlayerSpiritAuthoringUpdateAtPath(
  request: PlayerSpiritWriteBackCoreRequest
): Promise<PlayerSpiritWriteBackResult> {
  const validation = validateBattleMonsterAuthoringUpdate(request.candidate);
  if (!validation.ok) {
    const reason = validation.diagnostics.some((entry) => entry.code === 'UNKNOWN_DEFINITION')
      ? 'unknown-definition'
      : 'validation-failure';
    return failure(reason, validation.diagnostics);
  }
  if (validation.update.kind !== 'playerSpirit') {
    return failure(
      'validation-failure',
      writerDiagnostic('UNSUPPORTED_DEFINITION_KIND', 'kind', 'S4B-2A only writes Player Spirit definitions.')
    );
  }

  const sourcePath = resolve(request.sourcePath);
  let current: { text: string; parsed: ParsedDataSource };
  try {
    current = await currentSourceOrFailure(sourcePath);
  } catch (error) {
    if (error instanceof WriterFailure) return failure(error.reason, error.diagnostic);
    return failure(
      'filesystem-failure',
      writerDiagnostic('FILESYSTEM_FAILURE', sourcePath, error instanceof Error ? error.message : 'Read failed.')
    );
  }
  if (authoringSourceRevision(current.text) !== request.expectedRevision) {
    return failure(
      'stale-source',
      writerDiagnostic('STALE_SOURCE', sourcePath, 'Canonical source changed after the authoring snapshot was read.')
    );
  }

  let transformed: TransformResult;
  try {
    transformed = transformPlayerSpirit(
      current.text,
      current.parsed,
      validation.update.id,
      validation.update.changes
    );
    verifyTransformedSource(
      sourcePath,
      current.parsed,
      transformed.sourceText,
      validation.update.id,
      validation.update.changes
    );
  } catch (error) {
    if (error instanceof WriterFailure) return failure(error.reason, error.diagnostic);
    return failure(
      'source-transform-failure',
      writerDiagnostic('SOURCE_TRANSFORM_FAILURE', sourcePath, error instanceof Error ? error.message : 'Transform failed.')
    );
  }

  return runAuthoringSourceTransaction({
    sourcePath,
    expectedRevision: request.expectedRevision,
    originalSourceText: current.text,
    transformedSourceText: transformed.sourceText,
    hooks: request.hooks,
    verifyWrittenSource(verifiedPath, writtenText) {
      const writtenParsed = verifyTransformedSource(
        verifiedPath,
        current.parsed,
        writtenText,
        validation.update.id,
        validation.update.changes
      );
      return snapshotFromParsed(verifiedPath, writtenText, writtenParsed);
    }
  });
}
