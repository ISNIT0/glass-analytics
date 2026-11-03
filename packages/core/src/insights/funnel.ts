/**
 * Funnels: how many people complete an ordered sequence of events.
 *
 * Compiles to chained CTEs, one per step, with no window functions (they are
 * budget-gated in Basin SQL and unnecessary here). Step k keeps, per person, the
 * first occurrence of its event strictly after step k-1 and within `window` of
 * step 1. The breakdown value is read from the step-1 event.
 */

import { breakdownExpr, filtersSql } from '../sql/filters.ts';
import { eventsCte, num, text } from '../sql/source.ts';
import { iso, parseDuration, resolveRange } from '../time.ts';
import type { FunnelSpec } from './schemas.ts';
import { type QueryContext, type ResultBase, fmt } from './types.ts';

export interface FunnelStepResult {
  label: string;
  event: string;
  count: number;
  /** Share of step 1 that reached this step. */
  conversionFromStart: number;
  /** Share of the previous step that reached this step. */
  conversionFromPrevious: number;
  /** Mean seconds from the previous step, for people who reached this step. */
  avgSecondsFromPrevious: number | null;
}

export interface FunnelResult extends ResultBase {
  kind: 'funnel';
  windowSeconds: number;
  steps: FunnelStepResult[];
  /** Present when the spec has a breakdown: one funnel per value. */
  breakdowns?: { value: string; steps: FunnelStepResult[] }[];
}

export function compileFunnel(spec: FunnelSpec, ctx: QueryContext, range: { from: number; to: number }, windowMs: number): string {
  const d = ctx.dialect;
  const steps = spec.steps;
  const cte = eventsCte(d, {
    project: ctx.project,
    from: range.from,
    // Later steps may complete after the range ends, but never after the window closes.
    to: range.to + windowMs,
    events: steps.map((s) => s.event),
    filters: spec.filters,
  });
  const ctes: string[] = [cte];

  const first = steps[0]!;
  ctes.push(`s1 AS (
  SELECT pid, MIN(ts_ms) AS t1
  FROM ev
  WHERE event = ${d.str(first.event)} AND ts_ms < ${d.num(range.to)} AND ${filtersSql(first.filters, d)}
  GROUP BY pid
)`);

  if (spec.breakdown) {
    ctes.push(`b AS (
  SELECT s1.pid, MIN(${breakdownExpr(spec.breakdown, d, 'ev')}) AS bd
  FROM s1 JOIN ev ON ev.pid = s1.pid AND ev.ts_ms = s1.t1
  WHERE ev.event = ${d.str(first.event)} AND ${filtersSql(first.filters, d, 'ev')}
  GROUP BY s1.pid
)`);
  }

  for (let k = 2; k <= steps.length; k++) {
    const step = steps[k - 1]!;
    const prev = `s${k - 1}`;
    const carried = Array.from({ length: k - 1 }, (_, i) => `${prev}.t${i + 1}`);
    ctes.push(`s${k} AS (
  SELECT ${prev}.pid, ${carried.join(', ')}, MIN(ev.ts_ms) AS t${k}
  FROM ${prev} JOIN ev ON ev.pid = ${prev}.pid
  WHERE ev.event = ${d.str(step.event)}
    AND ev.ts_ms > ${prev}.t${k - 1}
    AND ev.ts_ms <= ${prev}.t1 + ${d.num(windowMs)}
    AND ${filtersSql(step.filters, d, 'ev')}
  GROUP BY ${prev}.pid, ${carried.join(', ')}
)`);
  }

  const bdSelect = spec.breakdown ? `COALESCE(b.bd, '(none)')` : `''`;
  const bdJoin = (s: string) => (spec.breakdown ? ` LEFT JOIN b ON b.pid = ${s}.pid` : '');
  const bdGroup = spec.breakdown ? ` GROUP BY COALESCE(b.bd, '(none)')` : '';
  const selects = steps.map((_, i) => {
    const k = i + 1;
    const s = `s${k}`;
    const dt = k === 1 ? '0' : `SUM(${s}.t${k} - ${s}.t${k - 1})`;
    return `SELECT ${k} AS step, ${bdSelect} AS bd, COUNT(*) AS n, ${dt} AS dt_ms FROM ${s}${bdJoin(s)}${bdGroup}`;
  });
  return `WITH ${ctes.join(',\n')}\n${selects.join('\nUNION ALL\n')}`;
}

