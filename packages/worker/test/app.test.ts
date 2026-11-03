import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ArrayStream, READ, type TestApp, testApp, wire } from './harness.ts';

let t: TestApp;

async function setup(extra: Parameters<typeof testApp>[0] = {}) {
  t = testApp(extra);
  await t.json('POST', '/api/projects', { body: { id: 'acme', name: 'Acme' } });
}

const rows = (sql: string, ...args: (string | number)[]) => t.db.sqlite.prepare(sql).all(...args) as Record<string, unknown>[];

describe('health and routing', () => {
  beforeEach(() => setup());

  it('reports status', async () => {
    const health = await t.json('GET', '/health', { key: null });
    assert.equal(health.ok, true);
    assert.equal(health.store, 'd1');
    assert.equal(health.replay, true);
  });

  it('serves everything under the /_glass mount prefix too', async () => {
    const res = await t.call('GET', '/_glass/s.js', { key: null });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '/* sdk */');
    assert.equal((await t.ingest([wire('$pageview')])).status, 204);
    const html = await (await t.call('GET', '/_glass/app', { key: null })).text();
    assert.match(html, /<meta name="glass-base" content="\/_glass">/);
  });

  it('explains 404s and serves llms.txt with real URLs', async () => {
    const res = await t.call('GET', '/nope');
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { hint: string }).hint, /llms\.txt/);
    const llms = await (await t.call('GET', '/llms.txt', { key: null })).text();
    assert.match(llms, /https:\/\/glass\.test\/s\.js/);
    assert.match(llms, /query_funnel/);
  });
});

describe('auth', () => {
  beforeEach(() => setup());

  it('requires a key for the API and MCP', async () => {
    assert.equal((await t.call('GET', '/api', { key: null })).status, 401);
    assert.equal((await t.call('GET', '/api', { key: 'wrong' })).status, 401);
    assert.equal((await t.call('POST', '/mcp', { key: null, body: {} })).status, 401);
  });

  it('lets the read key query but not change things', async () => {
    assert.equal((await t.call('GET', '/api/flags', { key: READ })).status, 200);
    const res = await t.call('PUT', '/api/flags/x', { key: READ, body: { rollout: 10 } });
    assert.equal(res.status, 403);
  });
});

describe('ingest', () => {
  beforeEach(() => setup());

  it('rejects unknown projects with a hint', async () => {
    const res = await t.ingest([wire('$pageview')], { project: 'nope' });
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { hint: string }).hint, /glass projects add/);
  });

  it('enriches events with URL, UTM, referrer, geo and user agent', async () => {
    const res = await t.ingest(
      [wire('$pageview', { url: 'https://acme.com/pricing?utm_source=hn&utm_campaign=launch', referrer: 'https://news.ycombinator.com/item?id=1', title: 'Pricing' })],
      { headers: { 'CF-IPCountry': 'GB' } },
    );
    assert.equal(res.status, 204);
    const [e] = rows('SELECT * FROM events');
    assert.equal(e!.path, '/pricing');
    assert.equal(e!.utm_source, 'hn');
    assert.equal(e!.utm_campaign, 'launch');
    assert.equal(e!.referrer_host, 'news.ycombinator.com');
    assert.equal(e!.referrer, 'https://news.ycombinator.com/item');
    assert.equal(e!.country, 'GB');
    assert.equal(e!.browser, 'Chrome');
    assert.equal(e!.os, 'macOS');
    assert.equal(e!.device, 'desktop');
  });

  it('drops bots, malformed events and duplicates', async () => {
    await t.ingest([wire('$pageview')], { headers: { 'User-Agent': 'Googlebot/2.1' } });
    assert.equal(rows('SELECT * FROM events').length, 0);
    const dup = wire('signup');
    await t.ingest([dup, dup, { id: 'x', event: '', ts: 1 }, { event: 'no-id', ts: 1 }]);
    assert.equal(rows('SELECT * FROM events').length, 1);
  });

  it('corrects client clock skew using sent_at', async () => {
    const skewed = Date.now() - 3_600_000; // client clock one hour behind
    await t.call('POST', '/e', {
      key: null,
      body: { project: 'acme', sent_at: skewed, events: [{ ...wire('x'), ts: skewed - 1000 }] },
    });
    const [e] = rows('SELECT ts_ms FROM events');
    assert.ok(Math.abs(Number(e!.ts_ms) - (Date.now() - 1000)) < 5000);
  });

  it('derives daily ids in cookieless mode', async () => {
    const anon = { distinct_id: null, session_id: null };
    const headers = { 'CF-Connecting-IP': '203.0.113.9' };
    await t.ingest([wire('$pageview', anon), wire('$pageview', anon)], { headers });
    await t.ingest([wire('$pageview', anon)], { headers: { 'CF-Connecting-IP': '203.0.113.10' } });
    const ids = rows('SELECT DISTINCT distinct_id FROM events').map((r) => String(r.distinct_id));
    assert.equal(ids.length, 2);
    assert.ok(ids.every((id) => id.startsWith('c_')));
    assert.ok(rows('SELECT session_id FROM events').every((r) => String(r.session_id).startsWith('cs_')));
  });
});

