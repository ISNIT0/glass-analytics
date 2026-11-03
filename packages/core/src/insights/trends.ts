/**
 * Trends: an aggregate of events per time bucket, optionally broken down by a property.
 */

import { breakdownExpr, filtersSql, propertyNumber } from '../sql/filters.ts';
import { bucketExpr, eventsCte, num, text } from '../sql/source.ts';
import { type Interval, bucketsBetween, iso, resolveRange } from '../time.ts';
import type { TrendsSpec } from './schemas.ts';
import { type QueryContext, type ResultBase, fmt } from './types.ts';

export interface TrendsSeries {
  label: string;
  /** Breakdown value, or null when the query has no breakdown. */
  breakdown: string | null;
  /** One value per bucket, aligned with `buckets`. */
  values: number[];
  /** Total over the range. For unique counts this is the number of distinct persons/sessions, not a sum. */
  total: number;
}

export interface TrendsResult extends ResultBase {
  kind: 'trends';
  interval: Interval;
  /** Bucket starts, epoch ms. */
  buckets: number[];
  series: TrendsSeries[];
}

type Series = TrendsSpec['series'][number];

function aggregate(series: Series): string {
  switch (series.math ?? 'total') {
    case 'total':
      return 'COUNT(*)';
    case 'unique_persons':
      return 'COUNT(DISTINCT pid)';
    case 'unique_sessions':
      return 'COUNT(DISTINCT session_id)';
    case 'sum':
      return 'SUM(val)';
    case 'avg':
      return 'AVG(val)';
  }
}

function seriesLabel(s: Series): string {
  if (s.label) return s.label;
  const math = s.math ?? 'total';
  if (math === 'total') return s.event;
  return `${s.event} (${math}${s.property ? ` of ${s.property}` : ''})`;
}

/** Compile the per-bucket query and the range-total query for one series. */
export function compileTrendsSeries(spec: TrendsSpec, series: Series, ctx: QueryContext, range: { from: number; to: number }) {
  const d = ctx.dialect;
  const interval = spec.interval ?? 'day';
  const math = series.math ?? 'total';
  if ((math === 'sum' || math === 'avg') && !series.property) {
    throw new TypeError(`Series "${series.event}" uses math "${math}" but has no "property".`);
  }
  const cte = eventsCte(d, {
    project: ctx.project,
    from: range.from,
    to: range.to,
    events: series.event === '*' ? undefined : [series.event],
    filters: spec.filters,
  });
  const bd = spec.breakdown ? breakdownExpr(spec.breakdown, d) : "''";
  const val = series.property ? propertyNumber(series.property, d) : 'NULL';
  const inner = `SELECT ${bucketExpr(d, 'ts_ms', interval, spec.utcOffsetMinutes)} AS bucket, ${bd} AS bd, pid, session_id, ${val} AS val
    FROM ev WHERE ${filtersSql(series.filters, d)}`;
  const perBucket = `WITH ${cte}
SELECT bucket, bd, ${aggregate(series)} AS agg
FROM (${inner}) t
GROUP BY bucket, bd
ORDER BY bucket
LIMIT 50000`;
  const totals = `WITH ${cte}
SELECT bd, ${aggregate(series)} AS agg
FROM (${inner}) t
GROUP BY bd
ORDER BY agg DESC
LIMIT 1000`;
  return { perBucket, totals };
}

export async function runTrends(spec: TrendsSpec, ctx: QueryContext): Promise<TrendsResult> {
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const interval = spec.interval ?? 'day';
  const buckets = bucketsBetween(range, interval, spec.utcOffsetMinutes);
  const index = new Map(buckets.map((b, i) => [b, i]));
  const limit = spec.breakdownLimit ?? 10;
  const sql: string[] = [];
  const out: TrendsSeries[] = [];

  const compiled = spec.series.map((s) => compileTrendsSeries(spec, s, ctx, range));
  const results = await Promise.all(
    compiled.map(async (c) => {
      sql.push(c.perBucket, c.totals);
      const [rows, totals] = await Promise.all([ctx.execute(c.perBucket), ctx.execute(c.totals)]);
      return { rows, totals };
    }),
  );

  spec.series.forEach((series, i) => {
    const { rows, totals } = results[i]!;
    const label = seriesLabel(series);
    const ranked = totals.map((r) => ({ bd: text(r.bd), value: num(r.agg) }));
    const keep = new Set(ranked.slice(0, limit).map((r) => r.bd));
    const additive = (series.math ?? 'total') === 'total' || series.math === 'sum';
    const byValue = new Map<string, number[]>();
    for (const row of rows) {
      const raw = text(row.bd);
      const key = keep.has(raw) ? raw : additive ? 'Other' : null;
      if (key === null) continue;
      const slot = index.get(num(row.bucket));
      if (slot === undefined) continue;
      const values = byValue.get(key) ?? new Array<number>(buckets.length).fill(0);
      values[slot] = (values[slot] ?? 0) + num(row.agg);
      byValue.set(key, values);
    }
    const totalFor = (key: string) =>
      key === 'Other'
        ? ranked.filter((r) => !keep.has(r.bd)).reduce((a, r) => a + r.value, 0)
        : (ranked.find((r) => r.bd === key)?.value ?? 0);
    const keys = spec.breakdown ? [...keep, ...(byValue.has('Other') ? ['Other'] : [])] : [''];
    for (const key of keys) {
      out.push({
        label: spec.breakdown ? `${label} · ${key}` : label,
        breakdown: spec.breakdown ? key : null,
        values: byValue.get(key) ?? new Array<number>(buckets.length).fill(0),
        total: totalFor(key),
      });
    }
  });

  const head = out
    .slice(0, 5)
    .map((s) => `${s.label}: ${fmt(s.total, Number.isInteger(s.total) ? 'count' : 'decimal')}`)
    .join('; ');
  return {
    kind: 'trends',
    interval,
    buckets,
    series: out,
    sql,
    range: { from: iso(range.from), to: iso(range.to) },
    summary: `${iso(range.from).slice(0, 10)} to ${iso(range.to).slice(0, 10)} by ${interval}. ${head || 'No data.'}`,
  };
}
