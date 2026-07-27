/**
 * Two-radius blast damage (recovered from the original's blast routine):
 *   • full damage inside the inner CORE (0.5·size + collR),
 *   • LINEAR falloff — normalized by the OUTER field (radius + collR) — out to zero,
 *   • a step DOWN at the core edge (core is flat full damage, not a smooth peak),
 *   • nothing beyond the outer field.
 * The target's own collision radius is ADDED to both radii (a target-size bonus).
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {CTank} from '../src/core/CTank';
import {GameConfig} from '../src/core/CGameConfig';
import {Vec2} from '../src/math/Vec2';

type GCInternals = {m_tanks: CTank[]};
const priv = (gc: CGameController) => gc as unknown as GCInternals;

const RADIUS = 100; // outer-field base
const INNER = 20; // inner-core base
const DMG = 10000;

function freshGame(scale = 1): CGameController {
  GameConfig.tankSizeScale = scale;
  GameConfig.hitpoints = 1_000_000; // survive full damage so we can measure the fraction
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.startGame(2);
  return gc;
}

/** Fire one blast `offsetX` px to the side of the target; return the life it removed and
 *  the TRUE distance the routine measured (from the tank's hit-box centre, not its feet). */
function measure(gc: CGameController, offsetX: number): {removed: number; dist: number} {
  const [shooter, target] = priv(gc).m_tanks;
  target.setMaxLife(1_000_000); // heal to full → each measurement is independent
  const p = target.getPosition();
  const bx = p.x + offsetX;
  const by = p.y;
  const dist = target.distanceTo(bx, by); // what applyBlast will use internally
  const before = target.getHealth().nLife;
  gc.applyBlast(new Vec2(bx, by), RADIUS, DMG, shooter, false, false, INNER);
  return {removed: before - target.getHealth().nLife, dist};
}

describe('Two-radius blast damage', () => {
  it('matches full-core → linear-falloff → zero across the whole range', () => {
    const gc = freshGame();
    const collR = priv(gc).m_tanks[1].getHitRadius();
    const inner = INNER + collR;
    const outer = RADIUS + collR;
    // The exact model: flat full damage in the core, linear to zero at the outer edge.
    const expected = (d: number) => (d <= inner ? DMG : d >= outer ? 0 : DMG * (1 - d / outer));

    for (const ox of [0, 10, 25, 45, 65, 85, 105, 118, 130, 250]) {
      const {removed, dist} = measure(gc, ox);
      expect(removed).toBeCloseTo(expected(dist), 1); // within ~0.05 of the formula
    }
  });

  it('is flat in the core and steps DOWN at the core edge (not a smooth peak)', () => {
    const gc = freshGame();
    const collR = priv(gc).m_tanks[1].getHitRadius();
    const inner = INNER + collR;
    const outer = RADIUS + collR;

    // Two points both inside the core deal the SAME full damage (flat, no peak).
    const coreA = measure(gc, 0).removed;
    const coreB = measure(gc, inner - 14).removed; // still inside the core after the ~12px y-offset
    expect(coreA).toBe(DMG);
    expect(coreB).toBe(DMG);

    // Just outside the core, damage has already dropped BELOW full (the discontinuity).
    const justOut = measure(gc, inner + 6);
    expect(justOut.dist).toBeGreaterThan(inner);
    expect(justOut.removed).toBeLessThan(DMG);
    expect(justOut.removed).toBeGreaterThan(0);

    // Beyond the outer field → nothing.
    expect(measure(gc, outer + 5).removed).toBe(0);
  });

  it('the target collision radius extends the outer field', () => {
    // Scale the tank up (collR is a live function of tankSizeScale). Its outer field is
    // RADIUS + collR, so a hit beyond a base tank's outer (RADIUS + 16) but within this
    // bigger tank's outer still lands — proving collR is added to the radius.
    const big = freshGame(2);
    const bigR = priv(big).m_tanks[1].getHitRadius();
    expect(bigR).toBeGreaterThan(16); // scaled up from the base 16

    let banded: {removed: number; dist: number} | null = null;
    for (const ox of [105, 110, 115, 120, 125]) {
      const m = measure(big, ox);
      if (m.dist > RADIUS + 16 && m.dist < RADIUS + bigR) {
        banded = m;
        break;
      }
    }
    expect(banded).not.toBeNull(); // found a hit past a base tank's reach but within this one's
    expect(banded!.removed).toBeGreaterThan(0);

    GameConfig.tankSizeScale = 1; // restore for other tests
  });

  it('knockback scales with explosion size (a bigger blast shoves harder for equal damage)', () => {
    const gc = freshGame();
    const [shooter, target] = priv(gc).m_tanks;
    GameConfig.kickbackScale = 1;

    // Impulse magnitude the kick imparts: kick adds `dir·force` to a resting tank, and dir is a
    // unit vector, so |velocity| after a single kick == the force. Same damage + same (core) hit
    // distance each time — only the blast radius differs.
    const kickForce = (radius: number): number => {
      (target as unknown as {m_vVel: Vec2}).m_vVel = new Vec2(0, 0); // reset the impulse
      target.setMaxLife(1_000_000); // survive so `removed` is the full damage each time
      const p = target.getPosition();
      gc.applyBlast(new Vec2(p.x, p.y), radius, 5000, shooter, false, false, 10); // direct core hit
      const v = (target as unknown as {m_vVel: {x: number; y: number}}).m_vVel;
      return Math.hypot(v.x, v.y);
    };

    const small = kickForce(20); // sizeFactor clamps to 0.4
    const big = kickForce(120); // sizeFactor clamps to 2.4
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small * 2); // ~6× by radius ratio — decisively size-dependent

    GameConfig.kickbackScale = 1; // leave a known state
  });
});