describe('identity and persons', () => {
  beforeEach(() => setup());

  it('links devices to users and snapshots person properties onto events', async () => {
    await t.ingest([wire('$pageview', { url: 'https://acme.com/pricing' })]);
    await t.ingest([wire('$identify', { user_id: 'alice', props: { $set: { plan: 'pro', email_domain: 'acme.com' } } })]);
    await t.ingest([wire('purchase', { user_id: 'alice', props: { amount: 49 } })]);

    const [identity] = rows('SELECT * FROM identities');
    assert.deepEqual([identity!.distinct_id, identity!.person_id], ['device-1', 'alice']);
    const purchase = rows("SELECT person_id, person_props FROM events WHERE event = 'purchase'")[0]!;
    assert.equal(purchase.person_id, 'alice');
    assert.equal(JSON.parse(String(purchase.person_props)).plan, 'pro');

    // The anonymous pricing view counts towards alice's funnel.
    const funnel = await t.json<{ steps: { count: number }[] }>('POST', '/api/query', {
      body: { kind: 'funnel', steps: [{ event: '$pageview', filters: [{ property: 'path', value: '/pricing' }] }, { event: 'purchase' }] },
    });
    assert.deepEqual(
      funnel.steps.map((s) => s.count),
      [1, 1],
    );

    const person = await t.json<{ identified: boolean; devices: string[]; recentEvents: unknown[] }>('GET', '/api/persons/alice');
    assert.equal(person.identified, true);
    assert.deepEqual(person.devices, ['device-1']);
    assert.equal(person.recentEvents.length, 3);
  });

  it('keeps the first link when a shared device logs in as someone else', async () => {
    await t.ingest([wire('$identify', { user_id: 'alice' })]);
    await t.ingest([wire('$identify', { user_id: 'bob' })]);
    assert.equal(rows('SELECT person_id FROM identities')[0]!.person_id, 'alice');
    await t.ingest([wire('x', { user_id: 'bob' })]);
    assert.equal(rows("SELECT person_id FROM events WHERE event = 'x'")[0]!.person_id, 'bob');
  });

  it('applies $set_once without overwriting', async () => {
    await t.ingest([wire('$identify', { user_id: 'carol', props: { $set: { plan: 'free' } } })]);
    await t.ingest([wire('$set', { user_id: 'carol', props: { $set_once: { plan: 'pro', source: 'ad' } } })]);
    const props = JSON.parse(String(rows('SELECT props FROM persons')[0]!.props));
    assert.deepEqual(props, { plan: 'free', source: 'ad' });
  });

  it('erases a person, their events and replays', async () => {
    await t.ingest([wire('$identify', { user_id: 'dave' }), wire('x', { user_id: 'dave' })]);
    await t.call('POST', '/r?project=acme&session=session-1&seq=0&d=device-1&u=dave&enc=json', { key: null, body: '[]' });
    await t.call('POST', '/r?project=acme&session=session-1&seq=1&d=device-1&u=dave&enc=json', { key: null, body: '[{"type":4,"timestamp":1}]' });
    const res = await t.json<{ eventsDeleted: boolean; replaysDeleted: number }>('DELETE', '/api/persons/dave');
    assert.equal(res.eventsDeleted, true);
    assert.equal(res.replaysDeleted, 1);
    assert.equal(rows('SELECT * FROM events').length, 0);
    assert.equal(rows('SELECT * FROM persons').length, 0);
    assert.equal(t.r2.objects.size, 0);
  });
});

