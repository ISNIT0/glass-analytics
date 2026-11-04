/**
 * CLI tests. `glass init` runs against a fake Wrangler (which records the
 * commands and applies secrets to the test Worker) while every HTTP call goes
 * to the real Worker code running in-process. That covers the whole onboarding
 * path: provisioning, deploy, secrets, project creation, test event, agent files.
 */

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GLASS_VERSION } from '@glassanalytics/core/version';
import { testApp } from '../../worker/test/harness.ts';
import { agentsSection, upsertSection } from '../src/agent-files.ts';
import type { RunResult, Wrangler } from '../src/cloudflare/wrangler.ts';
import { init } from '../src/commands/init.ts';
import { mcpBridge } from '../src/commands/mcp.ts';
import { ci, upgrade } from '../src/commands/upgrade.ts';

const HOST = 'https://glass.test-account.workers.dev';

interface FakeOptions {
  r2Enabled?: boolean;
}

/** A fake Wrangler: records commands, simulates Cloudflare state, and applies secrets to the test Worker. */
function fakeWrangler(worker: ReturnType<typeof testApp>, options: FakeOptions = {}) {
  const commands: string[][] = [];
  const state = { d1: [] as { uuid: string; name: string }[], streams: [] as { id: string; name: string }[], sinks: [] as { id: string; name: string }[], pipelines: [] as { id: string; name: string }[] };
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const wrangler: Wrangler = {
    async run(args) {
      commands.push(args);
      const cmd = args.join(' ');
      if (cmd === 'd1 list --json') return ok(`Wrangler 4\n${JSON.stringify(state.d1)}`);
      if (args[0] === 'd1' && args[1] === 'create') {
        state.d1.push({ uuid: 'db-uuid-1', name: args[2]! });
        return ok('Created');
      }
      if (cmd.startsWith('r2 bucket create')) {
        return options.r2Enabled === false ? { code: 1, stdout: '', stderr: 'Please enable R2 through the Cloudflare Dashboard. [code: 10042]' } : ok();
      }
      if (cmd.startsWith('r2 bucket catalog enable')) return ok('Warehouse: acct_glass-data');
      for (const kind of ['streams', 'sinks'] as const) {
        if (cmd.startsWith(`pipelines ${kind} list`)) return ok(JSON.stringify(state[kind]));
        if (cmd.startsWith(`pipelines ${kind} create`)) {
          state[kind].push({ id: `${kind}-${args[3]}`, name: args[3]! });
          return ok();
        }
      }
      if (cmd.startsWith('pipelines list')) return ok(JSON.stringify(state.pipelines));
      if (cmd.startsWith('pipelines create')) {
        state.pipelines.push({ id: `p-${args[2]}`, name: args[2]! });
        return ok();
      }
      if (cmd.startsWith('d1 migrations apply')) return ok('Migrations applied');
      if (args[0] === 'deploy') return ok(`Uploaded glass\nDeployed glass triggers (1.2 sec)\n  ${HOST}\nCurrent Version ID: x`);
      if (args[0] === 'secret' && args[1] === 'bulk') {
        // Secrets reach the running Worker, as they would on Cloudflare.
        Object.assign(worker.env, JSON.parse(readFileSync(args[2]!, 'utf8')));
        return ok('Finished processing secrets file');
      }
      return { code: 1, stdout: '', stderr: `unexpected command: ${cmd}` };
    },
  };
  return { wrangler, commands, state };
}

/** Routes Cloudflare API calls to a stub and Worker calls to the in-process app. */
function fetcherFor(worker: ReturnType<typeof testApp>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.cloudflare.com/client/v4/accounts')) {
      return Response.json({ success: true, result: [{ id: 'acct-1', name: 'Test Account' }] });
    }
    if (url.startsWith(HOST)) {
      return worker.app.fetch(new Request(url.replace(HOST, 'https://glass.test'), init), worker.env);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

function tempProject(pkg: object = { name: '@acme/web-app', dependencies: { next: '15.0.0' } }): string {
  const dir = mkdtempSync(join(tmpdir(), 'glass-init-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, 'CLAUDE.md'), '# Project notes\n');
  return dir;
}

function bundleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'glass-bundle-'));
  writeFileSync(join(dir, 'worker.js'), 'export default {}');
  cpSync(fileURLToPath(new URL('../../worker/migrations', import.meta.url)), join(dir, 'migrations'), { recursive: true });
  return dir;
}

