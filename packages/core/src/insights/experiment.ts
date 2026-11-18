/**
 * Experiment readout.
 *
 * An actor (a person, or a group for group experiments) enters at their first
 * exposure to the flag: a `$exposure` the SDK logs when a variant is shown, or a
 * custom exposure event, whose `flags` column holds the variant. Actors exposed to
 * more than one variant are left out (or kept on their first, if asked) — a high
 * count means the flag is read inconsistently.
 *
 * Every metric is measured per exposed actor, after their exposure:
 *
 * - conversion: did the event (within a window) — a rate;
 * - mean: how many times they did it, or the sum of a property (winsorised if asked);
 * - ratio: Σ numerator / Σ denominator across actors (e.g. revenue per order), with a
 *   delta-method standard error;
 * - funnel: completed the steps in order after exposure — a rate;
 * - retention: came back in a window after exposure — a rate, over actors exposed
 *   long enough ago.
 *
 * Engines: Bayesian (default) reports the probability each variant beats control
 * and is best of all, with credible intervals; frequentist reports p-values and
 * confidence intervals. A winner needs the first primary metric to clear the
 * confidence level, no sample ratio mismatch, the minimum runtime and the minimum
 * exposures per variant.
 */

import { SYSTEM_EVENTS } from '../events.ts';
import type { Filter } from '../filters.ts';
import { filtersSql, propertyNumber } from '../sql/filters.ts';
import { exactQuantile, type SketchCell, sketchColumns, sketchQuantile } from '../sql/sketch.ts';
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
  type BayesComparison,
  type Comparison,
  compareEstimates,
  compareMeans,
  compareProportions,
  type MeanComparison,
  meanAndError,
  probabilityToBeBestBeta,
  probabilityToBeBestNormal,
  ratioAndError,
  type SrmResult,
  sampleRatioMismatch,
  sampleSizeForMean,
  sampleSizeForRate,
  wilson,
  zFor,
} from '../stats/tests.ts';
import { DAY_MS, iso, parseDuration, resolveRange } from '../time.ts';
import type { ExperimentMetric, ExperimentSpec } from './schemas.ts';
import { fmt, type QueryContext, type ResultBase, zoneOf } from './types.ts';

export interface MetricVariant {
  variant: string;
  exposures: number;
  /** Rate metrics: actors who converted. */
  conversions?: number;
  /** The variant's value: a rate, a mean per actor, or a ratio. */
  value: number;
  /** Interval of the value at the experiment's confidence. */
  interval: [number, number];
  /** Comparison to control; null for control itself. */
  vsControl: Comparison | null;
  /** P(this variant is the best of all), Bayesian. */
  probabilityToBeBest: number;
}

export interface MetricResult {
  name: string;
  kind: ExperimentMetric['kind'];
  goal: 'increase' | 'decrease';
  variants: MetricVariant[];
  /** Best variant at the confidence level, or null. */
  significantVariant: string | null;
  /** For winsorised means: the bounds values were clamped to. */
  winsorized?: { lower: number | null; upper: number | null };
  /** Daily cumulative values by variant, for the primary metric. */
  timeline?: { days: number[]; variants: Record<string, number[]> };
}

/** Kept for the original readout shape (and the dashboard): conversion on the first primary metric. */
export interface VariantResult {
  variant: string;
  exposures: number;
  conversions: number;
  conversionRate: number;
  rateInterval: [number, number];
  vsControl: BayesComparison | null;
  /** Present when the goal has a `value` property. */
  mean: { value: number; vsControl: MeanComparison | null } | null;
}

export interface ExperimentResult extends ResultBase {
  kind: 'experiment';
  flag: string;
  goal: string;
  engine: 'bayesian' | 'frequentist';
  confidence: number;
  aggregateBy: string;
  variants: VariantResult[];
  /** Primary metrics; the first decides the winner. */
  metrics: MetricResult[];
  secondary: MetricResult[];
  /** People exposed to more than one variant (excluded). */
  excludedMultipleVariants: number;
  srm: SrmResult;
  /** Best variant on the first primary metric when the experiment can call it. */
  winner: string | null;
  /** Why there is no winner yet, when there isn't. */
  status: 'winner' | 'no_winner_yet' | 'too_early' | 'srm' | 'no_data';
  daysRunning: number;
  /** Estimated days until a `mde` change is detectable at the current exposure rate. */
  estimatedDaysToSignificance: number | null;
}

type Spec = ExperimentSpec & {
  startedAt?: number;
  /**
   * Holdout results: compare people in a holdout ("holdout") with everyone exposed to any of
   * these flags otherwise ("experiments").
   */
  holdoutFlags?: string[];
  /** Planning: everyone doing the exposure event counts as one group ("all"). */
  baseline?: boolean;
};

