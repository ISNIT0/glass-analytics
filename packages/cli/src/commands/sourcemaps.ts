/**
 * `dataflare sourcemaps upload <dir> --release <version>`: send a build's source
 * maps to the Worker, so error tracking can show stack traces in your own code.
 * Each `x.js.map` is filed under the path its `x.js` is served at: the file's path
 * in <dir>, under `--url-prefix` (default "/"). Run it in CI after the build, with
 * the same release your app passes to `glass.init({ release })`.
 *
 * Also `dataflare sourcemaps list [--release <version>]` and
 * `dataflare sourcemaps delete --release <version>`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { trimSlashes } from '@dataflare/core/url';
import { call, withProject } from '../client.ts';
import { connection, UsageError } from '../config.ts';
import { color, line, ok, printJson, table } from '../output.ts';

function mapFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js.map') || name.endsWith('.mjs.map') || name.endsWith('.cjs.map'))
        out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** The served path of the minified file a map belongs to. */
export function servedPath(dir: string, file: string, prefix = '/'): string {
  const rel = relative(dir, file)
    .split(sep)
    .join('/')
    .replace(/\.map$/, '');
  return `/${trimSlashes(prefix)}/${rel}`.replace(/\/{2,}/g, '/');
}

export async function sourcemaps(
  sub: string | undefined,
  arg: string | undefined,
  options: {
    release?: string;
    urlPrefix?: string;
    project?: string;
    json?: boolean;
    dryRun?: boolean;
  },
  deps: { fetcher?: typeof fetch } = {},
): Promise<void> {
  const project = withProject({ project: options.project }).project;
  if (sub === 'list') {
    const q = new URLSearchParams({
      ...(project ? { project } : {}),
      ...(options.release ? { release: options.release } : {}),
    });
    const res = await call<{
      sourcemaps: { release: string; path: string; bytes: number; uploadedAt: string }[];
      summary: string;
    }>('GET', `/api/sourcemaps?${q}`, undefined, { fetcher: deps.fetcher });
    if (options.json) return printJson(res);
    line(res.summary);
    if (res.sourcemaps.length) {
      table(
        ['Release', 'Path', 'KB', 'Uploaded'],
        res.sourcemaps.map((m) => [
          m.release,
          m.path,
          String(Math.round(m.bytes / 1024)),
          m.uploadedAt.slice(0, 16),
        ]),
      );
    }
    return;
  }
  if (sub === 'delete') {
    if (!options.release)
      throw new UsageError('Usage: dataflare sourcemaps delete --release <version>');
    const q = new URLSearchParams({ ...(project ? { project } : {}), release: options.release });
    const res = await call<{ deleted: number; summary: string }>(
      'DELETE',
      `/api/sourcemaps?${q}`,
      undefined,
      { fetcher: deps.fetcher },
    );
    if (options.json) return printJson(res);
    return ok(res.summary);
  }
  if (sub !== 'upload' || !arg) {
    throw new UsageError(
      'Usage: dataflare sourcemaps upload <dir> --release <version> [--url-prefix /assets]',
      'Also: dataflare sourcemaps list [--release <version>], dataflare sourcemaps delete --release <version>.',
    );
  }
  if (!options.release) {
    throw new UsageError(
      'Pass --release with the version your app sends, e.g. --release "$GITHUB_SHA".',
      'Set the same value in glass.init({ release }) or data-release on the script tag.',
    );
  }
  try {
    if (!statSync(arg).isDirectory()) throw new Error();
  } catch {
    throw new UsageError(`${arg} is not a directory.`);
  }
  const files = mapFiles(arg);
  if (files.length === 0)
    throw new UsageError(
      `No .js.map files in ${arg}.`,
      'Build with source maps on (e.g. build.sourcemap: true in Vite).',
    );
  const conn = connection();
  const fetcher = deps.fetcher ?? fetch;
  const uploaded: { path: string; bytes: number }[] = [];
  for (const file of files) {
    const path = servedPath(arg, file, options.urlPrefix);
    const text = readFileSync(file, 'utf8');
    if (!options.dryRun) {
      const q = new URLSearchParams({
        ...(project ? { project } : {}),
        release: options.release,
        path,
      });
      const res = await fetcher(`${conn.host}/api/sourcemaps?${q}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${conn.key}`, 'Content-Type': 'application/json' },
        body: text,
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
        throw new UsageError(`Uploading ${path}: ${err.error ?? `HTTP ${res.status}`}`, err.hint);
      }
    }
    uploaded.push({ path, bytes: text.length });
  }
  const result = { release: options.release, files: uploaded, dryRun: Boolean(options.dryRun) };
  if (options.json) return printJson(result);
  ok(
    `${options.dryRun ? 'Would upload' : 'Uploaded'} ${uploaded.length} source map${uploaded.length === 1 ? '' : 's'} for release ${options.release}`,
  );
  for (const u of uploaded.slice(0, 10)) line(color.dim(`  ${u.path}`));
  if (uploaded.length > 10) line(color.dim(`  … and ${uploaded.length - 10} more`));
  line(
    color.dim(
      "Maps don't need to be deployed with your site: delete them from the build output if you'd rather not serve them.",
    ),
  );
}
