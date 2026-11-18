/**
 * Coverage and complexity ratchet. See "Quality ratchet" in AGENTS.md.
 *
 *   pnpm quality                     run tests with coverage, check against quality-baseline.json
 *   pnpm quality --fast              complexity only, no test run (seconds)
 *   pnpm quality:update              lock improvements into the baseline
 *   pnpm quality:hotspots            the most complex, least tested code: where to improve next
 *
 * CI only (the Quality workflow):
 *   node scripts/quality.ts measure --root <dir> --out <metrics.json>
 *   node scripts/quality.ts check --metrics <metrics.json>
 *   node scripts/quality.ts report --head <metrics.json> [--base <metrics.json> --base-root <dir>]
 *        --base-ref <sha> --out <report.md> [--run-url <url>]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Metrics, measure, packageOf, pct, toRanges } from './quality/measure.ts';
import {
  BASELINE_FILE,
  changedLines,
  check,
  coverageLines,
  defaultBase,
  loosenings,
  nextBaseline,
  patchCoverage,
  readBaseline,
  writeBaseline,
} from './quality/ratchet.ts';
import { renderReport } from './quality/report.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    fast: { type: 'boolean', default: false },
    'allow-regression': { type: 'boolean', default: false },
    limit: { type: 'string', default: '15' },
    root: { type: 'string' },
    out: { type: 'string' },
    metrics: { type: 'string' },
    head: { type: 'string' },
    base: { type: 'string' },
    'base-root': { type: 'string' },
    'base-ref': { type: 'string' },
    'run-url': { type: 'string' },
  },
});

const root = resolve(values.root ?? process.cwd());
const command = positionals[0] ?? 'check';
const readMetrics = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Metrics;
const load = (quiet = false): Metrics =>
  values.metrics ? readMetrics(values.metrics) : measure({ root, coverage: !values.fast, quiet });

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function summary(metrics: Metrics): void {
  const baseline = readBaseline(root);
  const lines = coverageLines(metrics);
  if (lines) {
    const parts = Object.entries(lines).map(([name, now]) => {
      const floor = baseline?.coverage.lines[name];
      return `${name} ${now}%${floor === undefined ? '' : ` (floor ${floor}%)`}`;
    });
    console.log(`Line coverage: ${parts.join(' · ')}`);
  }
  const threshold = baseline?.complexity.threshold ?? 15;
  const over = metrics.functions.filter((fn) => fn.cognitive > threshold).length;
  const listed = baseline ? Object.keys(baseline.complexity.functions).length : 0;
  console.log(
    `Complexity: ${over} functions over cognitive ${threshold} (baseline lists ${listed}) across ${metrics.functions.length} functions`,
  );

  const base = defaultBase(root);
  const patch = base ? patchCoverage(metrics, changedLines(root, base)) : null;
  if (patch && patch.total > 0) {
    const share = ((patch.hit / patch.total) * 100).toFixed(1);
    console.log(
      `Changed lines covered since ${base?.slice(0, 7)}: ${share}% (${patch.hit}/${patch.total})`,
    );
    for (const [file, missed] of patch.uncovered) {
      console.log(`  not run by any test: ${file} lines ${toRanges(missed)}`);
    }
  }
}

function runCheck(): void {
  const baseline = readBaseline(root);
  if (!baseline) fail(`No ${BASELINE_FILE}. Run \`pnpm quality:update\` to create one.`);
  const metrics = load();
  console.log('');
  summary(metrics);
  const result = check(metrics, baseline);
  for (const w of result.warnings) console.log(`\n! ${w}`);
  if (result.improvements.length) {
    console.log(
      `\n↑ ${result.improvements.length} improvements to lock in with \`pnpm quality:update\` (then commit ${BASELINE_FILE}):`,
    );
    for (const i of result.improvements) console.log(`  - ${i}`);
  }
  if (result.failures.length) {
    console.log(`\n✗ ${result.failures.length} regressions against ${BASELINE_FILE}:`);
    for (const f of result.failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n✓ No regressions.');
}

function runUpdate(): void {
  const previous = readBaseline(root);
  const metrics = load();
  const next = nextBaseline(metrics, previous);
  if (metrics.coverage && !metrics.coverage.python && previous) {
    console.log('uv is not installed: keeping the coverage floors, updating complexity only.');
  }
  const loose = loosenings(previous, next);
  if (loose.length && !values['allow-regression']) {
    console.log(`This would loosen ${BASELINE_FILE}:`);
    for (const l of loose) console.log(`  - ${l}`);
    fail(
      '\nFix the regressions instead. If one is genuinely right (e.g. code moved and kept its ' +
        'complexity), rerun with --allow-regression and say why in the PR; the PR comment flags it.',
    );
  }
  writeBaseline(root, next);
  console.log(
    `Wrote ${BASELINE_FILE}: ${Object.keys(next.complexity.functions).length} functions over ${next.complexity.threshold}, total line coverage floor ${next.coverage.lines.total ?? '—'}%.`,
  );
}

function runHotspots(): void {
  const metrics = load();
  const limit = Number(values.limit);
  // Risk: complexity weighted by how much of it no test runs (a CRAP-style score).
  const risk = (fn: Metrics['functions'][number]) =>
    fn.cognitive * (1 - (fn.coverage ?? 0) / 100) + fn.cognitive * 0.25;
  const fns = [...metrics.functions].sort((a, b) => risk(b) - risk(a)).slice(0, limit);
  console.log(`\nRiskiest functions (complex and untested first):\n`);
  console.log('  risk  cog  cyc   cov  function');
  for (const fn of fns) {
    const cov = fn.coverage === null ? '   —' : `${fn.coverage.toFixed(0).padStart(3)}%`;
    console.log(
      `  ${risk(fn).toFixed(0).padStart(4)}  ${String(fn.cognitive).padStart(3)}  ${String(fn.cyclomatic).padStart(3)}  ${cov}  ${fn.name}  ${fn.file}:${fn.line}`,
    );
  }
  const files = metrics.coverage?.files;
  if (!files) return;
  const gaps = Object.entries(files)
    .map(([file, c]) => ({ file, missed: c.lines.total - c.lines.hit, c }))
    .sort((a, b) => b.missed - a.missed)
    .slice(0, limit);
  console.log(`\nMost uncovered lines:\n`);
  console.log('  missed   cov  file');
  for (const { file, missed, c } of gaps) {
    const note = c.loaded ? '' : '  (no test loads it)';
    console.log(
      `  ${String(missed).padStart(6)}  ${pct(c.lines).toFixed(0).padStart(3)}%  ${file}${note}`,
    );
  }
  const pkgs = [...new Set(Object.keys(files).map(packageOf))];
  console.log(`\nPackages measured: ${pkgs.join(', ')}`);
}

function runReport(): void {
  if (!values.head || !values['base-ref']) fail('report needs --head and --base-ref.');
  const head = readMetrics(values.head);
  const base = values.base ? readMetrics(values.base) : null;
  const headBaseline = readBaseline(root);
  if (!headBaseline) fail(`No ${BASELINE_FILE} in ${root}.`);
  const baseBaseline = values['base-root'] ? readBaseline(resolve(values['base-root'])) : null;
  const changed = changedLines(root, values['base-ref']);
  const markdown = renderReport({
    head,
    base,
    headBaseline,
    baseBaseline,
    result: check(head, headBaseline),
    patch: patchCoverage(head, changed),
    changedFiles: [...changed.keys()],
    ...(values['run-url'] ? { runUrl: values['run-url'] } : {}),
  });
  if (values.out) writeFileSync(values.out, markdown);
  else process.stdout.write(markdown);
}

switch (command) {
  case 'check':
    runCheck();
    break;
  case 'update':
    runUpdate();
    break;
  case 'hotspots':
    runHotspots();
    break;
  case 'measure': {
    if (!values.out) fail('measure needs --out.');
    writeFileSync(values.out, JSON.stringify(load(true)));
    break;
  }
  case 'report':
    runReport();
    break;
  default:
    fail(`Unknown command "${command}". Use check, update, hotspots, measure or report.`);
}
