/**
 * Funnel correlation: what converters do (or are) that people who drop off
 * don't, and the reverse.
 *
 * Converters are actors whose best attempt reached the last step; drop-offs
 * entered but didn't. For each candidate — another event done during the
 * attempt, or a value of a property of the first step — we count how many of
 * each group have it and compute the odds ratio, with half-counts added
 * (Haldane–Anscombe) so zero cells don't explode, and a χ² test on the 2×2
 * table. An odds ratio above 1 goes with converting; below 1, with dropping off.
 */

import { SYSTEM_EVENTS } from '../events.ts';
import type { Filter } from '../filters.ts';
import { breakdownExpr } from '../sql/filters.ts';
import { eventsCte, num, parseAggregation, text } from '../sql/source.ts';
import { chiSquareSurvival } from '../stats/tests.ts';
import { iso, parseDuration, resolveRange } from '../time.ts';
import { funnelChain } from './funnel.ts';
import type { FunnelCorrelationSpec } from './schemas.ts';
import { fmt, type QueryContext, type ResultBase } from './types.ts';

export interface CorrelationItem {
  /** The event name, or "property = value". */
  name: string;
  event?: string;
  property?: string;
  value?: string;
  /** Converters / drop-offs that have it. */
  successCount: number;
  failureCount: number;
  /** Conversion rate among actors that have it. */
  conversionRate: number;
  oddsRatio: number;
  pValue: number;
  significant: boolean;
}

export interface FunnelCorrelationResult extends ResultBase {
  kind: 'funnel_correlation';
  correlation: 'events' | 'properties';
  converters: number;
  dropOffs: number;
  /** Most associated with converting, strongest first. */
  success: CorrelationItem[];
  /** Most associated with dropping off, strongest first. */
  failure: CorrelationItem[];
}

/** Bookkeeping events say nothing about behaviour. */
const IGNORED_EVENTS = new Set<string>([
  SYSTEM_EVENTS.pageleave,
  SYSTEM_EVENTS.webVitals,
  SYSTEM_EVENTS.identify,
  SYSTEM_EVENTS.set,
  SYSTEM_EVENTS.groupIdentify,
]);

/** Odds ratio and χ² p-value for "has it" vs "converted" over a 2×2 table. */
export function scoreCorrelation(
  successWith: number,
  failureWith: number,
  successTotal: number,
  failureTotal: number,
): { oddsRatio: number; pValue: number } {
  const a = successWith;
  const b = failureWith;
  const c = Math.max(0, successTotal - successWith);
  const e = Math.max(0, failureTotal - failureWith);
  const oddsRatio = ((a + 0.5) * (e + 0.5)) / ((b + 0.5) * (c + 0.5));
  const n = a + b + c + e;
  const denom = (a + b) * (c + e) * (a + c) * (b + e);
  const chi = denom > 0 ? (n * (a * e - b * c) ** 2) / denom : 0;
  return { oddsRatio, pValue: denom > 0 ? chiSquareSurvival(chi, 1) : 1 };
}

