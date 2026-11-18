/**
 * Revenue analytics (`kind: "revenue"`): money in and recurring revenue.
 *
 * Reads the normalised fields ingest writes (see `core/src/revenue.ts`):
 * `$revenue_base` on payments and refunds, `$subscription_id`/`$mrr` on
 * subscription state. Per period it reports gross revenue, refunds, net revenue,
 * orders, paying customers and ARPU; MRR and ARR at the period's end with the
 * movements behind them (new, expansion, contraction, churned, reactivated);
 * revenue and customer churn; and LTV for monthly periods. Plus revenue by a
 * breakdown (product, first-touch channel or UTM, country, any property) and the
 * top customers — people, or accounts with `aggregateBy` set to a group type.
 *
 * MRR without window functions: each period's end joins the subscription events
 * before it (a VALUES list of ends), takes each subscription's latest state there
 * (a join on MAX(ts)), and compares it with the previous period's.
 */

import type { z } from 'zod/v4';
import type { Filter } from '../filters.ts';
import { breakdownExpr } from '../sql/filters.ts';
import { bucketExpr, eventsCte, num, text } from '../sql/source.ts';
import { bucketsBetween, DAY_MS, resolveRange } from '../time.ts';
import { aggregationOf } from './actors.ts';
import { dimensionExpr, SOURCE_DIMENSIONS, type SourceDimension } from './report.ts';
import type { revenueSpec } from './schemas.ts';
import { type QueryContext, type ResultBase, zoneOf } from './types.ts';

export type RevenueSpec = z.infer<typeof revenueSpec>;

/** How far before the range subscription state is read (a yearly plan renews within it). */
const STATE_LOOKBACK_MS = 400 * DAY_MS;
/** First touch for revenue by channel: pageviews from this long before the range. */
const TOUCH_LOOKBACK_MS = 90 * DAY_MS;

export interface RevenuePeriod {
  gross: number;
  refunds: number;
  net: number;
  orders: number;
  customers: number;
  arpu: number;
  mrr: number;
  arr: number;
  subscriptions: number;
  subscribers: number;
  newMrr: number;
  expansionMrr: number;
  contractionMrr: number;
  churnedMrr: number;
  reactivatedMrr: number;
  netNewMrr: number;
  /** Churned MRR / MRR at the start of the period. */
  revenueChurn: number;
  /** Subscriptions that churned / subscriptions paying at the start. */
  customerChurn: number;
}

