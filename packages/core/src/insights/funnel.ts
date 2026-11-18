/**
 * Funnels: how many people (or sessions, or groups) complete a sequence of events.
 *
 * Every step-1 event in the range starts an attempt. For each attempt, step k is
 * the first matching event after the step before it (skipping optional steps that
 * weren't done) and within `window` of step 1. Each actor keeps their best
 * attempt: the one that got furthest, then the earliest. That is how PostHog
 * counts, and it means someone who tried twice and converted the second time
 * counts as converted.
 *
 * Orders:
 * - ordered: other events may happen between steps;
 * - strict: each step must be the very next event (Dataflare's own bookkeeping
 *   events such as $pageleave and $web_vitals don't count as "in between");
 * - unordered: the steps may happen in any order within the window.
 *
 * Exclusions drop attempts where an event happened between two steps. All of it
 * compiles to chained CTEs with joins and GROUP BY — no window functions, which
 * are budget-gated in Basin SQL.
 */

import { SYSTEM_EVENTS } from '../events.ts';
import type { Filter } from '../filters.ts';
import { breakdownExpr, breakdownProperties, filtersSql } from '../sql/filters.ts';
import { type SketchCell, sketchColumns, sketchHistogram, sketchQuantile } from '../sql/sketch.ts';
import {
  type Aggregation,
  actorNoun,
  bucketExpr,
  eventsCte,
  num,
  parseAggregation,
  text,
} from '../sql/source.ts';
import {
  bucketsBetween,
  type Interval,
  iso,
  parseDuration,
  resolveRange,
  type TimeRange,
} from '../time.ts';
import {
  type CohortBreakdown,
  isCohortBreakdown,
  type NumericBin,
  numericBins,
} from './breakdowns.ts';
import type { FunnelSpec } from './schemas.ts';
import { fmt, type QueryContext, type ResultBase, zoneOf } from './types.ts';
import { defaultInterval } from './web.ts';

export interface FunnelStepResult {
  label: string;
  event: string;
  optional?: boolean;
  count: number;
  /** Share of step 1 that reached this step. */
  conversionFromStart: number;
  /** Share of the previous step that reached this step. */
  conversionFromPrevious: number;
  /** Mean seconds from the previous step, for actors who reached this step. */
  avgSecondsFromPrevious: number | null;
  /** Median seconds from the previous step (1% accuracy). */
  medianSecondsFromPrevious: number | null;
}

export interface FunnelResult extends ResultBase {
  kind: 'funnel';
  order: 'ordered' | 'strict' | 'unordered';
  windowSeconds: number;
  /** What was counted: "person", "session" or a group type. */
  aggregateBy: string;
  steps: FunnelStepResult[];
  /** Present when the spec has a breakdown: one funnel per value. */
  breakdowns?: { value: string; steps: FunnelStepResult[] }[];
  bins?: NumericBin[];
  /** viz "time_to_convert". */
  timeToConvert?: {
    fromStep: number;
    toStep: number;
    converters: number;
    averageSeconds: number | null;
    medianSeconds: number | null;
    histogram: { fromSeconds: number; toSeconds: number; count: number }[];
  };
  /** viz "trends": conversion by when actors entered. */
  trend?: {
    interval: Interval;
    buckets: number[];
    fromStep: number;
    toStep: number;
    series: { breakdown: string | null; entered: number[]; converted: number[]; rate: number[] }[];
  };
}

type Spec = FunnelSpec & { cohortBreakdown?: CohortBreakdown[] };

/** Events Dataflare records about itself, which don't break a strict funnel. */
const BOOKKEEPING = [
  SYSTEM_EVENTS.pageleave,
  SYSTEM_EVENTS.webVitals,
  SYSTEM_EVENTS.exposure,
  SYSTEM_EVENTS.identify,
  SYSTEM_EVENTS.set,
  SYSTEM_EVENTS.groupIdentify,
];

interface ChainOptions {
  bd: string;
  extra: Filter[];
  aggregation: Aggregation;
}