const BUNDLE = bundleDir();

describe('glass init', () => {
  let worker: ReturnType<typeof testApp>;
  beforeEach(() => {
    worker = testApp({ GLASS_ADMIN_KEY: undefined, GLASS_READ_KEY: undefined });
  });

  it('provisions, deploys, creates the project and writes agent files', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    await init({ token: 'cf-token', json: true }, { root, wrangler: () => fake.wrangler, fetcher: fetcherFor(worker), bundleDir: BUNDLE, pollMs: 1 });

    assert.deepEqual(
      fake.commands.map((c) => c.slice(0, 2).join(' ')),
      ['d1 list', 'd1 create', 'd1 list', 'r2 bucket', 'd1 migrations', 'deploy --config', 'secret bulk'],
    );
    const config = JSON.parse(readFileSync(join(root, '.glass', 'config.json'), 'utf8'));
    assert.equal(config.host, HOST);
    assert.equal(config.project, 'web-app');
    assert.deepEqual(config.d1, { name: 'glass', id: 'db-uuid-1' });
    assert.deepEqual(config.replay, { bucket: 'glass-replays' });

    const wranglerConfig = readFileSync(join(root, '.glass', 'wrangler.jsonc'), 'utf8');
    assert.match(wranglerConfig, /"database_id": "db-uuid-1"/);
    assert.match(wranglerConfig, /"binding": "REPLAYS"/);
    assert.ok(existsSync(join(root, '.glass', 'worker.js')));
    assert.ok(existsSync(join(root, '.glass', 'migrations', '0001_init.sql')));
    assert.equal(readFileSync(join(root, '.glass', '.gitignore'), 'utf8'), 'credentials.json\n');
    assert.ok(!existsSync(join(root, '.glass', '.secrets.tmp.json')), 'temporary secrets file is removed');

    const credentials = JSON.parse(readFileSync(join(root, '.glass', 'credentials.json'), 'utf8'));
    assert.equal(worker.env.GLASS_ADMIN_KEY, credentials.adminKey);
    assert.match(credentials.adminKey, /^[0-9a-f]{64}$/);

    const projects = worker.db.sqlite.prepare('SELECT id FROM projects').all() as { id: string }[];
    assert.deepEqual(projects.map((p) => p.id), ['web-app']);
    const events = worker.db.sqlite.prepare('SELECT event FROM events').all() as { event: string }[];
    assert.deepEqual(events.map((e) => e.event), ['$install_check']);

    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    assert.match(agents, /<!-- glass:start -->/);
    assert.match(agents, /next\/script|Script src=/);
    assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /^# Project notes\n\n<!-- glass:start -->/);
    assert.match(readFileSync(join(root, '.claude', 'skills', 'glass', 'SKILL.md'), 'utf8'), /^---\nname: glass\n/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers.glass, { command: 'npx', args: ['-y', '@glassanalytics/cli', 'mcp'] });

    const workflow = readFileSync(join(root, '.github', 'workflows', 'glass.yml'), 'utf8');
    assert.match(workflow, /^# Generated by `glass ci`\./);
    assert.match(workflow, /branches: \[main\]/);
    assert.match(workflow, /upgrade --ci/);
    assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
    assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /Upgrades \(the Worker version is pinned/);
  });

  it('is idempotent: a second run reuses resources and keys', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    const deps = { root, wrangler: () => fake.wrangler, fetcher: fetcherFor(worker), bundleDir: BUNDLE, pollMs: 1 };
    await init({ token: 'cf-token', json: true }, deps);
    const key = worker.env.GLASS_ADMIN_KEY;
    fake.commands.length = 0;
    await init({ token: 'cf-token', json: true }, deps);
    assert.ok(!fake.commands.some((c) => c[0] === 'd1' && c[1] === 'create'));
    assert.equal(worker.env.GLASS_ADMIN_KEY, key, 'keys are kept');
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    assert.equal(agents.match(/glass:start/g)?.length, 1, 'the AGENTS.md section is replaced, not duplicated');
  });

  it('carries on without session replay when R2 is not enabled', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker, { r2Enabled: false });
    await init({ token: 'cf-token', json: true }, { root, wrangler: () => fake.wrangler, fetcher: fetcherFor(worker), bundleDir: BUNDLE, pollMs: 1 });
    const config = JSON.parse(readFileSync(join(root, '.glass', 'config.json'), 'utf8'));
    assert.equal(config.replay, null);
    assert.doesNotMatch(readFileSync(join(root, '.glass', 'wrangler.jsonc'), 'utf8'), /REPLAYS/);
  });

  it('provisions Pipelines and Iceberg tables in lake mode', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    await init({ token: 'cf-token', lake: true, json: true }, { root, wrangler: () => fake.wrangler, fetcher: fetcherFor(worker), bundleDir: BUNDLE, pollMs: 1 });
    const created = fake.commands.filter((c) => c.includes('create')).map((c) => c.slice(0, 4).join(' '));
    assert.ok(created.includes('pipelines streams create glass_events'));
    assert.ok(created.includes('pipelines sinks create glass_events_sink'));
    assert.ok(created.includes('pipelines create glass_identities --sql'));
    const sink = fake.commands.find((c) => c[2] === 'create' && c[3] === 'glass_events_sink')!;
    assert.deepEqual(sink.slice(sink.indexOf('--type'), sink.indexOf('--type') + 2), ['--type', 'r2-data-catalog']);
    const schema = JSON.parse(readFileSync(join(root, '.glass', 'schemas', 'events.json'), 'utf8'));
    assert.ok(schema.fields.some((f: { name: string; type: string }) => f.name === 'ts_ms' && f.type === 'int64'));
    const wranglerConfig = readFileSync(join(root, '.glass', 'wrangler.jsonc'), 'utf8');
    assert.match(wranglerConfig, /"GLASS_STORE": "lake"/);
    assert.match(wranglerConfig, /"stream": "streams-glass_events"/);
    assert.equal(worker.env.CF_API_TOKEN, 'cf-token', 'the query token is stored as a secret');
  });

  it('changes nothing in a dry run', async () => {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    await init({ token: 'cf-token', dryRun: true, json: true }, { root, wrangler: () => fake.wrangler, fetcher: fetcherFor(worker), bundleDir: BUNDLE });
    assert.equal(fake.commands.length, 0);
    assert.ok(!existsSync(join(root, '.glass')));
  });
});