const FLAG_VARIANT = (d: QueryContext['dialect'], flag: string) => d.jsonText('ev.flags', [flag]);

/** The metrics a spec measures, with the simple `goal` form turned into metrics. */
export function metricsOf(spec: ExperimentSpec): {
  primary: ExperimentMetric[];
  secondary: ExperimentMetric[];
} {
  const primary: ExperimentMetric[] = [...(spec.metrics ?? [])];
  if (spec.goal) {
    primary.unshift({
      kind: 'conversion',
      event: spec.goal.event,
      filters: spec.goal.filters,
      name: spec.goal.label,
    });
    if (spec.goal.value) {
      primary.push({
        kind: 'mean',
        event: spec.goal.event,
        filters: spec.goal.filters,
        math: 'sum',
        property: spec.goal.value,
        name: `${spec.goal.value} per person`,
      });
    }
  }
  if (primary.length === 0)
    throw new TypeError('An experiment needs a goal or at least one metric.');
  return { primary, secondary: [...(spec.secondary ?? [])] };
}

function metricName(m: ExperimentMetric): string {
  if (m.name) return m.name;
  switch (m.kind) {
    case 'conversion':
      return `${m.event} conversion`;
    case 'mean':
      return m.math === 'sum' ? `${m.property} per person` : `${m.event} per person`;
    case 'ratio':
      return `${m.numerator.event} / ${m.denominator.event}`;
    case 'funnel':
      return `${m.steps.map((s) => s.event).join(' → ')} funnel`;
    case 'retention':
      return `${m.event} retention`;
  }
}

function metricEvents(m: ExperimentMetric): string[] {
  switch (m.kind) {
    case 'ratio':
      return [m.numerator.event, m.denominator.event];
    case 'funnel':
      return m.steps.map((s) => s.event);
    default:
      return [m.event];
  }
}

interface Head {
  sql: string;
  aggregation: Aggregation;
}

/**
 * The shared CTEs: `ev` (the events every metric needs) and `xe` (one row per exposed actor:
 * actor, t0 first exposure, variant), plus `x` (all exposed, with how many variants each saw).
 */
function exposureHead(
  spec: Spec,
  ctx: QueryContext,
  range: { from: number; to: number },
  metrics: ExperimentMetric[],
): Head {
  const d = ctx.dialect;
  const aggregation = parseAggregation(spec.aggregateBy);
  const exposureEvent = spec.exposure?.event ?? SYSTEM_EVENTS.exposure;
  const names = [exposureEvent, ...metrics.flatMap(metricEvents)];
  const events = names.includes('*') ? undefined : names;
  const maxWindow = Math.max(
    0,
    ...metrics.map((m) => (m.kind === 'retention' ? parseDuration(m.to ?? '8d') : 0)),
  );
  const now = ctx.now ?? Date.now();
  const cte = eventsCte(d, {
    project: ctx.project,
    from: range.from,
    to: Math.min(range.to + maxWindow, now + DAY_MS),
    events,
    filters: spec.filters as Filter[] | undefined,
    aggregation,
  });
  const viaExposure = exposureEvent === SYSTEM_EVENTS.exposure && !spec.exposure?.event;
  const flagProp = d.jsonText('ev.props', ['flag']);
  const variantProp = d.jsonText('ev.props', ['variant']);
  let variant = viaExposure ? variantProp : FLAG_VARIANT(d, spec.flag);
  let exposureCond = viaExposure
    ? `ev.event = ${d.str(SYSTEM_EVENTS.exposure)} AND ${flagProp} = ${d.str(spec.flag)}`
    : `ev.event = ${d.str(exposureEvent)}`;
  if (spec.holdoutFlags) {
    exposureCond = `ev.event = ${d.str(SYSTEM_EVENTS.exposure)} AND ${flagProp} IN (${spec.holdoutFlags.map((f) => d.str(f)).join(', ')})`;
    variant = `(CASE WHEN ${variantProp} = 'holdout' THEN 'holdout' WHEN ${variantProp} IS NULL OR ${variantProp} = '' THEN NULL ELSE 'experiments' END)`;
  } else if (spec.baseline) {
    exposureCond = `${exposureEvent === '*' ? '1 = 1' : `ev.event = ${d.str(exposureEvent)}`}`;
    variant = "'all'";
  }
  const firstSeen = spec.exposure?.multipleVariants === 'first_seen';
  const sql = `WITH ${cte},
xr AS (
  SELECT ev.actor AS actor, ev.ts_ms AS ts_ms, ${variant} AS variant FROM ev
  WHERE ${exposureCond} AND ev.ts_ms < ${d.num(range.to)} AND ${filtersSql(spec.exposure?.filters as Filter[] | undefined, d, 'ev')}
    AND ${variant} IS NOT NULL AND ${variant} <> ''
),
x AS (SELECT actor, MIN(ts_ms) AS t0, COUNT(DISTINCT variant) AS nv, MIN(variant) AS anyv FROM xr GROUP BY actor),
${
  firstSeen
    ? `xf AS (SELECT x.actor, MIN(xr.variant) AS variant FROM x JOIN xr ON xr.actor = x.actor AND xr.ts_ms = x.t0 GROUP BY x.actor),
xe AS (SELECT x.actor, x.t0, xf.variant FROM x JOIN xf ON xf.actor = x.actor)`
    : 'xe AS (SELECT actor, t0, anyv AS variant FROM x WHERE nv = 1)'
}`;
  return { sql, aggregation };
}

