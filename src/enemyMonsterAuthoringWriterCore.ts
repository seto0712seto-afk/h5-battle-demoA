import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { authoringPropertyName, printAuthoringLiteral } from './authoringSourceAst';
import {
  authoringSourceRevision,
  runAuthoringSourceTransaction
} from './authoringSourceTransaction';
import type { AuthoringSourceTransactionHooks } from './authoringSourceTransaction';
import { validateBattleMonsterAuthoringUpdate } from './battleMonsterAuthoring';
import type {
  AuthoringDiagnostic,
  EnemyMonsterAuthoringChanges
} from './battleMonsterAuthoring';
import type { MonsterDefinition, MonsterSkillDefinition } from './monsterTypes';

export type EnemyMonsterWriteBackFailureReason =
  | 'validation-failure'
  | 'unknown-definition'
  | 'stale-source'
  | 'source-parse-failure'
  | 'source-transform-failure'
  | 'post-write-verification-failure'
  | 'rollback-failure'
  | 'filesystem-failure';

export type EnemyMonsterWriteBackSourceState = 'not-modified' | 'updated' | 'original-restored' | 'unknown';

export type EnemyMonsterWriteBackDiagnosticCode =
  | AuthoringDiagnostic['code']
  | 'UNSUPPORTED_DEFINITION_KIND'
  | 'STALE_SOURCE'
  | 'SOURCE_PARSE_FAILURE'
  | 'SOURCE_TRANSFORM_FAILURE'
  | 'POST_WRITE_VERIFICATION_FAILURE'
  | 'ROLLBACK_FAILURE'
  | 'FILESYSTEM_FAILURE';

export interface EnemyMonsterWriteBackDiagnostic {
  severity: 'error';
  code: EnemyMonsterWriteBackDiagnosticCode;
  path: string;
  message: string;
}

export interface EnemyMonsterSourceLocation {
  id: string;
  sourceKind: 'theme-config' | 'direct-boss';
}

export interface EnemyMonsterSourceSnapshot {
  sourcePath: string;
  revision: string;
  definitions: MonsterDefinition[];
  monsterSkills: Record<string, MonsterSkillDefinition>;
  locations: EnemyMonsterSourceLocation[];
}

export type EnemyMonsterSourceReadResult =
  | { ok: true; snapshot: EnemyMonsterSourceSnapshot; diagnostics: [] }
  | {
      ok: false;
      snapshot: null;
      reason: 'source-parse-failure' | 'filesystem-failure';
      diagnostics: EnemyMonsterWriteBackDiagnostic[];
    };

interface EnemyMonsterWriteBackTestHooks extends AuthoringSourceTransactionHooks {}

export interface EnemyMonsterWriteBackCoreRequest {
  sourcePath: string;
  expectedRevision: string;
  candidate: unknown;
  hooks?: EnemyMonsterWriteBackTestHooks;
}

export type EnemyMonsterWriteBackResult =
  | {
      ok: true;
      snapshot: EnemyMonsterSourceSnapshot;
      sourceState: 'not-modified' | 'updated';
      recoveryPath: null;
      diagnostics: [];
    }
  | {
      ok: false;
      snapshot: null;
      reason: EnemyMonsterWriteBackFailureReason;
      sourceState: Exclude<EnemyMonsterWriteBackSourceState, 'updated'>;
      recoveryPath: string | null;
      diagnostics: EnemyMonsterWriteBackDiagnostic[];
    };

interface ParsedEnemyLocation extends EnemyMonsterSourceLocation {
  node: ts.ObjectLiteralExpression;
}

interface ParsedEnemySource {
  sourceFile: ts.SourceFile;
  definitions: Record<string, MonsterDefinition>;
  monsterSkills: Record<string, MonsterSkillDefinition>;
  locations: ParsedEnemyLocation[];
  locationById: Map<string, ParsedEnemyLocation>;
}

interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

class WriterFailure extends Error {
  constructor(
    readonly reason: EnemyMonsterWriteBackFailureReason,
    readonly diagnostic: EnemyMonsterWriteBackDiagnostic
  ) {
    super(diagnostic.message);
  }
}

function writerDiagnostic(
  code: EnemyMonsterWriteBackDiagnosticCode,
  path: string,
  message: string
): EnemyMonsterWriteBackDiagnostic {
  return { severity: 'error', code, path, message };
}

