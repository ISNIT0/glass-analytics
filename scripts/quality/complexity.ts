/**
 * Per-function complexity for `packages/* /src`, using the TypeScript compiler API (already a
 * dev dependency) so there is nothing new to install.
 *
 * Two numbers per function:
 *
 * - **cognitive**: SonarSource's cognitive complexity, the one the ratchet gates on. Each break
 *   in linear flow (if, else, ternary, switch, loop, catch, labelled jump, a run of `&&`/`||`/`??`)
 *   costs 1, and structures nested inside other structures cost 1 more per level. It tracks how
 *   hard a function is to read, not how many paths it has.
 * - **cyclomatic**: McCabe's count of independent paths (1 + decisions). Reported, not gated.
 *
 * What counts as "a function": declarations, methods, constructors, accessors, and function
 * expressions or arrows bound to a name (a variable, a class field, an object property, a
 * default export). Inline callbacks (`.map(x => …)`, `r.get('/api', () => …)`) are scored as
 * part of the function they sit in, one nesting level deeper, as Sonar does. An inline
 * callback with no enclosing function (a top-level `addEventListener(…, () => …)`) is
 * scored on its own and named after the call it is passed to.
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';

export interface FunctionMetrics {
  /** Repo-relative path with forward slashes. */
  file: string;
  /** Qualified name, e.g. `GlassService.overview`, `apiRouter`, `FRAMEWORKS.next`. */
  name: string;
  line: number;
  endLine: number;
  cognitive: number;
  cyclomatic: number;
}

export interface FileComplexity {
  functions: FunctionMetrics[];
  /** True when the file has no runtime code (only types, interfaces, type imports/exports). */
  typeOnly: boolean;
  lines: number;
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

const LOGICAL = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

/** Skip wrappers that don't change what an expression is bound to: parens, `as`, `satisfies`, `!`. */
function bindingParent(node: ts.Node): ts.Node {
  let parent = node.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isTypeAssertionExpression(parent)
  ) {
    parent = parent.parent;
  }
  return parent;
}

function propertyName(name: ts.PropertyName | ts.BindingName, sf: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sf);
}

/** The name a function is bound to, or null when it is an inline callback. */
function boundName(node: FunctionLike, sf: ts.SourceFile): string | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    const own = node.name ? propertyName(node.name, sf) : 'default';
    if (ts.isGetAccessorDeclaration(node)) return `get ${own}`;
    if (ts.isSetAccessorDeclaration(node)) return `set ${own}`;
    return own;
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  const parent = bindingParent(node);
  if (ts.isVariableDeclaration(parent)) return propertyName(parent.name, sf);
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return propertyName(parent.name, sf);
  }
  if (ts.isExportAssignment(parent)) return 'default';
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    node.pos >= parent.right.pos // `x.onload = () => …`
  ) {
    return parent.left.getText(sf);
  }
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  return null;
}

/** Names of the classes and object literals around a node, outermost first. */
function containerPath(node: ts.Node, sf: ts.SourceFile): string[] {
  const path: string[] = [];
  for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if ((ts.isClassDeclaration(n) || ts.isClassExpression(n)) && n.name) path.unshift(n.name.text);
    else if (ts.isObjectLiteralExpression(n)) {
      const holder = bindingParent(n);
      if (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)) {
        path.unshift(propertyName(holder.name, sf));
      }
    } else if (isFunctionLike(n)) {
      const name = boundName(n, sf);
      if (name) path.unshift(name);
    }
  }
  return path;
}

/** `addEventListener('click')`-style label for a top-level inline callback. */
function callbackLabel(node: FunctionLike, sf: ts.SourceFile): string {
  const parent = bindingParent(node);
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression.getText(sf).replace(/\s+/g, '');
    const first = parent.arguments[0];
    const arg = first && ts.isStringLiteralLike(first) ? `'${first.text}'` : '';
    return `${callee}(${arg}) callback`;
  }
  return 'callback';
}

/** In-order list of logical operators in a chain, looking through parentheses. */
function logicalOperators(node: ts.Expression, out: ts.SyntaxKind[]): void {
  if (ts.isParenthesizedExpression(node)) logicalOperators(node.expression, out);
  else if (ts.isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind)) {
    logicalOperators(node.left, out);
    out.push(node.operatorToken.kind);
    logicalOperators(node.right, out);
  }
}

function isLogical(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind);
}

