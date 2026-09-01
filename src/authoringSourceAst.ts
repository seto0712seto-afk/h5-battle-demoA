import * as ts from 'typescript';

export function authoringPropertyName(property: ts.PropertyName): string | null {
  if (ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property)) {
    return property.text;
  }
  if (ts.isComputedPropertyName(property) && ts.isStringLiteral(property.expression)) {
    return property.expression.text;
  }
  return null;
}

function expressionForAuthoringValue(value: string | number): ts.Expression {
  if (typeof value === 'string') return ts.factory.createStringLiteral(value, true);
  if (value < 0 || Object.is(value, -0)) {
    return ts.factory.createPrefixUnaryExpression(
      ts.SyntaxKind.MinusToken,
      ts.factory.createNumericLiteral(Math.abs(value))
    );
  }
  return ts.factory.createNumericLiteral(value);
}

export function printAuthoringLiteral(value: string | number, sourceFile: ts.SourceFile): string {
  return ts.createPrinter().printNode(ts.EmitHint.Expression, expressionForAuthoringValue(value), sourceFile);
}
