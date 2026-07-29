/**
 * Deterministic randomness.
 *
 * Every roll in the terrain sim is seeded from (worldSeed, tileIndex, epoch) so that
 * a fast-forward is reproducible and auditable rather than a one-way dice roll. This
 * is what lets an unobserved region be resolved lazily on first contact and still
 * agree with what the server would have computed tick by tick.
 */

/** 32-bit integer hash (mulberry32's mixing step, used standalone). */
export function hash32(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    let x = p | 0;
    // Mix each part with an xorshift-multiply chain.
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = x ^ (x >>> 16);
    h = Math.imul(h ^ x, 0x01000193);
  }
  return h >>> 0;
}

/** Uniform float in [0, 1) derived directly from a coordinate tuple. No state. */
export function rollAt(...parts: number[]): number {
  const h = hash32(...parts);
  return h / 0x100000000;
}

/** A small stateful PRNG for world generation, where a stream is more convenient. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Per-visit probability that yields a given median lifetime, in visits.
 *
 * The sweep visits each tile once per revolution, so a transition with a median of
 * `medianVisits` visits needs a per-visit probability p where (1-p)^median = 0.5.
 * This produces a geometric distribution: a wide spread with a long tail, which is
 * the "10 to 10,000 ticks, centred around 1200" shape the design calls for —
 * inevitability without precision.
 */
export function medianToProbability(medianVisits: number): number {
  if (medianVisits <= 0) return 1;
  return 1 - Math.pow(0.5, 1 / medianVisits);
}