/** Score one function body. Nested functions that are reported on their own are skipped. */
function score(unit: FunctionLike, isUnit: (n: ts.Node) => boolean) {
  let cognitive = 0;
  let cyclomatic = 1;

  const visit = (node: ts.Node, nesting: number): void => {
    if (node !== unit && isUnit(node)) return;

    if (ts.isIfStatement(node)) {
      // A chain `if … else if … else` costs 1 + nesting for the first `if`, then 1 per branch.
      const isElseIf = ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
      cognitive += isElseIf ? 1 : 1 + nesting;
      cyclomatic += 1;
      visit(node.expression, nesting);
      visit(node.thenStatement, nesting + 1);
      const otherwise = node.elseStatement;
      if (otherwise && ts.isIfStatement(otherwise)) visit(otherwise, nesting);
      else if (otherwise) {
        cognitive += 1;
        visit(otherwise, nesting + 1);
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      cognitive += 1 + nesting;
      cyclomatic += 1;
      visit(node.condition, nesting);
      visit(node.whenTrue, nesting + 1);
      visit(node.whenFalse, nesting + 1);
      return;
    }
    if (ts.isSwitchStatement(node)) {
      cognitive += 1 + nesting;
      visit(node.expression, nesting);
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) cyclomatic += 1;
        visit(clause, nesting + 1);
      }
      return;
    }
    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      cognitive += 1 + nesting;
      cyclomatic += 1;
      ts.forEachChild(node, (child) => {
        visit(child, child === node.statement ? nesting + 1 : nesting);
      });
      return;
    }
    if (ts.isCatchClause(node)) {
      cognitive += 1 + nesting;
      cyclomatic += 1;
      visit(node.block, nesting + 1);
      return;
    }
    if ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) && node.label) {
      cognitive += 1;
      return;
    }
    if (isLogical(node) && !isLogical(bindingParentExpr(node))) {
      // `a && b && c` costs 1; `a && b || c` costs 2: one per run of the same operator.
      const ops: ts.SyntaxKind[] = [];
      logicalOperators(node, ops);
      cyclomatic += ops.length;
      cognitive += ops.filter((op, i) => op !== ops[i - 1]).length;
    }
    if (node !== unit && isFunctionLike(node)) {
      // An inline callback: its structures count toward this function, one level deeper.
      ts.forEachChild(node, (child) => visit(child, nesting + 1));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, nesting));
  };

  visit(unit, 0);
  return { cognitive, cyclomatic };
}

/** Parent of an expression, looking through parentheses only (so `a && (b || c)` is one chain). */
function bindingParentExpr(node: ts.Node): ts.Node {
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return parent;
}

function isTypeOnlyStatement(statement: ts.Statement): boolean {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true;
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    return !!clause && (clause.isTypeOnly || isAllTypeNamedBindings(clause.namedBindings));
  }
  if (ts.isExportDeclaration(statement)) return statement.isTypeOnly;
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
}

function isAllTypeNamedBindings(bindings: ts.NamedImportBindings | undefined): boolean {
  return (
    !!bindings &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((e) => e.isTypeOnly)
  );
}

export function analyzeFile(path: string, file: string): FileComplexity {
  const text = readFileSync(path, 'utf8');
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  // A function is reported on its own when it is bound to a name, or when it is an inline
  // callback with no enclosing function to roll up into.
  const units = new Set<ts.Node>();
  const findUnits = (node: ts.Node, inUnit: boolean): void => {
    let inside = inUnit;
    if (isFunctionLike(node) && (boundName(node, sf) !== null || !inUnit)) {
      units.add(node);
      inside = true;
    }
    ts.forEachChild(node, (child) => findUnits(child, inside));
  };
  findUnits(sf, false);

  const seen = new Map<string, number>();
  const functions: FunctionMetrics[] = [];
  for (const unit of units as Set<FunctionLike>) {
    if (!unit.body) continue; // overload signatures
    const own = boundName(unit, sf) ?? callbackLabel(unit, sf);
    let name = [...containerPath(unit, sf), own].join('.');
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count > 1) name = `${name}#${count}`;
    const { cognitive, cyclomatic } = score(unit, (n) => units.has(n));
    functions.push({
      file,
      name,
      line: lineOf(unit.getStart(sf)),
      endLine: lineOf(unit.getEnd()),
      cognitive,
      cyclomatic,
    });
  }

  return {
    functions,
    typeOnly: path.endsWith('.d.ts') || sf.statements.every(isTypeOnlyStatement),
    lines: text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length,
  };
}