describe('query API', () => {
  beforeEach(async () => {
    await setup();
    await t.ingest([
      wire('$pageview', { distinct_id: 'a', session_id: 'sa', url: 'https://acme.com/' }),
      wire('$pageview', { distinct_id: 'a', session_id: 'sa', url: 'https://acme.com/pricing' }),
      wire('$pageview', { distinct_id: 'b', session_id: 'sb', url: 'https://acme.com/' }),
      wire('signup_completed', { distinct_id: 'a', session_id: 'sa', props: { plan: 'pro' } }),
    ]);
  });

  it('answers web, trends and retention queries with SQL and a dashboard link', async () => {
    const web = await t.json<{ totals: { visitors: number; pageviews: number }; sql: string[]; dashboard: string }>('POST', '/api/query', {
      body: { kind: 'web', from: '-1d' },
    });
    assert.equal(web.totals.visitors, 2);
    assert.equal(web.totals.pageviews, 3);
    assert.ok(web.sql.length >= 4);
    assert.match(web.dashboard, /^https:\/\/glass\.test\/app#\/insights\/web/);

    const trends = await t.json<{ series: { total: number }[] }>('POST', '/api/query', {
      body: { kind: 'trends', series: [{ event: 'signup_completed' }], breakdown: 'plan', from: '-1d' },
    });
    assert.equal(trends.series[0]!.total, 1);

    const retention = await t.json<{ cohorts: unknown[] }>('POST', '/api/query', {
      body: { kind: 'retention', cohortEvent: { event: 'signup_completed' }, returnEvent: { event: '$pageview' }, from: '-7d' },
    });
    assert.equal(retention.cohorts.length, 1);
  });

  it('returns readable validation errors', async () => {
    const res = await t.call('POST', '/api/query', { body: { kind: 'funnel', steps: [{ event: 'only-one' }] } });
    assert.equal(res.status, 400);
    const unknown = await t.call('POST', '/api/query', { body: { kind: 'paths' } });
    assert.match(((await unknown.json()) as { hint: string }).hint, /web, trends, funnel, retention/);
  });

  it('runs read-only SQL and refuses writes', async () => {
    const res = await t.json<{ rows: { n: number }[] }>('POST', '/api/sql', { body: { query: "SELECT COUNT(*) AS n FROM events WHERE event = '$pageview'" } });
    assert.equal(res.rows[0]!.n, 3);
    const bad = await t.call('POST', '/api/sql', { body: { query: 'DELETE FROM events' } });
    assert.equal(bad.status, 400);
  });

  it('lists and describes events, and flags undocumented ones', async () => {
    const list = await t.json<{ events: { event: string; count: number }[]; undocumented: string[] }>('GET', '/api/events');
    assert.deepEqual(list.undocumented, ['signup_completed']);
    await t.json('PUT', '/api/events/signup_completed', { body: { description: 'Account created', properties: { plan: 'Chosen plan' } } });
    const described = await t.json<{ description: string; properties: { name: string; description: string; examples: string[] }[] }>('GET', '/api/events/signup_completed');
    assert.equal(described.description, 'Account created');
    assert.deepEqual(described.properties[0], { name: 'plan', types: ['string'], coverage: 1, examples: ['pro'], description: 'Chosen plan' });
  });

  it('gives an overview with movers', async () => {
    const o = await t.json<{ web: { totals: { visitors: number } }; events: { event: string }[]; summary: string }>('GET', '/api/overview?from=-1d');
    assert.equal(o.web.totals.visitors, 2);
    assert.ok(o.events.some((e) => e.event === 'signup_completed'));
    assert.match(o.summary, /2 visitors/);
  });
});

describe('feature flags', () => {
  beforeEach(() => setup());

  it('evaluates flags server-side with person targeting', async () => {
    await t.json('PUT', '/api/flags/beta', { body: { rollout: 0, rules: [{ conditions: [{ property: 'person.plan', value: 'pro' }], rollout: 100 }] } });
    await t.ingest([wire('$identify', { user_id: 'alice', props: { $set: { plan: 'pro' } } })]);
    const evaluate = (body: object) => t.json<{ flags: Record<string, string> }>('POST', '/f', { key: null, body: { project: 'acme', ...body } });
    assert.deepEqual((await evaluate({ distinct_id: 'device-1' })).flags, { beta: 'on' });
    assert.deepEqual((await evaluate({ distinct_id: 'someone-else' })).flags, {});
    assert.deepEqual((await evaluate({ distinct_id: null })).flags, {});
  });

  it('validates definitions', async () => {
    const res = await t.call('PUT', '/api/flags/bad', { body: { rollout: 150 } });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /^Invalid request — rollout: /);
  });
});

