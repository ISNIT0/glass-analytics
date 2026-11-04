/**
 * Copy the CLI's version into `GLASS_VERSION` (packages/core/src/version.ts).
 *
 * `changeset version` bumps package.json files only; the Worker reports
 * `GLASS_VERSION` and `pnpm build` refuses to build when the two differ. The
 * release workflow runs this right after `changeset version`
 * (`pnpm version-packages`), so the "Version packages" PR carries both.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const cli = JSON.parse(readFileSync(new URL('packages/cli/package.json', root), 'utf8')) as {
  version: string;
};
const file = new URL('packages/core/src/version.ts', root);
const source = readFileSync(file, 'utf8');
const next = source.replace(
  /export const GLASS_VERSION = '[^']+';/,
  `export const GLASS_VERSION = '${cli.version}';`,
);
if (next === source && !source.includes(`GLASS_VERSION = '${cli.version}'`)) {
  throw new Error('Could not find GLASS_VERSION in packages/core/src/version.ts');
}
writeFileSync(file, next);
console.log(`GLASS_VERSION = ${cli.version}`);