function validate(spec: Spec): void {
  const n = spec.steps.length;
  if (spec.steps[0]!.optional) throw new TypeError('The first funnel step cannot be optional.');
  const order = spec.order ?? 'ordered';
  if (order === 'unordered') {
    if (spec.exclusions?.length)
      throw new TypeError('Exclusions need an ordered or strict funnel.');
    if (spec.steps.some((s) => s.optional))
      throw new TypeError('Unordered funnels have no optional steps.');
    const a = spec.breakdownAttribution;
    if (a !== undefined && a !== 'first_touch') {
      throw new TypeError(
        'Unordered funnels take the breakdown from the first event (first_touch).',
      );
    }
  }
  for (const x of spec.exclusions ?? []) {
    if (x.fromStep >= x.toStep || x.toStep > n) {
      throw new RangeError(`Exclusion "${x.event}" needs 1 <= fromStep < toStep <= ${n}.`);
    }
  }
  const attribution = spec.breakdownAttribution;
  if (typeof attribution === 'number' && attribution > n) {
    throw new RangeError(`breakdownAttribution ${attribution} is past the last step (${n}).`);
  }
}

/** The time of the step before step k that was actually done (optional steps may be skipped). */
function prevExpr(spec: Spec, k: number, alias: string): string {
  if (k <= 2) return `${alias}.t1`;
  const before = spec.steps[k - 2]!;
  return before.optional
    ? `COALESCE(${alias}.t${k - 1}, ${prevExpr(spec, k - 1, alias)})`
    : `${alias}.t${k - 1}`;
}

/** Required steps before k must all have happened. */
function aliveExpr(spec: Spec, k: number, alias: string): string[] {
  const out: string[] = [];
  for (let j = 2; j < k; j++)
    if (!spec.steps[j - 1]!.optional) out.push(`${alias}.t${j} IS NOT NULL`);
  return out;
}

const tCols = (n: number, alias?: string) =>
  Array.from({ length: n }, (_, i) => `${alias ? `${alias}.` : ''}t${i + 1}`);

/**
 * The CTE chain ending in `f`: one row per actor with their best attempt —
 * `actor`, `bd` (breakdown value), `t1`…`tn` (step times, NULL when not reached;
 * unordered funnels also have `tend`), and `reach`, the furthest step.
 */