function failure(
  reason: EnemyMonsterWriteBackFailureReason,
  diagnostics: EnemyMonsterWriteBackDiagnostic | EnemyMonsterWriteBackDiagnostic[],
  sourceState: Exclude<EnemyMonsterWriteBackSourceState, 'updated'> = 'not-modified',
  recoveryPath: string | null = null
): EnemyMonsterWriteBackResult {
  return {
    ok: false,
    snapshot: null,
    reason,
    sourceState,
    recoveryPath,
    diagnostics: Array.isArray(diagnostics) ? diagnostics : [diagnostics]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameSemanticValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameSemanticValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) =>
    key === rightKeys[index]
    && Object.prototype.hasOwnProperty.call(right, key)
    && sameSemanticValue(left[key], right[key])
  );
}

function staticProperties(object: ts.ObjectLiteralExpression): Map<string, ts.PropertyAssignment> {
  const properties = new Map<string, ts.PropertyAssignment>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) throw new Error('Expected direct property assignments.');
    const name = authoringPropertyName(property.name);
    if (name === null || properties.has(name)) throw new Error('Expected unique static property names.');
    properties.set(name, property);
  }
  return properties;
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string
): ts.ObjectLiteralExpression {
  const property = staticProperties(object).get(name);
  if (!property || !ts.isObjectLiteralExpression(property.initializer)) {
    throw new Error(`Expected '${name}' object literal.`);
  }
  return property.initializer;
}

function callFromTopLevelStatement(statement: ts.Statement, name: string): ts.CallExpression | null {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return null;
  const call = statement.expression;
  return ts.isIdentifier(call.expression) && call.expression.text === name ? call : null;
}

function definitionId(node: ts.ObjectLiteralExpression): string {
  const idProperty = staticProperties(node).get('id');
  if (!idProperty || !ts.isStringLiteralLike(idProperty.initializer)) {
    throw new Error('Every authorable Enemy source node requires a direct string ID literal.');
  }
  return idProperty.initializer.text;
}

function compileMonsterData(
  sourcePath: string,
  sourceText: string
): { definitions: Record<string, MonsterDefinition>; monsterSkills: Record<string, MonsterSkillDefinition> } {
  const compilation = ts.transpileModule(sourceText, {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      strict: true
    }
  });
  const errors = (compilation.diagnostics ?? []).filter((entry) => entry.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(`TypeScript compile failed: ${ts.flattenDiagnosticMessageText(errors[0].messageText, '\n')}`);
  }

  const exported: Record<string, unknown> = {};
  const module = { exports: exported };
  const execute = new Function('exports', 'module', 'require', compilation.outputText);
  execute(exported, module, (id: string) => {
    throw new Error(`Unexpected runtime import '${id}'.`);
  });
  const definitions = module.exports.MONSTERS;
  const monsterSkills = module.exports.MONSTER_SKILLS;
  if (!isRecord(definitions) || !isRecord(monsterSkills)) {
    throw new Error('Compiled source must export MONSTERS and MONSTER_SKILLS records.');
  }
  return {
    definitions: definitions as unknown as Record<string, MonsterDefinition>,
    monsterSkills: monsterSkills as unknown as Record<string, MonsterSkillDefinition>
  };
}

function validateRuntimeDefinitionIdentity(definitions: Record<string, MonsterDefinition>): void {
  for (const [id, definition] of Object.entries(definitions)) {
    if (!isRecord(definition) || definition.id !== id) {
      throw new Error(`MONSTERS entry '${id}' has an invalid canonical ID.`);
    }
  }
}

