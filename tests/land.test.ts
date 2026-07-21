/**
 * Deterministic logic tests for CLand terrain deformation.
 * Run: npx tsx tests/land.test.ts
 */
import {CLand} from '../src/core/CLand';

let pass = 0,
  fail = 0;

function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${extra}`);
  }
}

type Priv = {m_particles: unknown[]};
const debrisLeft = (land: CLand): number => (land as unknown as Priv).m_particles.length;

console.log('CLand terrain');

// 1. A crater LOWERS the surface within its radius (the pixel-model `setColumnTop` clears the
//    bowl) and leaves terrain outside the blast untouched.
{
  const land = new CLand(1080, 400);
  land.generateRandomTerrain(12345);
  const cx = 540;
  const sy = land.getHeightAt(cx);
  const farBefore = land.getHeightAt(cx + 200);

  land.blastCircle(cx, sy, 60);

  // screen-Y down: a crater makes the surface number LARGER (lower on screen).
  ok('crater lowers the surface at its centre', land.getHeightAt(cx) > sy, `${sy}→${land.getHeightAt(cx)}`); // prettier-ignore
  let lowered = 0;
  for (let x = cx - 55; x <= cx + 55; x++) if (land.getHeightAt(x) > sy - 1) lowered++;
  ok('crater lowers a wide span', lowered >= 90, `lowered=${lowered}`);
  ok('terrain far from the crater is untouched', land.getHeightAt(cx + 200) === farBefore);
}

// 2. Debris settling RAISES the surface where chunks land (each stamps a dirt pixel + lifts
//    the column), and never lowers it — deposits only add material.
{
  const land = new CLand(1080, 400);
  land.generateRandomTerrain(999);
  const cx = 300;
  const before: number[] = [];
  for (let x = cx - 90; x <= cx + 90; x++) before.push(land.getHeightAt(x));
  land.addShowerParticles(cx, land.getHeightAt(cx), 2500, 60);
  for (let i = 0; i < 500 && debrisLeft(land) > 0; i++) land.update(1 / 60);
  let raised = 0,
    dug = 0;
  for (let i = 0; i < before.length; i++) {
    const now = land.getHeightAt(cx - 90 + i);
    if (now < before[i] - 1) raised++; // smaller Y = higher = added earth
    if (now > before[i] + 1) dug++; // never removes
  }
  ok('settled debris raises the surface', raised >= 10, `raised=${raised}`);
  ok('settled debris removes nothing', dug === 0, `dug=${dug}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