function eventCond(e: { event: string; filters?: unknown[] }, d: QueryContext['dialect']): string {
  return `${e.event === '*' ? '1 = 1' : `ev.event = ${d.str(e.event)}`} AND ${filtersSql(e.filters as Filter[] | undefined, d, 'ev')}`;
}

/** Per-actor value of a count/sum leg, as a CTE body: actor, v. */
function perActorValue(
  leg: { event: string; filters?: unknown[]; math?: 'count' | 'sum'; property?: string },
  d: QueryContext['dialect'],
): string {
  if ((leg.math ?? 'count') === 'sum' && !leg.property) {
    throw new TypeError(`A "sum" metric on ${leg.event} needs a property.`);
  }
  const v =
    (leg.math ?? 'count') === 'sum'
      ? `COALESCE(${propertyNumber(leg.property!, d, 'ev')}, 0)`
      : '1';
  return `SELECT xe.actor, SUM(${v}) AS v FROM xe JOIN ev ON ev.actor = xe.actor AND ev.ts_ms >= xe.t0 AND ${eventCond(leg, d)} GROUP BY xe.actor`;
}

/** SQL for the set of converted actors (binomial metrics), as a CTE body selecting `actor`. */
function convertedSql(
  m: ExperimentMetric,
  d: QueryContext['dialect'],
): { ctes: string[]; set: string } {
  if (m.kind === 'conversion') {
    const within =
      m.within === undefined ? '' : ` AND ev.ts_ms <= xe.t0 + ${d.num(parseDuration(m.within))}`;
    return {
      ctes: [
        `mc AS (SELECT DISTINCT xe.actor FROM xe JOIN ev ON ev.actor = xe.actor AND ev.ts_ms >= xe.t0${within} AND ${eventCond(m, d)})`,
      ],
      set: 'mc',
    };
  }
  if (m.kind === 'retention') {
    const from = parseDuration(m.from ?? '1d');
    const to = parseDuration(m.to ?? '8d');
    return {
      ctes: [
        `mc AS (SELECT DISTINCT xe.actor FROM xe JOIN ev ON ev.actor = xe.actor AND ev.ts_ms >= xe.t0 + ${d.num(from)} AND ev.ts_ms < xe.t0 + ${d.num(to)} AND ${eventCond(m, d)})`,
      ],
      set: 'mc',
    };
  }
  if (m.kind === 'funnel') {
    const w = d.num(parseDuration(m.window ?? '7d'));
    const ctes = [
      `f1 AS (SELECT xe.actor, MIN(ev.ts_ms) AS t1 FROM xe JOIN ev ON ev.actor = xe.actor AND ev.ts_ms >= xe.t0 AND ${eventCond(m.steps[0]!, d)} GROUP BY xe.actor)`,
    ];
    // Each step: the first matching event after the previous one, within the window of step 1.
    for (let k = 2; k <= m.steps.length; k++) {
      ctes.push(
        `f${k} AS (SELECT p.actor, p.t1, MIN(ev.ts_ms) AS t${k} FROM f${k - 1} p JOIN ev ON ev.actor = p.actor AND ev.ts_ms > p.t${k - 1} AND ev.ts_ms <= p.t1 + ${w} AND ${eventCond(m.steps[k - 1]!, d)} GROUP BY p.actor, p.t1)`,
      );
    }
    ctes.push(`mc AS (SELECT DISTINCT actor FROM f${m.steps.length})`);
    return { ctes, set: 'mc' };
  }
  throw new TypeError(`${m.kind} is not a rate metric`);
}

interface VariantStats {
  variant: string;
  n: number;
  /** Rate: conversions. Mean: Σv. Ratio: Σx. */
  a: number;
  /** Mean: Σv². Ratio: Σy. */
  b: number;
  c: number;
  dd: number;
  e: number;
}

const isRate = (m: ExperimentMetric) =>
  m.kind === 'conversion' || m.kind === 'funnel' || m.kind === 'retention';

