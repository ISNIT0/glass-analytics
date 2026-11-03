import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runExperiment } from '../src/insights/experiment.ts';
import { runFunnel } from '../src/insights/funnel.ts';
import { runRetention } from '../src/insights/retention.ts';
import { runTrends } from '../src/insights/trends.ts';
import { runWeb } from '../src/insights/web.ts';
import { DAY, NOW, context, createDb, insert, link } from './helpers.ts';

describe('trends', () => {
  it('counts events per day and fills empty days with zero', async () => {
    const db = createDb();
    insert(db, [
      { event: 'signup', daysAgo: 0 },
      { event: 'signup', daysAgo: 0 },
      { event: 'signup', daysAgo: 2 },
      { event: 'other', daysAgo: 0 },
    ]);
    const r = await runTrends({ series: [{ event: 'signup' }], from: '-3d', to: 'now', interval: 'day' }, context(db));
    assert.equal(r.series.length, 1);
    assert.equal(r.series[0]!.total, 3);
    assert.deepEqual(r.series[0]!.values.slice(-3), [1, 0, 2]);
    assert.equal(r.buckets.length, r.series[0]!.values.length);
  });

  it('counts unique persons, merging anonymous devices into identified users', async () => {
    const db = createDb();
    insert(db, [
      { event: 'view', distinct_id: 'anon-1' },
      { event: 'view', distinct_id: 'anon-1', user_id: 'u1' },
      { event: 'view', distinct_id: 'anon-2' },
    ]);
    link(db, 'anon-1', 'u1');
    const r = await runTrends({ series: [{ event: 'view', math: 'unique_persons' }], from: '-1d' }, context(db));
    assert.equal(r.series[0]!.total, 2);
  });

  it('breaks down by a property, keeping the top N and grouping the rest as Other', async () => {
    const db = createDb();
    insert(db, [
      ...Array.from({ length: 5 }, () => ({ event: 'buy', browser: 'Chrome' })),
      ...Array.from({ length: 3 }, () => ({ event: 'buy', browser: 'Firefox' })),
      { event: 'buy', browser: 'Safari' },
      { event: 'buy', browser: 'Edge' },
    ]);
    const r = await runTrends(
      { series: [{ event: 'buy' }], from: '-1d', breakdown: 'browser', breakdownLimit: 2 },
      context(db),
    );
    assert.deepEqual(
      r.series.map((s) => [s.breakdown, s.total]),
      [
        ['Chrome', 5],
        ['Firefox', 3],
        ['Other', 2],
      ],
    );
  });

  it('sums a numeric property and ignores non-numeric values', async () => {
    const db = createDb();
    insert(db, [
      { event: 'order', props: { amount: 10 } },
      { event: 'order', props: { amount: 32.5 } },
      { event: 'order', props: { amount: 'oops' } },
    ]);
    const r = await runTrends({ series: [{ event: 'order', math: 'sum', property: 'amount' }], from: '-1d' }, context(db));
    assert.equal(r.series[0]!.total, 42.5);
  });

  it('shifts day boundaries with utcOffsetMinutes', async () => {
    const db = createDb();
    // 23:30 UTC on 30 Oct is 00:30 on 31 Oct in UTC+1.
    insert(db, [{ event: 'late', ts_ms: Date.UTC(2026, 9, 30, 23, 30) }]);
    const utc = await runTrends({ series: [{ event: 'late' }], from: '-3d', interval: 'day' }, context(db));
    const plusOne = await runTrends({ series: [{ event: 'late' }], from: '-3d', interval: 'day', utcOffsetMinutes: 60 }, context(db));
    const dayOf = (r: typeof utc) => new Date(r.buckets[r.series[0]!.values.indexOf(1)]! + (r === plusOne ? 3_600_000 : 0)).getUTCDate();
    assert.equal(dayOf(utc), 30);
    assert.equal(dayOf(plusOne), 31);
  });
});