export function funnelChain(
  input: FunnelSpec,
  ctx: QueryContext,
  range: TimeRange,
  windowMs: number,
  o: ChainOptions,
): string {
  const spec = input as Spec;
  validate(spec);
  const d = ctx.dialect;
  const n = spec.steps.length;
  const order = spec.order ?? 'ordered';
  const W = d.num(windowMs);
  const names = [...spec.steps.map((s) => s.event), ...(spec.exclusions ?? []).map((x) => x.event)];
  const events = order === 'strict' || names.includes('*') ? undefined : names;
  const ev = eventsCte(d, {
    project: ctx.project,
    from: range.from,
    // Later steps may complete after the range ends, but never after the window closes.
    to: range.to + windowMs,
    events,
    filters: [...((spec.filters as Filter[] | undefined) ?? []), ...o.extra],
    aggregation: o.aggregation,
  });
  const cond = (event: string, filters: Filter[] | undefined) =>
    `${event === '*' ? '1 = 1' : `event = ${d.str(event)}`} AND ${filtersSql(filters, d)}`;
  const flags = [
    ...spec.steps.map(
      (s, i) => `CASE WHEN ${cond(s.event, s.filters as Filter[])} THEN 1 ELSE 0 END AS m${i + 1}`,
    ),
    ...(spec.exclusions ?? []).map(
      (x, i) => `CASE WHEN ${cond(x.event, x.filters as Filter[])} THEN 1 ELSE 0 END AS x${i + 1}`,
    ),
    order === 'strict'
      ? `CASE WHEN event IN (${BOOKKEEPING.map((e) => d.str(e)).join(', ')}) THEN 1 ELSE 0 END AS noise`
      : '0 AS noise',
  ];
  const ctes: string[] = [
    ev,
    `evb AS (SELECT actor, ts_ms, event, ${o.bd} AS bd, ${flags.join(', ')} FROM ev)`,
  ];
  const inRange = `ts_ms < ${d.num(range.to)}`;
  const reachCase = (alias = '') =>
    `CASE ${Array.from({ length: n - 1 }, (_, i) => `WHEN ${alias}t${n - i} IS NOT NULL THEN ${n - i}`).join(' ')} ELSE 1 END`;

  if (order === 'unordered') {
    const any = spec.steps.map((_, i) => `m${i + 1} = 1`).join(' OR ');
    ctes.push(
      `c AS (SELECT DISTINCT actor, ts_ms AS t1, bd AS bd1 FROM evb WHERE (${any}) AND ${inRange})`,
    );
    const firsts = spec.steps.map(
      (_, i) => `MIN(CASE WHEN e.m${i + 1} = 1 THEN e.ts_ms END) AS u${i + 1}`,
    );
    ctes.push(`u AS (
  SELECT c.actor, c.bd1, c.t1, ${firsts.join(', ')}
  FROM c LEFT JOIN evb e ON e.actor = c.actor AND e.ts_ms >= c.t1 AND e.ts_ms <= c.t1 + ${W}
  GROUP BY c.actor, c.bd1, c.t1
)`);
    const done = spec.steps
      .map((_, i) => `(CASE WHEN u${i + 1} IS NULL THEN 0 ELSE 1 END)`)
      .join(' + ');
    const uCols = spec.steps.map((_, i) => `u${i + 1}`);
    ctes.push(
      `r AS (SELECT actor, bd1, t1, ${uCols.join(', ')}, ${d.greatest(uCols)} AS tend, ${done} AS reach FROM u)`,
    );
  } else {
    ctes.push(
      `s1 AS (SELECT DISTINCT actor, ts_ms AS t1, bd AS bd1 FROM evb WHERE m1 = 1 AND ${inRange})`,
    );
    for (let k = 2; k <= n; k++) {
      const carried = ['p.actor', 'p.bd1', ...tCols(k - 1, 'p')];
      const join = [
        'e.actor = p.actor',
        `e.m${k} = 1`,
        `e.ts_ms > ${prevExpr(spec, k, 'p')}`,
        `e.ts_ms <= p.t1 + ${W}`,
        ...aliveExpr(spec, k, 'p'),
        ...(spec.breakdownAttribution === 'all_steps' ? ['e.bd = p.bd1'] : []),
      ];
      const raw = order === 'strict' ? `s${k}r` : `s${k}`;
      ctes.push(`${raw} AS (
  SELECT ${carried.join(', ')}, MIN(e.ts_ms) AS t${k}
  FROM s${k - 1} p LEFT JOIN evb e ON ${join.join(' AND ')}
  GROUP BY ${carried.join(', ')}
)`);
      if (order === 'strict') {
        // Any other (non-bookkeeping) event between the previous step and this one breaks it.
        ctes.push(`b${k} AS (
  SELECT DISTINCT r.actor, r.t1 FROM s${k}r r JOIN evb e
    ON e.actor = r.actor AND e.noise = 0 AND e.ts_ms > ${prevExpr(spec, k, 'r')} AND e.ts_ms < r.t${k}
)`);
        ctes.push(`s${k} AS (
  SELECT r.actor, r.bd1, ${tCols(k - 1, 'r').join(', ')}, CASE WHEN b.actor IS NULL THEN r.t${k} END AS t${k}
  FROM s${k}r r LEFT JOIN b${k} b ON b.actor = r.actor AND b.t1 = r.t1
)`);
      }
    }
    const last = `s${n}`;
    if (spec.exclusions?.length) {
      const any = spec.exclusions
        .map(
          (x, i) =>
            `(e.x${i + 1} = 1 AND e.ts_ms > p.t${x.fromStep} AND e.ts_ms < COALESCE(p.t${x.toStep}, p.t1 + ${W}))`,
        )
        .join(' OR ');
      ctes.push(
        `xb AS (SELECT DISTINCT p.actor, p.t1 FROM ${last} p JOIN evb e ON e.actor = p.actor AND (${any}))`,
      );
      ctes.push(`r AS (
  SELECT p.actor, p.bd1, ${tCols(n, 'p').join(', ')}, ${reachCase('p.')} AS reach
  FROM ${last} p LEFT JOIN xb ON xb.actor = p.actor AND xb.t1 = p.t1
  WHERE xb.actor IS NULL
)`);
    } else {
      ctes.push(
        `r AS (SELECT actor, bd1, ${tCols(n).join(', ')}, ${reachCase()} AS reach FROM ${last})`,
      );
    }
  }
  // Each actor's best attempt: the furthest, then the earliest.
  ctes.push('best AS (SELECT actor, MAX(reach) AS reach FROM r GROUP BY actor)');
  ctes.push(
    'pick AS (SELECT r.actor, MIN(r.t1) AS t1 FROM r JOIN best b ON b.actor = r.actor AND b.reach = r.reach GROUP BY r.actor)',
  );
  ctes.push('f0 AS (SELECT r.* FROM r JOIN pick k ON k.actor = r.actor AND k.t1 = r.t1)');

  const attribution = spec.breakdownAttribution ?? 'first_touch';
  if (order === 'unordered') {
    ctes.push('f AS (SELECT f0.actor, f0.bd1 AS bd, f0.t1, f0.reach, f0.tend FROM f0)');
  } else if (attribution === 'first_touch' || attribution === 'all_steps') {
    ctes.push(
      `f AS (SELECT f0.actor, f0.bd1 AS bd, ${tCols(n, 'f0').join(', ')}, f0.reach FROM f0)`,
    );
  } else {
    // The breakdown value of the event at the last step reached, or at a given step.
    const step = attribution === 'last_touch' ? null : attribution;
    const at =
      step === null
        ? `CASE f0.reach ${tCols(n, 'f0')
            .map((t, i) => `WHEN ${i + 1} THEN ${t}`)
            .join(' ')} END`
        : `f0.t${step}`;
    const match =
      step === null
        ? `(CASE f0.reach ${Array.from({ length: n }, (_, i) => `WHEN ${i + 1} THEN e.m${i + 1}`).join(' ')} END) = 1`
        : `e.m${step} = 1`;
    ctes.push(
      `fl AS (SELECT f0.actor, MIN(e.bd) AS bd FROM f0 JOIN evb e ON e.actor = f0.actor AND e.ts_ms = ${at} AND ${match} GROUP BY f0.actor)`,
    );
    const fallback = step === null ? 'f0.bd1' : `'(none)'`;
    ctes.push(
      `f AS (SELECT f0.actor, COALESCE(fl.bd, ${fallback}) AS bd, ${tCols(n, 'f0').join(', ')}, f0.reach FROM f0 LEFT JOIN fl ON fl.actor = f0.actor)`,
    );
  }
  return `WITH ${ctes.join(',\n')}\n`;
}

