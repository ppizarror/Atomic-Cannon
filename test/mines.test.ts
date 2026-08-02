/**
 * Deployed mines follow gravity: when the ground beneath a mine is carved away (a hole is dug
 * under it), the mine falls onto the NEW surface instead of floating in mid-air.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';

import {CGameController} from '../src/game/CGameController';

function freshGame(): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.startGame(2);
  return gc;
}

/** Lower the terrain surface (dig a hole) by `depth` px across [x-half, x+half]. Screen-Y is
 *  down, so a lower surface means a LARGER height value. */
function digHole(gc: CGameController, x: number, depth: number, half = 30): void {
  const lp = gc.land as unknown as {m_arrHeights: Int16Array};
  for (let i = x - half; i <= x + half; i++) lp.m_arrHeights[i] = lp.m_arrHeights[i] + depth;
}

describe('Deployed mine gravity', () => {
  it('falls onto the new surface when the ground beneath it is carved away', () => {
    const gc = freshGame();
    const x = 400;
    const surf0 = gc.land.getHeightAt(x);
    gc.deployMine(x, surf0, null, 0); // resting on the original surface

    digHole(gc, x, 60); // carve a 60px-deep hole under it
    const newSurf = gc.land.getHeightAt(x);
    expect(newSurf).toBeGreaterThan(surf0); // surface is now lower

    // The mine is still floating at the old height until gravity runs.
    expect(priv(gc).m_mines[0].y).toBe(surf0);

    for (let f = 0; f < 240; f++) priv(gc).settleMines(1 / 60); // ~4s of falling

    expect(priv(gc).m_mines[0].y).toBeCloseTo(newSurf, 0); // landed on the new surface
    expect(priv(gc).m_mines[0].vy).toBe(0); // and came to rest
  });

  it('accelerates downward under gravity (does not teleport)', () => {
    const gc = freshGame();
    const x = 400;
    const surf0 = gc.land.getHeightAt(x);
    gc.deployMine(x, surf0, null, 0);
    digHole(gc, x, 200); // deep hole so it is airborne for several frames

    priv(gc).settleMines(1 / 60);
    const y1 = priv(gc).m_mines[0].y;
    priv(gc).settleMines(1 / 60);
    const y2 = priv(gc).m_mines[0].y;

    expect(y1).toBeGreaterThan(surf0); // it has started to drop
    expect(y2 - y1).toBeGreaterThan(0); // still moving down
    expect(priv(gc).m_mines[0].vy).toBeGreaterThan(0); // under gravity, speeding up
  });

  it('stays glued to the surface when the terrain is unchanged', () => {
    const gc = freshGame();
    const x = 400;
    const surf0 = gc.land.getHeightAt(x);
    gc.deployMine(x, surf0, null, 0);

    for (let f = 0; f < 60; f++) priv(gc).settleMines(1 / 60);

    expect(priv(gc).m_mines[0].y).toBe(surf0); // no drift when the ground hasn't moved
  });
});
