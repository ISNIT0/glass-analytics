import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { analyzeFile } from './complexity.ts';
import { fromRanges, type Metrics, toRanges } from './measure.ts';
import { type Baseline, check, loosenings, nextBaseline } from './ratchet.ts';

const dir = mkdtempSync(join(tmpdir(), 'quality-'));
let n = 0;
function analyse(source: string) {
  const path = join(dir, `f${n++}.ts`);
  writeFileSync(path, source);
  return analyzeFile(path, 'packages/x/src/f.ts');
}
const byName = (source: string) =>
  Object.fromEntries(analyse(source).functions.map((f) => [f.name, f]));

describe('cognitive complexity', () => {
  it('charges nesting for nested structures and 1 for else', () => {
    const { a } = byName(`function a(x: number[] | null) {
      if (x) {                       // +1
        for (const y of x) {         // +2 (nesting 1)
          if (y) return 1;           // +3 (nesting 2)
        }
      } else {                       // +1
        return 2;
      }
      return 0;
    }`);
    assert.equal(a?.cognitive, 7);
    assert.equal(a?.cyclomatic, 4);
  });

  it('charges else-if chains flat', () => {
    const { a } = byName(`function a(x: number) {
      if (x === 1) return 1; else if (x === 2) return 2; else if (x === 3) return 3; else return 4;
    }`);
    assert.equal(a?.cognitive, 4);
  });

  it('charges one per run of the same logical operator', () => {
    const { b } = byName(
      'function b(a: boolean, b: boolean, c: boolean) { return (a && b && c) || a; }',
    );
    assert.equal(b?.cognitive, 2);
    assert.equal(b?.cyclomatic, 4);
  });

  it('rolls inline callbacks into their function, one level deeper', () => {
    const fns = byName('function c(xs: number[]) { return xs.map((x) => (x ? 1 : 2)); }');
    assert.deepEqual(Object.keys(fns), ['c']);
    assert.equal(fns.c?.cognitive, 2);
  });

  it('scores named helpers and methods on their own, with qualified names', () => {
    const fns = byName(`class K {
      m() { const helper = () => { if (Math.random()) return 1; return 0; }; return helper(); }
    }
    export const api = { get(x: number) { return x > 1 ? x : 0; } };`);
    assert.deepEqual(Object.keys(fns).sort(), ['K.m', 'K.m.helper', 'api.get']);
    assert.equal(fns['K.m']?.cognitive, 0);
    assert.equal(fns['K.m.helper']?.cognitive, 1);
    assert.equal(fns['api.get']?.cognitive, 1);
  });

  it('names top-level callbacks after the call they are passed to', () => {
    const fns = byName("addEventListener('click', () => { if (Math.random()) console.log(1); });");
    assert.equal(fns["addEventListener('click') callback"]?.cognitive, 1);
  });

  it('knows a type-only file from one with runtime code', () => {
    assert.equal(
      analyse("import type { B } from 'x';\nexport interface A { b: B }\nexport type C = A;\n")
        .typeOnly,
      true,
    );
    assert.equal(analyse('export interface A {}\nexport const x = 1;\n').typeOnly, false);
  });
});

describe('line ranges', () => {
  it('round-trips', () => {
    assert.equal(toRanges([1, 2, 3, 7, 9, 10]), '1-3,7,9-10');
    assert.deepEqual([...fromRanges('1-3,7,9-10')], [1, 2, 3, 7, 9, 10]);
  });
});

const fn = (name: string, cognitive: number) => ({
  file: 'packages/core/src/a.ts',
  name,
  line: 1,
  endLine: 2,
  cognitive,
  cyclomatic: 1,
  coverage: 50,
});

function metrics(lineHit: number, fns: ReturnType<typeof fn>[], python = true): Metrics {
  const counts = {
    lines: { hit: lineHit, total: 100 },
    branches: { hit: 0, total: 0 },
    functions: { hit: 0, total: 0 },
  };
  return {
    schema: 1,
    coverage: { python, total: counts, packages: { core: counts }, files: {} },
    functions: fns,
  };
}

const baseline: Baseline = {
  about: '',
  coverage: { tolerance: 0.1, lines: { total: 70, core: 70 } },
  complexity: { threshold: 15, functions: { 'packages/core/src/a.ts:old': 20 } },
};

describe('ratchet', () => {
  it('passes when nothing got worse', () => {
    const r = check(metrics(70, [fn('old', 20), fn('small', 3)]), baseline);
    assert.deepEqual(r.failures, []);
  });

  it('fails on a coverage drop, new complexity debt, and worse debt', () => {
    const r = check(metrics(60, [fn('old', 22), fn('fresh', 16)]), baseline);
    assert.equal(r.failures.length, 4); // total, core, old, fresh
    assert.match(r.failures.join('\n'), /fell from 70% to 60%/);
    assert.match(r.failures.join('\n'), /`old`.*20 → 22/);
    assert.match(r.failures.join('\n'), /`fresh`.*over the threshold/);
  });

  it('only warns about coverage when the Python tests did not run', () => {
    const r = check(metrics(60, [fn('old', 20)], false), baseline);
    assert.deepEqual(r.failures, []);
    assert.ok(r.warnings.some((w) => w.includes('fell from 70% to 60%')));
  });

  it('lists improvements and tightens the baseline with them', () => {
    const m = metrics(80, [fn('old', 12)]);
    assert.equal(check(m, baseline).improvements.length, 3);
    const next = nextBaseline(m, baseline);
    assert.deepEqual(next.complexity.functions, {});
    assert.equal(next.coverage.lines.total, 80);
    assert.deepEqual(loosenings(baseline, next), []);
  });

  it('reports loosening', () => {
    const next = nextBaseline(metrics(60, [fn('old', 25), fn('fresh', 16)]), baseline);
    assert.equal(loosenings(baseline, next).length, 4);
  });

  it('keeps coverage floors from a run without the Python tests', () => {
    const next = nextBaseline(metrics(10, [], false), baseline);
    assert.deepEqual(next.coverage.lines, baseline.coverage.lines);
  });
});