/** Whether actor row `f` reached step k (SQL). */
function reached(spec: Spec, k: number, alias = 'f'): string {
  if (k === 1) return '1 = 1';
  return (spec.order ?? 'ordered') === 'unordered'
    ? `${alias}.reach >= ${k}`
    : `${alias}.t${k} IS NOT NULL`;
}

/** Seconds from the previous step to step k (SQL, ms), NULL when not reached. */
function stepDuration(spec: Spec, k: number, alias = 'f'): string {
  if ((spec.order ?? 'ordered') === 'unordered') {
    return k === spec.steps.length ? `(${alias}.tend - ${alias}.t1)` : 'NULL';
  }
  return `(${alias}.t${k} - ${prevExpr(spec, k, alias)})`;
}

/** Duration between two steps (ms) for actors who did both. */
function spanDuration(spec: Spec, from: number, to: number, alias = 'f'): string {
  if ((spec.order ?? 'ordered') === 'unordered') return `(${alias}.tend - ${alias}.t1)`;
  return `(${alias}.t${to} - ${alias}.t${from})`;
}

/** Kept for callers that only want the SQL (CLI `--sql`, tests): the per-breakdown step counts. */
export function compileFunnel(
  spec: FunnelSpec,
  ctx: QueryContext,
  range: { from: number; to: number },
  windowMs: number,
): string[] {
  const breakdowns = breakdownProperties(spec.breakdown);
  const bd = breakdowns.length ? breakdownExpr(breakdowns, ctx.dialect) : "''";
  return [
    stepsSql(spec as Spec, ctx, range, windowMs, {
      bd,
      extra: [],
      aggregation: parseAggregation(spec.aggregateBy),
    }),
  ];
}