describe('experiments', () => {
  beforeEach(() => setup());

  it('runs the full lifecycle: create, start, measure, ship', async () => {
    const created = await t.json<{ experiment: { flag: string; status: string } }>('POST', '/api/experiments', {
      body: { key: 'checkout-v2', goal: { event: 'purchase' }, hypothesis: 'A shorter form converts better' },
    });
    assert.equal(created.experiment.status, 'draft');
    const flag = await t.json<{ flag: { enabled: boolean } }>('GET', '/api/flags/checkout-v2');
    assert.equal(flag.flag.enabled, false, 'flag stays off until the experiment starts');

    await t.json('POST', '/api/experiments/checkout-v2/start');
    const events = [];
    for (let i = 0; i < 40; i++) {
      const variant = i % 2 ? 'test' : 'control';
      events.push(wire('$exposure', { distinct_id: `u${i}`, ts: Date.now() - 5000, props: { flag: 'checkout-v2', variant } }));
      if (variant === 'test' || i % 4 === 0) events.push(wire('purchase', { distinct_id: `u${i}`, ts: Date.now() - 1000 }));
    }
    await t.ingest(events);
    const res = await t.json<{ results: { variants: { variant: string; exposures: number; conversions: number }[]; srm: { mismatch: boolean } } }>(
      'GET',
      '/api/experiments/checkout-v2',
    );
    assert.deepEqual(
      res.results.variants.map((v) => [v.variant, v.exposures, v.conversions]),
      [
        ['control', 20, 10],
        ['test', 20, 20],
      ],
    );
    assert.equal(res.results.srm.mismatch, false);

    await t.json('POST', '/api/experiments/checkout-v2/ship', { body: { variant: 'test' } });
    const flags = await t.json<{ flags: Record<string, string> }>('POST', '/f', { key: null, body: { project: 'acme', distinct_id: 'anyone' } });
    assert.equal(flags.flags['checkout-v2'], 'test');
  });
});

