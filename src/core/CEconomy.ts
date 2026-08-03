/**
 * CEconomy — the human player's credits and per-weapon ammo inventory.
 *
 * The Weapons Depot spends credits to stock weapons; firing consumes a round.
 * Some staple weapons are UNLIMITED (never deplete) so a player is never left
 * unable to fire. Quantities are kept per weapon index into WEAPON_DATABASE.
 *
 * Tunable constants live at the top so they are easy to adjust in one place.
 */
import {WEAPON_DATABASE, getDefaultWeaponIndex, weaponIndices} from './CWeapon';
import {weaponEnabled} from './CGameContent';
import {UTILITY_EXT} from './weapons/ExtType';
import {clamp01} from '../math/num';

// Economy defaults. Credits are awarded between turns/rounds by these rates
// (earning is a future gameplay hook — the constants live here so it's one place
// to wire).
/** Credits a player starts a match with (default: 3000 per tank). */
export const START_CREDITS = 3000;
/** Fraction of a weapon's cost refunded when sold (default: 50% sell-back rate). */
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
 *  basic Shell, so the player can always take a shot. */
function defaultUnlimited(): number[] {
  return [getDefaultWeaponIndex()];
}

/** A per-tank credit balance the economy can spend against. CTank implements this,
 *  so the human's depot operates directly on the human tank's credits. */
export interface CreditHolder {
  getCredits(): number;
  addCredits(n: number): void;
  setCredits(n: number): void;
}

export class CEconomy {
  private readonly m_owned: number[]; // per weapon index; UNLIMITED for staples
  // Weapon indices in the order they were FIRST acquired (bought / granted) — drives the arsenal's
  // buy-order numbering. Unlimited staples (the Shell) are never recorded here: they keep position 1,
  // then bought weapons follow in this order ("2." = first bought, "3." next, …).
  private m_order: number[] = [];
  // Free-fire (dev weapon-test): treat EVERY weapon as unlimited. It's a mode of the
  // inventory itself — the single source of truth for "in stock / unlimited / consume" —
  // so the depot, the arsenal and the fire path all agree without any external flag.
  // Deliberately NOT cleared by reset(), so a fresh match under weapon-test stays unlimited.
  private m_freeFire = false;
  private m_sellRate = SELL_REFUND; // fraction refunded on sell (Economy → Sell Back Rate)
  // Credits live on a bound holder (the human tank) once set; until then an internal
  // balance is used (construction, unit tests).
  private m_holder: CreditHolder | null = null;
  private m_credits: number;

  constructor(startCredits = START_CREDITS, unlimited: number[] = defaultUnlimited()) {
    this.m_credits = startCredits;
    this.m_owned = Array.from({length: WEAPON_DATABASE.length}, () => 0);
    for (const i of unlimited) if (i >= 0 && i < this.m_owned.length) this.m_owned[i] = UNLIMITED;
  }

  /** Route credits through a per-tank balance (the human tank). */
  bindCredits(h: CreditHolder): void {
    this.m_holder = h;
  }

  private creditsGet(): number {
    return this.m_holder ? this.m_holder.getCredits() : this.m_credits;
  }
  private creditsAdd(n: number): void {
    if (this.m_holder) this.m_holder.addCredits(n);
    else this.m_credits = Math.max(0, this.m_credits + n);
  }
  private creditsSet(n: number): void {
    if (this.m_holder) this.m_holder.setCredits(n);
    else this.m_credits = Math.max(0, n);
  }

  /** Reset to a fresh match: `startCredits` on hand, only the staples in stock. */
  reset(startCredits = START_CREDITS, unlimited: number[] = defaultUnlimited()): void {
    this.creditsSet(startCredits);
    this.m_owned.fill(0);
    this.m_order.length = 0; // fresh match → buy-order numbering restarts
    for (const i of unlimited) if (i >= 0 && i < this.m_owned.length) this.m_owned[i] = UNLIMITED;
  }

  /** Record a weapon as acquired (first buy/grant) for the arsenal's buy-order numbering. Idempotent
   *  — the first acquisition fixes its rank; buying more of the same weapon doesn't change it. */
  private recordAcquire(index: number): void {
    if (!this.m_order.includes(index)) this.m_order.push(index);
  }

  /** Weapon indices in first-acquired order (bought/granted, excluding unlimited staples). The
   *  arsenal renders the staple(s) first, then bought weapons in this order. */
  getAcquireOrder(): readonly number[] {
    return this.m_order;
  }

  /** Set the sell-back refund fraction (0..1). */
  setSellRate(fraction: number): void {
    this.m_sellRate = clamp01(fraction);
  }

  getCredits(): number {
    return this.creditsGet();
  }

  addCredits(n: number): void {
    this.creditsAdd(n);
  }

  /** Free-fire mode: when on, every weapon reads as unlimited (dev weapon-test). */
  setFreeFire(on: boolean): void {
    this.m_freeFire = on;
  }
  isFreeFire(): boolean {
    return this.m_freeFire;
  }

