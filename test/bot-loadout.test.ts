/**
 * Bot inventory + smart weapon use (the "smarter bots" feature): a computer player owns its own
 * weapon loadout bound to its own credits, restocks a difficulty-scaled DEFENSIVE support pass
 * (shield/heal/armor…) plus a varied offensive assortment, and — the player-visible payoff —
 * actually SELF-BUFFS (shields/heals) when a stat is low instead of only lobbing ballistic rounds.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController, EGameState} from '../src/game/CGameController';
import {WEAPON_DATABASE} from '../src/core/CWeapon';
import {GameConfig} from '../src/core/CGameConfig';
import {CEconomy} from '../src/core/CEconomy';
import {aiRestock} from '../src/core/botEconomy';

type GC = {
  m_tanks: {isBot(): boolean; hit(n: number): number; setCredits(n: number): void}[];
  m_currentWeaponIndex: number;
  m_gameState: EGameState;
  economyFor(tank: unknown): {
    grant(i: number): void;
    getCredits(): number;
    getOwned(i: number): number;
  };
  botAimAndFire(tank: unknown): void;
};

const idOf = (s: string) => WEAPON_DATABASE.findIndex(w => w.id === s);
const ownsExt = (econ: {getOwned(i: number): number}, ext: number) =>
  WEAPON_DATABASE.some(w => (w.extType ?? 0) === ext && econ.getOwned(w.index) > 0);

/** A fresh 1-human + 1-bot match at the given difficulty; returns the controller and the bot tank. */
function botGame(level: number): {gc: CGameController; priv: GC; bot: GC['m_tanks'][number]} {
  GameConfig.landSize = 1;
  const gc = new CGameController(makeCanvas());
  gc.setStartCredits(50_000); // plenty for the bot to stock support
  gc.setHumanCount(1);
  gc.setDifficulty(level);
  gc.startGame(2); // team 0 = human (idx 0), team 1 = bot (idx 1)
  const priv = gc as unknown as GC;
  return {gc, priv, bot: priv.m_tanks[1]};
}

describe('Smarter bots — inventory + self-buff', () => {
  it('each bot fires from its OWN inventory, bound to its own credits', () => {
    const {priv, bot} = botGame(5);
    const human = priv.m_tanks[0];
    const be = priv.economyFor(bot);
    expect(be).not.toBe(priv.economyFor(human)); // separate from the human depot
    bot.setCredits(1234);
    expect(be.getCredits()).toBe(1234); // spends against the bot tank's own credits
  });

  it('a hurt high-difficulty bot with a heal in stock CHOOSES to heal, not attack', () => {
    const {priv, bot} = botGame(9);
    priv.economyFor(bot).grant(idOf('repairs')); // put a heal (value 250) in its loadout
    bot.hit(700); // life 1000 → 300, well under the maxLife − 250·0.7 = 825 threshold
    priv.m_gameState = EGameState.Battle;
    priv.botAimAndFire(bot);
    expect(priv.m_currentWeaponIndex).toBe(idOf('repairs')); // self-buff overrode the attack pick
  });

  it('a healthy bot with a heal in stock does NOT waste it — it attacks', () => {
    const {priv, bot} = botGame(9);
    priv.economyFor(bot).grant(idOf('repairs'));
    // full health → heal condition false → it should NOT select the heal
    priv.m_gameState = EGameState.Battle;
    priv.botAimAndFire(bot);
    expect(priv.m_currentWeaponIndex).not.toBe(idOf('repairs'));
  });

  // The restock doctrine is a pure function over an inventory + the buyer's condition (see
  // core/botEconomy), so these drive it directly — no match, no controller, no private reach.
  const restock = (difficulty: number, hurt: boolean) => {
    const econ = new CEconomy(50_000);
    let spent = 0;
    aiRestock({
      econ,
      stats: {
        life: hurt ? 300 : 1000, // hurt → under the heal guard (life < maxLife·0.7)
        maxLife: 1000,
        shield: 0,
        armor: 0,
        hazmat: 0,
        buried: false,
      },
      difficulty,
      rng: {float: () => 0.5},
      onSpent: () => spent++,
    });
    return {econ, spent};
  };

  it('a high-difficulty hurt bot restocks defensive support (shield + heal)', () => {
    const {econ} = restock(9, true); // L9 > 5, so shield+heal are gated in
    expect(ownsExt(econ, 7)).toBe(true); // bought a Shield
    expect(ownsExt(econ, 10)).toBe(true); // bought a Heal
    expect(ownsExt(econ, 16)).toBe(true); // and a Mine (L>4)
  });

  it('a LOW-difficulty bot does not stock defensive support', () => {
    const {econ} = restock(2, true); // L2: below every support gate
    expect(ownsExt(econ, 7)).toBe(false); // no shield
    expect(ownsExt(econ, 10)).toBe(false); // no heal
    expect(ownsExt(econ, 11)).toBe(false); // no armor
  });

  it('re-pools the squad balance after spending (ECON-1)', () => {
    // The controller passes `onSpent` to re-sync same-team tanks to the debited balance; without
    // it a squad-mate's later earn would pool a stale balance back and refund the whole restock.
    expect(restock(9, true).spent).toBe(1);
  });
});