describe('session replay', () => {
  beforeEach(() => setup());

  it('stores chunks, indexes sessions and summarises them as text', async () => {
    const T = Date.now() - 60_000;
    const chunk0 = [
      { type: 4, timestamp: T, data: { href: 'https://acme.com/checkout' } },
      {
        type: 2,
        timestamp: T,
        data: { node: { id: 1, type: 0, childNodes: [{ id: 2, type: 2, tagName: 'button', childNodes: [{ id: 3, type: 3, textContent: 'Pay' }] }] } },
      },
    ];
    const chunk1 = [1000, 1200, 1400].map((dt) => ({ type: 3, timestamp: T + dt, data: { source: 2, type: 2, id: 2 } }));
    const gz = async (value: unknown) =>
      new Uint8Array(await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const q = (seq: number, extra: string) => `/r?project=acme&session=s-9&seq=${seq}&d=device-1&start=${T}&end=${T + 1400}${extra}`;
    assert.equal((await t.call('POST', q(0, '&enc=gzip'), { key: null, body: await gz(chunk0) })).status, 204);
    assert.equal((await t.call('POST', q(1, '&enc=json&clicks=3&errors=1'), { key: null, body: JSON.stringify(chunk1) })).status, 204);
    await t.ingest([wire('$exception', { session_id: 's-9', ts: T + 1500, props: { type: 'TypeError', message: 'card is undefined' } })]);

    const list = await t.json<{ replays: { session: string; clicks: number; errors: number }[] }>('GET', '/api/replays?with_errors=true');
    assert.deepEqual(list.replays.map((r) => [r.session, r.clicks, r.errors]), [['s-9', 3, 1]]);
    const events = await t.json<{ events: unknown[] }>('GET', '/api/replays/s-9/events');
    assert.equal(events.events.length, 5);
    const summary = await t.json<{ transcript: string }>('GET', '/api/replays/s-9/summary');
    assert.match(summary.transcript, /Rage-clicked "Pay" \(button\) ×3/);
    assert.match(summary.transcript, /ERROR TypeError: card is undefined/);
  });

  it('keeps chunks from different page loads of the same session apart', async () => {
    // Every page load restarts seq at 0; the page id must stop later pages overwriting earlier ones.
    const chunk = (href: string, ts: number) => JSON.stringify([{ type: 4, timestamp: ts, data: { href } }]);
    await t.call('POST', '/r?project=acme&session=multi&seq=0&page=aaa&start=1000&enc=json', { key: null, body: chunk('/one', 1000) });
    await t.call('POST', '/r?project=acme&session=multi&seq=0&page=bbb&start=2000&enc=json', { key: null, body: chunk('/two', 2000) });
    const events = await t.json<{ events: { data: { href: string } }[] }>('GET', '/api/replays/multi/events');
    assert.deepEqual(
      events.events.map((e) => e.data.href),
      ['/one', '/two'],
    );
  });

  it('labels each click against the page load it happened on', async () => {
    // Node ids restart on every page load: node 2 is a different button on each page.
    const T = Date.now() - 60_000;
    const snapshot = (ts: number, label: string) => ({
      type: 2,
      timestamp: ts,
      data: { node: { id: 1, type: 0, childNodes: [{ id: 2, type: 2, tagName: 'button', childNodes: [{ id: 3, type: 3, textContent: label }] }] } },
    });
    const click = (ts: number) => ({ type: 3, timestamp: ts, data: { source: 2, type: 2, id: 2 } });
    const upload = (page: string, events: { timestamp: number }[]) =>
      t.call('POST', `/r?project=acme&session=pages&seq=0&page=${page}&start=${events[0]!.timestamp}&enc=json`, { key: null, body: JSON.stringify(events) });
    await upload('aaa', [snapshot(T, 'Choose Team'), click(T + 500)]);
    await upload('bbb', [snapshot(T + 1000, 'Create account'), click(T + 1500)]);
    const { transcript } = await t.json<{ transcript: string }>('GET', '/api/replays/pages/summary');
    assert.match(transcript, /00:00 Clicked "Choose Team" \(button\)\n00:01 Clicked "Create account" \(button\)/);
  });

  it('explains when replay is disabled', async () => {
    t = testApp({ REPLAYS: undefined });
    await t.json('POST', '/api/projects', { body: { id: 'acme' } });
    const res = await t.call('POST', '/r?project=acme&session=s&seq=0', { key: null, body: '[]' });
    assert.equal(res.status, 501);
    assert.match(((await res.json()) as { hint: string }).hint, /glass upgrade/);
  });
});

describe('MCP server', () => {
  beforeEach(() => setup());
  const rpc = (body: unknown, key?: string) => t.call('POST', '/mcp', { body, key, headers: { Accept: 'application/json, text/event-stream' } });

  it('initializes and lists tools with JSON Schemas', async () => {
    const init = (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).json()) as {
      result: { protocolVersion: string; serverInfo: { name: string }; instructions: string };
    };
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'glass');
    assert.match(init.result.instructions, /overview/);
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

    const list = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as {
      result: { tools: { name: string; inputSchema: { type: string; properties: Record<string, unknown> }; annotations: { readOnlyHint: boolean } }[] };
    };
    const names = list.result.tools.map((x) => x.name);
    for (const expected of ['overview', 'query_funnel', 'query_retention', 'sql', 'summarise_replay', 'create_experiment']) {
      assert.ok(names.includes(expected), expected);
    }
    const funnel = list.result.tools.find((x) => x.name === 'query_funnel')!;
    assert.equal(funnel.inputSchema.type, 'object');
    assert.ok('steps' in funnel.inputSchema.properties);
    assert.equal(funnel.annotations.readOnlyHint, true);
  });

  it('calls tools and reports errors as tool results', async () => {
    await t.ingest([wire('$pageview')]);
    const call = async (name: string, args: unknown, key?: string) =>
      ((await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, key)).json()) as {
        result: { content: { text: string }[]; isError?: boolean; structuredContent?: { summary: string } };
      }).result;

    const overview = await call('overview', { from: '-1d' });
    assert.equal(overview.isError, undefined);
    assert.match(overview.structuredContent!.summary, /1 visitors/);

    const denied = await call('save_flag', { key: 'x' }, READ);
    assert.equal(denied.isError, true);
    assert.match(denied.content[0]!.text, /admin key/);

    const invalid = await call('query_funnel', { steps: [] });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0]!.text, /Invalid arguments/);

    const unknown = (await (await rpc({ jsonrpc: '2.0', id: 4, method: 'nope' })).json()) as { error: { code: number } };
    assert.equal(unknown.error.code, -32601);
  });
});

