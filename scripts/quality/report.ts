/**
 * The markdown the Quality workflow posts on a pull request (and writes to the job summary):
 * coverage and complexity before and after, the lines the PR changed that no test runs, and
 * whether the PR moves the baseline.
 */

import { type Counts, type MeasuredFunction, type Metrics, pct, toRanges } from './measure.ts';
import { type Baseline, type CheckResult, key, loosenings, type PatchCoverage } from './ratchet.ts';

export const MARKER = '<!-- dataflare-quality-report -->';

export interface ReportInput {
  head: Metrics;
  base: Metrics | null;
  headBaseline: Baseline;
  baseBaseline: Baseline | null;
  result: CheckResult;
  patch: PatchCoverage | null;
  changedFiles: string[];
  runUrl?: string;
}

const fmt = (n: number) => `${n.toFixed(1)}%`;

function delta(now: number, before: number | undefined, unit = '', digits = 1): string {
  if (before === undefined) return '';
  const d = now - before;
  if (Math.abs(d) < 0.05) return '';
  const arrow = d > 0 ? '▲' : '▼';
  return ` ${arrow}${Math.abs(d).toFixed(digits)}${unit}`;
}

function coverageRow(name: string, now: Counts, before: Counts | undefined): string {
  const cell = (k: keyof Counts) =>
    now[k].total === 0
      ? '—'
      : `${fmt(pct(now[k]))}${before ? delta(pct(now[k]), pct(before[k])) : ''}`;
  return `| ${name} | ${cell('lines')} | ${cell('branches')} | ${cell('functions')} |`;
}

function coverageSection(input: ReportInput): string[] {
  const now = input.head.coverage;
  if (!now) return [];
  const before = input.base?.coverage ?? undefined;
  const out = [
    '### Coverage',
    '',
    '| Package | Lines | Branches | Functions |',
    '| --- | ---: | ---: | ---: |',
    coverageRow('**Total**', now.total, before?.total),
  ];
  for (const pkg of Object.keys(now.packages).sort()) {
    out.push(coverageRow(pkg, now.packages[pkg]!, before?.packages[pkg]));
  }
  out.push('');
  const patch = input.patch;
  if (patch && patch.total > 0) {
    const share = (patch.hit / patch.total) * 100;
    const icon = share >= 80 ? '🟢' : share >= 50 ? '🟡' : '🔴';
    out.push(
      `${icon} **Changed lines covered: ${fmt(share)}** (${patch.hit} of ${patch.total} added or edited source lines run under test).`,
    );
    if (patch.uncovered.size) {
      const rows = [...patch.uncovered].map(
        ([file, lines]) => `- \`${file}\` lines ${toRanges(lines).replaceAll(',', ', ')}`,
      );
      out.push(
        '',
        `<details><summary>Changed lines no test runs (${patch.total - patch.hit})</summary>`,
        '',
      );
      out.push(...rows.slice(0, 40));
      if (rows.length > 40) out.push(`- …and ${rows.length - 40} more files`);
      out.push('', '</details>');
    }
  } else if (patch) {
    out.push('No source lines changed.');
  }
  out.push('');
  return out;
}

function fnRow(fn: MeasuredFunction, before: MeasuredFunction | undefined): string {
  const cog = before
    ? before.cognitive === fn.cognitive
      ? `${fn.cognitive}`
      : `${before.cognitive} → **${fn.cognitive}**`
    : `**${fn.cognitive}** (new)`;
  const cov = fn.coverage === null ? '—' : fmt(fn.coverage);
  return `| \`${fn.name}\` | \`${fn.file}:${fn.line}\` | ${cog} | ${fn.cyclomatic} | ${cov} |`;
}

