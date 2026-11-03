/**
 * Statistics for experiment readouts.
 *
 * - Conversion goals: Bayesian beta-binomial with a uniform Beta(1, 1) prior.
 *   We report P(variant beats control) and a 95% credible interval for the
 *   relative lift, both by Monte Carlo with a fixed seed.
 * - Mean goals (e.g. revenue per person): Welch's t-test with a normal
 *   approximation, which is accurate at the sample sizes experiments need.
 * - Sample ratio mismatch: chi-square goodness of fit against the configured
 *   variant weights. A tiny p-value means assignment or tracking is broken and
 *   the results should not be trusted.
 */

import { beta, mulberry32 } from './random.ts';

export interface ConversionStats {
  exposures: number;
  conversions: number;
}

export interface BayesComparison {
  /** P(variant rate > control rate). */
  probabilityToBeatControl: number;
  /** Posterior mean of (variant - control) / control. */
  expectedLift: number;
  /** 95% credible interval for the relative lift. */
  liftInterval: [number, number];
}

/** Compare a variant to control under Beta(1 + conversions, 1 + failures) posteriors. */
export function compareConversions(
  control: ConversionStats,
  variant: ConversionStats,
  samples = 20_000,
  seed = 42,
): BayesComparison {
  const rng = mulberry32(seed);
  const lifts = new Float64Array(samples);
  let wins = 0;
  for (let i = 0; i < samples; i++) {
    const c = beta(1 + control.conversions, 1 + control.exposures - control.conversions, rng);
    const v = beta(1 + variant.conversions, 1 + variant.exposures - variant.conversions, rng);
    if (v > c) wins++;
    lifts[i] = (v - c) / c;
  }
  lifts.sort();
  const mean = lifts.reduce((a, b) => a + b, 0) / samples;
  return {
    probabilityToBeatControl: wins / samples,
    expectedLift: mean,
    liftInterval: [lifts[Math.floor(0.025 * samples)]!, lifts[Math.floor(0.975 * samples)]!],
  };
}

/** Wilson score interval for a binomial proportion. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface MeanStats {
  n: number;
  sum: number;
  sumSquares: number;
}

export interface MeanComparison {
  controlMean: number;
  variantMean: number;
  difference: number;
  /** 95% confidence interval for the difference in means. */
  interval: [number, number];
  /** Two-sided p-value. */
  pValue: number;
}

/** Welch's t-test from sufficient statistics (normal approximation). */
export function compareMeans(control: MeanStats, variant: MeanStats): MeanComparison {
  const stats = (s: MeanStats) => {
    const mean = s.n ? s.sum / s.n : 0;
    const variance = s.n > 1 ? Math.max(0, (s.sumSquares - s.n * mean * mean) / (s.n - 1)) : 0;
    return { mean, variance };
  };
  const c = stats(control);
  const v = stats(variant);
  const se = Math.sqrt((control.n ? c.variance / control.n : 0) + (variant.n ? v.variance / variant.n : 0));
  const diff = v.mean - c.mean;
  const z = se > 0 ? diff / se : 0;
  return {
    controlMean: c.mean,
    variantMean: v.mean,
    difference: diff,
    interval: [diff - 1.96 * se, diff + 1.96 * se],
    pValue: se > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1,
  };
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf). */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

export interface SrmResult {
  chiSquare: number;
  pValue: number;
  /** True when p < 0.001: treat the experiment as broken until explained. */
  mismatch: boolean;
}

/** Chi-square goodness-of-fit test of observed exposures against expected weights. */
export function sampleRatioMismatch(observed: number[], weights: number[]): SrmResult {
  const total = observed.reduce((a, b) => a + b, 0);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || weightSum === 0 || observed.length < 2) return { chiSquare: 0, pValue: 1, mismatch: false };
  let chi = 0;
  observed.forEach((o, i) => {
    const expected = (total * (weights[i] ?? 0)) / weightSum;
    if (expected > 0) chi += (o - expected) ** 2 / expected;
  });
  const pValue = chiSquareSurvival(chi, observed.length - 1);
  return { chiSquare: chi, pValue, mismatch: pValue < 0.001 };
}

/** P(X > x) for a chi-square distribution with k degrees of freedom. */
export function chiSquareSurvival(x: number, k: number): number {
  if (x <= 0) return 1;
  return upperRegularizedGamma(k / 2, x / 2);
}

/** Q(a, x), the regularized upper incomplete gamma function (Numerical Recipes 6.2). */
function upperRegularizedGamma(a: number, x: number): number {
  if (x < a + 1) {
    // Series for P(a, x), then Q = 1 - P.
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  // Continued fraction for Q(a, x) (Lentz's method).
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Lanczos approximation of ln Γ(x). */
function logGamma(x: number): number {
  const g = 7;
  const coef = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const xx = x - 1;
  let a = coef[0]!;
  const t = xx + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += coef[i]! / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * People needed per variant to detect a relative lift `mde` on a base rate `p`
 * with a two-sided test at alpha 0.05 and 80% power.
 */
export function sampleSizePerVariant(p: number, mde: number): number {
  const p2 = p * (1 + mde);
  if (p <= 0 || p >= 1 || p2 <= 0 || p2 >= 1 || p2 === p) return Number.POSITIVE_INFINITY;
  const zAlpha = 1.959964;
  const zBeta = 0.841621;
  return Math.ceil(((zAlpha + zBeta) ** 2 * (p * (1 - p) + p2 * (1 - p2))) / (p2 - p) ** 2);
}
