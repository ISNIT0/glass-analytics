/**
 * Size budgets for what we ship, checked after `pnpm build` (CI runs it on every PR).
 *
 * The SDK budgets are the tight ones: every visitor of every site that installs Dataflare
 * downloads them (AGENTS.md rule 5). If a change needs more, raise the budget in the same PR
 * and say why; reviewers see the number move.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = join(import.meta.dirname, '..');

/** Gzipped size limits in KB. */
const BUDGETS: Record<string, number> = {
  'packages/web/dist/index.js': 7.5, // npm SDK
  'packages/web/dist/glass.js': 5.5, // script-tag SDK
  'packages/web/dist/replay.js': 65, // replay recorder, loaded on demand
  'packages/dashboard/dist/app.js': 150,
  'packages/dashboard/dist/app.css': 17,
  'packages/worker/dist/worker.js': 450,
  'packages/cli/dist/glass.js': 32,
};

const rows: string[] = [];
const over: string[] = [];
for (const [file, budget] of Object.entries(BUDGETS)) {
  const path = join(root, file);
  if (!existsSync(path)) {
    console.error(`${file} is missing: run \`pnpm build\` first.`);
    process.exit(1);
  }
  const kb = gzipSync(readFileSync(path)).length / 1024;
  const ok = kb <= budget;
  if (!ok) over.push(`${file} is ${kb.toFixed(1)} KB gzipped, over its ${budget} KB budget.`);
  const used = `${Math.round((kb / budget) * 100)}%`;
  rows.push(`| \`${file}\` | ${kb.toFixed(1)} KB | ${budget} KB | ${used} | ${ok ? '✅' : '❌'} |`);
  console.log(
    `${ok ? '✓' : '✗'} ${file.padEnd(34)} ${kb.toFixed(1).padStart(6)} KB / ${budget} KB`,
  );
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const table = [
    '### Bundle sizes (gzip)',
    '',
    '| File | Size | Budget | Used | |',
    '| --- | ---: | ---: | ---: | --- |',
    ...rows,
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table.join('\n')}\n`);
}
if (over.length) {
  console.error(
    `\n${over.join('\n')}\nShrink the change, or raise the budget in scripts/size.ts and say why in the PR.`,
  );
  process.exit(1);
}
