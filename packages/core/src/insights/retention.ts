/**
 * Retention: of the people who first did X in each period, how many did Y in
 * each later period?
 *
 * A person's cohort is the period of their first `cohortEvent` inside the range.
 * Period 0 is the cohort itself (100% by definition); period k counts people who
 * did `returnEvent` k periods later. Return events are counted up to `periods`
 * periods after the range ends (or now, whichever is sooner).
 */

import { filtersSql } from '../sql/filters.ts';
import { bucketExpr, eventsCte, fixedIntervalMs, num } from '../sql/source.ts';
import { addMonths, DAY_MS, iso, resolveRange } from '../time.ts';
import type { RetentionSpec } from './schemas.ts';
import { fmt, type QueryContext, type ResultBase } from './types.ts';

export interface RetentionCohort {
  /** Cohort period start, epoch ms. */
  start: number;
  size: number;
  /** People retained in period 0..periods (index 0 equals `size`). */
  counts: number[];
  rates: number[];
}

export interface RetentionResult extends ResultBase {
  kind: 'retention';
  period: 'day' | 'week' | 'month';
  periods: number;
  cohorts: RetentionCohort[];
  /** Size-weighted mean retention per period, over cohorts old enough to have that period. */
  average: number[];
}

export function compileRetention(
  spec: RetentionSpec,
  ctx: QueryContext,
  range: { from: number; to: number },
): string {
  const d = ctx.dialect;
  const period = spec.period ?? 'week';
  const periods = spec.periods ?? 8;
  const now = ctx.now ?? Date.now();
  const horizon =
    period === 'month'
      ? addMonths(range.to, periods + 1)
      : range.to + (periods + 1) * fixedIntervalMs(period);
  const cte = eventsCte(d, {
    project: ctx.project,
    from: range.from,
    to: Math.min(horizon, now + DAY_MS),
    events: [spec.cohortEvent.event, spec.returnEvent.event],
    filters: spec.filters,
  });
  const off = spec.utcOffsetMinutes ?? 0;
  // Month buckets are compared by month index (year*12+month), others by bucket start ms.
  const key = (ts: string) =>
    period === 'month'
      ? d.monthIndex(off ? `(${ts} + ${off * 60_000})` : ts)
      : bucketExpr(d, ts, period, off);
  const step = period === 'month' ? 1 : fixedIntervalMs(period);
  const diff = `(a.abucket - c.cbucket) / ${step}`;
  return `WITH ${cte},
first_seen AS (
  SELECT pid, MIN(ts_ms) AS t0
  FROM ev
  WHERE event = ${d.str(spec.cohortEvent.event)} AND ts_ms < ${d.num(range.to)} AND ${filtersSql(spec.cohortEvent.filters, d)}
  GROUP BY pid
),
c AS (SELECT pid, ${key('t0')} AS cbucket FROM first_seen),
a AS (
  SELECT DISTINCT pid, ${key('ts_ms')} AS abucket
  FROM ev
  WHERE event = ${d.str(spec.returnEvent.event)} AND ${filtersSql(spec.returnEvent.filters, d)}
)
SELECT c.cbucket AS cohort, ${diff} AS k, COUNT(DISTINCT c.pid) AS n
FROM c JOIN a ON a.pid = c.pid
WHERE a.abucket > c.cbucket AND ${diff} <= ${d.num(periods)}
GROUP BY c.cbucket, ${diff}
UNION ALL
SELECT cbucket AS cohort, 0 AS k, COUNT(*) AS n FROM c GROUP BY cbucket`;
}

export async function runRetention(
  spec: RetentionSpec,
  ctx: QueryContext,
): Promise<RetentionResult> {
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const period = spec.period ?? 'week';
  const periods = spec.periods ?? 8;
  const now = ctx.now ?? Date.now();
  const off = (spec.utcOffsetMinutes ?? 0) * 60_000;
  const sql = compileRetention(spec, ctx, range);
  const rows = await ctx.execute(sql);

  const toStart = (cohort: number) =>
    period === 'month' ? Date.UTC(Math.floor(cohort / 12), cohort % 12, 1) - off : cohort;
  const byCohort = new Map<number, number[]>();
  for (const row of rows) {
    const cohort = num(row.cohort);
    const k = num(row.k);
    if (k < 0 || k > periods) continue;
    const counts = byCohort.get(cohort) ?? new Array<number>(periods + 1).fill(0);
    counts[k] = num(row.n);
    byCohort.set(cohort, counts);
  }

  const elapsedPeriods = (start: number) =>
    period === 'month'
      ? (new Date(now).getUTCFullYear() - new Date(start).getUTCFullYear()) * 12 +
        (new Date(now).getUTCMonth() - new Date(start).getUTCMonth())
      : Math.floor((now - start) / fixedIntervalMs(period));

  const cohorts: RetentionCohort[] = [...byCohort.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cohort, counts]) => {
      const size = counts[0] ?? 0;
      return {
        start: toStart(cohort),
        size,
        counts,
        rates: counts.map((c) => (size ? c / size : 0)),
      };
    });

  const average = Array.from({ length: periods + 1 }, (_, k) => {
    const eligible = cohorts.filter((c) => elapsedPeriods(c.start) >= k && c.size > 0);
    const people = eligible.reduce((a, c) => a + c.size, 0);
    return people ? eligible.reduce((a, c) => a + (c.counts[k] ?? 0), 0) / people : 0;
  });

  const total = cohorts.reduce((a, c) => a + c.size, 0);
  return {
    kind: 'retention',
    period,
    periods,
    cohorts,
    average,
    sql: [sql],
    range: { from: iso(range.from), to: iso(range.to) },
    summary:
      total === 0
        ? `No one did "${spec.cohortEvent.event}" in this range.`
        : `${fmt(total)} people in ${cohorts.length} ${period}ly cohorts. ` +
          `Average retention: ${period} 1 ${fmt(average[1] ?? 0, 'percent')}` +
          (periods >= 4 ? `, ${period} 4 ${fmt(average[4] ?? 0, 'percent')}` : '') +
          `.`,
  };
}
