/**
 * The quality ratchet: `quality-baseline.json` records the coverage floor and every function
 * already over the complexity threshold. A change may not go below the floor or add complexity
 * debt; when it improves things, `pnpm quality:update` moves the baseline up so the gain sticks.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromRanges, type Metrics, pct } from './measure.ts';

export const BASELINE_FILE = 'quality-baseline.json';

export interface Baseline {
  about: string;
  coverage: {
    /** Percentage points of line coverage a change may lose before the check fails. */
    tolerance: number;
    /** Line coverage floor in percent, for `total` and each package. */
    lines: Record<string, number>;
  };
  complexity: {
    /** Functions with cognitive complexity above this are complexity debt. */
    threshold: number;
    /** Every function over the threshold, `file:name` → its cognitive complexity. */
    functions: Record<string, number>;
  };
}

export const ABOUT =
  'Quality ratchet, checked by `pnpm quality` and the Quality workflow. Coverage may not fall ' +
  'below these floors and no function may get more complex than listed here, or newly exceed ' +
  'the threshold. After improving either, run `pnpm quality:update` and commit this file.';

export const key = (fn: { file: string; name: string }) => `${fn.file}:${fn.name}`;
const round = (n: number) => Math.floor(n * 100) / 100;

export function readBaseline(root: string): Baseline | null {
  const path = join(root, BASELINE_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Baseline) : null;
}

export function writeBaseline(root: string, baseline: Baseline): void {
  writeFileSync(join(root, BASELINE_FILE), `${JSON.stringify(baseline, null, 2)}\n`);
}

export function coverageLines(metrics: Metrics): Record<string, number> | null {
  const cov = metrics.coverage;
  if (!cov) return null;
  const out: Record<string, number> = { total: round(pct(cov.total.lines)) };
  for (const pkg of Object.keys(cov.packages).sort()) {
    out[pkg] = round(pct(cov.packages[pkg]!.lines));
  }
  return out;
}

export interface CheckResult {
  /** Regressions: the check fails on these. */
  failures: string[];
  /** Things worth knowing that don't fail the check. */
  warnings: string[];
  /** Improvements `pnpm quality:update` would lock in. */
  improvements: string[];
}

export function check(metrics: Metrics, baseline: Baseline): CheckResult {
  const result: CheckResult = { failures: [], warnings: [], improvements: [] };
  const { tolerance } = baseline.coverage;

  const lines = coverageLines(metrics);
  if (!lines) {
    result.warnings.push('Coverage not measured (--fast); only complexity was checked.');
  } else {
    const soft = !metrics.coverage?.python;
    if (soft) {
      result.warnings.push(
        'uv is not installed, so the Python-backed lake tests were skipped and coverage reads ' +
          'low. Coverage drops below are warnings here; CI runs those tests and enforces them. ' +
          'Install uv (https://docs.astral.sh/uv/) for an exact local check.',
      );
    }
    for (const [name, floor] of Object.entries(baseline.coverage.lines)) {
      const now = lines[name];
      if (now === undefined) continue;
      const label = name === 'total' ? 'Total line coverage' : `Line coverage of ${name}`;
      if (now < floor - tolerance) {
        const message =
          `${label} fell from ${floor}% to ${now}%. Add tests for the code you added or ` +
          'changed (`pnpm quality:hotspots` lists the least-covered files).';
        (soft ? result.warnings : result.failures).push(message);
      } else if (now > floor && !soft) {
        result.improvements.push(`${label} rose from ${floor}% to ${now}%.`);
      }
    }
  }

  const { threshold, functions: debt } = baseline.complexity;
  const current = new Map(metrics.functions.map((fn) => [key(fn), fn]));
  for (const fn of metrics.functions) {
    if (fn.cognitive <= threshold) continue;
    const before = debt[key(fn)];
    const where = `\`${fn.name}\` (${fn.file}:${fn.line})`;
    if (before === undefined) {
      result.failures.push(
        `${where} has cognitive complexity ${fn.cognitive}, over the threshold of ${threshold}. ` +
          'Split it into smaller functions, flatten nesting with early returns, or move ' +
          'branches into a lookup table.',
      );
    } else if (fn.cognitive > before) {
      result.failures.push(
        `${where} got more complex: cognitive ${before} → ${fn.cognitive}. It is already over ` +
          `the threshold of ${threshold}; leave it simpler than you found it, not more complex.`,
      );
    } else if (fn.cognitive < before) {
      result.improvements.push(`\`${fn.name}\` cognitive ${before} → ${fn.cognitive}.`);
    }
  }
  for (const [k, before] of Object.entries(debt)) {
    const fn = current.get(k);
    if (!fn) result.improvements.push(`\`${k}\` (was ${before}) no longer exists.`);
    else if (fn.cognitive <= threshold) {
      result.improvements.push(
        `\`${fn.name}\` is under the threshold now (cognitive ${before} → ${fn.cognitive}).`,
      );
    }
  }
  return result;
}

