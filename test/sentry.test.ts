/**
 * Sentry turrets: a deployed Sentry weapon becomes a stationary "Sentry" tank on the
 * owner's team that renders with the Sentry sprites, takes damage, auto-aims at the
 * nearest enemy and fires in a direct line (Turret → Shell, Minigun → Machine Gun, and
 * the Minigun variant is tougher). A turret must land where it can be SEEN, and it keeps
 * its team in the battle after its owner dies (solo only — net defers to the server).
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';

import {CGameController, EGameState} from '../src/game/CGameController';
import {CTank} from '../src/core/CTank';
import {WEAPON_DATABASE, weaponName} from '../src/core/CWeapon';
import {GameConfig} from '../src/core/CGameConfig';

// Weapon display names come from i18n (data/weapons.json carries only the id slug),
// so look weapons up by their localised name.
const idxOf = (name: string) => WEAPON_DATABASE.findIndex(w => weaponName(w) === name);
const SENTRY_TURRET = idxOf('Sentry Turret');
const SENTRY_MINIGUN = idxOf('Sentry Minigun');
const SHELL = idxOf('Shell');
const MACHINE_GUN = idxOf('Machine Gun');

// Private-field view for driving the internals a real deploy/turn would.
/** Spawn a match and return the controller + its two enemy tanks. */
function twoPlayerGame(): {gc: CGameController; a: CTank; b: CTank} {
  GameConfig.hitpoints = 1000;
  const gc = new CGameController(makeCanvas());
  gc.startGame(2);
  const [a, b] = priv(gc).m_tanks;
  return {gc, a, b};
}

