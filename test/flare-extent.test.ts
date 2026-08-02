/**
 * A blast's flare burst must stay inside the crater it digs. Every flare-burst member's `size` is
 * the DRAWN WIDTH (the draw pass centres the sprite in a box of that width), so a member's reach
 * from the blast centre is `offset + size/2`. Treating `size` as a radius instead — doubling it at
 * draw time — pushes the central puff to 1.4·r and makes the fireball glow twice as wide as the hole.
 */
import {describe, it, expect} from 'vitest';
import {CParticleSystem} from '../src/core/CParticleSystem';
import {EXP, type ExpType} from '../src/core/weapons/ExpType';

type Explosion = {x: number; y: number; size: number; shrink?: boolean};
const membersOf = (ps: CParticleSystem) =>
  (ps as unknown as {m_explosions: Explosion[]}).m_explosions;

const R = 60;
const CX = 400;
const CY = 300;

/** Flare-burst members of one conventional blast of radius R. */
function burst(expType: ExpType): Explosion[] {
  const ps = new CParticleSystem();
  ps.blast(CX, CY, R, '#ff8000', false, undefined, expType, 'flares/07.bmp');
  return membersOf(ps);
}

/** Furthest lit edge from the blast centre, in units of the blast radius. */
const reach = (ms: Explosion[]) =>
  Math.max(...ms.map(m => (Math.hypot(m.x - CX, m.y - CY) + m.size / 2) / R));

describe('flare burst extent', () => {
  for (const [label, expType] of [
    ['BURST', EXP.BURST],
    ['DENSE', EXP.DENSE],
    ['SINGLE', EXP.SINGLE],
  ] as const) {
    it(`${label}: stays within the crater radius`, () => {
      const ms = burst(expType);
      expect(ms.length).toBeGreaterThan(0);
      expect(ms.every(m => m.shrink)).toBe(true); // the whole burst contracts; none of it grows
      expect(reach(ms)).toBeLessThanOrEqual(1);
      // …and it isn't so small the blast vanishes: it should fill most of the hole.
      expect(reach(ms)).toBeGreaterThan(0.6);
    });
  }

  it('keeps the original central-puff width, and reads it as a width', () => {
    const centre = burst(EXP.BURST).filter(m => m.x === CX && m.y === CY);
    expect(centre).toHaveLength(1);
    // The original's own constant (mag·1.4), carried over verbatim — what matters is that it is
    // read as a WIDTH.
    expect(centre[0].size).toBeCloseTo(R * 1.4, 6);
    // As a width that is a 0.7·r reach; read as a radius it would be 1.4·r, past the rim.
    expect(centre[0].size / 2 / R).toBeCloseTo(0.7, 6);
  });

  it('the spark spray SPEED scales with the radius, so its reach is proportional', () => {
    // A fixed px/s spray makes the reach a constant distance while the crater scales: Plasma (r 60)
    // flings sparks 2.3·r out while Plasma Bomb (r 90) — same style, same sprite — keeps them at
    // 1.5·r. Launch speed per unit radius must be the same at every size.
    //
    // Assert the BOUND, not a sample statistic: every emitter draws its speed randomly, so both the
    // sample max and the sample mean are random variables that jitter with the particle count —
    // comparing them across radii is flaky. A CAP in units of r is exact instead. The cap is 1.8:
    // the radial ring tops out at 1.4·r, and the box spray reaches hypot(1, 1.4)·r ≈ 1.72·r because
    // its vertical component carries an extra `speed·0.4` upward bias. A fixed 70..200 px/s spray
    // breaks this loudly at small radii (200/30 = 6.7·r).
    // Crater fume ('smoke') is excluded: its drift is deliberately a fixed gentle rise, radius-
    // independent by design (only its LIFE scales), so it is not part of this invariant.
    for (const r of [30, 60, 90, 150]) {
      const ps = new CParticleSystem();
      ps.blast(CX, CY, r, '#ff00ff', false, undefined, EXP.DENSE, 'flares/05.bmp');
      const spray = (
        ps as unknown as {m_particles: {vx: number; vy: number; kind: string}[]}
      ).m_particles.filter(p => p.kind !== 'smoke');
      expect(spray.length).toBeGreaterThan(20);
      const speeds = spray.map(p => Math.hypot(p.vx, p.vy) / r);
      expect(Math.max(...speeds)).toBeLessThanOrEqual(1.8); // capped in units of r, at every size
      expect(Math.max(...speeds)).toBeGreaterThan(0.9); // …and not degenerately slow
    }
  });

  it('scales with the blast radius rather than being a fixed size', () => {
    const small = new CParticleSystem();
    small.blast(CX, CY, 30, '#ff8000', false, undefined, EXP.BURST, 'flares/07.bmp');
    const big = new CParticleSystem();
    big.blast(CX, CY, 120, '#ff8000', false, undefined, EXP.BURST, 'flares/07.bmp');
    const puff = (ps: CParticleSystem) => membersOf(ps).find(m => m.x === CX && m.y === CY)!.size;
    expect(puff(big) / puff(small)).toBeCloseTo(4, 6); // 4× radius → 4× puff
  });
});
