/**
 * The turn hands off when the EXPLOSION finishes — NOT when its smoke finishes.
 *
 * Our port adds lingering grey smoke/plume puffs (1–4 s) that the original blasts never had
 * (the original emits only flares + fire streamers). `hasActiveExplosions()` counts them, so
 * gating turn hand-off on it made the round wait seconds for cosmetic smoke to fade. The Explosion
 * state now gates on `hasActiveBlast()`, which tracks the fireball / beam / fire+spark particles but
 * IGNORES the smoke/plume, so the turn ends with the blast and the smoke drifts on cosmetically.
 */
import {describe, it, expect} from 'vitest';
import {CParticleSystem} from '../src/core/CParticleSystem';

type Priv = {
  m_particles: {kind: string}[];
  m_explosions: unknown[];
  add(
    x: number,
    y: number,
    vx: number,
    vy: number,
    c: object,
    life: number,
    size: number,
    kind: string,
  ): void;
};

function addKind(ps: CParticleSystem, kind: string): void {
  (ps as unknown as Priv).add(400, 300, 0, 0, {r: 150, g: 150, b: 150}, 1, 10, kind);
}

function stepN(ps: CParticleSystem, n: number): void {
  for (let i = 0; i < n; i++) ps.update(1 / 60);
}

describe('turn hand-off waits for the explosion, not the smoke', () => {
  it('lingering smoke/plume alone does NOT hold the turn; fire/sparks do', () => {
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);

    // Only cosmetic smoke + plume in the pool → the explosion is over. 'exhaust' is the BAKED
    // rocket-trail cluster: still just trail smoke, so it must not hold the turn either — a
    // Stingers volley leaves thousands of frames' worth of it drifting after the round lands.
    addKind(ps, 'smoke');
    addKind(ps, 'plume');
    addKind(ps, 'exhaust');
    expect(ps.hasActiveExplosions()).toBe(true); // something is still on screen (keeps drawing)
    expect(ps.hasActiveBlast()).toBe(false); // …but it's only smoke → the turn may hand off

    // A fire/spark particle (part of the explosion) DOES hold the turn.
    addKind(ps, 'flare');
    expect(ps.hasActiveBlast()).toBe(true);
  });

  it('the fireball itself (m_explosions) holds the turn until it finishes', () => {
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    // No m_particles, but an active fireball puff → still blasting.
    (ps as unknown as Priv).m_explosions.push({
      x: 0,
      y: 0,
      age: 0,
      life: 0.5,
      size: 10,
      sprite: null,
    });
    expect(ps.hasActiveBlast()).toBe(true);
  });

  it('after a real blast the gate clears while smoke still lingers, then everything ends', () => {
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.blast(400, 300, 45, '#ff8c22', false);
    expect(ps.hasActiveBlast()).toBe(true); // fireball + sparks are up

    // ~1.3 s: past the fireball (≤0.95 s) and every fire/spark (≤1.0 s) — only smoke (1–2 s) can remain.
    stepN(ps, 80);
    if (ps.hasActiveExplosions()) {
      // Whatever is left must be purely cosmetic smoke/plume…
      const parts = (ps as unknown as Priv).m_particles;
      expect(parts.every(p => p.kind === 'smoke' || p.kind === 'plume' || p.kind === 'fume')).toBe(
        true,
      );
      // …so the blast gate is already clear (the turn would have handed off).
      expect(ps.hasActiveBlast()).toBe(false);
    }

    // And it all clears eventually — past the crater vent's full life (VENT_LIFE + puff life).
    stepN(ps, 780); // ~14s total with the 80 above
    expect(ps.hasActiveBlast()).toBe(false);
    expect(ps.hasActiveExplosions()).toBe(false);
  });
});
