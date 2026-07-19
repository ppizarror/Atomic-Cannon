/**
 * Deterministic logic tests for CLand terrain deformation.
 * Run: npx tsx tests/land.test.ts
 */
import { CLand } from '../src/core/CLand';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
}

type Deg = { m_degrass: Uint8Array | null; m_particles: unknown[] };
const degrass = (land: CLand): Uint8Array => (land as unknown as Deg).m_degrass!;
const debrisLeft = (land: CLand): number => (land as unknown as Deg).m_particles.length;

/** Columns de-grassed outside the single contiguous run covering `cx` = strays. */
function strayDegrass(deg: Uint8Array, cx: number): { total: number; craterCols: number; stray: number; runs: number } {
  const W = deg.length;
  let total = 0;
  for (let i = 0; i < W; i++) if (deg[i]) total++;
  let lo = cx, hi = cx;
  while (lo > 0 && deg[lo - 1]) lo--;
  while (hi < W - 1 && deg[hi + 1]) hi++;
  let craterCols = 0;
  for (let i = lo; i <= hi; i++) if (deg[i]) craterCols++;
  let runs = 0, prev = 0;
  for (let i = 0; i < W; i++) { if (deg[i]) { if (!prev) runs++; prev = 1; } else prev = 0; }
  return { total, craterCols, stray: total - craterCols, runs };
}

console.log('CLand terrain');

// 1. A crater + a nuke's worth of ejecta must not speckle the map with isolated
//    de-grass stripes: every de-grassed column stays connected to the crater, so
//    the bare-earth zone is ONE contiguous run (no stray vertical dirt bars).
{
  const land = new CLand(1080, 400);
  land.generateRandomTerrain(12345);
  const cx = 540;
  const sy = land.getHeightAt(cx);

  land.blastCircle(cx, sy, 60);              // contiguous crater de-grass seed
  land.addShowerParticles(cx, sy, 4000, 90); // fling debris far and wide

  for (let i = 0; i < 400 && debrisLeft(land) > 0; i++) land.update(1 / 60);
  for (let i = 0; i < 60; i++) land.update(1 / 60);   // let the slump settle

  const s = strayDegrass(degrass(land), cx);
  ok('crater is de-grassed (bare earth)', s.craterCols >= 100, `craterCols=${s.craterCols}`);
  ok('no stray de-grass stripes far from the crater', s.stray === 0, `stray=${s.stray} runs=${s.runs}`);
  ok('de-grass forms a single contiguous zone', s.runs === 1, `runs=${s.runs}`);
}

// 2. Debris that never lands adjacent to bared ground leaves the grass intact
//    (no de-grass at all without a crater seed).
{
  const land = new CLand(1080, 400);
  land.generateRandomTerrain(999);
  const cx = 300;
  const sy = land.getHeightAt(cx);
  land.addShowerParticles(cx, sy, 1500, 70);   // debris, but NO crater seed
  for (let i = 0; i < 400 && debrisLeft(land) > 0; i++) land.update(1 / 60);
  const deg = degrass(land);
  let total = 0;
  for (let i = 0; i < deg.length; i++) if (deg[i]) total++;
  ok('debris alone never bares grass (needs a blast to seed it)', total === 0, `degrassed=${total}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
