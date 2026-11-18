/**
 * Formulas over series: `B / A * 100`, `(A - B) / A`, `A + B + C`.
 *
 * Letters name series in order (A is the first). The grammar is arithmetic only:
 * numbers, letters, + - * /, unary minus and parentheses. It is parsed once into
 * a tree and evaluated per bucket, never with `eval`, so a formula from an agent
 * or a URL can't run code. Division by zero gives 0, as in PostHog.
 */

export type FormulaNode =
  | { type: 'num'; value: number }
  | { type: 'var'; index: number; name: string }
  | { type: 'neg'; arg: FormulaNode }
  | { type: 'bin'; op: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode };

export class FormulaError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '(' | ')' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < input.length && /[0-9.]/.test(input[j]!)) j++;
      const value = Number(input.slice(i, j));
      if (!Number.isFinite(value)) throw new FormulaError(`Bad number "${input.slice(i, j)}"`);
      tokens.push({ kind: 'num', value });
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      if (i + 1 < input.length && /[A-Za-z0-9_]/.test(input[i + 1]!)) {
        throw new FormulaError(
          `Unknown name "${input.slice(i).match(/^[A-Za-z0-9_]+/)![0]}": series are single letters A, B, C…`,
        );
      }
      tokens.push({ kind: 'var', name: c.toUpperCase() });
      i++;
      continue;
    }
    if ('+-*/()'.includes(c)) {
      tokens.push({ kind: 'op', value: c as '+' | '-' | '*' | '/' | '(' | ')' });
      i++;
      continue;
    }
    if (c === '×') {
      tokens.push({ kind: 'op', value: '*' });
      i++;
      continue;
    }
    if (c === '÷') {
      tokens.push({ kind: 'op', value: '/' });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected "${c}" in formula "${input}"`);
  }
  return tokens;
}

/** Parse a formula. `series` is how many series exist, so `D` with three series is an error. */
export function parseFormula(input: string, series: number): FormulaNode {
  if (input.length > 500) throw new FormulaError('Formula too long (500 characters at most).');
  const tokens = tokenize(input);
  let pos = 0;
  const peek = () => tokens[pos];
  const expect = (value: string) => {
    const t = tokens[pos];
    if (t?.kind !== 'op' || t.value !== value)
      throw new FormulaError(`Expected "${value}" in formula "${input}"`);
    pos++;
  };

  function primary(): FormulaNode {
    const t = tokens[pos++];
    if (!t) throw new FormulaError(`Formula "${input}" ends too soon`);
    if (t.kind === 'num') return { type: 'num', value: t.value };
    if (t.kind === 'var') {
      const index = t.name.charCodeAt(0) - 65;
      if (index >= series) {
        throw new FormulaError(
          `Formula uses ${t.name}, but there ${series === 1 ? 'is 1 series' : `are ${series} series`} (A${series > 1 ? `–${String.fromCharCode(64 + series)}` : ''}).`,
        );
      }
      return { type: 'var', index, name: t.name };
    }
    if (t.value === '(') {
      const node = expr();
      expect(')');
      return node;
    }
    if (t.value === '-') return { type: 'neg', arg: primary() };
    throw new FormulaError(`Unexpected "${t.value}" in formula "${input}"`);
  }

  function term(): FormulaNode {
    let node = primary();
    for (;;) {
      const t = peek();
      if (t?.kind === 'op' && (t.value === '*' || t.value === '/')) {
        pos++;
        node = { type: 'bin', op: t.value, left: node, right: primary() };
      } else return node;
    }
  }

  function expr(): FormulaNode {
    let node = term();
    for (;;) {
      const t = peek();
      if (t?.kind === 'op' && (t.value === '+' || t.value === '-')) {
        pos++;
        node = { type: 'bin', op: t.value, left: node, right: term() };
      } else return node;
    }
  }

  const tree = expr();
  if (pos < tokens.length) throw new FormulaError(`Unexpected text after formula "${input}"`);
  return tree;
}

/** Evaluate a parsed formula for one bucket: `values[i]` is series i's value. */
export function evaluateFormula(node: FormulaNode, values: readonly number[]): number {
  switch (node.type) {
    case 'num':
      return node.value;
    case 'var':
      return values[node.index] ?? 0;
    case 'neg':
      return -evaluateFormula(node.arg, values);
    case 'bin': {
      const a = evaluateFormula(node.left, values);
      const b = evaluateFormula(node.right, values);
      if (node.op === '+') return a + b;
      if (node.op === '-') return a - b;
      if (node.op === '*') return a * b;
      return b === 0 ? 0 : a / b;
    }
  }
}
