/**
 * Crater fumes belong to the CRATER, not to the turn.
 *
 * A vent holds after its blast while the ground is still physically moving, so the smoke reads as
 * aftermath rather than arriving with the bang. The signal it waits on is the whole map going quiet
 * — which is fine for one shell and wrong for everything that fires more than once. A Katyusha
 * barrage, a cluster, any multi-shot weapon keeps SOMETHING in motion for as long as it is firing,
 * so under a single shared cap every hole already dug stayed silent until the last round had landed:
 * craters visibly smokeless while the player was still shooting, and then the entire field igniting
 * on one frame when the map finally settled.
 *
 * Two properties fix that, and both are about craters being independent of each other:
 *  - a crater vents on ITS OWN clock, however long the rest of the volley takes;
 *  - craters born together do not open together.
 */
import {describe, it, expect} from 'vitest';
import {particlesPriv} from './_internals';
import {CParticleSystem} from '../src/core/CParticleSystem';

/** Ground at y=300 across the field, so every blast reaches soil and vents. */
function ps(settling: () => boolean): CParticleSystem {
  const p = new CParticleSystem();
  p.setBounds(2000, 600);
  p.setGroundProvider(() => 300);
  p.setSettleProvider(settling);
  return p;
}

const fumes = (p: CParticleSystem): number => particlesPriv(p).m_particles.filter(q => q.kind === 'fume').length;

describe('CParticleSystem — a crater fumes on its own clock', () => {
  it('smokes while the rest of the volley is still landing', () => {
    // The map never goes quiet — a barrage still in the air, exactly as `isSettling` reports it.
    const p = ps(() => true);
    p.blast(400, 300, 25, '#ff8c22', false); // the first rocket of the salvo

    // Give it several seconds: its own delay and its own hold, both of which are short for a
    // rocket-sized crater. Held on the map's clock instead, this crater would still be silent.
    for (let i = 0; i < 60 * 4; i++) p.update(1 / 60);

    expect(fumes(p)).toBeGreaterThan(0);
  });

  it('craters dug in the same salvo do not all open on the same frame', () => {
    const p = ps(() => false);
    // Eight identical holes born on ONE frame — the worst case for lockstep, and what a salvo
    // landing together looks like. Same radius, so nothing but the per-vent jitter separates them.
    for (let k = 0; k < 8; k++) p.blast(300 + k * 120, 300, 25, '#ff8c22', false);

    // Sample when each crater's first puff appears.
    const vents = particlesPriv(p).m_craterVents;
    const opened = new Map<number, number>();
    for (let f = 0; f < 60 * 6; f++) {
      p.update(1 / 60);
      for (const v of vents) if (v.emit > 0 && !opened.has(v.x)) opened.set(v.x, f);
    }

    expect(opened.size).toBe(8); // they all light eventually…
    // …but not together. One shared delay put every one of these on the same frame.
    expect(new Set(opened.values()).size).toBeGreaterThan(1);
    const frames = [...opened.values()];
    expect(Math.max(...frames) - Math.min(...frames)).toBeGreaterThan(10); // spread over ~1/6 s+
  });

  it('still waits out its OWN debris — the fumes are aftermath, not the blast', () => {
    // The hold is not simply removed: while the ground is moving a fresh crater stays silent for a
    // beat, and a big one for longer than a small one, because that is its own spoil clearing.
    const p = ps(() => true);
    p.blast(400, 300, 25, '#ff8c22', false);
    for (let i = 0; i < 6; i++) p.update(1 / 60); // 0.1s — inside every crater's delay
    expect(fumes(p)).toBe(0);
  });
});