function stepsSql(
  spec: Spec,
  ctx: QueryContext,
  range: TimeRange,
  windowMs: number,
  o: ChainOptions,
): string {
  const n = spec.steps.length;
  const cols: string[] = ['COUNT(*) AS n1'];
  for (let k = 2; k <= n; k++) {
    cols.push(`SUM(CASE WHEN ${reached(spec, k)} THEN 1 ELSE 0 END) AS n${k}`);
    const dur = stepDuration(spec, k);
    cols.push(
      dur === 'NULL'
        ? `0 AS dt${k}`
        : `SUM(CASE WHEN ${reached(spec, k)} THEN ${dur} ELSE 0 END) AS dt${k}`,
    );
  }
  return `${funnelChain(spec, ctx, range, windowMs, o)}SELECT f.bd AS bd, ${cols.join(', ')} FROM f GROUP BY f.bd`;
}

function mediansSql(
  spec: Spec,
  ctx: QueryContext,
  range: TimeRange,
  windowMs: number,
  o: ChainOptions,
): string {
  const d = ctx.dialect;
  const n = spec.steps.length;
  const ks = Array.from({ length: n - 1 }, (_, i) => i + 2);
  const dur = `CASE v.column1 ${ks.map((k) => `WHEN ${k} THEN ${stepDuration(spec, k)}`).join(' ')} END`;
  const sk = sketchColumns(d, 'dur');
  return `${funnelChain(spec, ctx, range, windowMs, o)}SELECT k, bd, ${sk.sign} AS sign, ${sk.key} AS key, COUNT(*) AS n FROM (
  SELECT v.column1 AS k, f.bd AS bd, ${dur} AS dur FROM f CROSS JOIN (VALUES ${ks.map((k) => `(${k})`).join(', ')}) v
) x WHERE dur IS NOT NULL GROUP BY k, bd, ${sk.sign}, ${sk.key}`;
}

function shapeSteps(
  spec: Spec,
  counts: Map<number, { n: number; dt: number }>,
  medians: Map<number, SketchCell[]>,
): FunnelStepResult[] {
  const firstCount = counts.get(1)?.n ?? 0;
  return spec.steps.map((step, i) => {
    const c = counts.get(i + 1) ?? { n: 0, dt: 0 };
    const prev = i === 0 ? c.n : (counts.get(i)?.n ?? 0);
    const unordered = (spec.order ?? 'ordered') === 'unordered';
    const timed = i > 0 && c.n > 0 && (!unordered || i === spec.steps.length - 1);
    const median = timed ? sketchQuantile(medians.get(i + 1) ?? [], 0.5) : null;
    return {
      label: step.label ?? step.event,
      event: step.event,
      ...(step.optional ? { optional: true } : {}),
      count: c.n,
      conversionFromStart: firstCount ? c.n / firstCount : 0,
      conversionFromPrevious: prev ? c.n / prev : 0,
      avgSecondsFromPrevious: timed ? c.dt / c.n / 1000 : null,
      medianSecondsFromPrevious: median === null ? null : median / 1000,
    };
  });
}

interface FunnelPart {
  o: ChainOptions;
}

async function partsFor(spec: Spec, ctx: QueryContext, range: TimeRange, aggregation: Aggregation) {
  const d = ctx.dialect;
  const breakdowns = breakdownProperties(spec.breakdown);
  const sql: string[] = [];
  let bins: NumericBin[] | undefined;
  let parts: FunnelPart[];
  if (isCohortBreakdown(breakdowns)) {
    if (!spec.cohortBreakdown?.length) {
      throw new TypeError(
        'breakdown "cohort" needs breakdownCohorts: saved cohort keys (list_cohorts).',
      );
    }
    parts = spec.cohortBreakdown.map((c) => ({
      o: { bd: d.str(c.label), extra: [c.filter], aggregation },
    }));
  } else if (breakdowns.length === 1 && spec.breakdownBins) {
    const b = await numericBins(ctx, range, {
      events: spec.steps.map((s) => s.event),
      filters: spec.filters as Filter[] | undefined,
      aggregation,
      property: breakdowns[0]!,
      bins: spec.breakdownBins,
    });
    sql.push(b.sql);
    bins = b.bins;
    parts = [{ o: { bd: b.expr, extra: [], aggregation } }];
  } else {
    const bd = breakdowns.length ? breakdownExpr(breakdowns, d) : "''";
    parts = [{ o: { bd, extra: [], aggregation } }];
  }
  return { parts, bins, sql, breakdowns };
}