async function measure(
  m: ExperimentMetric,
  head: Head,
  ctx: QueryContext,
  sql: string[],
  now: number,
): Promise<{
  stats: VariantStats[];
  winsorized?: { lower: number | null; upper: number | null };
  timelineSql: string;
}> {
  const d = ctx.dialect;
  const day = (ts: string) => bucketExpr(d, ts, 'day', zoneOf({}, ctx, { from: 0, to: now }));
  if (isRate(m)) {
    const { ctes } = convertedSql(m, d);
    // Retention needs actors exposed long enough ago to have had the whole window.
    const eligible =
      m.kind === 'retention'
        ? `WHERE xe.t0 + ${d.num(parseDuration(m.to ?? '8d'))} <= ${d.num(now)}`
        : '';
    const q = `${head.sql},
${ctes.join(',\n')}
SELECT xe.variant AS variant, COUNT(*) AS n, SUM(CASE WHEN mc.actor IS NULL THEN 0 ELSE 1 END) AS a
FROM xe LEFT JOIN mc ON mc.actor = xe.actor ${eligible} GROUP BY xe.variant`;
    sql.push(q);
    const rows = await ctx.execute(q);
    return {
      stats: rows.map((r) => ({
        variant: text(r.variant),
        n: num(r.n),
        a: num(r.a),
        b: 0,
        c: 0,
        dd: 0,
        e: 0,
      })),
      timelineSql: `${head.sql},
${ctes.join(',\n')}
SELECT ${day('xe.t0')} AS day, xe.variant AS variant, COUNT(*) AS n, SUM(CASE WHEN mc.actor IS NULL THEN 0 ELSE 1 END) AS a
FROM xe LEFT JOIN mc ON mc.actor = xe.actor ${eligible} GROUP BY ${day('xe.t0')}, xe.variant`,
    };
  }
  if (m.kind === 'mean') {
    const base = `${head.sql},
mv AS (${perActorValue(m, d)}),
vals AS (SELECT xe.actor, xe.t0, xe.variant, COALESCE(mv.v, 0) AS v FROM xe LEFT JOIN mv ON mv.actor = xe.actor)`;
    let value = 'v';
    let winsorized: { lower: number | null; upper: number | null } | undefined;
    if (m.winsorize && (m.winsorize.lower !== undefined || m.winsorize.upper !== undefined)) {
      // Per-actor counts are exact; sums of a property go through the sketch.
      const sk = sketchColumns(d, 'v');
      const q =
        (m.math ?? 'count') === 'count'
          ? `${base}\nSELECT 0 AS sign, v AS k, COUNT(*) AS n FROM vals GROUP BY v`
          : `${base}\nSELECT ${sk.sign} AS sign, ${sk.key} AS k, COUNT(*) AS n FROM vals GROUP BY ${sk.sign}, ${sk.key}`;
      sql.push(q);
      const cells = (await ctx.execute(q)).map((r) => ({
        sign: num(r.sign),
        key: num(r.k),
        n: num(r.n),
      }));
      const quantile = (p: number) =>
        (m.math ?? 'count') === 'count'
          ? exactQuantile(
              cells.map((c) => ({ value: c.key, n: c.n })),
              p,
            )
          : sketchQuantile(cells as SketchCell[], p);
      const lower = m.winsorize.lower !== undefined ? quantile(m.winsorize.lower / 100) : null;
      const upper = m.winsorize.upper !== undefined ? quantile(m.winsorize.upper / 100) : null;
      winsorized = { lower, upper };
      // No values yet means nothing to clamp.
      const clamps = [
        ...(lower !== null ? [`WHEN v < ${d.num(lower)} THEN ${d.num(lower)}`] : []),
        ...(upper !== null ? [`WHEN v > ${d.num(upper)} THEN ${d.num(upper)}`] : []),
      ];
      if (clamps.length) value = `(CASE ${clamps.join(' ')} ELSE v END)`;
    }
    const q = `${base}
SELECT variant, COUNT(*) AS n, SUM(${value}) AS a, SUM(${value} * ${value}) AS b FROM vals GROUP BY variant`;
    sql.push(q);
    const rows = await ctx.execute(q);
    return {
      stats: rows.map((r) => ({
        variant: text(r.variant),
        n: num(r.n),
        a: num(r.a),
        b: num(r.b),
        c: 0,
        dd: 0,
        e: 0,
      })),
      ...(winsorized ? { winsorized } : {}),
      timelineSql: `${base}
SELECT ${day('t0')} AS day, variant, COUNT(*) AS n, SUM(${value}) AS a, SUM(${value} * ${value}) AS b FROM vals GROUP BY ${day('t0')}, variant`,
    };
  }
  // Ratio.
  const base = `${head.sql},
mn AS (${perActorValue(m.numerator, d)}),
md AS (${perActorValue(m.denominator, d)}),
vals AS (
  SELECT xe.actor, xe.t0, xe.variant, COALESCE(mn.v, 0) AS x, COALESCE(md.v, 0) AS y
  FROM xe LEFT JOIN mn ON mn.actor = xe.actor LEFT JOIN md ON md.actor = xe.actor
)`;
  const q = `${base}
SELECT variant, COUNT(*) AS n, SUM(x) AS a, SUM(y) AS b, SUM(x * x) AS c, SUM(y * y) AS dd, SUM(x * y) AS e FROM vals GROUP BY variant`;
  sql.push(q);
  const rows = await ctx.execute(q);
  return {
    stats: rows.map((r) => ({
      variant: text(r.variant),
      n: num(r.n),
      a: num(r.a),
      b: num(r.b),
      c: num(r.c),
      dd: num(r.dd),
      e: num(r.e),
    })),
    timelineSql: `${base}
SELECT ${day('t0')} AS day, variant, COUNT(*) AS n, SUM(x) AS a, SUM(y) AS b, SUM(x * x) AS c, SUM(y * y) AS dd, SUM(x * y) AS e FROM vals GROUP BY ${day('t0')}, variant`,
  };
}

