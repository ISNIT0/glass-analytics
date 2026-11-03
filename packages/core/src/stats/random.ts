/**
 * Seeded randomness for Monte Carlo estimates.
 *
 * Experiment readouts are simulated; a fixed seed makes the same data always
 * produce the same numbers, so results don't flicker between page loads.
 */

/** mulberry32: a small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller. */
export function normal(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Gamma(shape, 1) via Marsaglia & Tsang (2000). */
export function gamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a + 1) * U^(1/a)
    return gamma(shape + 1, rng) * rng() ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta(a, b) as a ratio of gammas. */
export function beta(a: number, b: number, rng: () => number): number {
  const x = gamma(a, rng);
  const y = gamma(b, rng);
  return x / (x + y);
}