/** The baseline these metrics justify. Coverage is only taken from a full (uv) run. */
export function nextBaseline(metrics: Metrics, previous: Baseline | null): Baseline {
  const threshold = previous?.complexity.threshold ?? 15;
  const functions: Record<string, number> = {};
  for (const fn of [...metrics.functions].sort((a, b) => key(a).localeCompare(key(b)))) {
    if (fn.cognitive > threshold) functions[key(fn)] = fn.cognitive;
  }
  const lines =
    metrics.coverage?.python || !previous
      ? (coverageLines(metrics) ?? previous?.coverage.lines ?? {})
      : previous.coverage.lines;
  return {
    about: ABOUT,
    coverage: { tolerance: previous?.coverage.tolerance ?? 0.1, lines },
    complexity: { threshold, functions },
  };
}

/** Every way `next` is laxer than `previous`, in words. Empty when it only tightens. */
export function loosenings(previous: Baseline | null, next: Baseline): string[] {
  if (!previous) return [];
  const out: string[] = [];
  if (next.coverage.tolerance > previous.coverage.tolerance) {
    out.push(`coverage tolerance ${previous.coverage.tolerance} → ${next.coverage.tolerance}`);
  }
  if (next.complexity.threshold > previous.complexity.threshold) {
    out.push(
      `complexity threshold ${previous.complexity.threshold} → ${next.complexity.threshold}`,
    );
  }
  for (const [name, floor] of Object.entries(previous.coverage.lines)) {
    const now = next.coverage.lines[name];
    if (now !== undefined && now < floor) out.push(`${name} line coverage ${floor}% → ${now}%`);
  }
  for (const [k, value] of Object.entries(next.complexity.functions)) {
    const before = previous.complexity.functions[k];
    if (before === undefined) out.push(`new complexity debt \`${k}\` (${value})`);
    else if (value > before) out.push(`\`${k}\` complexity ${before} → ${value}`);
  }
  return out;
}

const git = (root: string, args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const SOURCE_PATHSPEC = ':(glob)packages/*/src/**/*.ts';

/** The commit to compare against locally: where this branch left origin/main. */
export function defaultBase(root: string): string | null {
  try {
    return git(root, ['merge-base', 'HEAD', 'origin/main']).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Source lines added or changed since `base`, per file, including uncommitted edits and new
 * untracked files. Blank and comment-only lines are left out.
 */
export function changedLines(root: string, base: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const diff = git(root, [
    'diff',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    base,
    '--',
    SOURCE_PATHSPEC,
  ]);
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice('+++ b/'.length);
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const set = out.get(file) ?? new Set<number>();
    for (let n = start; n < start + count; n++) set.add(n);
    if (set.size) out.set(file, set);
  }
  const untracked = git(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    SOURCE_PATHSPEC,
  ]);
  for (const f of untracked.split('\n').filter(Boolean)) {
    const count = readFileSync(join(root, f), 'utf8').split('\n').length;
    out.set(f, new Set(Array.from({ length: count }, (_, i) => i + 1)));
  }

  for (const [f, set] of out) {
    if (f.endsWith('.d.ts') || !existsSync(join(root, f))) {
      out.delete(f);
      continue;
    }
    const text = readFileSync(join(root, f), 'utf8').split('\n');
    for (const n of set) {
      const src = (text[n - 1] ?? '').trim();
      if (!src || src.startsWith('//') || src.startsWith('/*') || src.startsWith('*'))
        set.delete(n);
    }
    if (!set.size) out.delete(f);
  }
  return out;
}

export interface PatchCoverage {
  hit: number;
  total: number;
  /** Uncovered changed lines per file, as sorted line numbers. */
  uncovered: Map<string, number[]>;
}

export function patchCoverage(
  metrics: Metrics,
  changed: Map<string, Set<number>>,
): PatchCoverage | null {
  const files = metrics.coverage?.files;
  if (!files) return null;
  const result: PatchCoverage = { hit: 0, total: 0, uncovered: new Map() };
  for (const [file, lines] of changed) {
    const cov = files[file];
    if (!cov) continue; // a type-only file
    const missed = fromRanges(cov.uncovered);
    const misses: number[] = [];
    for (const n of lines) {
      result.total++;
      if (missed.has(n)) misses.push(n);
      else result.hit++;
    }
    if (misses.length)
      result.uncovered.set(
        file,
        misses.sort((a, b) => a - b),
      );
  }
  return result;
}
