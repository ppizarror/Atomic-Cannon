/**
 * "Winning the war" standings — per-tank war stats aggregate into per-team rows, the
 * leading team (most kills, tie-break life%) drives the title, and the battle→next-battle
 * flow keeps cumulative stats.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController, EGameType} from '../src/game/CGameController';
import {CTank} from '../src/core/CTank';
import {Roster} from '../src/core/CRoster';

// Reach into the controller's privates the tests need to drive directly.
type Priv = {m_tanks: CTank[]; endTurn(): void};

// Three distinct-colour tanks = three teams (free-for-all).
function newGame(): CGameController {
  Roster.players = [];
  const gc = new CGameController(makeCanvas());
  gc.setGameType(EGameType.Deathmatch);
  gc.setTotalBattles(5);
  gc.startGame(3);
  return gc;
}

describe('Winning the war', () => {
  it('aggregates stats into team rows led by the top-kills team', () => {
    const gc = newGame();
    const t = (gc as unknown as Priv).m_tanks;
    // t[0] dominates: 5 kills, 10 shots, 8 hits, 800 dmg. t[1]: 2 kills. t[2]: none.
    for (let i = 0; i < 5; i++) t[0].addKill();
    for (let i = 0; i < 10; i++) t[0].addShot();
    for (let i = 0; i < 8; i++) t[0].addHit(100);
    t[1].addKill();
    t[1].addKill();
    // Kill t[1] and t[2] so only t[0]'s team survives → battle ends.
    t[1].hit(999999);
    t[2].hit(999999);
    (gc as unknown as Priv).endTurn();

    const s = gc.getWarStandings();
    expect(s.rows[0].isLeader).toBe(true);
    expect(s.rows[0].kills).toBe(5);
    expect(s.rows[0].kills).toBeGreaterThanOrEqual(s.rows[1].kills); // sorted by kills desc
    expect(Math.round(s.rows[0].accuracyPct)).toBe(80); // hits/shots
    expect(Math.round(s.rows[0].damagePerHit)).toBe(100); // damage/hits
    expect(s.title).toBe(`${t[0].getName()} is winning the war.`);
    expect(s.subtitle.some(l => l.includes('1 of 5'))).toBe(true); // battle 1 of 5
    expect(s.prompt).toContain('play next battle'); // war ongoing
    expect(s.winCondition.length).toBeGreaterThan(0); // deathmatch win condition
  });

  it('reports negative damage/hit from friendly fire', () => {
    const gc = newGame();
    const t = (gc as unknown as Priv).m_tanks;
    // One shot that only ever hit a teammate/self → net negative damage.
    t[0].addShot();
    t[0].addHit(-50); // friendly-fire contribution is stored negative
    const s = gc.getWarStandings();
    const row = s.rows.find(r => r.name === t[0].getName())!;
    expect(row.damagePerHit).toBe(-50);
  });

  it('final battle → "wins the war!" + exit prompt', () => {
    const gc = newGame();
    const t = (gc as unknown as Priv).m_tanks;
    gc.setTotalBattles(1); // single battle → this IS the final
    t[0].addKill();
    t[1].hit(999999);
    t[2].hit(999999);
    (gc as unknown as Priv).endTurn();
    const s = gc.getWarStandings();
    expect(s.title).toBe(`${t[0].getName()} wins the war!`);
    expect(s.prompt).toContain('exit to menu');
    expect(s.warOver).toBe(true);
  });

  it('rounds mode → "wins the battle!" with no war subtitle', () => {
    const gc = newGame();
    gc.setGameType(EGameType.Rounds);
    const t = (gc as unknown as Priv).m_tanks;
    t[0].addKill();
    t[1].hit(999999);
    t[2].hit(999999);
    (gc as unknown as Priv).endTurn();
    const s = gc.getWarStandings();
    expect(s.title).toBe(`${t[0].getName()} wins the battle!`);
    expect(s.pointsMode).toBe(true); // uses the Points column
    expect(s.subtitle).toHaveLength(0);
  });

  it('nextBattle keeps cumulative stats and advances the counter', () => {
    const gc = newGame();
    const t = (gc as unknown as Priv).m_tanks;
    t[0].addKill();
    t[0].addKill();
    gc.nextBattle();
    expect(gc.getBattleNum()).toBe(2);
    expect(t[0].getKills()).toBe(2); // kills carry across battles
    expect(t[0].isAlive() && t[1].isAlive() && t[2].isAlive()).toBe(true); // respawned full
  });
});
