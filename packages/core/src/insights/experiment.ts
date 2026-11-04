/**
 * Experiment readout.
 *
 * A person enters the experiment at their first `$exposure` to the flag (logged
 * by the SDK when a variant is rendered). People exposed to more than one
 * variant are excluded and counted separately — a high count means the flag is
 * being evaluated inconsistently. A person converts if they do the goal event at
 * or after their first exposure.
 */

import { SYSTEM_EVENTS } from '../events.ts';
import { filtersSql, propertyNumber } from '../sql/filters.ts';
import { eventsCte, num, text } from '../sql/source.ts';
import {
  type BayesComparison,
  compareConversions,
  compareMeans,
  type MeanComparison,
  type SrmResult,
  sampleRatioMismatch,
  sampleSizePerVariant,
  wilson,
} from '../stats/tests.ts';
import { DAY_MS, iso, resolveRange } from '../time.ts';
import type { ExperimentSpec } from './schemas.ts';
import { fmt, type QueryContext, type ResultBase } from './types.ts';

export interface VariantResult {
  variant: string;
  exposures: number;
  conversions: number;
  conversionRate: number;
  rateInterval: [number, number];
  /** Comparison to control; null for control itself. */
  vsControl: BayesComparison | null;
  /** Present when the goal has a `value` property. */
  mean: { value: number; vsControl: MeanComparison | null } | null;
}

export interface ExperimentResult extends ResultBase {
  kind: 'experiment';
  flag: string;
  goal: string;
  variants: VariantResult[];
  /** People exposed to more than one variant (excluded). */
  excludedMultipleVariants: number;
  srm: SrmResult;
  /** Best variant by probability to beat control, when it clears 95%. */
  winner: string | null;
  /** Rough days until a 10% relative lift would be detectable at the current exposure rate. */
  estimatedDaysToSignificance: number | null;
}

export function compileExperiment(
  spec: ExperimentSpec,
  ctx: QueryContext,
  range: { from: number; to: number },
): string {
  const d = ctx.dialect;
  const variant = d.jsonText('props', ['variant']);
  const flag = d.jsonText('props', ['flag']);
  const value = spec.goal.value ? `COALESCE(${propertyNumber(spec.goal.value, d, 'ev')}, 0)` : '0';
  return `WITH ${eventsCte(d, { project: ctx.project, ...range, events: [SYSTEM_EVENTS.exposure, spec.goal.event] })},
x AS (
  SELECT pid, MIN(ts_ms) AS t0, MIN(${variant}) AS variant, COUNT(DISTINCT ${variant}) AS nv
  FROM ev
  WHERE event = ${d.str(SYSTEM_EVENTS.exposure)} AND ${flag} = ${d.str(spec.flag)}
  GROUP BY pid
),
xe AS (SELECT pid, t0, variant FROM x WHERE nv = 1),
g AS (
  SELECT xe.pid, SUM(${value}) AS total
  FROM xe JOIN ev ON ev.pid = xe.pid
  WHERE ev.event = ${d.str(spec.goal.event)} AND ev.ts_ms >= xe.t0 AND ${filtersSql(spec.goal.filters, d, 'ev')}
  GROUP BY xe.pid
)
SELECT xe.variant AS variant,
  COUNT(*) AS exposures,
  SUM(CASE WHEN g.pid IS NULL THEN 0 ELSE 1 END) AS conversions,
  SUM(COALESCE(g.total, 0)) AS value_sum,
  SUM(COALESCE(g.total, 0) * COALESCE(g.total, 0)) AS value_sumsq,
  MIN(xe.t0) AS first_exposure,
  (SELECT COUNT(*) FROM x WHERE nv > 1) AS multi
FROM xe LEFT JOIN g ON g.pid = xe.pid
GROUP BY xe.variant`;
}

export interface ExperimentOptions {
  /** Variant weights from the flag, for the sample ratio check. Defaults to equal weights. */
  weights?: Record<string, number>;
}

