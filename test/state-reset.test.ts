/**
 * State-reset / taunt guards from the round-9 audits:
 *  - respawn() clears in-progress motion (drive target, jet fuel) so a tank respawned while a drive/jet
 *    was queued at battle-end doesn't crawl / fly on its first update.
 *  - setNetState() clears a locally-mispredicted explosion when the snapshot says the tank is alive
 *    (else a live tank renders as a wreck with no barrel/badge).
 *  - the victor's gloat bubble persists on the standings screen (bubbles don't age in BattleEnd).
 *  - a dead tank speaks only its death line, never an idle/gloat taunt (which would overwrite it).
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController, EGameState} from '../src/game/CGameController';
import {CTank} from '../src/core/CTank';
import {CLand} from '../src/core/CLand';
import {GameConfig} from '../src/core/CGameConfig';
import {Taunts} from '../src/core/CTaunts';

function flatLand(): CLand {
  const land = new CLand(1000, 500);
  land.generateFlat();
  return land;
}

describe('CTank respawn / setNetState resets', () => {
  it('respawn clears a queued drive and leftover jet fuel', () => {
    const land = flatLand();
    const t = new CTank('T', 0);
    t.init(400, land);
    t.startDrive(700); // queue a ground drive to a far column
    t.igniteJet(5); // and some jet fuel
    expect(t.getJetFuel()).toBeGreaterThan(0);

    t.respawn(200, land);
    t.update(land, 1 / 60); // first frame after respawn

    expect(t.getJetFuel()).toBe(0); // no leftover fuel
    expect(t.isMoving()).toBe(false); // no stale drive toward the old target
    expect(Math.abs(t.getPosition().x - 200)).toBeLessThan(5); // stayed at the respawn column
  });

  it('setNetState clears a mispredicted explosion when the snapshot says alive', () => {
    const prev = GameConfig.lethalDamage;
    GameConfig.lethalDamage = true;
    try {
      const land = flatLand();
      const t = new CTank('T', 0);
      t.init(400, land);
      t.hit(999999); // lethal → dead + m_bExploded
      expect(t.isAlive()).toBe(false);
      expect((t as unknown as {m_bExploded: boolean}).m_bExploded).toBe(true);

      t.setNetState({
        x: 400,
        y: t.getPosition().y,
        life: 100,
        shield: 0,
        armor: 0,
        hazmat: 0,
        credits: 0,
        alive: true,
      });

      expect(t.isAlive()).toBe(true);
      expect((t as unknown as {m_bExploded: boolean}).m_bExploded).toBe(false); // no longer a wreck
    } finally {
      GameConfig.lethalDamage = prev;
    }
  });
});

type TauntPriv = {
  m_bubbles: {age: number; speaker: CTank; text: string; id: number}[];
  m_gameState: EGameState;
  m_tanks: CTank[];
  updateTaunts(dt: number): void;
  tryTaunt(cat: string, speaker: CTank | null, pct: number): void;
};

describe('taunt bubbles', () => {
  function game(): TauntPriv {
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(1);
    gc.startGame(2);
    return gc as unknown as TauntPriv;
  }

  it('the victor gloat bubble persists on the standings screen (does not age in BattleEnd)', () => {
    const p = game();
    p.m_bubbles = [{id: 1, speaker: p.m_tanks[0], text: 'gg', age: 3.9}]; // near the 4s TAUNT_LIFE
    p.m_gameState = EGameState.BattleEnd;

    p.updateTaunts(1.0); // >TAUNT_LIFE of aging — would drop it if it aged

    expect(p.m_bubbles.length).toBe(1); // still there beside the winner flag
  });

  it('a dead tank speaks its death line but never an idle taunt', () => {
    const prev = GameConfig.chatter;
    GameConfig.chatter = true;
    Taunts.death = ['I regret nothing']; // seed a death line (lists are empty until i18n loads at boot)
    Taunts.taunt = ['You call that aim?'];
    try {
      const p = game();
      const t = p.m_tanks[0];
      (t as unknown as {m_bIsAlive: boolean}).m_bIsAlive = false; // dead
      p.m_bubbles = [];

      p.tryTaunt('taunt', t, 100); // idle/gloat — blocked for a dead tank
      expect(p.m_bubbles.length).toBe(0);

      p.tryTaunt('death', t, 100); // the death cry — allowed even though dead
      expect(p.m_bubbles.length).toBe(1);
    } finally {
      GameConfig.chatter = prev;
    }
  });
});