describe('agent files', () => {
  it('replaces the Glass section and leaves the rest of the file alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glass-agents-'));
    const path = join(dir, 'AGENTS.md');
    writeFileSync(path, '# Rules\n\nBe nice.\n\n<!-- glass:start -->\nold\n<!-- glass:end -->\n\n## Other\n');
    const section = agentsSection({ root: dir, host: HOST, project: 'p', snippet: { file: 'index.html', code: '<script src="x"></script>' } });
    upsertSection(path, section, true);
    const text = readFileSync(path, 'utf8');
    assert.match(text, /^# Rules\n\nBe nice\.\n\n<!-- glass:start -->/);
    assert.match(text, /## Other\n$/);
    assert.doesNotMatch(text, /\nold\n/);
  });
});

describe('glass mcp (stdio bridge)', () => {
  it('forwards JSON-RPC lines to the Worker with the stored key', async () => {
    const worker = testApp();
    await worker.json('POST', '/api/projects', { body: { id: 'acme' } });
    const root = mkdtempSync(join(tmpdir(), 'glass-mcp-'));
    mkdirSync(join(root, '.glass'));
    writeFileSync(join(root, '.glass', 'config.json'), JSON.stringify({ host: HOST, project: 'acme' }));
    writeFileSync(join(root, '.glass', 'credentials.json'), JSON.stringify({ adminKey: worker.env.GLASS_ADMIN_KEY }));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      let text = '';
      output.on('data', (d: Buffer) => {
        text += d.toString();
      });
      const done = mcpBridge({ fetcher: fetcherFor(worker), input, output });
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_projects', arguments: {} } })}\n`);
      input.write('not json\n');
      input.end();
      await done;
      const messages = text.trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(messages.length, 3, 'one response per request; none for the notification');
      const byId = new Map(messages.map((m) => [m.id, m]));
      assert.equal(byId.get(1).result.serverInfo.name, 'glass');
      assert.match(byId.get(2).result.content[0].text, /acme/);
      assert.equal(byId.get(null).error.code, -32700);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('glass upgrade', () => {
  let worker: ReturnType<typeof testApp>;
  beforeEach(() => {
    worker = testApp({ GLASS_ADMIN_KEY: undefined, GLASS_READ_KEY: undefined });
  });

  async function installed(): Promise<{ root: string; fake: ReturnType<typeof fakeWrangler> }> {
    const root = tempProject();
    const fake = fakeWrangler(worker);
    await init({ token: 'cf-token', json: true }, { root, wrangler: () => fake.wrangler, fetcher: fetcherFor(worker), bundleDir: BUNDLE, pollMs: 1 });
    fake.commands.length = 0;
    return { root, fake };
  }
  const setVersion = (root: string, version: string) => {
    const path = join(root, '.glass', 'config.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), version }));
  };
  const version = (root: string) => JSON.parse(readFileSync(join(root, '.glass', 'config.json'), 'utf8')).version;
  const quiet = async (fn: () => Promise<void>) => {
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await fn();
    } finally {
      process.stdout.write = write;
    }
  };

  it('only stages .glass/ on a laptop when the CI workflow exists', async () => {
    const { root, fake } = await installed();
    setVersion(root, '0.0.1');
    await quiet(() => upgrade({ json: true }, { root, wrangler: () => fake.wrangler, fetcher: fetcherFor(worker), bundleDir: BUNDLE, env: {} }));
    assert.deepEqual(fake.commands, [], 'nothing is deployed');
    assert.equal(version(root), GLASS_VERSION);
  });

  it('deploys in CI without credentials.json and leaves Worker secrets alone', async () => {
    const { root, fake } = await installed();
    rmSync(join(root, '.glass', 'credentials.json'));
    setVersion(root, '0.0.1');
    await quiet(() => upgrade({ json: true }, { root, wrangler: () => fake.wrangler, fetcher: fetcherFor(worker), bundleDir: BUNDLE, env: { CI: 'true', CLOUDFLARE_API_TOKEN: 'cf-token' } }));
    assert.deepEqual(fake.commands.map((c) => c.slice(0, 2).join(' ')), ['d1 migrations', 'deploy --config']);
    assert.equal(version(root), GLASS_VERSION);
  });

  it('refuses to replace a newer Worker with an older CLI', async () => {
    const { root, fake } = await installed();
    setVersion(root, '99.0.0');
    await assert.rejects(
      upgrade({ json: true }, { root, wrangler: () => fake.wrangler, fetcher: fetcherFor(worker), bundleDir: BUNDLE, env: { CI: 'true', CLOUDFLARE_API_TOKEN: 'cf-token' } }),
      /runs Glass 99\.0\.0, which is newer than this CLI/,
    );
    assert.deepEqual(fake.commands, []);
    assert.equal(version(root), '99.0.0');
  });

  it('glass ci keeps a hand-written workflow', async () => {
    const { root } = await installed();
    writeFileSync(join(root, '.github', 'workflows', 'glass.yml'), 'name: mine\n');
    await quiet(async () => ci({ json: true }, { root }));
    assert.equal(readFileSync(join(root, '.github', 'workflows', 'glass.yml'), 'utf8'), 'name: mine\n');
  });
});