export async function runFunnel(input: FunnelSpec, ctx: QueryContext): Promise<FunnelResult> {
  const spec = input as Spec;
  validate(spec);
  const d = ctx.dialect;
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const windowMs = parseDuration(spec.window ?? '7d');
  const aggregation = parseAggregation(spec.aggregateBy);
  const n = spec.steps.length;
  const order = spec.order ?? 'ordered';
  const viz = spec.viz ?? 'steps';
  const { parts, bins, sql, breakdowns } = await partsFor(spec, ctx, range, aggregation);

  const byValue = new Map<string, Map<number, { n: number; dt: number }>>();
  const medianCells = new Map<string, Map<number, SketchCell[]>>();
  const fromStep = spec.fromStep ?? 1;
  const toStep = spec.toStep ?? n;
  if (fromStep >= toStep || toStep > n) {
    throw new RangeError(`fromStep and toStep need 1 <= fromStep < toStep <= ${n}.`);
  }
  if (order === 'unordered' && (fromStep !== 1 || toStep !== n) && viz !== 'steps') {
    throw new TypeError('Unordered funnels measure from the first step done to the last.');
  }
  const ttc = { cells: [] as SketchCell[], total: 0, count: 0 };
  const trendRows: { bucket: number; bd: string; entered: number; converted: number }[] = [];
  const interval = spec.interval ?? defaultInterval(range);
  const zone = zoneOf(spec, ctx, range);

  await Promise.all(
    parts.map(async ({ o }) => {
      const stepsQuery = stepsSql(spec, ctx, range, windowMs, o);
      const mediansQuery = mediansSql(spec, ctx, range, windowMs, o);
      sql.push(stepsQuery, mediansQuery);
      const queries: Promise<Record<string, unknown>[]>[] = [
        ctx.execute(stepsQuery),
        ctx.execute(mediansQuery),
      ];
      const head = funnelChain(spec, ctx, range, windowMs, o);
      let ttcQuery: string | null = null;
      let trendQuery: string | null = null;
      if (viz === 'time_to_convert') {
        const sk = sketchColumns(d, 'dur');
        ttcQuery = `${head}SELECT ${sk.sign} AS sign, ${sk.key} AS key, COUNT(*) AS n, SUM(dur) AS total FROM (
  SELECT ${spanDuration(spec, fromStep, toStep)} AS dur FROM f WHERE ${reached(spec, fromStep)} AND ${reached(spec, toStep)}
) x WHERE dur IS NOT NULL GROUP BY ${sk.sign}, ${sk.key}`;
        sql.push(ttcQuery);
        queries.push(ctx.execute(ttcQuery));
      }
      if (viz === 'trends') {
        trendQuery = `${head}SELECT ${bucketExpr(d, 'f.t1', interval, zone)} AS bucket, f.bd AS bd, COUNT(*) AS entered,
  SUM(CASE WHEN ${reached(spec, toStep)} THEN 1 ELSE 0 END) AS converted
FROM f WHERE ${reached(spec, fromStep)} GROUP BY ${bucketExpr(d, 'f.t1', interval, zone)}, f.bd`;
        sql.push(trendQuery);
        queries.push(ctx.execute(trendQuery));
      }
      const [stepRows, medianRows, ...rest] = await Promise.all(queries);
      for (const row of stepRows!) {
        const value = text(row.bd);
        const steps = byValue.get(value) ?? new Map();
        for (let k = 1; k <= n; k++)
          steps.set(k, { n: num(row[`n${k}`]), dt: k === 1 ? 0 : num(row[`dt${k}`]) });
        byValue.set(value, steps);
      }
      for (const row of medianRows!) {
        const value = text(row.bd);
        const m = medianCells.get(value) ?? new Map<number, SketchCell[]>();
        const k = num(row.k);
        const list = m.get(k) ?? [];
        list.push({ sign: num(row.sign), key: num(row.key), n: num(row.n) });
        m.set(k, list);
        medianCells.set(value, m);
      }
      let i = 0;
      if (ttcQuery) {
        for (const row of rest[i++]!) {
          ttc.cells.push({ sign: num(row.sign), key: num(row.key), n: num(row.n) });
          ttc.total += num(row.total);
          ttc.count += num(row.n);
        }
      }
      if (trendQuery) {
        for (const row of rest[i++]!) {
          trendRows.push({
            bucket: num(row.bucket),
            bd: text(row.bd),
            entered: num(row.entered),
            converted: num(row.converted),
          });
        }
      }
    }),
  );

  const total = new Map<number, { n: number; dt: number }>();
  for (const steps of byValue.values()) {
    for (const [k, c] of steps) {
      const t = total.get(k) ?? { n: 0, dt: 0 };
      total.set(k, { n: t.n + c.n, dt: t.dt + c.dt });
    }
  }
  const mergeCells = (maps: Map<number, SketchCell[]>[]) => {
    const out = new Map<number, SketchCell[]>();
    for (const m of maps) for (const [k, cells] of m) out.set(k, [...(out.get(k) ?? []), ...cells]);
    return out;
  };
  const result: FunnelResult = {
    kind: 'funnel',
    order,
    windowSeconds: windowMs / 1000,
    aggregateBy: typeof aggregation === 'object' ? aggregation.group : aggregation,
    steps: shapeSteps(spec, total, mergeCells([...medianCells.values()])),
    sql,
    range: { from: iso(range.from), to: iso(range.to) },
    summary: '',
  };
  if (bins) result.bins = bins;

  if (breakdowns.length) {
    const fixedOrder = bins
      ? [...bins.map((b) => b.label), '(none)']
      : spec.cohortBreakdown?.length && isCohortBreakdown(breakdowns)
        ? spec.cohortBreakdown.map((c) => c.label)
        : null;
    const shape = (value: string, steps: Map<number, { n: number; dt: number }>) => ({
      value,
      steps: shapeSteps(spec, steps, medianCells.get(value) ?? new Map()),
    });
    if (fixedOrder) {
      result.breakdowns = fixedOrder
        .filter((v) => byValue.has(v))
        .map((v) => shape(v, byValue.get(v)!));
    } else {
      const limit = spec.breakdownLimit ?? 10;
      const ranked = [...byValue.entries()].sort(
        (a, b) => (b[1].get(1)?.n ?? 0) - (a[1].get(1)?.n ?? 0),
      );
      const top = ranked.slice(0, limit).map(([value, steps]) => shape(value, steps));
      const rest = ranked.slice(limit);
      if (rest.length > 0) {
        const other = new Map<number, { n: number; dt: number }>();
        for (const [, steps] of rest) {
          for (const [k, c] of steps) {
            const t = other.get(k) ?? { n: 0, dt: 0 };
            other.set(k, { n: t.n + c.n, dt: t.dt + c.dt });
          }
        }
        top.push({
          value: 'Other',
          steps: shapeSteps(
            spec,
            other,
            mergeCells(rest.map(([v]) => medianCells.get(v) ?? new Map())),
          ),
        });
      }
      result.breakdowns = top;
    }
  }

  if (viz === 'time_to_convert') {
    const median = sketchQuantile(ttc.cells, 0.5);
    result.timeToConvert = {
      fromStep,
      toStep,
      converters: ttc.count,
      averageSeconds: ttc.count ? ttc.total / ttc.count / 1000 : null,
      medianSeconds: median === null ? null : median / 1000,
      histogram: sketchHistogram(ttc.cells, 15).map((b) => ({
        fromSeconds: b.from / 1000,
        toSeconds: b.to / 1000,
        count: b.count,
      })),
    };
  }
  if (viz === 'trends') {
    const buckets = bucketsBetween(range, interval, zone);
    const index = new Map(buckets.map((b, i) => [b, i]));
    const keys = breakdowns.length ? [...new Set(trendRows.map((r) => r.bd))] : [''];
    result.trend = {
      interval,
      buckets,
      fromStep,
      toStep,
      series: keys.map((key) => {
        const entered = new Array<number>(buckets.length).fill(0);
        const converted = new Array<number>(buckets.length).fill(0);
        for (const r of trendRows.filter((x) => x.bd === key)) {
          const slot = index.get(r.bucket);
          if (slot === undefined) continue;
          entered[slot]! += r.entered;
          converted[slot]! += r.converted;
        }
        return {
          breakdown: breakdowns.length ? key : null,
          entered,
          converted,
          rate: entered.map((e, i) => (e ? converted[i]! / e : 0)),
        };
      }),
    };
  }

  const s = result.steps;
  const last = s[s.length - 1]!;
  const worst = s
    .slice(1)
    .reduce(
      (w, step) => (step.conversionFromPrevious < w.conversionFromPrevious ? step : w),
      s[1]!,
    );
  const who = (count: number) => `${fmt(count)} ${actorNoun(aggregation, count)}`;
  const median = last.medianSecondsFromPrevious;
  result.summary =
    s[0]!.count === 0
      ? `No one did "${s[0]!.label}" in this range.`
      : `${who(s[0]!.count)} started; ${fmt(last.count)} completed (${fmt(last.conversionFromStart, 'percent')})${order === 'ordered' ? '' : ` [${order}]`}. ` +
        (worst.conversionFromPrevious < 1
          ? `Biggest drop-off: into "${worst.label}" (${fmt(worst.conversionFromPrevious, 'percent')} of the previous step).`
          : 'No drop-off between steps.') +
        (median !== null ? ` Median time into the last step: ${formatSeconds(median)}.` : '') +
        (result.timeToConvert?.medianSeconds != null
          ? ` Median time to convert: ${formatSeconds(result.timeToConvert.medianSeconds)}.`
          : '');
  return result;
}