export async function runFunnelCorrelation(
  spec: FunnelCorrelationSpec,
  ctx: QueryContext,
): Promise<FunnelCorrelationResult> {
  const d = ctx.dialect;
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const windowMs = parseDuration(spec.window ?? '7d');
  const aggregation = parseAggregation(spec.aggregateBy);
  const n = spec.steps.length;
  const correlation = spec.correlation ?? 'events';
  const limit = spec.limit ?? 10;
  const unordered = (spec.order ?? 'ordered') === 'unordered';
  const conv = `CASE WHEN f.reach >= ${n} THEN 1 ELSE 0 END`;
  const sql: string[] = [];
  type Row = {
    name: string;
    event?: string;
    property?: string;
    value?: string;
    s: number;
    f: number;
  };
  const rows: Row[] = [];
  let successTotal = 0;
  let failureTotal = 0;

  const totalsFrom = async (head: string) => {
    const q = `${head}SELECT SUM(${conv}) AS s, SUM(1 - ${conv}) AS f FROM f`;
    sql.push(q);
    const [r] = await ctx.execute(q);
    successTotal = num(r?.s);
    failureTotal = num(r?.f);
  };

  if (correlation === 'events') {
    const head = funnelChain(spec, ctx, range, windowMs, { bd: "''", extra: [], aggregation });
    await totalsFrom(head);
    const skip = new Set([
      ...IGNORED_EVENTS,
      ...spec.steps.map((s) => s.event),
      ...(spec.exclude ?? []),
    ]);
    const all = eventsCte(d, {
      project: ctx.project,
      from: range.from,
      to: range.to + windowMs,
      filters: spec.filters as Filter[] | undefined,
      aggregation,
      name: 'ea',
    });
    // During the attempt: from step 1 to converting, or to the end of the window.
    const end = unordered ? 'f.tend' : `f.t${n}`;
    const q = `${head.replace(/\n$/, '')},
${all}
SELECT event, SUM(conv) AS s, SUM(1 - conv) AS f FROM (
  SELECT DISTINCT f.actor, ${conv} AS conv, a.event FROM f JOIN ea a
    ON a.actor = f.actor AND a.ts_ms >= f.t1 AND a.ts_ms <= COALESCE(${end}, f.t1 + ${d.num(windowMs)})
) x GROUP BY event ORDER BY s + f DESC LIMIT 500`;
    sql.push(q);
    for (const r of await ctx.execute(q)) {
      const event = text(r.event);
      if (skip.has(event)) continue;
      rows.push({ name: event, event, s: num(r.s), f: num(r.f) });
    }
  } else {
    const properties = spec.properties ?? [];
    if (properties.length === 0) {
      throw new TypeError(
        'correlation "properties" needs properties, e.g. ["person.plan", "browser"].',
      );
    }
    let first = true;
    for (const property of properties) {
      const head = funnelChain(
        { ...spec, breakdownAttribution: 'first_touch' },
        ctx,
        range,
        windowMs,
        {
          bd: breakdownExpr([property], d),
          extra: [],
          aggregation,
        },
      );
      if (first) {
        await totalsFrom(head);
        first = false;
      }
      const q = `${head}SELECT f.bd AS value, SUM(${conv}) AS s, SUM(1 - ${conv}) AS f FROM f GROUP BY f.bd ORDER BY s + f DESC LIMIT 200`;
      sql.push(q);
      for (const r of await ctx.execute(q)) {
        const value = text(r.value);
        rows.push({ name: `${property} = ${value}`, property, value, s: num(r.s), f: num(r.f) });
      }
    }
  }

  const items: CorrelationItem[] = rows
    // Too rare to say anything.
    .filter((r) => r.s + r.f >= 3)
    .map((r) => {
      const { oddsRatio, pValue } = scoreCorrelation(r.s, r.f, successTotal, failureTotal);
      return {
        name: r.name,
        ...(r.event ? { event: r.event } : {}),
        ...(r.property ? { property: r.property, value: r.value } : {}),
        successCount: r.s,
        failureCount: r.f,
        conversionRate: r.s / (r.s + r.f),
        oddsRatio,
        pValue,
        significant: pValue < 0.05,
      };
    });
  const success = items
    .filter((i) => i.oddsRatio > 1)
    .sort((a, b) => b.oddsRatio - a.oddsRatio)
    .slice(0, limit);
  const failure = items
    .filter((i) => i.oddsRatio < 1)
    .sort((a, b) => a.oddsRatio - b.oddsRatio)
    .slice(0, limit);
  const top = success.find((i) => i.significant);
  const bottom = failure.find((i) => i.significant);
  return {
    kind: 'funnel_correlation',
    correlation,
    converters: successTotal,
    dropOffs: failureTotal,
    success,
    failure,
    sql,
    range: { from: iso(range.from), to: iso(range.to) },
    summary:
      successTotal + failureTotal === 0
        ? 'No one entered this funnel in the range.'
        : `${fmt(successTotal)} converted, ${fmt(failureTotal)} dropped off. ` +
          (top
            ? `Most associated with converting: ${top.name} (${top.oddsRatio.toFixed(1)}× the odds). `
            : 'Nothing is significantly associated with converting. ') +
          (bottom
            ? `With dropping off: ${bottom.name} (${(1 / bottom.oddsRatio).toFixed(1)}× the odds of dropping).`
            : ''),
  };
}