/** The value and its standard error for a variant's stats. */
function estimate(m: ExperimentMetric, s: VariantStats): { value: number; se: number } {
  if (isRate(m)) {
    const p = s.n ? s.a / s.n : 0;
    return { value: p, se: s.n ? Math.sqrt((p * (1 - p)) / s.n) : 0 };
  }
  if (m.kind === 'mean') {
    const r = meanAndError({ n: s.n, sum: s.a, sumSquares: s.b });
    return { value: r.mean, se: r.se };
  }
  const r = ratioAndError({ n: s.n, sumX: s.a, sumY: s.b, sumX2: s.c, sumY2: s.dd, sumXY: s.e });
  return { value: r.ratio, se: r.se };
}

function analyse(
  m: ExperimentMetric,
  stats: VariantStats[],
  order: string[],
  engine: 'bayesian' | 'frequentist',
  confidence: number,
): MetricResult {
  const lower = m.goal === 'decrease';
  const by = new Map(stats.map((s) => [s.variant, s]));
  const zero = (variant: string): VariantStats => ({
    variant,
    n: 0,
    a: 0,
    b: 0,
    c: 0,
    dd: 0,
    e: 0,
  });
  const rows = order.map((v) => by.get(v) ?? zero(v));
  const control = rows[0]!;
  const z = zFor(confidence);
  const estimates = rows.map((r) => estimate(m, r));
  const best = isRate(m)
    ? probabilityToBeBestBeta(
        rows.map((r) => ({ exposures: r.n, conversions: r.a })),
        lower,
      )
    : probabilityToBeBestNormal(estimates, lower);
  const variants: MetricVariant[] = rows.map((r, i) => {
    const e = estimates[i]!;
    const interval: [number, number] = isRate(m)
      ? wilson(r.a, r.n, z)
      : [e.value - z * e.se, e.value + z * e.se];
    let vsControl: Comparison | null = null;
    if (i > 0 && control.n > 0 && r.n > 0) {
      vsControl = isRate(m)
        ? compareProportions(
            { exposures: control.n, conversions: control.a },
            { exposures: r.n, conversions: r.a },
            confidence,
            lower,
          )
        : compareEstimates(estimates[0]!, e, confidence, lower);
    }
    return {
      variant: r.variant,
      exposures: r.n,
      ...(isRate(m) ? { conversions: r.a } : {}),
      value: e.value,
      interval,
      vsControl,
      probabilityToBeBest: best[i] ?? 0,
    };
  });
  const candidates = variants.filter((v) => v.vsControl);
  let significantVariant: string | null = null;
  if (engine === 'bayesian') {
    const top = [...candidates].sort(
      (a, b) => b.vsControl!.probabilityToBeatControl - a.vsControl!.probabilityToBeatControl,
    )[0];
    if (top && top.vsControl!.probabilityToBeatControl >= confidence)
      significantVariant = top.variant;
  } else {
    const winners = candidates.filter((v) => {
      const c = v.vsControl!;
      const better = lower ? c.expectedLift < 0 : c.expectedLift > 0;
      return better && c.pValue < 1 - confidence;
    });
    const top = winners.sort((a, b) => a.vsControl!.pValue - b.vsControl!.pValue)[0];
    if (top) significantVariant = top.variant;
  }
  return {
    name: metricName(m),
    kind: m.kind,
    goal: lower ? 'decrease' : 'increase',
    variants,
    significantVariant,
  };
}

