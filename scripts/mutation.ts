/**
 * Mutation testing with StrykerJS: make small deliberate bugs (flip a condition, drop a
 * statement, change a string) and check a test fails for each. Coverage says a line ran;
 * the mutation score says the tests would notice if it were wrong.
 *
 *   pnpm mutation --changed origin/main   files changed since a commit (what PRs run)
 *   pnpm mutation --files packages/core/src/url.ts,packages/core/src/ua.ts
 *   pnpm mutation --all                   core, worker and cli (weekly; ~30 min on 4 cores)
 *
 * Each package's mutants run against that package's own tests. The dashboard and the web SDK
 * are skipped: their tests are browser e2e, too slow to run once per mutant. Writes
 * coverage/mutation/report.md (and Stryker's HTML report per package) and never fails, so it
 * informs a PR rather than gating it.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeFile } from './quality/complexity.ts';

const PACKAGES = ['core', 'worker', 'cli'];
export const MARKER = '<!-- dataflare-mutation-report -->';
const root = join(import.meta.dirname, '..');
const outDir = join(root, 'coverage', 'mutation');

const { values } = parseArgs({
  options: {
    changed: { type: 'string' },
    files: { type: 'string' },
    all: { type: 'boolean', default: false },
    out: { type: 'string', default: join(outDir, 'report.md') },
  },
});

/** Source files worth mutating: in a tested package, with runtime code. */
function mutable(file: string): boolean {
  const match = /^packages\/([^/]+)\/src\/.+\.ts$/.exec(file);
  if (!match || !PACKAGES.includes(match[1]!) || file.endsWith('.d.ts')) return false;
  return existsSync(join(root, file)) && !analyzeFile(join(root, file), file).typeOnly;
}

function targets(): string[] {
  if (values.all) return PACKAGES.map((p) => `packages/${p}/src/**/*.ts`);
  if (values.files) return values.files.split(',').filter(mutable);
  if (values.changed) {
    const diff = execFileSync('git', ['diff', '--name-only', values.changed, '--', 'packages'], {
      cwd: root,
      encoding: 'utf8',
    });
    return diff.split('\n').filter(mutable);
  }
  console.error('Pass --changed <ref>, --files <a,b> or --all.');
  process.exit(1);
}

interface Mutant {
  status: string;
  mutatorName: string;
  replacement?: string;
  location: { start: { line: number } };
}
type Report = { files: Record<string, { mutants: Mutant[] }> };

function runPackage(pkg: string, mutate: string[]): Report | null {
  const config = join(outDir, `${pkg}.stryker.json`);
  const json = join(outDir, `${pkg}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      testRunner: 'command',
      commandRunner: { command: `node --test "packages/${pkg}/test/**/*.test.ts"` },
      coverageAnalysis: 'off',
      mutate: mutate.length ? mutate : [`packages/${pkg}/src/**/*.ts`],
      reporters: ['json', 'html', 'progress'],
      jsonReporter: { fileName: json },
      htmlReporter: { fileName: join(outDir, `${pkg}.html`) },
      tempDirName: '.stryker-tmp',
      cleanTempDir: 'always',
      timeoutMS: 30_000,
    }),
  );
  const run = spawnSync(join(root, 'node_modules', '.bin', 'stryker'), ['run', config], {
    cwd: root,
    stdio: 'inherit',
    // The Python lake tests would run once per mutant; leave them to CI's normal test job.
    env: { ...process.env, DATAFLARE_REQUIRE_PYTHON: '' },
  });
  if (run.status !== 0 || !existsSync(json)) return null;
  return JSON.parse(readFileSync(json, 'utf8')) as Report;
}

const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);

function render(results: Map<string, Report | null>): string {
  const rows: string[] = [];
  const survivors: string[] = [];
  let detected = 0;
  let valid = 0;
  for (const [pkg, report] of results) {
    if (!report) {
      rows.push(`| ${pkg} | Stryker failed to run; see the job log. | | |`);
      continue;
    }
    for (const [file, { mutants }] of Object.entries(report.files).sort()) {
      const d = mutants.filter((m) => DETECTED.has(m.status)).length;
      const missed = mutants.filter((m) => UNDETECTED.has(m.status));
      const v = d + missed.length;
      if (v === 0) continue;
      detected += d;
      valid += v;
      rows.push(`| \`${file}\` | ${((d / v) * 100).toFixed(0)}% | ${d} | ${missed.length} |`);
      for (const m of missed.sort((a, b) => a.location.start.line - b.location.start.line)) {
        const change = (m.replacement ?? '').replace(/\s+/g, ' ').slice(0, 70);
        survivors.push(
          `- \`${file}:${m.location.start.line}\` ${m.mutatorName}${change ? `: \`${change.replaceAll('`', "'")}\`` : ''}`,
        );
      }
    }
  }
  if (!rows.length) return `${MARKER}\n## Mutation testing\n\nNo mutable source files changed.\n`;
  const score = valid ? ((detected / valid) * 100).toFixed(1) : '—';
  const out = [
    MARKER,
    '## Mutation testing',
    '',
    `**Mutation score: ${score}%**: tests caught ${detected} of ${valid} deliberate bugs in the files this run covered. ` +
      'Each survivor below is a change to the code that no test noticed; add an assertion that would fail on it. Informational, does not block merging.',
    '',
    '| File | Score | Caught | Survived |',
    '| --- | ---: | ---: | ---: |',
    ...rows,
    '',
  ];
  if (survivors.length) {
    out.push(`<details><summary>Survivors (${survivors.length})</summary>`, '');
    out.push(...survivors.slice(0, 60));
    if (survivors.length > 60)
      out.push(`- …and ${survivors.length - 60} more in the HTML report artifact`);
    out.push('', '</details>', '');
  }
  return `${out.join('\n')}\n`;
}

mkdirSync(outDir, { recursive: true });
const files = targets();
const byPackage = new Map<string, string[]>();
if (values.all) for (const p of PACKAGES) byPackage.set(p, []);
for (const f of values.all ? [] : files) {
  const pkg = f.split('/')[1]!;
  byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), f]);
}
const results = new Map<string, Report | null>();
for (const [pkg, mutate] of byPackage) results.set(pkg, runPackage(pkg, mutate));
const markdown = render(results);
writeFileSync(values.out, markdown);
console.log(`\n${markdown}`);