function parseEnemySource(sourcePath: string, sourceText: string): ParsedEnemySource {
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    throw new WriterFailure(
      'source-parse-failure',
      writerDiagnostic(
        'SOURCE_PARSE_FAILURE',
        '$',
        `TypeScript parse failed: ${ts.flattenDiagnosticMessageText(parseDiagnostics[0].messageText, '\n')}`
      )
    );
  }

  try {
    const locations: ParsedEnemyLocation[] = [];
    const locationById = new Map<string, ParsedEnemyLocation>();
    const register = (node: ts.ObjectLiteralExpression, sourceKind: EnemyMonsterSourceLocation['sourceKind']) => {
      const id = definitionId(node);
      if (locationById.has(id)) throw new Error(`Duplicate Enemy source node '${id}'.`);
      const location = { id, sourceKind, node };
      locations.push(location);
      locationById.set(id, location);
    };

    for (const statement of sourceFile.statements) {
      const themeCall = callFromTopLevelStatement(statement, 'addThemeEnemies');
      if (themeCall) {
        if (themeCall.arguments.length !== 1 || !ts.isObjectLiteralExpression(themeCall.arguments[0])) {
          throw new Error('Every addThemeEnemies call requires one object literal config.');
        }
        const enemies = objectProperty(themeCall.arguments[0], 'enemies');
        for (const property of enemies.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) {
            throw new Error('Every Theme Enemy requires an independent object literal config.');
          }
          register(property.initializer, 'theme-config');
        }
      }

      const bossCall = callFromTopLevelStatement(statement, 'addMonster');
      if (bossCall) {
        if (bossCall.arguments.length !== 1 || !ts.isObjectLiteralExpression(bossCall.arguments[0])) {
          throw new Error('Every direct Boss requires one object literal definition.');
        }
        register(bossCall.arguments[0], 'direct-boss');
      }
    }

    const runtime = compileMonsterData(sourcePath, sourceText);
    validateRuntimeDefinitionIdentity(runtime.definitions);
    const runtimeIds = Object.keys(runtime.definitions);
    if (
      runtimeIds.length !== locations.length
      || runtimeIds.some((id) => !locationById.has(id))
      || locations.some((location) => !Object.prototype.hasOwnProperty.call(runtime.definitions, location.id))
    ) {
      throw new Error('Every runtime MONSTERS definition must have exactly one structured source node.');
    }

    return {
      sourceFile,
      definitions: runtime.definitions,
      monsterSkills: runtime.monsterSkills,
      locations,
      locationById
    };
  } catch (error) {
    if (error instanceof WriterFailure) throw error;
    throw new WriterFailure(
      'source-parse-failure',
      writerDiagnostic('SOURCE_PARSE_FAILURE', 'MONSTERS', error instanceof Error ? error.message : 'Invalid Enemy source.')
    );
  }
}

function snapshotFromParsed(
  sourcePath: string,
  sourceText: string,
  parsed: ParsedEnemySource
): EnemyMonsterSourceSnapshot {
  return {
    sourcePath,
    revision: authoringSourceRevision(sourceText),
    definitions: Object.keys(parsed.definitions).map((id) => structuredClone(parsed.definitions[id])),
    monsterSkills: structuredClone(parsed.monsterSkills),
    locations: parsed.locations.map(({ id, sourceKind }) => ({ id, sourceKind }))
  };
}

async function readSourceText(sourcePath: string): Promise<string> {
  return readFile(sourcePath, 'utf8');
}

export async function readEnemyMonsterAuthoringSourceAtPath(sourcePath: string): Promise<EnemyMonsterSourceReadResult> {
  const canonicalPath = resolve(sourcePath);
  try {
    const sourceText = await readSourceText(canonicalPath);
    const parsed = parseEnemySource(canonicalPath, sourceText);
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

function removePropertyEdit(
  sourceText: string,
  object: ts.ObjectLiteralExpression,
  property: ts.PropertyAssignment
): SourceEdit {
  const index = object.properties.indexOf(property);
  const next = object.properties[index + 1];
  if (!next || sourceText[property.getEnd()] !== ',') {
    throw new WriterFailure(
      'source-transform-failure',
      writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'changes.role', 'Cannot safely remove role.')
    );
  }
  return { start: property.getFullStart(), end: property.getEnd() + 1, text: '' };
}

function insertRoleEdit(
  sourceText: string,
  sourceFile: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
  properties: Map<string, ts.PropertyAssignment>,
  role: string
): SourceEdit {
  const defaultPosition = properties.get('defaultPosition');
  if (!defaultPosition) {
    throw new WriterFailure(
      'source-transform-failure',
      writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'changes.role', 'Cannot safely insert role.')
    );
  }
  const leadingTrivia = sourceText.slice(defaultPosition.getFullStart(), defaultPosition.getStart(sourceFile));
  return {
    start: defaultPosition.getFullStart(),
    end: defaultPosition.getFullStart(),
    text: `${leadingTrivia}role: ${printAuthoringLiteral(role, sourceFile)},`
  };
}