export function formatSeconds(s: number): string {
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

// ── Drill-down ───────────────────────────────────────────────────────────────

/**
 * The actors who reached a step (status "converted"), or reached the step before
 * it but not it ("dropped"). SQL selecting `actor` and `n` (always 1).
 */
export function compileFunnelActors(
  input: FunnelSpec,
  ctx: QueryContext,
  selection: { step?: number; status?: 'converted' | 'dropped'; breakdown?: string },
  page: { limit: number; offset: number },
): string {
  const spec = input as Spec;
  const d = ctx.dialect;
  const n = spec.steps.length;
  const step = selection.step ?? n;
  if (step < 1 || step > n) throw new RangeError(`step must be between 1 and ${n}.`);
  const status = selection.status ?? 'converted';
  if (status === 'dropped' && step === 1)
    throw new RangeError('No one drops off before the first step; use step 2 or later.');
  const range = resolveRange(spec.from, spec.to, ctx.now);
  const windowMs = parseDuration(spec.window ?? '7d');
  const aggregation = parseAggregation(spec.aggregateBy);
  const breakdowns = breakdownProperties(spec.breakdown);
  let o: ChainOptions = {
    bd: breakdowns.length && !isCohortBreakdown(breakdowns) ? breakdownExpr(breakdowns, d) : "''",
    extra: [],
    aggregation,
  };
  if (isCohortBreakdown(breakdowns) && selection.breakdown !== undefined) {
    const c = spec.cohortBreakdown?.find(
      (x) => x.label === selection.breakdown || x.key === selection.breakdown,
    );
    if (c) o = { ...o, bd: d.str(c.label), extra: [c.filter] };
  }
  const where = [
    status === 'converted'
      ? reached(spec, step)
      : `${reached(spec, step - 1)} AND NOT (${reached(spec, step)})`,
  ];
  if (selection.breakdown !== undefined && breakdowns.length && !isCohortBreakdown(breakdowns)) {
    where.push(`f.bd = ${d.str(selection.breakdown)}`);
  }
  return `${funnelChain(spec, ctx, range, windowMs, o)}SELECT f.actor AS actor, 1 AS n FROM f WHERE ${where.join(' AND ')}
ORDER BY f.actor LIMIT ${d.num(page.limit)} OFFSET ${d.num(page.offset)}`;
}
