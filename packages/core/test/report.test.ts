import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runConversions, runHealth, runSources } from '../src/insights/report.ts';
import { context, createDb, insert } from './helpers.ts';

describe('report queries', () => {
  it('counts key events, conversion rates and the previous period', async () => {
    const db = createDb();
    insert(db, [
      { distinct_id: 'a' },
      { distinct_id: 'b' },
      { distinct_id: 'c' },
      { distinct_id: 'd' },
      { distinct_id: 'a', event: 'signup' },
      { distinct_id: 'b', event: 'signup' },
      { distinct_id: 'b', event: 'signup' },
      { distinct_id: 'c', event: 'share' },
      { distinct_id: 'x', daysAgo: 40 },
      { distinct_id: 'x', event: 'signup', daysAgo: 40 },
    ]);
    const r = await runConversions(
      {
        from: '-30d',
        goals: [
          { event: 'signup', role: 'conversion' },
          { event: 'share', role: 'important' },
        ],
      },
      context(db),
    );
    assert.equal(r.visitors, 4);
    const signup = r.goals.find((g) => g.event === 'signup')!;
    assert.deepEqual([signup.count, signup.visitors, signup.rate], [3, 2, 0.5]);
    assert.deepEqual(signup.previous, { count: 1, visitors: 1, rate: 1 });
    assert.equal(
      signup.series.reduce((a, b) => a + b, 0),
      2,
    );
    assert.deepEqual(r.converted, { visitors: 2, rate: 0.5, previous: 1 });
  });

  it('attributes visitors to channels and sources on first touch, with conversion rates', async () => {
    const db = createDb();
    insert(db, [
      { distinct_id: 'g1', referrer_host: 'www.google.com', ts_ms: Date.UTC(2026, 9, 30) },
      { distinct_id: 'g1', referrer_host: 't.co', ts_ms: Date.UTC(2026, 9, 30, 1) },
      { distinct_id: 'g1', event: 'signup', ts_ms: Date.UTC(2026, 9, 30, 2) },
      { distinct_id: 'g2', referrer_host: 'google.co.uk' },
      { distinct_id: 'p1', utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'nature' },
      { distinct_id: 'n1', utm_source: 'newsletter' },
      { distinct_id: 'r1', referrer_host: 'blog.example.org' },
      { distinct_id: 'ai', referrer_host: 'chatgpt.com' },
      { distinct_id: 'ai2', utm_source: 'chatgpt.com' },
      { distinct_id: 'ai3', utm_source: 'perplexity' },
      { distinct_id: 'd1' },
    ]);
    const channels = await runSources(
      { from: '-30d', dimension: 'channel', conversions: ['signup'] },
      context(db),
    );
    const by = Object.fromEntries(channels.rows.map((r) => [r.value, r]));
    assert.equal(by['Organic search']!.visitors, 2);
    assert.equal(by['Organic search']!.converted, 1);
    assert.equal(by['Organic search']!.rate, 0.5);
    assert.deepEqual(
      ['Paid', 'Email', 'Referral', 'AI assistants', 'Direct'].map((c) => by[c]?.visitors),
      [1, 1, 1, 3, 1],
    );
    assert.equal(by.Social, undefined, 'g1 came from Google first');
    const campaigns = await runSources(
      { from: '-30d', dimension: 'utm_campaign', conversions: [] },
      context(db),
    );
    assert.ok(campaigns.rows.some((r) => r.value === 'nature' && r.visitors === 1));
  });

  it('reports errors, sessions affected, not-found pages and slow pages', async () => {
    const db = createDb();
    insert(db, [
      { distinct_id: 'a', session_id: 's1', path: '/checkout' },
      {
        distinct_id: 'a',
        session_id: 's1',
        event: '$exception',
        path: '/checkout',
        props: { message: 'x' },
      },
      { distinct_id: 'b', session_id: 's2', path: '/old-page', title: 'Page not found' },
      { distinct_id: 'b', session_id: 's3', path: '/' },
      ...Array.from({ length: 6 }, (_, i) => ({
        event: '$web_vitals',
        path: '/slow',
        props: { metric: 'LCP', value: 4000 + i * 100 },
      })),
      { event: '$exception', daysAgo: 40 },
    ]);
    const r = await runHealth({ from: '-30d' }, context(db));
    assert.equal(r.errors.total, 1);
    assert.equal(r.errors.previous, 1);
    assert.equal(r.errors.sessions, 1);
    assert.equal(r.errors.sessionsTotal, 3);
    assert.deepEqual(r.errorPages, [{ path: '/checkout', errors: 1, visitors: 1 }]);
    assert.equal(r.notFound[0]?.path, '/old-page');
    assert.equal(r.slowPages[0]?.path, '/slow');
    assert.equal(r.slowPages[0]?.p75, 4400);
  });
});

describe('session filters', () => {
  it('keeps every event of sessions that landed from a source, so conversions count', async () => {
    const db = createDb();
    insert(db, [
      { distinct_id: 'm', session_id: 'sm', utm_source: 'meta', path: '/' },
      { distinct_id: 'm', session_id: 'sm', path: '/pledge' },
      { distinct_id: 'm', session_id: 'sm', event: 'signup', path: '/pledge' },
      { distinct_id: 'g', session_id: 'sg', referrer_host: 'google.com' },
      { distinct_id: 'g', session_id: 'sg', event: 'signup' },
    ]);
    const filters = [{ property: 'session.utm_source', value: 'meta' }];
    const conv = await runConversions(
      { from: '-30d', filters, goals: [{ event: 'signup', role: 'conversion' }] },
      context(db),
    );
    assert.equal(conv.visitors, 1);
    assert.equal(conv.goals[0]!.visitors, 1);
    const eventLevel = await runConversions(
      {
        from: '-30d',
        filters: [{ property: 'utm_source', value: 'meta' }],
        goals: [{ event: 'signup', role: 'conversion' }],
      },
      context(db),
    );
    assert.equal(eventLevel.goals[0]!.visitors, 0, 'an event-level filter loses the conversion');
  });
});