function transformEnemyDefinition(
  sourceText: string,
  parsed: ParsedEnemySource,
  id: string,
  changes: EnemyMonsterAuthoringChanges
): string {
  const location = parsed.locationById.get(id);
  if (!location) {
    throw new WriterFailure(
      'source-transform-failure',
      writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'id', `Enemy '${id}' is absent from the selected source.`)
    );
  }

  let properties: Map<string, ts.PropertyAssignment>;
  try {
    properties = staticProperties(location.node);
  } catch (error) {
    throw new WriterFailure(
      'source-transform-failure',
      writerDiagnostic('SOURCE_TRANSFORM_FAILURE', `MONSTERS.${id}`, error instanceof Error ? error.message : 'Invalid source node.')
    );
  }

  const edits: SourceEdit[] = [];
  for (const [field, value] of Object.entries(changes)) {
    if (field === 'coefficients') {
      const coefficientProperty = properties.get('coefficients');
      if (!coefficientProperty || !ts.isObjectLiteralExpression(coefficientProperty.initializer) || !isRecord(value)) {
        throw new WriterFailure(
          'source-transform-failure',
          writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'changes.coefficients', 'Expected direct coefficients source object.')
        );
      }
      let coefficientProperties: Map<string, ts.PropertyAssignment>;
      try {
        coefficientProperties = staticProperties(coefficientProperty.initializer);
      } catch (error) {
        throw new WriterFailure(
          'source-transform-failure',
          writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'changes.coefficients', error instanceof Error ? error.message : 'Invalid coefficients source.')
        );
      }
      for (const [coefficient, coefficientValue] of Object.entries(value)) {
        const sourceProperty = coefficientProperties.get(coefficient);
        if (!sourceProperty || typeof coefficientValue !== 'number') {
          throw new WriterFailure(
            'source-transform-failure',
            writerDiagnostic(
              'SOURCE_TRANSFORM_FAILURE',
              `changes.coefficients.${coefficient}`,
              'Validated coefficient has no direct writable source literal.'
            )
          );
        }
        edits.push({
          start: sourceProperty.initializer.getStart(parsed.sourceFile),
          end: sourceProperty.initializer.getEnd(),
          text: printAuthoringLiteral(coefficientValue, parsed.sourceFile)
        });
      }
      continue;
    }

    const property = properties.get(field);
    if (field === 'role' && value === null) {
      if (property) edits.push(removePropertyEdit(sourceText, location.node, property));
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', `changes.${field}`, 'Validated field is not a writable literal.')
      );
    }
    if (!property) {
      if (field === 'role' && typeof value === 'string') {
        edits.push(insertRoleEdit(sourceText, parsed.sourceFile, location.node, properties, value));
        continue;
      }
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', `changes.${field}`, `Required field '${field}' is absent from source.`)
      );
    }
    edits.push({
      start: property.initializer.getStart(parsed.sourceFile),
      end: property.initializer.getEnd(),
      text: printAuthoringLiteral(value, parsed.sourceFile)
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
  return transformed;
}

function expectedDefinition(
  definition: MonsterDefinition,
  changes: EnemyMonsterAuthoringChanges
): MonsterDefinition {
  const expected = structuredClone(definition);
  for (const [field, value] of Object.entries(changes)) {
    if (field === 'role' && value === null) {
      delete expected.role;
    } else if (field === 'coefficients' && isRecord(value)) {
      expected.coefficients = { ...expected.coefficients, ...value };
    } else {
      (expected as unknown as Record<string, unknown>)[field] = value;
    }
  }
  return expected;
}

function sameOrderedKeys(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
}

function verifyTransformedSource(
  sourcePath: string,
  original: ParsedEnemySource,
  sourceText: string,
  id: string,
  changes: EnemyMonsterAuthoringChanges,
  batchChanges?: ReadonlyMap<string, EnemyMonsterAuthoringChanges>
): ParsedEnemySource {
  let transformed: ParsedEnemySource;
  try {
    transformed = parseEnemySource(sourcePath, sourceText);
  } catch (error) {
    throw new WriterFailure(
      'source-transform-failure',
      writerDiagnostic(
        'SOURCE_TRANSFORM_FAILURE',
        '$',
        error instanceof Error ? error.message : 'Transformed source is invalid.'
      )
    );
  }

  if (
    !sameOrderedKeys(original.definitions as unknown as Record<string, unknown>, transformed.definitions as unknown as Record<string, unknown>)
    || !sameOrderedKeys(original.monsterSkills as unknown as Record<string, unknown>, transformed.monsterSkills as unknown as Record<string, unknown>)
  ) {
    throw new WriterFailure(
      'source-transform-failure',
      writerDiagnostic('SOURCE_TRANSFORM_FAILURE', '$', 'MONSTERS or MONSTER_SKILLS identity/order changed unexpectedly.')
    );
  }
  if (!sameSemanticValue(original.monsterSkills, transformed.monsterSkills)) {
    throw new WriterFailure(
      'source-transform-failure',
      writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'MONSTER_SKILLS', 'MONSTER_SKILLS changed unexpectedly.')
    );
  }

  for (const definitionId of Object.keys(original.definitions)) {
    const patch = batchChanges?.get(definitionId) ?? (definitionId === id ? changes : undefined);
    const expected = patch
      ? expectedDefinition(original.definitions[definitionId], patch)
      : original.definitions[definitionId];
    if (!sameSemanticValue(expected, transformed.definitions[definitionId])) {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', `MONSTERS.${definitionId}`, 'Unexpected Enemy definition change detected.')
      );
    }
    if (original.locationById.get(definitionId)?.sourceKind !== transformed.locationById.get(definitionId)?.sourceKind) {
      throw new WriterFailure(
        'source-transform-failure',
        writerDiagnostic('SOURCE_TRANSFORM_FAILURE', `MONSTERS.${definitionId}`, 'Enemy source identity changed unexpectedly.')
      );
    }
  }
  return transformed;
}