export async function runExperiment(
  spec: ExperimentSpec,
  ctx: QueryContext,
  options: ExperimentOptions = {},
): Promise<ExperimentResult> {
  const now = ctx.now ?? Date.now();
  const range = resolveRange(spec.from ?? '-90d', spec.to, now);
  const sql = compileExperiment(spec, ctx, range);
  const rows = await ctx.execute(sql);

  const byVariant = new Map(rows.map((r) => [text(r.variant), r]));
  const seen = [...byVariant.keys()];
  const order = spec.variants ?? [
    ...(seen.includes('control') ? ['control'] : []),
    ...seen.filter((v) => v !== 'control').sort(),
  ];
  const stat = (v: string) => {
    const r = byVariant.get(v);
    return {
      exposures: num(r?.exposures),
      conversions: num(r?.conversions),
      sum: num(r?.value_sum),
      sumSquares: num(r?.value_sumsq),
      first: r ? num(r.first_exposure) : Number.POSITIVE_INFINITY,
    };
  };
  const control = order[0] ? stat(order[0]) : null;
  const hasValue = Boolean(spec.goal.value);

  const variants: VariantResult[] = order.map((v, i) => {
    const s = stat(v);
    return {
      variant: v,
      exposures: s.exposures,
      conversions: s.conversions,
      conversionRate: s.exposures ? s.conversions / s.exposures : 0,
      rateInterval: wilson(s.conversions, s.exposures),
      vsControl:
        i === 0 || !control || control.exposures === 0 || s.exposures === 0
          ? null
          : compareConversions(control, s),
      mean: hasValue
        ? {
            value: s.exposures ? s.sum / s.exposures : 0,
            vsControl:
              i === 0 || !control
                ? null
                : compareMeans(
                    { n: control.exposures, sum: control.sum, sumSquares: control.sumSquares },
                    { n: s.exposures, sum: s.sum, sumSquares: s.sumSquares },
                  ),
          }
        : null,
    };
  });

  const weights = order.map((v) => options.weights?.[v] ?? 1);
  const srm = sampleRatioMismatch(
    variants.map((v) => v.exposures),
    weights,
  );
  const best = variants
    .filter((v) => v.vsControl)
    .sort(
      (a, b) => b.vsControl!.probabilityToBeatControl - a.vsControl!.probabilityToBeatControl,
    )[0];
  const winner =
    best && best.vsControl!.probabilityToBeatControl >= 0.95 && !srm.mismatch ? best.variant : null;

  // Days to significance for a 10% relative lift at the observed base rate and exposure pace.
  let estimatedDaysToSignificance: number | null = null;
  const totalExposures = variants.reduce((a, v) => a + v.exposures, 0);
  const firstExposure = Math.min(...order.map((v) => stat(v).first));
  if (control && control.exposures > 0 && Number.isFinite(firstExposure) && !winner) {
    const days = Math.max(1, (now - firstExposure) / DAY_MS);
    const perDayPerVariant = totalExposures / days / Math.max(1, order.length);
    const needed = sampleSizePerVariant(
      Math.max(0.001, control.conversions / control.exposures),
      0.1,
    );
    const remaining = Math.max(0, needed - Math.min(...variants.map((v) => v.exposures)));
    estimatedDaysToSignificance =
      perDayPerVariant > 0 && Number.isFinite(needed)
        ? Math.ceil(remaining / perDayPerVariant)
        : null;
  }

  const excluded = num(rows[0]?.multi);
  const lines = variants.map((v) => {
    const vs = v.vsControl
      ? `, ${fmt(v.vsControl.probabilityToBeatControl, 'percent')} chance to beat control (lift ${fmt(v.vsControl.expectedLift, 'percent')})`
      : ' (control)';
    return `${v.variant}: ${fmt(v.conversions)}/${fmt(v.exposures)} = ${fmt(v.conversionRate, 'percent')}${vs}`;
  });
  const verdict = srm.mismatch
    ? 'Sample ratio mismatch detected (p < 0.001): exposure tracking or assignment is broken; do not trust these results.'
    : winner
      ? `"${winner}" is winning with ≥95% probability.`
      : estimatedDaysToSignificance !== null
        ? `No winner yet; roughly ${estimatedDaysToSignificance} more days to detect a 10% lift at the current pace.`
        : 'No winner yet.';

  return {
    kind: 'experiment',
    flag: spec.flag,
    goal: spec.goal.event,
    variants,
    excludedMultipleVariants: excluded,
    srm,
    winner,
    estimatedDaysToSignificance,
    sql: [sql],
    range: { from: iso(range.from), to: iso(range.to) },
    summary:
      totalExposures === 0
        ? `No exposures to "${spec.flag}" yet.`
        : `${lines.join('; ')}. ${verdict}`,
  };
}