/** Daily cumulative values by variant (by first-exposure day). */
async function timeline(
  m: ExperimentMetric,
  q: string,
  ctx: QueryContext,
  order: string[],
  sql: string[],
): Promise<MetricResult['timeline']> {
  sql.push(q);
  const rows = await ctx.execute(q);
  const days = [...new Set(rows.map((r) => num(r.day)))].sort((a, b) => a - b);
  const variants: Record<string, number[]> = {};
  for (const v of order) {
    const acc: VariantStats = { variant: v, n: 0, a: 0, b: 0, c: 0, dd: 0, e: 0 };
    variants[v] = days.map((day) => {
      const r = rows.find((x) => num(x.day) === day && text(x.variant) === v);
      if (r) {
        acc.n += num(r.n);
        acc.a += num(r.a);
        acc.b += num(r.b);
        acc.c += num(r.c);
        acc.dd += num(r.dd);
        acc.e += num(r.e);
      }
      return estimate(m, acc).value;
    });
  }
  return { days, variants };
}

export interface ExperimentOptions {
  /** Variant weights from the flag, for the sample ratio check. Defaults to equal weights. */
  weights?: Record<string, number>;
  /** When the experiment started (for runtime and the timeline). Defaults to the first exposure. */
  startedAt?: number | null;
  /** Skip the per-day timeline (cheaper, e.g. in listings). */
  timeline?: boolean;
}

export function compileExperiment(
  spec: ExperimentSpec,
  ctx: QueryContext,
  range: { from: number; to: number },
): string {
  const { primary } = metricsOf(spec);
  const head = exposureHead(spec, ctx, range, primary);
  return `${head.sql}\nSELECT variant, COUNT(*) AS exposures FROM xe GROUP BY variant`;
}

