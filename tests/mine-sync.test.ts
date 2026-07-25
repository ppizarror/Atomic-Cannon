/**
 * Mines are authoritative net state: getNetSnapshot carries them (position, arm countdown, weapon,
 * owner-by-index), applyNetSnapshot reproduces them, and stateHash mixes them so a mine that drifted
 * / armed / detonated on one client but not another is DETECTED. Before this they were invisible to
 * the drift detector and absent from reconnect bootstraps.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController} from '../src/game/CGameController';
import type {CTank} from '../src/core/CTank';

type Priv = {m_tanks: CTank[]; m_mines: {x: number; owner: CTank | null; armed: number}[]};
const priv = (gc: CGameController) => gc as unknown as Priv;

function game(): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(2);
  gc.startGame(2);
  return gc;
}

describe('mine net sync', () => {
  it('a snapshot round-trip reproduces mines and syncs the full hashed state', () => {
    const a = game();
    a.deployMine(123, 200, priv(a).m_tanks[0], 5);
    const snap = a.getNetSnapshot();
    expect(snap.mines).toHaveLength(1);
    expect(snap.mines?.[0]).toMatchObject({x: 123, weaponIndex: 5, ownerIdx: 0});

    const b = game(); // independent world (different random terrain, no mine)
    expect(b.stateHash()).not.toBe(a.stateHash());

    b.applyNetSnapshot(snap);

    // Everything the hash mixes — tanks, terrain, rng AND mines — is now identical.
    expect(b.stateHash()).toBe(a.stateHash());
    const m = priv(b).m_mines[0];
    expect(m.x).toBe(123);
    expect(m.owner).toBe(priv(b).m_tanks[0]); // owner re-linked from its index
  });

  it('stateHash reflects a mine and its arm state', () => {
    const a = game();
    const h0 = a.stateHash();

    a.deployMine(100, 200, null, 3);
    const h1 = a.stateHash();
    expect(h1).not.toBe(h0); // a new mine changes the hash

    priv(a).m_mines[0].armed = 0; // arming → armed transition
    expect(a.stateHash()).not.toBe(h1); // the armed state is part of the hash
  });
});