describe('Sentry turrets', () => {
  it('deploys as a stationary "Sentry" tank on the owner team, using the Sentry sprites', () => {
    const {gc, a} = twoPlayerGame();
    const before = priv(gc).m_tanks.length;

    gc.deploySentry(a.getPosition().x + 30, 0, a, SENTRY_TURRET);

    const tanks = priv(gc).m_tanks;
    expect(tanks.length).toBe(before + 1); // a new entity joined the field
    const sentry = tanks[tanks.length - 1];
    expect(sentry.getTankType()).toBe('Sentry'); // → tanks/Sentry body|turret|wreck sprites
    // The badge shows the OWNER's name (the type "Sentry" is internal, never drawn).
    expect(sentry.getName()).toBe(a.getName());
    expect(sentry.getTeamId()).toBe(a.getTeamId()); // fights for its owner's team
    expect(sentry.isAlive()).toBe(true);
    expect(sentry.getMaxLife()).toBe(200); // Turret HP = its deploy weapon's fixed value (not match HP)
  });

  it('Minigun variant has more health than the Turret variant', () => {
    const {gc, a} = twoPlayerGame();
    gc.deploySentry(a.getPosition().x + 30, 0, a, SENTRY_MINIGUN);
    const sentry = priv(gc).m_tanks.at(-1)!;
    // A fixed per-weapon value (500), not the match Hit-Points nor a ×2 — but still tougher than the Turret's 200.
    expect(sentry.getMaxLife()).toBe(500);
  });

  it('on its turn a sentry aims at the nearest enemy and picks the right weapon', () => {
    const {gc, a, b} = twoPlayerGame();
    // Park the enemy to the RIGHT of where the sentry drops.
    const sentryX = a.getPosition().x;
    b.respawn(sentryX + 200, priv(gc).m_land);

    gc.deploySentry(sentryX, 0, a, SENTRY_TURRET);
    const sentry = priv(gc).m_tanks.at(-1)!;

    // Make the sentry the acting tank and run its turn (aim + weapon select happen
    // synchronously; the shot itself is scheduled).
    priv(gc).m_currentPlayerIndex = priv(gc).m_tanks.indexOf(sentry);
    priv(gc).executeSentryTurn();

    expect(sentry.getWeaponIndex()).toBe(SHELL); // Turret variant → Shell
    // Aimed toward the enemy on the right: barrel points right (positive x component).
    expect(sentry.aimUnit().x).toBeGreaterThan(0);
  });

  it('Minigun variant fires the Machine Gun on its turn', () => {
    const {gc, a, b} = twoPlayerGame();
    b.respawn(a.getPosition().x + 150, priv(gc).m_land);
    gc.deploySentry(a.getPosition().x, 0, a, SENTRY_MINIGUN);
    const sentry = priv(gc).m_tanks.at(-1)!;
    priv(gc).m_currentPlayerIndex = priv(gc).m_tanks.indexOf(sentry);
    priv(gc).executeSentryTurn();
    expect(sentry.getWeaponIndex()).toBe(MACHINE_GUN >= 0 ? MACHINE_GUN : SHELL);
  });

  it('Minigun sentry still holds the Machine Gun THROUGH fire() (not swapped to the staple Shell)', () => {
    const {gc, a, b} = twoPlayerGame();
    b.respawn(a.getPosition().x + 150, priv(gc).m_land);
    gc.deploySentry(a.getPosition().x, 0, a, SENTRY_MINIGUN);
    const sentry = priv(gc).m_tanks.at(-1)!;
    priv(gc).m_currentPlayerIndex = priv(gc).m_tanks.indexOf(sentry);
    priv(gc).m_gameState = EGameState.Battle;
    priv(gc).executeSentryTurn();
    expect(sentry.getWeaponIndex()).toBe(MACHINE_GUN); // selected the Machine Gun

    // fire() is what the sentry's scheduled turn calls. A sentry reports isBot(), so the bot
    // ammo-charge path would claim it → ensureStocked finds no MG rounds in its empty economy →
    // swaps it back to the Shell. It must keep the Machine Gun (sentries hold no inventory).
    priv(gc).fire();
    expect(sentry.getWeaponIndex()).toBe(MACHINE_GUN);
  });

  it('a lone survivor plus their OWN sentry is still one team → the battle ends', () => {
    const {gc, a, b} = twoPlayerGame();
    gc.deploySentry(a.getPosition().x + 30, 0, a, SENTRY_TURRET);
    // Only the owner (a) + their sentry survive — b, the sole enemy player, dies.
    b.hit(999999);
    expect(b.isAlive()).toBe(false);

    priv(gc).m_gameState = EGameState.Battle; // endBattleIfDecided only acts in Battle
    priv(gc).endBattleIfDecided();
    // A sentry carries its owner's team id, so it can never make the winner's own side "two teams".
    expect(priv(gc).m_gameState).toBe(EGameState.BattleEnd);
  });

  it("a dead player's sentry keeps their team in the fight until it too is destroyed", () => {
    const {gc, b} = twoPlayerGame();
    // The turret belongs to b — who then dies, leaving it as the only thing standing for that team.
    const bx = b.getPosition().x;
    gc.deploySentry(bx + (bx > priv(gc).m_land.width / 2 ? -30 : 30), 0, b, SENTRY_TURRET); // inboard of b
    const sentry = priv(gc).m_tanks.at(-1)!;
    expect(sentry.isSentry()).toBe(true);
    expect(sentry.getTeamId()).toBe(b.getTeamId());
    b.hit(999999);
    expect(b.isAlive()).toBe(false);

    priv(gc).m_gameState = EGameState.Battle;
    priv(gc).endBattleIfDecided();
    // NOT over: the turret takes its own turns and can still kill a — ending here would call a
    // fight the loser's turret never got to finish.
    expect(priv(gc).m_gameState).toBe(EGameState.Battle);

    // Destroy the turret and the battle is genuinely decided.
    sentry.hit(999999);
    priv(gc).endBattleIfDecided();
    expect(priv(gc).m_gameState).toBe(EGameState.BattleEnd);
  });

  it('a battle carried by a lone turret still RESOLVES — it takes real turns and can be killed', () => {
    // The point of the rule above is that the fight goes ON. Drive the whole thing for real, because
    // "the battle never ends" is the way it could go wrong: an ownerless turret that never got a turn
    // (or an enemy that never targeted it) would hang the match instead of finishing it.
    const realPerf = globalThis.performance;
    const landSize = GameConfig.landSize;
    try {
      // ScreenShake decays on the WALL clock and gates the Explosion → endTurn hand-off, so a sim
      // running 100× real time would leave every blast permanently "shaking" and wedge the turn.
      let fakeNow = 0;
      (globalThis as {performance?: unknown}).performance = {now: () => fakeNow};
      GameConfig.landSize = 1; // one screen: the duel is in range without cross-map driving
      GameConfig.hitpoints = 1000;
      const gc = new CGameController(makeCanvas(900, 600));
      gc.setHumanCount(0); // both sides played by the AI, so the match runs unattended
      gc.startGame(2);
      const [a, b] = priv(gc).m_tanks;

      // Drop it 40px INBOARD of b (a tank can spawn 60px from the edge, and a turret landing
      // inside the edge margin is refused — see the off-map test — which would leave no turret).
      const bx = b.getPosition().x;
      gc.deploySentry(bx + (bx > priv(gc).m_land.width / 2 ? -40 : 40), 0, b, SENTRY_TURRET);
      const sentry = priv(gc).m_tanks.at(-1)!;
      expect(sentry.isSentry()).toBe(true);
      b.hit(999999); // b's team is now nothing but that one turret

      const acted = new Set<number>();
      let ticks = 0;
      for (; ticks < 600 * 60; ticks++) {
        fakeNow += 1000 / 60;
        gc.update(1 / 60);
        acted.add(priv(gc).m_currentPlayerIndex);
        if (priv(gc).m_gameState === EGameState.BattleEnd) break;
      }

      expect(acted.has(priv(gc).m_tanks.indexOf(sentry))).toBe(true); // the turret really played on
      expect(priv(gc).m_gameState).toBe(EGameState.BattleEnd); // …and the battle finished
      expect(sentry.isAlive()).toBe(false); // it ended because the turret died, not by timeout
      expect(a.isAlive()).toBe(true);
    } finally {
      (globalThis as {performance?: unknown}).performance = realPerf;
      GameConfig.landSize = landSize;
    }
  });

  it('NET: a sentry never keeps the battle alive (the server decides from a snapshot without them)', () => {
    const {gc, a, b} = twoPlayerGame();
    priv(gc).m_netMode = true;
    const bx = b.getPosition().x;
    gc.deploySentry(bx + (bx > priv(gc).m_land.width / 2 ? -30 : 30), 0, b, SENTRY_TURRET); // inboard of b
    expect(priv(gc).m_tanks.at(-1)!.isSentry()).toBe(true);
    b.hit(999999);
    expect(a.isAlive()).toBe(true);
    // Room.battleDecided counts only the squad tanks the snapshot carries, and the SERVER drives the
    // turn order — a client that held the battle open for a sentry would just disagree with it.
    expect(gc.isNetBattleOver()).toBe(true);
  });

  it('a round that lands off the map deploys NOTHING (an unseeable turret is not allowed)', () => {
    const {gc, a} = twoPlayerGame();
    const before = priv(gc).m_tanks.length;
    const w = priv(gc).m_land.width;

    // A sentry shot still meets the ground up to 60px beyond either edge — where no camera reaches.
    gc.deploySentry(-40, 0, a, SENTRY_TURRET);
    gc.deploySentry(w + 40, 0, a, SENTRY_TURRET);
    // …and one landing ON the border would only be half-drawn, so it's refused too.
    gc.deploySentry(4, 0, a, SENTRY_TURRET);
    gc.deploySentry(w - 4, 0, a, SENTRY_TURRET);
    expect(priv(gc).m_tanks.length).toBe(before); // every one of them a dud

    // An ordinary landing, well inside the world, still deploys.
    gc.deploySentry(w / 2, 0, a, SENTRY_TURRET);
    expect(priv(gc).m_tanks.length).toBe(before + 1);
  });

  it('the deploy cap is PER PLAYER — one player cannot use up another’s allowance', () => {
    const {gc, a, b} = twoPlayerGame();
    const roster = priv(gc).m_tanks.length;
    const sentriesOf = (t: CTank) =>
      priv(gc).m_tanks.filter(x => x.isSentry() && x.getTeamId() === t.getTeamId()).length;

    // Player A spends its whole allowance and then some — the surplus deploys are dropped.
    for (let i = 0; i < 20; i++) gc.deploySentry(a.getPosition().x + i, 0, a, SENTRY_TURRET);
    const capped = sentriesOf(a);
    expect(capped).toBeLessThan(20); // a ceiling really is enforced (free-fire ammo is unlimited)
    expect(priv(gc).m_tanks.length).toBe(roster + capped);

    // …and player B still has its own full allowance: a shared pool would have starved it.
    for (let i = 0; i < 20; i++) gc.deploySentry(b.getPosition().x + i, 0, b, SENTRY_TURRET);
    expect(sentriesOf(b)).toBe(capped);
    expect(sentriesOf(a)).toBe(capped); // B's deploys never evicted A's
  });

  it('every player keeps its allowance in a big match (16 players, 5 tanks each)', () => {
    // The sentry budget is PER PLAYER: a global pool lets the first deployers consume it and
    // leaves the rest silently with nothing — worse the more players join.
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(8); // the Play menu's maximum split: 8 humans + 8 CPUs = 16 roster slots
    gc.setTanksPerTeam(5);
    gc.startGame(16);
    const tanks = priv(gc).m_tanks.slice();
    const leaders = tanks.filter((t, i) => tanks.findIndex(x => x.getTeamId() === t.getTeamId()) === i);
    expect(leaders).toHaveLength(16); // 16 distinct teams on the field

    for (const t of leaders) {
      for (let i = 0; i < 3; i++) gc.deploySentry(t.getPosition().x + i, 0, t, SENTRY_TURRET);
    }
    for (const t of leaders) {
      const mine = priv(gc).m_tanks.filter(x => x.isSentry() && x.getTeamId() === t.getTeamId());
      expect(mine).toHaveLength(3); // the LAST player deployed just as many as the first
    }
  });
});