describe('funnels', () => {
  it('requires steps in order and within the window', async () => {
    const db = createDb();
    const t = NOW - 10 * DAY;
    insert(db, [
      // a: completes all steps in order
      { distinct_id: 'a', event: 'visit', ts_ms: t },
      { distinct_id: 'a', event: 'signup', ts_ms: t + 1000 },
      { distinct_id: 'a', event: 'pay', ts_ms: t + 5000 },
      // b: signs up before visiting — only step 1 counts
      { distinct_id: 'b', event: 'signup', ts_ms: t },
      { distinct_id: 'b', event: 'visit', ts_ms: t + 1000 },
      // c: pays outside the 1 day window
      { distinct_id: 'c', event: 'visit', ts_ms: t },
      { distinct_id: 'c', event: 'signup', ts_ms: t + 1000 },
      { distinct_id: 'c', event: 'pay', ts_ms: t + 2 * DAY },
    ]);
    const r = await runFunnel(
      { steps: [{ event: 'visit' }, { event: 'signup' }, { event: 'pay' }], window: '1d', from: '-30d' },
      context(db),
    );
    assert.deepEqual(
      r.steps.map((s) => s.count),
      [3, 2, 1],
    );
    assert.equal(r.steps[1]!.avgSecondsFromPrevious, 1);
    assert.match(r.summary, /3 people started; 1 completed/);
  });

  it('connects anonymous steps to the identified user who signed up', async () => {
    const db = createDb();
    const t = NOW - DAY;
    insert(db, [
      { distinct_id: 'anon', event: '$pageview', path: '/pricing', ts_ms: t },
      { distinct_id: 'anon', user_id: 'alice', event: 'signup', ts_ms: t + 60_000 },
    ]);
    link(db, 'anon', 'alice');
    const r = await runFunnel(
      { steps: [{ event: '$pageview', filters: [{ property: 'path', value: '/pricing' }] }, { event: 'signup' }], from: '-7d' },
      context(db),
    );
    assert.deepEqual(
      r.steps.map((s) => s.count),
      [1, 1],
    );
  });

  it('breaks down by a property of the first step', async () => {
    const db = createDb();
    const t = NOW - DAY;
    insert(db, [
      { distinct_id: 'x', event: 'visit', utm_source: 'google', ts_ms: t },
      { distinct_id: 'x', event: 'signup', ts_ms: t + 1 },
      { distinct_id: 'y', event: 'visit', utm_source: 'google', ts_ms: t },
      { distinct_id: 'z', event: 'visit', utm_source: 'twitter', ts_ms: t },
      { distinct_id: 'z', event: 'signup', ts_ms: t + 1 },
    ]);
    const r = await runFunnel({ steps: [{ event: 'visit' }, { event: 'signup' }], breakdown: 'utm_source', from: '-7d' }, context(db));
    const google = r.breakdowns!.find((b) => b.value === 'google')!;
    const twitter = r.breakdowns!.find((b) => b.value === 'twitter')!;
    assert.deepEqual(
      google.steps.map((s) => s.count),
      [2, 1],
    );
    assert.deepEqual(
      twitter.steps.map((s) => s.count),
      [1, 1],
    );
    assert.deepEqual(
      r.steps.map((s) => s.count),
      [3, 2],
    );
  });
});

describe('retention', () => {
  it('builds weekly cohorts with returning users per week', async () => {
    const db = createDb();
    // Monday 12 Oct 2026 is the start of the first cohort week.
    const week1 = Date.UTC(2026, 9, 12, 10);
    insert(db, [
      { distinct_id: 'a', event: 'signup', ts_ms: week1 },
      { distinct_id: 'a', event: 'use', ts_ms: week1 + 7 * DAY },
      { distinct_id: 'a', event: 'use', ts_ms: week1 + 14 * DAY },
      { distinct_id: 'b', event: 'signup', ts_ms: week1 + DAY },
      { distinct_id: 'b', event: 'use', ts_ms: week1 + 14 * DAY },
      { distinct_id: 'c', event: 'signup', ts_ms: week1 + 7 * DAY },
    ]);
    const r = await runRetention(
      {
        cohortEvent: { event: 'signup' },
        returnEvent: { event: 'use' },
        period: 'week',
        periods: 3,
        from: '2026-10-12',
        to: '2026-10-26',
      },
      context(db),
    );
    assert.equal(r.cohorts.length, 2);
    const [first, second] = r.cohorts;
    assert.equal(first!.start, Date.UTC(2026, 9, 12));
    assert.deepEqual(first!.counts, [2, 1, 2, 0]);
    assert.deepEqual(second!.counts, [1, 0, 0, 0]);
    assert.equal(r.average[1], 1 / 3);
  });

  it('supports monthly cohorts', async () => {
    const db = createDb();
    insert(db, [
      { distinct_id: 'a', event: 'signup', ts_ms: Date.UTC(2026, 7, 20) },
      { distinct_id: 'a', event: 'use', ts_ms: Date.UTC(2026, 8, 2) },
    ]);
    const r = await runRetention(
      { cohortEvent: { event: 'signup' }, returnEvent: { event: 'use' }, period: 'month', periods: 2, from: '2026-08-01', to: '2026-09-01' },
      context(db),
    );
    assert.equal(r.cohorts[0]!.start, Date.UTC(2026, 7, 1));
    assert.deepEqual(r.cohorts[0]!.counts, [1, 1, 0]);
  });
});

