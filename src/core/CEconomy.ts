/**
 * CEconomy — the human player's credits and per-weapon ammo inventory.
 *
 * The Weapons Depot spends credits to stock weapons; firing consumes a round.
 * Some staple weapons are UNLIMITED (never deplete) so a player is never left
 * unable to fire. Quantities are kept per weapon index into WEAPON_DATABASE.
 *
 * Tunable constants live at the top so they can be matched to the original.
 */
import { WEAPON_DATABASE, getDefaultWeaponIndex } from './CWeapon';

// Economy defaults, matching the original's documented settings. Credits are
// awarded between turns/rounds by these rates (earning is a future gameplay hook —
// the constants live here so it's one place to wire).
/** Credits a player starts a match with (original default: 3000 per tank). */
export const START_CREDITS = 3000;
/** Fraction of a weapon's cost refunded when sold (original: 50% sell-back rate). */
export const SELL_REFUND = 0.5;
/** Credits earned per point of damage dealt (default 1). */
export const CREDIT_PER_DAMAGE = 1;
/** Credits earned per kill (default 500). */
export const CREDIT_PER_KILL = 500;
/** Credits earned each round (default 1000). */
export const CREDIT_PER_ROUND = 1000;
/** Credits earned each turn (default 0). */
export const CREDIT_PER_TURN = 0;
/** Sentinel quantity meaning "never runs out". */
export const UNLIMITED = Number.POSITIVE_INFINITY;

/** Weapons that start unlimited (always fireable, not sold/bought). By default the
 * basic Shell, so the player can always take a shot. */
function defaultUnlimited(): number[] {
  return [getDefaultWeaponIndex()];
}

export class CEconomy {
  private m_credits: number;
  private m_owned: number[];   // per weapon index; UNLIMITED for staples

  constructor(startCredits = START_CREDITS, unlimited: number[] = defaultUnlimited()) {
    this.m_credits = startCredits;
    this.m_owned = new Array(WEAPON_DATABASE.length).fill(0);
    for (const i of unlimited) if (i >= 0 && i < this.m_owned.length) this.m_owned[i] = UNLIMITED;
  }

  getCredits(): number { return this.m_credits; }
  addCredits(n: number): void { this.m_credits = Math.max(0, this.m_credits + n); }

  /** Owned rounds for a weapon (UNLIMITED for staples, 0 if none). */
  getOwned(index: number): number { return this.m_owned[index] ?? 0; }
  isUnlimited(index: number): boolean { return this.m_owned[index] === UNLIMITED; }

  /** A weapon is fireable if unlimited or at least one round is in stock. */
  hasStock(index: number): boolean { return this.getOwned(index) > 0; }

  private cost(index: number): number { return WEAPON_DATABASE[index]?.cost ?? 0; }

  /** Can the player afford one more of this weapon? (Unlimited staples aren't bought.) */
  canBuy(index: number): boolean {
    if (this.isUnlimited(index)) return false;
    return this.m_credits >= this.cost(index);
  }

  /** Buy one round: deduct the cost, add to stock. Returns whether it went through. */
  buy(index: number): boolean {
    if (!this.canBuy(index)) return false;
    this.m_credits -= this.cost(index);
    this.m_owned[index] = this.getOwned(index) + 1;
    return true;
  }

  /** True if this weapon can be sold (owned, finite, at least one round). */
  canSell(index: number): boolean {
    return !this.isUnlimited(index) && this.getOwned(index) > 0;
  }

  /** Sell one round: refund a fraction of the cost, remove from stock. */
  sell(index: number): boolean {
    if (!this.canSell(index)) return false;
    this.m_owned[index] = this.getOwned(index) - 1;
    this.m_credits += Math.round(this.cost(index) * SELL_REFUND);
    return true;
  }

  /** Consume one round on fire. Unlimited staples never deplete. Returns whether a
   * shot was allowed (always true for unlimited / in-stock, false if empty). */
  consume(index: number): boolean {
    if (this.isUnlimited(index)) return true;
    if (this.getOwned(index) <= 0) return false;
    this.m_owned[index] = this.getOwned(index) - 1;
    return true;
  }

  /**
   * Auto Buy: a "drain loop" like the original — repeatedly pick a random
   * affordable weapon and buy it until nothing is left affordable, spending nearly
   * all credits on a varied, semi-random assortment (the Shell staple is excluded).
   * The original also front-loads a few support weapons scaled to AI difficulty;
   * that difficulty-gated pass isn't modelled here.
   */
  autoBuy(): void {
    // Guard against pathological loops (every buy removes at least the cheapest cost).
    for (let guard = 0; guard < 5000; guard++) {
      const affordable: number[] = [];
      for (let i = 0; i < WEAPON_DATABASE.length; i++) {
        if (!this.isUnlimited(i) && WEAPON_DATABASE[i].cost > 0 && WEAPON_DATABASE[i].cost <= this.m_credits) {
          affordable.push(i);
        }
      }
      if (affordable.length === 0) break;
      this.buy(affordable[Math.floor(Math.random() * affordable.length)]);
    }
  }

  /** Snapshot of owned counts (for mirroring to the UI). */
  ownedSnapshot(): number[] { return this.m_owned.slice(); }
}
