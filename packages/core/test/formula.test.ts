import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateFormula, FormulaError, parseFormula } from '../src/formula.ts';

const run = (f: string, values: number[]) =>
  evaluateFormula(parseFormula(f, values.length), values);

describe('formulas', () => {
  it('evaluates arithmetic with precedence and parentheses', () => {
    assert.equal(run('B / A * 100', [200, 50]), 25);
    assert.equal(run('(A - B) / A', [10, 4]), 0.6);
    assert.equal(run('A + B * C', [1, 2, 3]), 7);
    assert.equal(run('-A + 2', [5]), -3);
    assert.equal(run('a × b ÷ 2', [3, 4]), 6);
  });

  it('gives 0 when dividing by zero', () => {
    assert.equal(run('A / B', [5, 0]), 0);
  });

  it('rejects unknown series, names and code', () => {
    assert.throws(() => parseFormula('A + D', 3), /uses D, but there are 3 series/);
    assert.throws(() => parseFormula('Math.max(A)', 1), FormulaError);
    assert.throws(() => parseFormula('A; process.exit()', 1), FormulaError);
    assert.throws(() => parseFormula('(A + B', 2), /Expected "\)"/);
    assert.throws(() => parseFormula('A B', 2), /Unexpected text/);
  });
});
