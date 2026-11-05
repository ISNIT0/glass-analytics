/**
 * Provisioning: create (or find) every Cloudflare resource Dataflare needs, then
 * deploy the Worker. Every step is idempotent, so `dataflare init` can be re-run
 * safely and `dataflare upgrade` reuses the same steps.
 */

import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAKE_TABLES, type LakeTable, streamSchemaFile } from '@dataflare/core/lake';
import type { GlassConfig } from '../config.ts';
import { must, parseJsonOutput, type Wrangler, WranglerError } from './wrangler.ts';

export type ProvisionReport = (
  status: 'ok' | 'created' | 'skipped',
  label: string,
  detail?: string,
) => void;

const isAlreadyExists = (err: unknown) =>
  err instanceof WranglerError && /already exists|already own|10004|11009/i.test(err.output);
const isR2Disabled = (err: unknown) =>
  err instanceof WranglerError &&
  /enable R2|R2 (is|has) not been enabled|purchase R2|10042/i.test(err.output);

/** Find or create the D1 database. */
export async function ensureD1(
  wrangler: Wrangler,
  name: string,
  eu: boolean,
  report: ProvisionReport,
): Promise<{ name: string; id: string }> {
  const find = async () =>
    parseJsonOutput<{ uuid: string; name: string }[]>(
      await must(wrangler, ['d1', 'list', '--json']),
    ).find((db) => db.name === name);
  let db = await find();
  if (db) {
    report('ok', `D1 database "${name}"`, 'exists');
  } else {
    await must(wrangler, ['d1', 'create', name, ...(eu ? ['--jurisdiction', 'eu'] : [])]);
    db = await find();
    if (!db) throw new Error(`Created D1 database "${name}" but could not find it afterwards.`);
    report('created', `D1 database "${name}"`);
  }
  return { name, id: db.uuid };
}

/** Create an R2 bucket. Returns false when R2 is not enabled on the account. */
export async function ensureBucket(
  wrangler: Wrangler,
  bucket: string,
  eu: boolean,
  report: ProvisionReport,
  purpose: string,
): Promise<boolean> {
  try {
    await must(wrangler, [
      'r2',
      'bucket',
      'create',
      bucket,
      ...(eu ? ['--jurisdiction', 'eu'] : []),
    ]);
    report('created', `R2 bucket "${bucket}" for ${purpose}`);
    return true;
  } catch (err) {
    if (isAlreadyExists(err)) {
      report('ok', `R2 bucket "${bucket}" for ${purpose}`, 'exists');
      return true;
    }
    if (isR2Disabled(err)) return false;
    throw err;
  }
}

async function findByName(
  wrangler: Wrangler,
  kind: 'streams' | 'sinks' | null,
  name: string,
): Promise<{ id: string; name: string } | undefined> {
  const args = kind
    ? ['pipelines', kind, 'list', '--json', '--per-page', '100']
    : ['pipelines', 'list', '--json', '--per-page', '100'];
  const items = parseJsonOutput<{ id: string; name: string }[]>(await must(wrangler, args));
  return items.find((i) => i.name === name);
}

/**
 * Lake mode: an R2 bucket with the data catalog enabled, and for each table a
 * Pipelines stream (what the Worker writes to), a sink (Iceberg table) and a
 * pipeline (SQL connecting the two).
 */
export async function ensureLake(
  wrangler: Wrangler,
  options: { bucket: string; namespace: string; token: string; eu: boolean; dir: string },
  report: ProvisionReport,
): Promise<{ bucket: string; namespace: string; streams: Record<LakeTable, string> }> {
  if (!(await ensureBucket(wrangler, options.bucket, options.eu, report, 'event lake'))) {
    throw new Error(
      'Lake mode needs R2. Enable R2 in the Cloudflare dashboard, then run `dataflare init --lake` again.',
    );
  }
  // The data catalog was renamed (R2 Data Catalog → Basin Catalog); try both commands.
  let enabled = false;
  for (const args of [
    ['r2', 'bucket', 'catalog', 'enable', options.bucket],
    ['basin', 'catalog', 'enable', options.bucket],
  ]) {
    const r = await wrangler.run(args);
    if (r.code === 0 || /already enabled/i.test(r.stdout + r.stderr)) {
      enabled = true;
      break;
    }
  }
  if (!enabled)
    throw new Error(
      `Could not enable the data catalog on "${options.bucket}". Enable it in the R2 dashboard, then re-run.`,
    );
  report('ok', `Data catalog on "${options.bucket}"`);

  const streams = {} as Record<LakeTable, string>;
  for (const table of Object.keys(LAKE_TABLES) as LakeTable[]) {
    const streamName = LAKE_TABLES[table].stream;
    const sinkName = `${streamName}_sink`;
    let stream = await findByName(wrangler, 'streams', streamName);
    if (!stream) {
      const schemaPath = join(options.dir, 'schemas', `${table}.json`);
      mkdirSync(join(options.dir, 'schemas'), { recursive: true });
      writeFileSync(schemaPath, `${JSON.stringify(streamSchemaFile(table), null, 2)}\n`);
      await must(wrangler, [
        'pipelines',
        'streams',
        'create',
        streamName,
        '--schema-file',
        schemaPath,
        '--http-enabled',
        'false',
      ]);
      stream = await findByName(wrangler, 'streams', streamName);
      if (!stream) throw new Error(`Created stream "${streamName}" but could not find it.`);
      report('created', `Pipelines stream "${streamName}"`);
    }
    streams[table] = stream.id;
    if (!(await findByName(wrangler, 'sinks', sinkName))) {
      await must(wrangler, [
        'pipelines',
        'sinks',
        'create',
        sinkName,
        '--type',
        'r2-data-catalog',
        '--bucket',
        options.bucket,
        '--namespace',
        options.namespace,
        '--table',
        table,
        '--catalog-token',
        options.token,
        '--roll-interval',
        '60',
      ]);
      report('created', `Iceberg table "${options.namespace}.${table}"`);
    }
    if (!(await findByName(wrangler, null, streamName))) {
      await must(wrangler, [
        'pipelines',
        'create',
        streamName,
        '--sql',
        `INSERT INTO ${sinkName} SELECT * FROM ${streamName}`,
      ]);
      report('created', `Pipeline "${streamName}"`);
    }
  }
  return { bucket: options.bucket, namespace: options.namespace, streams };
}