function shapeSteps(spec: FunnelSpec, counts: Map<number, { n: number; dt: number }>): FunnelStepResult[] {
  const firstCount = counts.get(1)?.n ?? 0;
  return spec.steps.map((step, i) => {
    const c = counts.get(i + 1) ?? { n: 0, dt: 0 };
    const prev = i === 0 ? c.n : (counts.get(i)?.n ?? 0);
    return {
      label: step.label ?? step.event,
      event: step.event,
      count: c.n,
      conversionFromStart: firstCount ? c.n / firstCount : 0,
      conversionFromPrevious: prev ? c.n / prev : 0,
      avgSecondsFromPrevious: i === 0 || c.n === 0 ? null : c.dt / c.n / 1000,
    };
  });
}

export async function runFunnel(spec: FunnelSpec, ctx: QueryContext): Promise<FunnelResult> {
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const windowMs = parseDuration(spec.window ?? '7d');
  const sql = compileFunnel(spec, ctx, range, windowMs);
  const rows = await ctx.execute(sql);

  // Aggregate rows into per-breakdown step counts.
  const byValue = new Map<string, Map<number, { n: number; dt: number }>>();
  for (const row of rows) {
    const value = text(row.bd);
    const steps = byValue.get(value) ?? new Map();
    steps.set(num(row.step), { n: num(row.n), dt: num(row.dt_ms) });
    byValue.set(value, steps);
  }

  const total = new Map<number, { n: number; dt: number }>();
  for (const steps of byValue.values()) {
    for (const [k, c] of steps) {
      const t = total.get(k) ?? { n: 0, dt: 0 };
      total.set(k, { n: t.n + c.n, dt: t.dt + c.dt });
    }
  }

  const result: FunnelResult = {
    kind: 'funnel',
    windowSeconds: windowMs / 1000,
    steps: shapeSteps(spec, total),
    sql: [sql],
    range: { from: iso(range.from), to: iso(range.to) },
    summary: '',
  };

  if (spec.breakdown) {
    const limit = spec.breakdownLimit ?? 10;
    const ranked = [...byValue.entries()].sort((a, b) => (b[1].get(1)?.n ?? 0) - (a[1].get(1)?.n ?? 0));
    const top = ranked.slice(0, limit).map(([value, steps]) => ({ value, steps: shapeSteps(spec, steps) }));
    const rest = ranked.slice(limit);
    if (rest.length > 0) {
      const other = new Map<number, { n: number; dt: number }>();
      for (const [, steps] of rest) {
        for (const [k, c] of steps) {
          const t = other.get(k) ?? { n: 0, dt: 0 };
          other.set(k, { n: t.n + c.n, dt: t.dt + c.dt });
        }
      }
      top.push({ value: 'Other', steps: shapeSteps(spec, other) });
    }
    result.breakdowns = top;
  }

  const s = result.steps;
  const last = s[s.length - 1]!;
  const worst = s.slice(1).reduce((w, step) => (step.conversionFromPrevious < w.conversionFromPrevious ? step : w), s[1]!);
  const people = (n: number) => `${fmt(n)} ${n === 1 ? 'person' : 'people'}`;
  result.summary =
    s[0]!.count === 0
      ? `No one did "${s[0]!.label}" in this range.`
      : `${people(s[0]!.count)} started; ${fmt(last.count)} completed (${fmt(last.conversionFromStart, 'percent')}). ` +
        (worst.conversionFromPrevious < 1
          ? `Biggest drop-off: into "${worst.label}" (${fmt(worst.conversionFromPrevious, 'percent')} of the previous step).`
          : 'No drop-off between steps.');
  return result;
}