export interface RevenueResult extends ResultBase {
  kind: 'revenue';
  currency: string;
  interval: string;
  buckets: number[];
  periods: RevenuePeriod[];
  totals: {
    gross: number;
    refunds: number;
    net: number;
    orders: number;
    customers: number;
    arpu: number;
    mrr: number;
    arr: number;
    netNewMrr: number;
    /** Average monthly revenue churn over the range (monthly periods). */
    revenueChurn: number | null;
    /** MRR per paying customer / monthly customer churn (monthly periods with churn). */
    ltv: number | null;
  };
  breakdown: {
    by: string;
    values: { value: string; net: number; customers: number; series: number[] }[];
  } | null;
  topCustomers: {
    actor: string;
    net: number;
    orders: number;
    mrr: number;
    firstAt: string;
    lastAt: string;
  }[];
  /** Revenue events with no exchange rate for their currency (left out of the totals). */
  unconverted: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const FIRST_TOUCH = new Set([
  'channel',
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'entry_page',
]);

export async function runRevenue(spec: RevenueSpec, ctx: QueryContext): Promise<RevenueResult> {
  const d = ctx.dialect;
  const range = resolveRange(spec.from ?? '-6mo', spec.to, ctx.now);
  const interval = spec.interval ?? 'month';
  const zone = zoneOf(spec, ctx, { from: range.from - STATE_LOOKBACK_MS, to: range.to });
  const buckets = bucketsBetween(range, interval, zone);
  const bucket = bucketExpr(d, 'ts_ms', interval, zone);
  const aggregation = aggregationOf(spec);
  const filters = (spec.filters ?? []) as Filter[];
  const currency = (spec.currency ?? 'USD').toUpperCase();
  const rev = d.jsonNumber('props', ['$revenue_base']);
  const money = eventsCte(d, {
    project: ctx.project,
    ...range,
    filters: [...filters, { property: 'props.$revenue_base', op: 'is_set' }],
    aggregation,
  });
  const x = `x AS (SELECT ts_ms, pid, actor, country, props, ${rev} AS r FROM ev)`;

  const sql: Record<string, string> = {
    sales: `WITH ${money},
${x}
SELECT ${bucket} AS b,
  SUM(CASE WHEN r > 0 THEN r ELSE 0 END) AS gross,
  SUM(CASE WHEN r < 0 THEN r ELSE 0 END) AS refunds,
  SUM(CASE WHEN r > 0 THEN 1 ELSE 0 END) AS orders,
  COUNT(DISTINCT CASE WHEN r > 0 THEN actor END) AS customers
FROM x GROUP BY ${bucket} ORDER BY b`,
    totals: `WITH ${money},
${x}
SELECT COUNT(DISTINCT CASE WHEN r > 0 THEN actor END) AS customers FROM x`,
    top: `WITH ${money},
${x}
SELECT actor, SUM(r) AS net, SUM(CASE WHEN r > 0 THEN 1 ELSE 0 END) AS orders, MIN(ts_ms) AS first_ts, MAX(ts_ms) AS last_ts
FROM x GROUP BY actor ORDER BY net DESC, actor ASC LIMIT ${Math.min(spec.limit ?? 10, 100)}`,
    unconverted: `WITH ${eventsCte(d, {
      project: ctx.project,
      ...range,
      filters: [...filters, { property: 'props.$revenue_unconverted', op: 'is_set' }],
    })}
SELECT COUNT(*) AS n FROM ev`,
  };

  // MRR state at each period's end (and at the end of the period before the first).
  const ends = [buckets[0] ?? range.from, ...buckets.slice(1), range.to];
  const values = ends.map((e, i) => `(${i - 1}, ${d.num(e)})`).join(', ');
  const stateCtes = `WITH ${eventsCte(d, {
    project: ctx.project,
    from: range.from - STATE_LOOKBACK_MS,
    to: range.to,
    filters: [...filters, { property: 'props.$subscription_id', op: 'is_set' }],
    aggregation,
  })},
s AS (
  SELECT ${d.jsonText('props', ['$subscription_id'])} AS sub, actor, ts_ms,
    ${d.jsonNumber('props', ['$mrr'])} AS mrr, ${d.jsonNumber('props', ['$mrr_grace_days'])} AS grace
  FROM ev
),
w AS (SELECT column1 AS i, column2 AS e FROM (VALUES ${values}) v),
latest AS (SELECT w.i AS i, w.e AS e, s.sub AS sub, MAX(s.ts_ms) AS t FROM w JOIN s ON s.ts_ms < w.e GROUP BY w.i, w.e, s.sub),
state AS (
  SELECT latest.i AS i, latest.sub AS sub, MAX(s.actor) AS actor,
    MAX(CASE WHEN s.grace IS NOT NULL AND latest.e - s.ts_ms > s.grace * ${DAY_MS} THEN 0 ELSE COALESCE(s.mrr, 0) END) AS mrr
  FROM latest JOIN s ON s.sub = latest.sub AND s.ts_ms = latest.t
  GROUP BY latest.i, latest.sub
)`;
  sql.mrr = `${stateCtes},
firsts AS (SELECT sub, MIN(i) AS fi FROM state WHERE mrr > 0 GROUP BY sub),
moves AS (
  SELECT cur.i AS i, cur.actor AS actor, cur.mrr AS now_mrr, COALESCE(prev.mrr, 0) AS before_mrr, firsts.fi AS fi
  FROM state cur
  LEFT JOIN state prev ON prev.sub = cur.sub AND prev.i = cur.i - 1
  LEFT JOIN firsts ON firsts.sub = cur.sub
  WHERE cur.i >= 0
)
SELECT i,
  SUM(now_mrr) AS mrr,
  SUM(CASE WHEN now_mrr > 0 THEN 1 ELSE 0 END) AS subscriptions,
  COUNT(DISTINCT CASE WHEN now_mrr > 0 THEN actor END) AS subscribers,
  SUM(CASE WHEN before_mrr = 0 AND now_mrr > 0 AND fi = i THEN now_mrr ELSE 0 END) AS new_mrr,
  SUM(CASE WHEN before_mrr = 0 AND now_mrr > 0 AND fi < i THEN now_mrr ELSE 0 END) AS reactivated_mrr,
  SUM(CASE WHEN before_mrr > 0 AND now_mrr > before_mrr THEN now_mrr - before_mrr ELSE 0 END) AS expansion_mrr,
  SUM(CASE WHEN before_mrr > 0 AND now_mrr > 0 AND now_mrr < before_mrr THEN before_mrr - now_mrr ELSE 0 END) AS contraction_mrr,
  SUM(CASE WHEN before_mrr > 0 AND now_mrr = 0 THEN before_mrr ELSE 0 END) AS churned_mrr,
  SUM(CASE WHEN before_mrr > 0 AND now_mrr = 0 THEN 1 ELSE 0 END) AS churned,
  SUM(CASE WHEN before_mrr > 0 THEN 1 ELSE 0 END) AS paying_at_start,
  SUM(before_mrr) AS start_mrr
FROM moves GROUP BY i ORDER BY i`;
  sql.mrrByActor = `${stateCtes}
SELECT actor, SUM(mrr) AS mrr FROM state WHERE i = ${ends.length - 2} AND mrr > 0 GROUP BY actor ORDER BY mrr DESC, actor ASC LIMIT 500`;

  // Breakdown.
  let by: string | null = null;
  if (spec.breakdown) {
    by = spec.breakdown;
    if (FIRST_TOUCH.has(by)) {
      sql.breakdown = `WITH ${money},
${eventsCte(d, { project: ctx.project, from: range.from - TOUCH_LOOKBACK_MS, to: range.to, events: ['$pageview'], name: 'pv' })},
${x},
pfirst AS (SELECT pid, MIN(ts_ms) AS t FROM pv GROUP BY pid),
ptouch AS (
  SELECT pv.pid AS pid, MIN(${dimensionExpr(by as SourceDimension, 'pv')}) AS val
  FROM pv JOIN pfirst ON pfirst.pid = pv.pid AND pv.ts_ms = pfirst.t GROUP BY pv.pid
)
SELECT ${bucketExpr(d, 'x.ts_ms', interval, zone)} AS b, COALESCE(ptouch.val, '(unknown)') AS val, SUM(x.r) AS net, COUNT(DISTINCT x.actor) AS customers
FROM x LEFT JOIN ptouch ON ptouch.pid = x.pid
GROUP BY ${bucketExpr(d, 'x.ts_ms', interval, zone)}, COALESCE(ptouch.val, '(unknown)')`;
    } else {
      const expr = breakdownExpr(by === 'product' ? 'props.$revenue_product' : by, d);
      sql.breakdown = `WITH ${money}
SELECT ${bucket} AS b, ${expr} AS val, SUM(${rev}) AS net, COUNT(DISTINCT actor) AS customers
FROM ev GROUP BY ${bucket}, ${expr}`;
    }
  }

  const names = Object.keys(sql);
  const results = Object.fromEntries(
    await Promise.all(names.map(async (n) => [n, await ctx.execute(sql[n]!)] as const)),
  );

  const slot = new Map(buckets.map((b, i) => [b, i]));
  const periods: RevenuePeriod[] = buckets.map(() => ({
    gross: 0,
    refunds: 0,
    net: 0,
    orders: 0,
    customers: 0,
    arpu: 0,
    mrr: 0,
    arr: 0,
    subscriptions: 0,
    subscribers: 0,
    newMrr: 0,
    expansionMrr: 0,
    contractionMrr: 0,
    churnedMrr: 0,
    reactivatedMrr: 0,
    netNewMrr: 0,
    revenueChurn: 0,
    customerChurn: 0,
  }));
  for (const r of results.sales!) {
    const p = periods[slot.get(num(r.b)) ?? -1];
    if (!p) continue;
    p.gross = round2(num(r.gross));
    p.refunds = round2(num(r.refunds));
    p.net = round2(p.gross + p.refunds);
    p.orders = num(r.orders);
    p.customers = num(r.customers);
    p.arpu = p.customers ? round2(p.net / p.customers) : 0;
  }
  for (const r of results.mrr!) {
    const p = periods[num(r.i)];
    if (!p) continue;
    p.mrr = round2(num(r.mrr));
    p.arr = round2(p.mrr * 12);
    p.subscriptions = num(r.subscriptions);
    p.subscribers = num(r.subscribers);
    p.newMrr = round2(num(r.new_mrr));
    p.expansionMrr = round2(num(r.expansion_mrr));
    p.contractionMrr = round2(num(r.contraction_mrr));
    p.churnedMrr = round2(num(r.churned_mrr));
    p.reactivatedMrr = round2(num(r.reactivated_mrr));
    p.netNewMrr = round2(
      p.newMrr + p.expansionMrr + p.reactivatedMrr - p.contractionMrr - p.churnedMrr,
    );
    p.revenueChurn = num(r.start_mrr) ? num(r.churned_mrr) / num(r.start_mrr) : 0;
    p.customerChurn = num(r.paying_at_start) ? num(r.churned) / num(r.paying_at_start) : 0;
  }

  const sum = (k: keyof RevenuePeriod) => round2(periods.reduce((n, p) => n + p[k], 0));
  const last = periods.at(-1);
  const customers = num(results.totals![0]?.customers);
  const gross = sum('gross');
  const refunds = sum('refunds');
  const net = round2(gross + refunds);
  const monthly = interval === 'month';
  const churnPeriods = periods.filter((p) => p.mrr > 0 || p.churnedMrr > 0);
  const avgRevenueChurn =
    monthly && churnPeriods.length
      ? churnPeriods.reduce((n, p) => n + p.revenueChurn, 0) / churnPeriods.length
      : null;
  const avgCustomerChurn =
    monthly && churnPeriods.length
      ? churnPeriods.reduce((n, p) => n + p.customerChurn, 0) / churnPeriods.length
      : null;
  const arpa = last?.subscribers ? last.mrr / last.subscribers : 0;
  const ltv = avgCustomerChurn ? round2(arpa / avgCustomerChurn) : null;

  // Breakdown values: top ten by net revenue, the rest as "Other".
  let breakdown: RevenueResult['breakdown'] = null;
  if (by && results.breakdown) {
    const totalsBy = new Map<string, { net: number; customers: number; series: number[] }>();
    for (const r of results.breakdown) {
      const v = text(r.val) || '(none)';
      const e = totalsBy.get(v) ?? { net: 0, customers: 0, series: buckets.map(() => 0) };
      e.net += num(r.net);
      e.customers += num(r.customers);
      const i = slot.get(num(r.b));
      if (i !== undefined) e.series[i] = round2(e.series[i]! + num(r.net));
      totalsBy.set(v, e);
    }
    const sorted = [...totalsBy].sort((a, b) => b[1].net - a[1].net || a[0].localeCompare(b[0]));
    const top = sorted.slice(0, 10);
    const rest = sorted.slice(10);
    if (rest.length) {
      top.push([
        'Other',
        rest.reduce(
          (acc, [, e]) => ({
            net: acc.net + e.net,
            customers: acc.customers + e.customers,
            series: acc.series.map((n, i) => round2(n + e.series[i]!)),
          }),
          { net: 0, customers: 0, series: buckets.map(() => 0) },
        ),
      ]);
    }
    breakdown = {
      by: FIRST_TOUCH.has(by)
        ? `first-touch ${SOURCE_DIMENSIONS[by as SourceDimension].toLowerCase()}`
        : by,
      values: top.map(([value, e]) => ({
        value,
        net: round2(e.net),
        customers: e.customers,
        series: e.series,
      })),
    };
  }

  const mrrBy = new Map(results.mrrByActor!.map((r) => [text(r.actor), round2(num(r.mrr))]));
  const topCustomers = results.top!.map((r) => ({
    actor: text(r.actor),
    net: round2(num(r.net)),
    orders: num(r.orders),
    mrr: mrrBy.get(text(r.actor)) ?? 0,
    firstAt: new Date(num(r.first_ts)).toISOString(),
    lastAt: new Date(num(r.last_ts)).toISOString(),
  }));
  const unconverted = num(results.unconverted![0]?.n);
  const fmt = (n: number) =>
    new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  const who =
    aggregation === 'person'
      ? 'customers'
      : aggregation === 'session'
        ? 'sessions'
        : `${aggregation.group} accounts`;
  const parts = [
    `Net revenue ${fmt(net)} (gross ${fmt(gross)}${refunds ? `, refunds ${fmt(Math.abs(refunds))}` : ''}) from ${customers} paying ${who}.`,
  ];
  if (last && (last.mrr > 0 || last.churnedMrr > 0)) {
    parts.push(
      `MRR ${fmt(last.mrr)} (ARR ${fmt(last.arr)}), ${last.netNewMrr >= 0 ? '+' : ''}${fmt(last.netNewMrr)} in the last period: new ${fmt(last.newMrr)}, expansion ${fmt(last.expansionMrr)}, reactivated ${fmt(last.reactivatedMrr)}, contraction ${fmt(last.contractionMrr)}, churned ${fmt(last.churnedMrr)}.`,
    );
    if (avgRevenueChurn !== null)
      parts.push(
        `Revenue churn ${(avgRevenueChurn * 100).toFixed(1)}% a month${ltv ? `, LTV about ${fmt(ltv)}` : ''}.`,
      );
  }
  if (breakdown?.values[0])
    parts.push(
      `Top ${breakdown.by}: ${breakdown.values[0].value} (${fmt(breakdown.values[0].net)}).`,
    );
  if (unconverted)
    parts.push(
      `${unconverted} revenue events had no exchange rate for their currency and are left out.`,
    );
  if (net === 0 && !last?.mrr) {
    parts.splice(
      0,
      parts.length,
      'No revenue in this range. Set revenueEvents (update_settings) or connect Stripe (connect_stripe).',
    );
  }

  return {
    kind: 'revenue',
    currency,
    interval,
    buckets,
    periods,
    totals: {
      gross,
      refunds,
      net,
      orders: periods.reduce((n, p) => n + p.orders, 0),
      customers,
      arpu: customers ? round2(net / customers) : 0,
      mrr: last?.mrr ?? 0,
      arr: last?.arr ?? 0,
      netNewMrr: sum('netNewMrr'),
      revenueChurn: avgRevenueChurn,
      ltv,
    },
    breakdown,
    topCustomers,
    unconverted,
    summary: parts.join(' '),
    sql: Object.values(sql),
    range: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() },
  };
}