export async function runExperiment(
  input: ExperimentSpec,
  ctx: QueryContext,
  options: ExperimentOptions = {},
): Promise<ExperimentResult> {
  const spec = input as Spec;
  const now = ctx.now ?? Date.now();
  const range = resolveRange(spec.from ?? '-90d', spec.to, now);
  const engine = spec.engine ?? 'bayesian';
  const confidence = spec.confidence ?? 0.95;
  const { primary, secondary } = metricsOf(spec);
  const all = [...primary, ...secondary];
  const head = exposureHead(spec, ctx, range, all);
  const sql: string[] = [];

  // Exposures per variant, and actors who saw more than one.
  const exposureQuery = `${head.sql}
SELECT variant, COUNT(*) AS exposures, MIN(t0) AS first_exposure, (SELECT COUNT(*) FROM x WHERE nv > 1) AS multi FROM xe GROUP BY variant`;
  sql.push(exposureQuery);
  const exposureRows = await ctx.execute(exposureQuery);
  const seen = exposureRows
    .map((r) => text(r.variant))
    .filter((v) => spec.holdoutFlags || v !== 'holdout');
  const order = spec.holdoutFlags
    ? ['holdout', 'experiments']
    : (spec.variants ?? [
        ...(seen.includes('control') ? ['control'] : []),
        ...seen.filter((v) => v !== 'control').sort(),
      ]);
  const exposuresOf = new Map(exposureRows.map((r) => [text(r.variant), num(r.exposures)]));
  const excluded = num(exposureRows[0]?.multi);
  const firstExposure = Math.min(
    ...exposureRows.map((r) => num(r.first_exposure)),
    Number.POSITIVE_INFINITY,
  );

  const measured = await Promise.all(all.map((m) => measure(m, head, ctx, sql, now)));
  const results = all.map((m, i) => {
    const r = analyse(m, measured[i]!.stats, order, engine, confidence);
    if (measured[i]!.winsorized) r.winsorized = measured[i]!.winsorized;
    return r;
  });
  const metrics = results.slice(0, primary.length);
  const secondaryResults = results.slice(primary.length);
  if (options.timeline !== false && order.length) {
    metrics[0]!.timeline = await timeline(primary[0]!, measured[0]!.timelineSql, ctx, order, sql);
  }

  const weights = order.map((v) => options.weights?.[v] ?? 1);
  const srm = sampleRatioMismatch(
    order.map((v) => exposuresOf.get(v) ?? 0),
    weights,
  );
  const startedAt = options.startedAt ?? (Number.isFinite(firstExposure) ? firstExposure : now);
  const daysRunning = Math.max(0, (Math.min(now, range.to) - startedAt) / DAY_MS);
  const minimumDays = spec.minimumDays ?? 7;
  const minimumExposures = spec.minimumExposures ?? 100;
  const enough =
    order.length > 1 && order.every((v) => (exposuresOf.get(v) ?? 0) >= minimumExposures);
  const decider = metrics[0]!;
  const totalExposures = order.reduce((a, v) => a + (exposuresOf.get(v) ?? 0), 0);
  let status: ExperimentResult['status'];
  let winner: string | null = null;
  if (totalExposures === 0) status = 'no_data';
  else if (srm.mismatch) status = 'srm';
  else if (daysRunning < minimumDays || !enough) status = 'too_early';
  else if (decider.significantVariant) {
    status = 'winner';
    winner = decider.significantVariant;
  } else status = 'no_winner_yet';

  // Days until an `mde` change on the first metric is detectable at the current exposure pace.
  let estimatedDaysToSignificance: number | null = null;
  const mde = spec.mde ?? 0.1;
  const controlStats = measured[0]!.stats.find((s) => s.variant === order[0]);
  if (controlStats && controlStats.n > 0 && status !== 'winner') {
    const m0 = primary[0]!;
    const needed = isRate(m0)
      ? sampleSizeForRate(Math.max(0.001, controlStats.a / controlStats.n), mde, confidence)
      : (() => {
          const e = estimate(m0, controlStats);
          const sd = e.se * Math.sqrt(controlStats.n);
          return sampleSizeForMean(e.value, sd, mde, confidence);
        })();
    const perDayPerVariant = totalExposures / Math.max(1, daysRunning) / Math.max(1, order.length);
    const have = Math.min(...order.map((v) => exposuresOf.get(v) ?? 0));
    const remaining = Math.max(0, needed - have);
    estimatedDaysToSignificance =
      perDayPerVariant > 0 && Number.isFinite(needed)
        ? Math.max(
            Math.ceil(remaining / perDayPerVariant),
            Math.ceil(Math.max(0, minimumDays - daysRunning)),
          )
        : null;
  }

  // The original shape: conversion on the first rate metric (and the mean of a goal value).
  const rate = metrics.find((_, i) => isRate(all[i]!)) ?? null;
  const meanMetric = spec.goal?.value ? metrics.find((r) => r.kind === 'mean') : undefined;
  const variants: VariantResult[] = order.map((v, i) => {
    const r = rate?.variants[i];
    const mean = meanMetric?.variants[i];
    const control = meanMetric?.variants[0];
    const meanStats = (x: MetricVariant | undefined) => {
      const s = measured[metrics.indexOf(meanMetric!)]?.stats.find((y) => y.variant === x?.variant);
      return { n: s?.n ?? 0, sum: s?.a ?? 0, sumSquares: s?.b ?? 0 };
    };
    return {
      variant: v,
      exposures: exposuresOf.get(v) ?? 0,
      conversions: r?.conversions ?? 0,
      conversionRate: r?.value ?? 0,
      rateInterval: r?.interval ?? [0, 0],
      vsControl: r?.vsControl
        ? {
            probabilityToBeatControl: r.vsControl.probabilityToBeatControl,
            expectedLift: r.vsControl.expectedLift,
            liftInterval: r.vsControl.liftInterval,
          }
        : null,
      mean:
        meanMetric && mean
          ? {
              value: mean.value,
              vsControl: i === 0 ? null : compareMeans(meanStats(control), meanStats(mean)),
            }
          : null,
    };
  });

  const lines = decider.variants.map((v) => {
    const shown = isRate(primary[0]!) ? fmt(v.value, 'percent') : fmt(v.value, 'decimal');
    const vs = v.vsControl
      ? engine === 'bayesian'
        ? `, ${fmt(v.vsControl.probabilityToBeatControl, 'percent')} chance to beat control (lift ${fmt(v.vsControl.expectedLift, 'percent')})`
        : `, p = ${v.vsControl.pValue.toFixed(3)} (lift ${fmt(v.vsControl.expectedLift, 'percent')})`
      : ' (control)';
    return `${v.variant}: ${shown}${vs}`;
  });
  const verdict = {
    no_data: '',
    srm: 'Sample ratio mismatch detected (p < 0.001): exposure tracking or assignment is broken; do not trust these results.',
    too_early: `Too early to call: wait for ${minimumDays} days and ${minimumExposures} exposures per variant${estimatedDaysToSignificance !== null ? ` (about ${estimatedDaysToSignificance} more days to detect a ${Math.round(mde * 100)}% change)` : ''}.`,
    winner: `"${winner}" is winning on ${decider.name} at ${Math.round(confidence * 100)}% ${engine === 'bayesian' ? 'probability' : 'confidence'}.`,
    no_winner_yet:
      estimatedDaysToSignificance !== null
        ? `No winner yet; roughly ${estimatedDaysToSignificance} more days to detect a ${Math.round(mde * 100)}% change at the current pace.`
        : 'No winner yet.',
  }[status];
  const secondaryNotes = secondaryResults
    .filter((r) => r.significantVariant)
    .map((r) => `${r.name}: ${r.significantVariant} better`);
  const aggregation = parseAggregation(spec.aggregateBy);
  return {
    kind: 'experiment',
    flag: spec.flag,
    goal: metricName(primary[0]!),
    engine,
    confidence,
    aggregateBy: typeof aggregation === 'object' ? aggregation.group : aggregation,
    variants,
    metrics,
    secondary: secondaryResults,
    excludedMultipleVariants: excluded,
    srm,
    winner,
    status,
    daysRunning,
    estimatedDaysToSignificance,
    sql,
    range: { from: iso(range.from), to: iso(range.to) },
    summary:
      totalExposures === 0
        ? `No exposures to "${spec.flag}" yet.`
        : `${fmt(totalExposures)} ${actorNoun(aggregation, totalExposures)} exposed over ${daysRunning.toFixed(1)} days. ${decider.name}: ${lines.join('; ')}. ${verdict}${secondaryNotes.length ? ` Secondary: ${secondaryNotes.join('; ')}.` : ''}`,
  };
}