describe('lake store', () => {
  it('streams events to Pipelines and queries Basin SQL', async () => {
    const events = new ArrayStream();
    const identities = new ArrayStream();
    const queries: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      queries.push(JSON.parse(String(init.body)).query);
      if (url.includes('/basin-sql/')) return new Response('not found', { status: 404 }); // exercise the fallback path
      return Response.json({ success: true, result: { schema: [{ name: 'n' }], rows: [[7]] } });
    }) as typeof fetch;
    const { LakeStore } = await import('../src/stores/lake.ts');
    const env = { GLASS_STORE: 'lake', EVENTS_STREAM: events, IDENTITIES_STREAM: identities, CF_ACCOUNT_ID: 'acct', LAKE_BUCKET: 'glass-data', CF_API_TOKEN: 'tok' };
    t = testApp(env, { createStore: (e) => new LakeStore(e, fakeFetch) });
    await t.json('POST', '/api/projects', { body: { id: 'acme' } });

    await t.ingest([wire('$pageview'), wire('$identify', { user_id: 'alice' })]);
    assert.equal(events.records.length, 2);
    assert.match(String((events.records[0] as { ts: string }).ts), /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(
      identities.records.map((r) => (r as { person_id: string }).person_id),
      ['alice'],
    );
    assert.equal(t.db.sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()!.n, 0, 'events are not written to D1');

    const res = await t.json<{ rows: { n: number }[] }>('POST', '/api/sql', { body: { query: 'SELECT COUNT(*) AS n FROM glass.events' } });
    assert.deepEqual(res.rows, [{ n: 7 }]);

    await t.call('POST', '/api/query', { body: { kind: 'trends', series: [{ event: 'signup', math: 'unique_persons' }], filters: [{ property: 'plan', value: 'pro' }] } });
    const trendsSql = queries.at(-1)!;
    assert.match(trendsSql, /FROM glass\.events e/);
    assert.match(trendsSql, /FROM glass\.identities/);
    assert.match(trendsSql, /json_as_text\(e\.props, 'plan'\) = 'pro'/);
    assert.doesNotMatch(trendsSql, /json_extract|strftime/);
  });

  it('normalises the result shapes analytics APIs return', async () => {
    const { normaliseRows } = await import('../src/stores/lake.ts');
    assert.deepEqual(normaliseRows([{ a: 1 }]), [{ a: 1 }]);
    assert.deepEqual(normaliseRows({ result: [{ a: 1 }] }), [{ a: 1 }]);
    assert.deepEqual(normaliseRows({ result: { rows: [[1, 'x']], schema: [{ name: 'a' }, { name: 'b' }] } }), [{ a: 1, b: 'x' }]);
    assert.deepEqual(normaliseRows({ meta: [{ name: 'a' }], data: [{ a: 2 }] }), [{ a: 2 }]);
    assert.deepEqual(normaliseRows({ columns: ['a'], rows: [[3]] }), [{ a: 3 }]);
    assert.deepEqual(normaliseRows(null), []);
  });
});

describe('maintenance', () => {
  it('deletes events and replays past their retention', async () => {
    await setup({ GLASS_RETENTION_DAYS: '30', GLASS_REPLAY_RETENTION_DAYS: '7' });
    await t.ingest([wire('recent')]);
    t.db.sqlite.exec(`UPDATE events SET ts_ms = ${Date.now() - 40 * 86_400_000} WHERE event = 'recent'`);
    await t.ingest([wire('fresh')]);
    const old = Date.now() - 10 * 86_400_000;
    await t.call('POST', `/r?project=acme&session=old&seq=0&start=${old}&end=${old}&enc=json`, { key: null, body: '[]' });
    await t.call('POST', `/r?project=acme&session=old&seq=1&start=${old}&end=${old}&enc=json`, { key: null, body: '[{"type":4,"timestamp":1}]' });
    await t.app.scheduled({}, t.env);
    assert.deepEqual(
      rows('SELECT event FROM events').map((r) => r.event),
      ['fresh'],
    );
    assert.equal(rows('SELECT * FROM replays').length, 0);
  });
});
