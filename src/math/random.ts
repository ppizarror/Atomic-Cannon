/**
 * Non-deterministic random helpers (thin wrappers over `Math.random`). Extracted from
 * duplicate `rnd`/`between` pairs in CWeather and CParticleSystem plus ~10 inline
 * `(Math.random() * 2 - 1) * x` symmetric-jitter sites.
 *
 * NOTE: CLand keeps its OWN seeded LCG (`rand01`) — that stream is deliberately
 * reproducible for terrain generation and must not route through here.
 */

/** Uniform in [a, b). */
export const between = (a: number, b: number): number => a + (b - a) * Math.random();

/** Symmetric jitter: uniform in [-x, x]. */
export const plusMinus = (x: number): number => (Math.random() * 2 - 1) * x;