// ── Planning ─────────────────────────────────────────────────────────────────

export interface ExperimentPlan {
  kind: 'experiment_plan';
  metric: string;
  /** The metric's current value among people doing the traffic event (rate, mean or ratio). */
  baseline: number;
  /** Standard deviation per person, for means and ratios. */
  standardDeviation: number | null;
  mde: number;
  confidence: number;
  variants: number;
  /** People needed in each variant. */
  perVariant: number | null;
  /** New people reaching the experiment per day (from the look-back). */
  peoplePerDay: number;
  /** Days to reach the sample size, and never fewer than the minimum runtime. */
  days: number | null;
  sql: string[];
  range: { from: string; to: string };
  summary: string;
}

/**
 * How long an experiment needs: the metric's baseline among recent traffic, the sample size per
 * variant to detect `mde`, and the days that takes at the recent rate of new people.
 */
export async function planExperiment(
  input: {
    metric: ExperimentMetric;
    traffic?: { event: string; filters?: Filter[] };
    variants?: number;
    mde?: number;
    confidence?: 0.9 | 0.95 | 0.99;
    exposurePercentage?: number;
    lookback?: string;
    minimumDays?: number;
    aggregateBy?: string;
    filters?: Filter[];
  },
  ctx: QueryContext,
): Promise<ExperimentPlan> {
  const now = ctx.now ?? Date.now();
  const lookback = input.lookback ?? '-14d';
  const range = resolveRange(lookback, 'now', now);
  const days = Math.max(1, (range.to - range.from) / DAY_MS);
  const traffic = input.traffic ?? { event: SYSTEM_EVENTS.pageview };
  const spec: Spec = {
    flag: '$plan',
    metrics: [input.metric],
    exposure: { event: traffic.event, filters: traffic.filters },
    baseline: true,
    aggregateBy: input.aggregateBy,
    filters: input.filters,
    from: range.from,
    to: range.to,
  } as Spec;
  const head = exposureHead(spec, ctx, range, [input.metric]);
  const sql: string[] = [];
  const countQuery = `${head.sql}\nSELECT COUNT(*) AS n FROM xe`;
  sql.push(countQuery);
  const people = num((await ctx.execute(countQuery))[0]?.n);
  const measured = await measure(input.metric, head, ctx, sql, now);
  const stats = measured.stats[0] ?? { variant: 'all', n: 0, a: 0, b: 0, c: 0, dd: 0, e: 0 };
  const e = estimate(input.metric, stats);
  const mde = input.mde ?? 0.1;
  const confidence = input.confidence ?? 0.95;
  const variants = input.variants ?? 2;
  const sd = isRate(input.metric) ? null : e.se * Math.sqrt(Math.max(1, stats.n));
  const perVariant = stats.n
    ? isRate(input.metric)
      ? sampleSizeForRate(e.value, mde, confidence)
      : sampleSizeForMean(e.value, sd ?? 0, mde, confidence)
    : Number.POSITIVE_INFINITY;
  const share = Math.min(100, Math.max(1, input.exposurePercentage ?? 100)) / 100;
  const peoplePerDay = (people / days) * share;
  const minimumDays = input.minimumDays ?? 7;
  const needDays =
    Number.isFinite(perVariant) && peoplePerDay > 0
      ? Math.max(minimumDays, Math.ceil((perVariant * variants) / peoplePerDay))
      : null;
  const name = metricName(input.metric);
  const shown = isRate(input.metric) ? fmt(e.value, 'percent') : fmt(e.value, 'decimal');
  return {
    kind: 'experiment_plan',
    metric: name,
    baseline: e.value,
    standardDeviation: sd,
    mde,
    confidence,
    variants,
    perVariant: Number.isFinite(perVariant) ? perVariant : null,
    peoplePerDay,
    days: needDays,
    sql,
    range: { from: iso(range.from), to: iso(range.to) },
    summary:
      needDays === null
        ? `Not enough recent data to plan: ${name} is ${shown} over ${fmt(people)} people in ${Math.round(days)} days.`
        : `${name} is ${shown} today. To detect a ${Math.round(mde * 100)}% change at ${Math.round(confidence * 100)}% with ${variants} variants you need about ${fmt(perVariant)} people per variant: roughly ${needDays} days at ${fmt(peoplePerDay)} new people a day${share < 1 ? ` (${Math.round(share * 100)}% of traffic)` : ''}.`,
  };
}
