/**
 * `glass upgrade` — redeploy the Worker bundled with this CLI version and
 * apply new migrations. `glass status` — check a deployment end to end.
 * `glass key` — print connection details for the dashboard or an agent.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLASS_VERSION } from '@glassanalytics/core/version';
import { call } from '../client.ts';
import { deploy, ensureBucket, installWorkerFiles, migrate, putSecrets, renderWranglerConfig } from '../cloudflare/provision.ts';
import { type Wrangler, createWrangler } from '../cloudflare/wrangler.ts';
import { UsageError, connection, glassDir, loadConfig, loadCredentials, projectRoot, saveConfig } from '../config.ts';
import { ask } from '../prompt.ts';
import { color, line, ok, printJson, skip } from '../output.ts';

/** Where the built Worker lives: next to the CLI bundle when installed, or in the repo during development. */
export function workerBundleDir(): string {
  const candidates = [new URL('./worker/', import.meta.url), new URL('../../../worker/dist/', import.meta.url)];
  for (const c of candidates) {
    const dir = fileURLToPath(c);
    if (existsSync(join(dir, 'worker.js')) && existsSync(join(dir, 'migrations'))) return dir;
  }
  throw new UsageError('The Worker bundle is missing.', 'If you are working on Glass itself, run `pnpm build` first.');
}

export async function upgrade(options: { token?: string; json?: boolean }, deps: { wrangler?: (auth: { token: string; accountId: string }, cwd: string) => Wrangler } = {}): Promise<void> {
  const root = projectRoot();
  const config = loadConfig(root);
  const credentials = loadCredentials(root);
  if (!config || !credentials) throw new UsageError('No Glass deployment in this project.', 'Run `npx @glassanalytics/cli init` first.');
  const token = options.token ?? process.env.CLOUDFLARE_API_TOKEN ?? (await ask('Cloudflare API token', { flag: '--token (or CLOUDFLARE_API_TOKEN)', secret: true }));
  const wrangler = (deps.wrangler ?? createWrangler)({ token, accountId: config.accountId }, root);
  const dir = glassDir(root);
  const report = (status: 'ok' | 'created' | 'skipped', label: string, detail?: string) => {
    if (options.json) return;
    (status === 'skipped' ? skip : ok)(`${label}${detail ? color.dim(` (${detail})`) : ''}`);
  };

  // Replay may have been skipped because R2 wasn't enabled; try again.
  if (!config.replay && (await ensureBucket(wrangler, `${config.name}-replays`, config.eu, report, 'session replay'))) {
    config.replay = { bucket: `${config.name}-replays` };
  }
  installWorkerFiles(dir, workerBundleDir());
  const configPath = join(dir, 'wrangler.jsonc');
  writeFileSync(configPath, renderWranglerConfig(config));
  await migrate(wrangler, config.d1.name, configPath);
  report('ok', 'Migrations applied');
  await deploy(wrangler, configPath);
  await putSecrets(
    wrangler,
    {
      GLASS_ADMIN_KEY: credentials.adminKey,
      GLASS_READ_KEY: credentials.readKey,
      GLASS_SALT_SECRET: credentials.saltSecret,
      // CF_API_TOKEN (lake mode) is set by init and left alone here, so a narrower token you set stays.
    },
    configPath,
    dir,
  );
  const from = config.version;
  config.version = GLASS_VERSION;
  saveConfig(config, root);
  if (options.json) printJson({ from, to: GLASS_VERSION, host: config.host, replay: Boolean(config.replay) });
  else ok(`Glass ${from === GLASS_VERSION ? GLASS_VERSION : `${from} upgraded to ${GLASS_VERSION}`} is live at ${config.host}`);
}

export async function status(options: { json?: boolean }): Promise<void> {
  const conn = connection();
  const config = loadConfig();
  const health = await call<{ version: string; store: string; replay: boolean; freshnessSeconds: number }>('GET', '/health');
  const events = await call<{ events: { event: string; count: number; lastSeen: string }[] }>('GET', `/api/events?days=1${conn.project ? `&project=${conn.project}` : ''}`).catch(() => ({ events: [] }));
  const total = events.events.reduce((a, e) => a + e.count, 0);
  const last = events.events.map((e) => e.lastSeen).sort().at(-1);
  const mcp = existsSync(join(projectRoot(), '.mcp.json'));
  const result = {
    host: conn.host,
    project: conn.project,
    version: health.version,
    cliVersion: GLASS_VERSION,
    store: health.store,
    replay: health.replay,
    eventsLast24h: total,
    lastEvent: last ?? null,
    mcpConfigured: mcp,
    upgradeAvailable: health.version !== GLASS_VERSION,
    account: config?.accountId,
  };
  if (options.json) return printJson(result);
  ok(`Worker reachable at ${conn.host} (Glass ${health.version}, ${health.store} store)`);
  (total ? ok : skip)(total ? `${total.toLocaleString('en-US')} events in the last 24 hours, latest ${last}` : 'No events in the last 24 hours. Is the snippet installed?');
  (health.replay ? ok : skip)(health.replay ? 'Session replay enabled' : 'Session replay disabled (no R2 bucket); `glass upgrade` retries');
  (mcp ? ok : skip)(mcp ? 'MCP server configured in .mcp.json' : 'No .mcp.json; run `glass init` again to write agent files');
  if (result.upgradeAvailable) skip(`This CLI is Glass ${GLASS_VERSION}; the Worker runs ${health.version}. Run \`glass upgrade\`.`);
}

export function key(options: { read?: boolean; json?: boolean }): void {
  const conn = connection();
  const credentials = loadCredentials();
  const value = options.read ? credentials?.readKey : conn.key;
  if (options.json) return printJson({ host: conn.host, project: conn.project, dashboard: `${conn.host}/app`, key: value });
  line(`Dashboard: ${conn.host}/app`);
  line(`${options.read ? 'Read-only key' : 'Admin key'}: ${value}`);
  line(color.dim(options.read ? 'Safe to share for viewing.' : 'Full access. Use `glass key --read` for a key that can only view.'));
}