async function currentSourceOrFailure(sourcePath: string): Promise<{ text: string; parsed: ParsedEnemySource }> {
  let text: string;
  try {
    text = await readSourceText(sourcePath);
  } catch (error) {
    throw new WriterFailure(
      'filesystem-failure',
      writerDiagnostic('FILESYSTEM_FAILURE', sourcePath, error instanceof Error ? error.message : 'Read failed.')
    );
  }
  return { text, parsed: parseEnemySource(sourcePath, text) };
}

/** In-memory preparation only; the batch authority owns the one filesystem transaction. */
export function prepareEnemyMonsterAuthoringBatch(
  sourcePath: string,
  originalText: string,
  updates: readonly { id: string; changes: EnemyMonsterAuthoringChanges }[]
) {
  const original = parseEnemySource(sourcePath, originalText);
  let parsed = original;
  let text = originalText;
  const patches = new Map(updates.map((update) => [update.id, update.changes]));
  let changed = false;
  for (const update of updates) {
    const before = parsed.definitions[update.id];
    if (!before) throw new WriterFailure('source-transform-failure',
      writerDiagnostic('SOURCE_TRANSFORM_FAILURE', 'id', 'Target is absent from the selected source.'));
    if (sameSemanticValue(before, expectedDefinition(before, update.changes))) continue;
    const transformed = transformEnemyDefinition(text, parsed, update.id, update.changes);
    parsed = verifyTransformedSource(sourcePath, parsed, transformed, update.id, update.changes);
    text = transformed;
    changed = true;
  }
  const verify = (verifiedPath: string, writtenText: string) => snapshotFromParsed(
    verifiedPath, writtenText,
    verifyTransformedSource(verifiedPath, original, writtenText, '', {}, patches)
  );
  return { changed, transformedSourceText: text, snapshot: verify(sourcePath, text), verifyWrittenSource: verify };
}

export async function writeEnemyMonsterAuthoringUpdateAtPath(
  request: EnemyMonsterWriteBackCoreRequest
): Promise<EnemyMonsterWriteBackResult> {
  const validation = validateBattleMonsterAuthoringUpdate(request.candidate);
  if (!validation.ok) {
    const reason = validation.diagnostics.some((entry) => entry.code === 'UNKNOWN_DEFINITION')
      ? 'unknown-definition'
      : 'validation-failure';
    return failure(reason, validation.diagnostics);
  }
  if (validation.update.kind !== 'enemyMonster') {
    return failure(
      'validation-failure',
      writerDiagnostic('UNSUPPORTED_DEFINITION_KIND', 'kind', 'S4B-2B only writes Enemy Monster definitions.')
    );
  }

  const sourcePath = resolve(request.sourcePath);
  let current: { text: string; parsed: ParsedEnemySource };
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

  const expected = expectedDefinition(
    current.parsed.definitions[validation.update.id],
    validation.update.changes
  );
  if (sameSemanticValue(expected, current.parsed.definitions[validation.update.id])) {
    return {
      ok: true,
      snapshot: snapshotFromParsed(sourcePath, current.text, current.parsed),
      sourceState: 'not-modified',
      recoveryPath: null,
      diagnostics: []
    };
  }

  let transformedText: string;
  try {
    transformedText = transformEnemyDefinition(
      current.text,
      current.parsed,
      validation.update.id,
      validation.update.changes
    );
    verifyTransformedSource(
      sourcePath,
      current.parsed,
      transformedText,
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
    transformedSourceText: transformedText,
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