/** The Worker's wrangler.jsonc, generated from config. */
export function renderWranglerConfig(config: GlassConfig): string {
  const vars: Record<string, string> = { GLASS_STORE: config.store };
  if (config.lake) {
    vars.LAKE_BUCKET = config.lake.bucket;
    vars.LAKE_NAMESPACE = config.lake.namespace;
    vars.CF_ACCOUNT_ID = config.accountId;
  }
  if (config.route) vars.GLASS_PUBLIC_URL = `https://${config.route.replace(/\/\*$/, '')}`;
  if (config.retentionDays) vars.GLASS_RETENTION_DAYS = String(config.retentionDays);
  const wrangler: Record<string, unknown> = {
    name: config.name,
    main: 'worker.js',
    compatibility_date: '2026-10-01',
    workers_dev: true,
    d1_databases: [
      {
        binding: 'DB',
        database_name: config.d1.name,
        database_id: config.d1.id,
        migrations_dir: 'migrations',
      },
    ],
    vars,
    triggers: { crons: ['17 * * * *'] },
    observability: { enabled: true },
  };
  if (config.replay)
    wrangler.r2_buckets = [{ binding: 'REPLAYS', bucket_name: config.replay.bucket }];
  if (config.lake) {
    wrangler.pipelines = [
      { binding: 'EVENTS_STREAM', stream: config.lake.streams.events },
      { binding: 'IDENTITIES_STREAM', stream: config.lake.streams.identities },
    ];
  }
  if (config.route) {
    const zone = config.route.split('/')[0]!.split('.').slice(-2).join('.');
    wrangler.routes = [{ pattern: config.route, zone_name: zone }];
  }
  return `// Generated by \`glass\`. Edit .glass/config.json and run \`dataflare upgrade\` instead of editing this file.\n${JSON.stringify(wrangler, null, 2)}\n`;
}

/** Copy the bundled Worker and migrations from the CLI package into .glass/. */
export function installWorkerFiles(dir: string, bundleDir: string): void {
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  copyFileSync(join(bundleDir, 'worker.js'), join(dir, 'worker.js'));
  for (const file of readdirSync(join(bundleDir, 'migrations'))) {
    copyFileSync(join(bundleDir, 'migrations', file), join(dir, 'migrations', file));
  }
}

export async function deploy(wrangler: Wrangler, configPath: string): Promise<string | null> {
  const out = await must(wrangler, ['deploy', '--config', configPath]);
  return /https:\/\/[\w.-]+\.workers\.dev/.exec(out)?.[0] ?? null;
}

export async function migrate(
  wrangler: Wrangler,
  database: string,
  configPath: string,
): Promise<void> {
  await must(wrangler, ['d1', 'migrations', 'apply', database, '--remote', '--config', configPath]);
}

export async function putSecrets(
  wrangler: Wrangler,
  secrets: Record<string, string>,
  configPath: string,
  dir: string,
): Promise<void> {
  // `secret bulk` reads a JSON file; write it, upload, then remove it.
  const file = join(dir, '.secrets.tmp.json');
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  try {
    await must(wrangler, ['secret', 'bulk', file, '--config', configPath]);
  } finally {
    rmSync(file, { force: true });
  }
}

/** Cloudflare accounts the token can see. */
export async function listAccounts(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<{ id: string; name: string }[]> {
  const res = await fetcher('https://api.cloudflare.com/client/v4/accounts?per_page=50', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    result?: { id: string; name: string }[];
    errors?: { message: string }[];
  };
  if (!res.ok || !body.success) {
    throw new Error(
      `Cloudflare rejected the API token: ${body.errors?.[0]?.message ?? `HTTP ${res.status}`}`,
    );
  }
  return body.result ?? [];
}

/** Token scopes Dataflare needs, shown when something is denied. */
export const TOKEN_SCOPES = [
  'Account › Workers Scripts › Edit',
  'Account › D1 › Edit',
  'Account › Workers R2 Storage › Edit',
  'Account › Account Settings › Read',
  'Zone › Workers Routes › Edit (only with --route)',
  'Account › Pipelines › Edit, Workers R2 Data Catalog › Edit, Workers R2 SQL › Read (only with --lake)',
];