  /** Owned rounds for a weapon (UNLIMITED for staples / free-fire, 0 if none). */
  getOwned(index: number): number {
    if (this.m_freeFire) return UNLIMITED;
    return this.m_owned[index] ?? 0;
  }

  isUnlimited(index: number): boolean {
    return this.m_freeFire || this.m_owned[index] === UNLIMITED;
  }

  /** Mark a weapon as unlimited (dev: ?weaponsel=<id>). */
  setUnlimited(index: number): void {
    if (index >= 0 && index < this.m_owned.length) this.m_owned[index] = UNLIMITED;
  }

  /** A weapon is fireable if unlimited or at least one round is in stock. */
  hasStock(index: number): boolean {
    return this.getOwned(index) > 0;
  }

  private cost(index: number): number {
    return WEAPON_DATABASE[index]?.cost ?? 0;
  }

  /** Can the player afford one more of this weapon? (Unlimited staples aren't bought.) */
  canBuy(index: number): boolean {
    if (this.isUnlimited(index)) return false;
    return this.creditsGet() >= this.cost(index);
  }

  /** Buy one round: deduct the cost, add to stock. Returns whether it went through. */
  buy(index: number): boolean {
    if (!this.canBuy(index)) return false;
    this.creditsAdd(-this.cost(index));
    this.m_owned[index] = this.getOwned(index) + 1;
    this.recordAcquire(index); // buy-order numbering
    return true;
  }

  /** Grant one round for free (a crate pickup) — adds to stock without charging, and
   *  never touches unlimited staples. */
  grant(index: number): void {
    if (index < 0 || index >= this.m_owned.length || this.isUnlimited(index)) return;
    this.m_owned[index] = this.getOwned(index) + 1;
    this.recordAcquire(index); // buy-order numbering
  }

  /** True if this weapon can be sold (owned, finite, at least one round). */
  canSell(index: number): boolean {
    return !this.isUnlimited(index) && this.getOwned(index) > 0;
  }

  /** Sell one round: refund a fraction of the cost, remove from stock. */
  sell(index: number): boolean {
    if (!this.canSell(index)) return false;
    this.m_owned[index] = this.getOwned(index) - 1;
    this.creditsAdd(Math.round(this.cost(index) * this.m_sellRate));
    return true;
  }

  /** Consume one round on fire. Unlimited staples never deplete. Returns whether a
   *  shot was allowed (always true for unlimited / in-stock, false if empty). */
  consume(index: number): boolean {
    if (this.isUnlimited(index)) return true;
    if (this.getOwned(index) <= 0) return false;
    this.m_owned[index] = this.getOwned(index) - 1;
    return true;
  }

  /**
   * Auto Buy: a "drain loop" — repeatedly pick an affordable weapon and buy it until
   * nothing is left affordable, spending nearly all credits on a varied assortment. Only
   * OFFENSIVE stock is bought — the shared {@link UTILITY_EXT} filter skips the support types,
   * mirroring the original's buy-candidate filter (which also excludes the unlimited Shell
   * staple). `conserve` mirrors the original's
   * tough-AI branch — half the time it grabs the weakest affordable filler to hoard credits
   * for pricier rounds; the difficulty-gated support front-load pass isn't modelled here.
   */
  autoBuy(opts?: {conserve?: boolean; deterministic?: boolean}): void {
    // Guard against pathological loops (every buy removes at least the cheapest cost).
    for (let guard = 0; guard < 5000; guard++) {
      const affordable = weaponIndices(i => {
        const w = WEAPON_DATABASE[i];
        return (
          !this.isUnlimited(i) &&
          weaponEnabled(i) &&
          w.cost > 0 &&
          w.cost <= this.creditsGet() &&
          !UTILITY_EXT.has(w.extType ?? 0)
        );
      });
      if (affordable.length === 0) break;
      // Deterministic (network): cycle through the affordable list by the loop counter so every
      // client autobuys the SAME varied loadout + spends the SAME credits — no Math.random.
      // Solo: tough-AI conserve grabs the weakest affordable half the time, else a random pick.
      const pick = opts?.deterministic
        ? affordable[guard % affordable.length]
        : opts?.conserve && Math.random() < 0.5
          ? affordable.reduce((lo, i) => (WEAPON_DATABASE[i].damage < WEAPON_DATABASE[lo].damage ? i : lo))
          : affordable[Math.floor(Math.random() * affordable.length)];
      this.buy(pick);
    }
  }

  /** Snapshot of owned counts (for mirroring to the UI). Free-fire reports every weapon
   *  as unlimited so the depot's Qty column shows ∞ across the board. */
  ownedSnapshot(): number[] {
    if (this.m_freeFire) return this.m_owned.map(() => UNLIMITED);
    return this.m_owned.slice();
  }
}