describe('web overview', () => {
  it('computes visitors, sessions, bounce rate and breakdowns', async () => {
    const db = createDb();
    const t = NOW - DAY;
    insert(db, [
      // Session 1: two pages, from Google, lasting 60s.
      { distinct_id: 'v1', session_id: 's1', path: '/', referrer_host: 'google.com', ts_ms: t },
      { distinct_id: 'v1', session_id: 's1', path: '/pricing', ts_ms: t + 30_000 },
      { distinct_id: 'v1', session_id: 's1', event: '$pageleave', path: '/pricing', ts_ms: t + 60_000 },
      // Session 2: one page (a bounce), direct.
      { distinct_id: 'v2', session_id: 's2', path: '/pricing', browser: 'Firefox', ts_ms: t },
      // An error and some vitals.
      { distinct_id: 'v2', session_id: 's2', event: '$exception', props: { message: 'boom' }, ts_ms: t + 1 },
      { distinct_id: 'v2', event: '$web_vitals', props: { metric: 'LCP', value: 1200 }, ts_ms: t },
      { distinct_id: 'v1', event: '$web_vitals', props: { metric: 'LCP', value: 2500 }, ts_ms: t },
      // Previous period: one visitor.
      { distinct_id: 'old', session_id: 's0', path: '/', ts_ms: NOW - 10 * DAY },
    ]);
    const r = await runWeb({ from: '-7d' }, context(db));
    assert.deepEqual(
      {
        visitors: r.totals.visitors,
        pageviews: r.totals.pageviews,
        sessions: r.totals.sessions,
        bounceRate: r.totals.bounceRate,
        avgSessionSeconds: r.totals.avgSessionSeconds,
      },
      { visitors: 2, pageviews: 3, sessions: 2, bounceRate: 0.5, avgSessionSeconds: 30 },
    );
    assert.equal(r.previous!.visitors, 1);
    assert.deepEqual(r.breakdowns.pages[0], { value: '/pricing', visitors: 2, count: 2 });
    assert.deepEqual(
      r.breakdowns.entry_pages.map((b) => b.value).sort(),
      ['/', '/pricing'],
    );
    assert.deepEqual(r.breakdowns.exit_pages.find((b) => b.value === '/pricing')?.count, 2);
    assert.deepEqual(
      r.breakdowns.referrers.map((b) => b.value).sort(),
      ['Direct / None', 'google.com'],
    );
    assert.equal(r.breakdowns.errors[0]!.value, 'boom');
    assert.equal(r.vitals.LCP!.p75, 2500);
    assert.match(r.summary, /2 visitors \(\+100\.0% vs previous period\)/);
  });
});

describe('experiment readout', () => {
  it('counts conversions after exposure and excludes people who saw both variants', async () => {
    const db = createDb();
    const t = NOW - 5 * DAY;
    const exposure = (distinct_id: string, variant: string, ts_ms = t) => ({
      distinct_id,
      event: '$exposure',
      ts_ms,
      props: { flag: 'checkout', variant },
    });
    insert(db, [
      exposure('c1', 'control'),
      exposure('c2', 'control'),
      { distinct_id: 'c1', event: 'purchase', ts_ms: t + 1, props: { revenue: 10 } },
      exposure('t1', 'test'),
      exposure('t2', 'test'),
      { distinct_id: 't1', event: 'purchase', ts_ms: t + 1, props: { revenue: 30 } },
      { distinct_id: 't2', event: 'purchase', ts_ms: t + 1, props: { revenue: 20 } },
      // Purchased before exposure: not a conversion.
      exposure('t3', 'test', t + 10),
      { distinct_id: 't3', event: 'purchase', ts_ms: t },
      // Saw both: excluded.
      exposure('both', 'control'),
      exposure('both', 'test', t + 5),
    ]);
    const r = await runExperiment(
      { flag: 'checkout', goal: { event: 'purchase', value: 'revenue' }, from: '-30d' },
      context(db),
    );
    const [control, test] = r.variants;
    assert.equal(control!.variant, 'control');
    assert.deepEqual([control!.exposures, control!.conversions], [2, 1]);
    assert.deepEqual([test!.exposures, test!.conversions], [3, 2]);
    assert.equal(r.excludedMultipleVariants, 1);
    assert.equal(control!.mean!.value, 5);
    assert.equal(test!.mean!.value, 50 / 3);
    assert.ok(test!.vsControl!.probabilityToBeatControl > 0.5);
    assert.equal(r.winner, null, 'tiny samples should never declare a winner');
  });
});