function complexitySection(input: ReportInput): string[] {
  const threshold = input.headBaseline.complexity.threshold;
  const baseFns = new Map((input.base?.functions ?? []).map((fn) => [key(fn), fn]));
  const over = (fns: MeasuredFunction[]) => fns.filter((fn) => fn.cognitive > threshold).length;
  const touched = new Set(input.changedFiles);
  const sum = (fns: MeasuredFunction[]) =>
    fns.filter((fn) => touched.has(fn.file)).reduce((n, fn) => n + fn.cognitive, 0);

  const out = ['### Complexity', ''];
  const nowOver = over(input.head.functions);
  const line = [`Functions over cognitive complexity ${threshold}: **${nowOver}**`];
  if (input.base) {
    line[0] += delta(nowOver, over(input.base.functions), '', 0);
    if (touched.size) {
      const now = sum(input.head.functions);
      line.push(
        `total cognitive complexity of the files this PR touches: **${now}**${delta(now, sum(input.base.functions), '', 0)}`,
      );
    }
  }
  out.push(`${line.join('; ')}.`, '');

  // Functions in touched files whose complexity changed, biggest change first.
  const changed = input.head.functions
    .filter((fn) => touched.has(fn.file))
    .filter((fn) => {
      const b = baseFns.get(key(fn));
      return b ? b.cognitive !== fn.cognitive : fn.cognitive > 0 && input.base !== null;
    })
    .sort((a, b) => {
      const da = Math.abs(a.cognitive - (baseFns.get(key(a))?.cognitive ?? 0));
      const db = Math.abs(b.cognitive - (baseFns.get(key(b))?.cognitive ?? 0));
      return db - da;
    });
  const header = [
    '| Function | Where | Cognitive | Cyclomatic | Coverage |',
    '| --- | --- | ---: | ---: | ---: |',
  ];
  if (changed.length) {
    out.push('Functions whose complexity changed:', '', ...header);
    out.push(...changed.slice(0, 15).map((fn) => fnRow(fn, baseFns.get(key(fn)))));
    if (changed.length > 15) out.push(`| …and ${changed.length - 15} more | | | | |`);
    out.push('');
  }
  const hottest = input.head.functions
    .filter((fn) => touched.has(fn.file) && fn.cognitive > threshold)
    .sort((a, b) => b.cognitive - a.cognitive)
    .slice(0, 10);
  if (hottest.length) {
    out.push(
      `<details><summary>Functions over the threshold in files this PR touches (${hottest.length})</summary>`,
      '',
      'Touching one of these is a good moment to simplify it.',
      '',
      ...header,
      ...hottest.map((fn) => fnRow(fn, baseFns.get(key(fn)) ?? fn)),
      '',
      '</details>',
      '',
    );
  }
  return out;
}

export function renderReport(input: ReportInput): string {
  const { result } = input;
  const out = [MARKER, '## Code quality', ''];
  if (result.failures.length) {
    out.push(
      `❌ **${result.failures.length} regression${result.failures.length === 1 ? '' : 's'}** against \`quality-baseline.json\`. The Quality check fails until they are fixed:`,
      '',
      ...result.failures.map((f) => `- ${f}`),
      '',
    );
  } else {
    out.push('✅ No regressions against `quality-baseline.json`.', '');
  }
  if (result.warnings.length) {
    out.push('> [!NOTE]', ...result.warnings.map((w) => `> - ${w}`), '');
  }

  const loosened = loosenings(input.baseBaseline, input.headBaseline);
  if (loosened.length) {
    out.push(
      '> [!WARNING]',
      `> This PR loosens \`quality-baseline.json\`. A reviewer should agree to each of these:`,
      ...loosened.map((l) => `> - ${l}`),
      '',
    );
  }
  if (result.improvements.length) {
    out.push(
      `🔒 **${result.improvements.length} improvement${result.improvements.length === 1 ? '' : 's'}** not yet locked into the baseline. Run \`pnpm quality:update\` and commit \`quality-baseline.json\` so they stick:`,
      '',
      ...result.improvements.slice(0, 10).map((i) => `- ${i}`),
      ...(result.improvements.length > 10
        ? [`- …and ${result.improvements.length - 10} more`]
        : []),
      '',
    );
  }

  out.push(...coverageSection(input), ...complexitySection(input));
  const run = input.runUrl ? ` · [workflow run](${input.runUrl})` : '';
  out.push(
    `<sub>Same check locally: \`pnpm quality\`. Best places to improve: \`pnpm quality:hotspots\`${run}</sub>`,
  );
  return `${out.join('\n')}\n`;
}
