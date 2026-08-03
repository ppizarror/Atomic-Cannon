/**
 * botEconomy — what a computer player BUYS, kept out of CGameController.
 *
 * The port already keeps the bots' *aiming* and *planning* brains as pure modules (CBotAI, and the
 * expected-value planner in CBotUltraAI) with the controller marshalling engine state into them.
 * The purchasing half belongs out here for the same reason: it touches almost nothing the
 * controller owns — it reads an inventory, asks the weapon database questions, and spends. This
 * module is that half, in the same shape as its siblings.
 *
 * Two doctrines live here:
 *  • {@link aiRestock} — levels 1..10. A difficulty-gated DEFENSIVE front-load (shield/heal/armor/
 *    death/mine/move, each bought once and only when the matching stat is low), then an offensive
 *    drain. Higher levels turtle up more.
 *  • {@link ultraManageEconomy} — level 11. SPENDS to win rather than hoarding: it reads the other
 *    side's arsenal and answers it, banks toward one real nuke instead of frittering, and fills out
 *    with a varied assortment. This is what makes two Ultra bots finish a fight instead of chipping
 *    and healing forever.
 *
 * Everything the controller owns arrives through {@link BotBuyCtx} / {@link UltraBuyCtx}, so the
 * decisions are testable without a running match.
 */
import {WEAPON_DATABASE, getWeapon, someWeapon, weaponIndices} from './CWeapon';
import {weaponEnabled} from './CGameContent';
import {CEconomy} from './CEconomy';
import {AI_LEVEL_ULTRA} from './CBotAI';
import {SELF_BURY_MIN_EARTH, type UltraThreat} from './CBotUltraAI';
import {EXT_CODE, UTILITY_EXT, isBeamExt} from './weapons/ExtType';

// ==========================================================================
// TUNING
// ==========================================================================

/** Shield below which a mid-level bot considers itself under-defended and buys one. */
const BOT_SHIELD_NEED = 500;

/** Damage at/above which a round counts as a NUKE (a.bomb and up). */
const ULTRA_NUKE_DAMAGE = 350;
/** Small credit floor Ultra keeps back; everything above it gets spent on firepower. */
const ULTRA_CREDIT_RESERVE = 150;
/** Offensive rounds Ultra tries to keep on hand once it holds a nuke. */
const ULTRA_OFFENSE_STOCK = 6;
/** "Surrounded" = at least 2 enemies within this radius — the kamikaze trigger. */
export const ULTRA_SURROUND_RADIUS = 260;

// ==========================================================================
// INTERFACES & TYPES
// ==========================================================================

/** The buyer's own condition — the stats the defensive rules test. */
export interface BotBuyStats {
  life: number;
  maxLife: number;
  shield: number;
  armor: number;
  hazmat: number;
  /** Sunk under dirt: it can't drive and can't fire a normal round, so digging out outranks all. */
  buried: boolean;
}

export interface BotBuyCtx {
  econ: CEconomy;
  stats: BotBuyStats;
  /** AI level (see CBotAI's AI_LEVEL_*). Gates which defensive items unlock. */
  difficulty: number;
  /** The match's seeded RNG — the weighted offensive fill draws from it. */
  rng: {float(): number};
  /**
   * Run after a buying pass has debited credits. The controller re-syncs the buyer's SQUAD to the
   * new balance: each bot spends its own economy, so leaving a squad-mate's copy stale would let
   * its next earn pool the undebited balance back and silently refund the purchase (ECON-1).
   */
  onSpent: () => void;
}

export interface UltraBuyCtx extends BotBuyCtx {
  /** The tank is standing on live fallout — buy a hazmat suit. */
  onRadiation: boolean;
  /** What the OTHER side is holding; drives the counter-nuke doctrine. */
  threat: UltraThreat;
  /** Enemies within {@link ULTRA_SURROUND_RADIUS} of the buyer. */
  enemiesNear: number;
}

// ==========================================================================
// WEAPON PREDICATES
// ==========================================================================

/**
 * A true NUKE — an expensive BALLISTIC blast worth reserving and ranging with a Shell first, not a
 * mid-tier round like Hercules/Roller and not a beam/death/utility. Classified by DAMAGE rather
 * than cost: a $1200 seeker (dmg 200) is not a nuke; a.bomb / hydrogen / plutonium / uranium are.
 */
export function isNukeWeapon(i: number): boolean {
  const w = getWeapon(i);
  const ext = WEAPON_DATABASE[i].extType ?? 0;
  if (UTILITY_EXT.has(ext) || isBeamExt(w.getExtType())) return false;
  return w.isNukeClass() || w.getDamage() >= ULTRA_NUKE_DAMAGE;
}

/** A hitscan straight-line ray — no arc, ignores terrain, and the one thing a BURIED tank can fire. */
export function isBeamWeapon(i: number): boolean {
  return isBeamExt(getWeapon(i).getExtType());
}

/** A sub-premium RADIATION/gas round (lays a fallout zone) — area denial that forces the foe to move. */
function isRadWeapon(i: number): boolean {
  return getWeapon(i).getRadiation().dmg > 0 && !isNukeWeapon(i);
}

// ==========================================================================
// INVENTORY QUERIES
// ==========================================================================

/** Does `econ` own any weapon of this extType? */
function botOwnsExt(econ: CEconomy, ext: number): boolean {
  return WEAPON_DATABASE.some(w => (w.extType ?? 0) === ext && econ.getOwned(w.index) > 0);
}

/** Does `econ` hold a FINITE (bought, non-staple) round matching `pred`? */
function botOwnsMatching(econ: CEconomy, pred: (i: number) => boolean): boolean {
  return someWeapon(i => !econ.isUnlimited(i) && econ.getOwned(i) > 0 && pred(i));
}

/** Owned weapon indices for a tank's inventory (the Shell staple always included). */
export function ownedWeaponIndices(econ: CEconomy): number[] {
  return weaponIndices(i => econ.getOwned(i) > 0);
}

/** Finite rounds a tank has in stock (excludes the unlimited Shell) — the restock trigger. */
export function botFiniteStock(econ: CEconomy): number {
  let n = 0;
  for (let i = 0; i < WEAPON_DATABASE.length; i++) {
    if (econ.isUnlimited(i)) continue;
    const c = econ.getOwned(i);
    if (Number.isFinite(c)) n += c;
  }
  return n;
}

/** Count of finite (non-Shell) OFFENSIVE rounds a bot holds — the "do I have real firepower?" gauge. */
export function ultraFiniteOffense(econ: CEconomy): number {
  let n = 0;
  for (let i = 0; i < WEAPON_DATABASE.length; i++) {
    if (econ.isUnlimited(i) || econ.getOwned(i) <= 0) continue;
    const w = WEAPON_DATABASE[i];
    if ((w.damage ?? 0) > 0 && !UTILITY_EXT.has(w.extType ?? 0)) n += econ.getOwned(i);
  }
  return n;
}

/** Does the bot already hold a premium (nuke-class) round? */
function ultraOwnsPremium(econ: CEconomy): boolean {
  return botOwnsMatching(econ, isNukeWeapon);
}

// ==========================================================================
// PURCHASING
// ==========================================================================

/**
 * Buy one random enabled weapon of `ext`, only if credits cover `afford ×` its cost (the original
 * guards support buys with a 2–2.5× affordability margin). Returns whether it bought.
 *
 * NB this draws from `Math.random`, not the seeded match RNG — matching the original. It is safe
 * because bots never run in a network match (every net team is human), so no lockstep peer is
 * reproducing this decision.
 */
function botBuyOneOfExt(econ: CEconomy, ext: number, afford: number): boolean {
  const cands = WEAPON_DATABASE.filter(
    w => (w.extType ?? 0) === ext && w.cost > 0 && weaponEnabled(w.index) && econ.getCredits() >= w.cost * afford,
  );
  if (!cands.length) return false;
  return econ.buy(cands[Math.floor(Math.random() * cands.length)].index);
}

/**
 * Buy the best affordable weapon matching `pred` — the strongest (highest damage) if `strongest`,
 * else the cheapest. Used to guarantee a specific class (nuke / beam / gas) actually gets bought,
 * unlike the weighted-random fill. Returns whether it bought.
 */
function ultraBuyMatching(econ: CEconomy, pred: (i: number) => boolean, strongest: boolean): boolean {
  const cands = weaponIndices(i => {
    const cost = WEAPON_DATABASE[i].cost ?? 0;
    return cost > 0 && cost <= econ.getCredits() && weaponEnabled(i) && pred(i);
  });
  if (!cands.length) return false;
  cands.sort((a, b) =>
    strongest
      ? (WEAPON_DATABASE[b].damage ?? 0) - (WEAPON_DATABASE[a].damage ?? 0)
      : (WEAPON_DATABASE[a].cost ?? 0) - (WEAPON_DATABASE[b].cost ?? 0),
  );
  return econ.buy(cands[0]);
}

/**
 * Buy an affordable OFFENSIVE weapon costing ≤ `maxCost`, picked at RANDOM but weighted toward
 * higher damage — so Ultra stocks a VARIED arsenal (not four of the single strongest round) and its
 * firing actually differs turn to turn. Skips utilities/self-buffs. Returns whether it bought.
 */
function ultraBuyBestOffense(econ: CEconomy, maxCost: number, rng: {float(): number}): boolean {
  const cands = weaponIndices(i => {
    const w = WEAPON_DATABASE[i];
    const cost = w.cost ?? 0;
    if (cost <= 0 || cost > maxCost || cost > econ.getCredits()) return false;
    return weaponEnabled(i) && (w.damage ?? 0) > 0 && !UTILITY_EXT.has(w.extType ?? 0);
  });
  if (!cands.length) return false;
  // Weight ∝ damage² so heavy rounds are favoured, but lighter ones still get bought — a real mix.
  const weights = cands.map(i => Math.pow(WEAPON_DATABASE[i].damage ?? 1, 2));
  let r = rng.float() * weights.reduce((a, b) => a + b, 0);
  let pick = cands[cands.length - 1];
  for (let k = 0; k < cands.length; k++) {
    r -= weights[k];
    if (r <= 0) {
      pick = cands[k];
      break;
    }
  }
  return econ.buy(pick);
}

// ==========================================================================
// RESTOCK POLICIES
// ==========================================================================

/**
 * Levels 1..10. A difficulty-gated DEFENSIVE front-load — shield/heal (L>5), armor (L>6),
 * Death's-head (L>7), mine (L>4), move (L>3), each bought once only when the bot doesn't own it
 * and the matching need-stat is low — then an offensive drain that stocks a varied assortment
 * (conserving toward cheap filler at high level). Called at turn start when the bot's finite stock
 * has run low, so higher-difficulty bots actually turtle up and vary their arsenal.
 */
export function aiRestock(ctx: BotBuyCtx): void {
  const {econ, stats: s, difficulty: L} = ctx;
  if (L > 5 && !botOwnsExt(econ, EXT_CODE.SHIELD) && s.shield < BOT_SHIELD_NEED)
    botBuyOneOfExt(econ, EXT_CODE.SHIELD, 2);
  if (L > 5 && !botOwnsExt(econ, EXT_CODE.HEAL) && s.life < s.maxLife * 0.7) botBuyOneOfExt(econ, EXT_CODE.HEAL, 2);
  if (L > 6 && !botOwnsExt(econ, EXT_CODE.ARMOR) && s.armor === 0) botBuyOneOfExt(econ, EXT_CODE.ARMOR, 2.5);
  if (L > 7 && !botOwnsExt(econ, EXT_CODE.DEATH)) botBuyOneOfExt(econ, EXT_CODE.DEATH, 2.5);
  if (L > 4 && !botOwnsExt(econ, EXT_CODE.MINE)) botBuyOneOfExt(econ, EXT_CODE.MINE, 2.5);
  if (L > 3 && !botOwnsExt(econ, EXT_CODE.MOVE)) botBuyOneOfExt(econ, EXT_CODE.MOVE, 2.5);
  // Offensive drain: high-level bots conserve (buy cheap filler), but ULTRA does NOT — it stocks a
  // strong, varied arsenal so its expected-value planner actually has heavy/area/gas rounds to fire.
  econ.autoBuy({conserve: L > 6 && L < AI_LEVEL_ULTRA});
  ctx.onSpent();
}

/**
 * Level 11 (Ultra). Minimal reactive defence, then a real arsenal of LEVERAGE weapons — a NUKE (big
 * damage to force the issue), a BEAM (fire while buried), a GAS/RADIATION round (area denial that
 * makes the foe move) — then fill with strong varied rounds until stocked, draining down to a tiny
 * reserve.
 */
export function ultraManageEconomy(ctx: UltraBuyCtx): void {
  const {econ, stats: s, threat, rng} = ctx;
  const R = ULTRA_CREDIT_RESERVE;
  const isCleaner = (i: number) => getWeapon(i).isCleaner();
  const buriesSelf = (i: number) => getWeapon(i).getEarth() >= SELF_BURY_MIN_EARTH;
  const isExt = (ext: number) => (i: number) => (WEAPON_DATABASE[i].extType ?? 0) === ext;

  // BURIED — top priority, ahead of everything else: a pinned tank can't drive and can't fire a
  // normal round without eating its own blast, so nothing else in the shop matters until it's out.
  // A cleaner (earth-remover, no damage) is the clean way out, and the planner can only pick one
  // that's actually in stock, so the escape only exists if the economy keeps one on the shelf.
  // Ignores the reserve: being stuck costs far more than the credits do.
  if (s.buried && !botOwnsMatching(econ, isCleaner)) ultraBuyMatching(econ, isCleaner, false);
  // Buy a HEAL as soon as it's hurt (< 60%) and holds none — so a heal is in stock BEFORE it gets
  // critical, and a bot with money always has the self-heal option the desperation curve will use.
  if (s.life < s.maxLife * 0.6 && !botOwnsExt(econ, EXT_CODE.HEAL)) botBuyOneOfExt(econ, EXT_CODE.HEAL, 1);
  if (s.armor <= 0 && !botOwnsExt(econ, EXT_CODE.ARMOR)) botBuyOneOfExt(econ, EXT_CODE.ARMOR, 1);
  if (ctx.onRadiation && s.hazmat <= 0 && !botOwnsExt(econ, EXT_CODE.HAZMAT)) botBuyOneOfExt(econ, EXT_CODE.HAZMAT, 1);

  // COUNTER-NUKE DOCTRINE. Weapons are visible, so read the other side's arsenal before spending:
  // once they hold nuke-class ordnance, the answer is not to race them to a bigger one — it's to
  // make their nuke miss. That means a BEAM (a straight ray that still reaches them once we're
  // under the dirt, and the one weapon a buried tank can fire) and a cheap DIRT round to pull that
  // dirt over ourselves with. Bought AHEAD of our own nuke savings, because a nuke we can't live
  // long enough to fire is worth nothing. Skipped if they hold a beam too — then dirt hides us
  // from nobody.
  if (threat.hasNuke && !threat.hasBeam) {
    if (!botOwnsMatching(econ, isBeamWeapon)) ultraBuyMatching(econ, isBeamWeapon, false);
    // Only worth a dirt round if we actually got the beam — else burying is just hiding in a hole.
    if (botOwnsMatching(econ, isBeamWeapon) && !botOwnsMatching(econ, buriesSelf))
      ultraBuyMatching(econ, buriesSelf, false);
  }

  // A DEATH (kamikaze) round FIRST when SURROUNDED — 2+ enemies close, so dying takes them with it.
  // Priority (bought before the pricey nuke can drain the purse); pointless/skipped when spread out.
  if (econ.getCredits() > R && ctx.enemiesNear >= 2 && !botOwnsMatching(econ, isExt(EXT_CODE.DEATH)))
    ultraBuyMatching(econ, isExt(EXT_CODE.DEATH), false);

  // Leverage weapons — a NUKE (cheapest true nuke, so it affords one AND keeps credits for variety
  // — not blowing the whole purse on the single priciest), then a BEAM, then a GAS round.
  if (econ.getCredits() > R && !ultraOwnsPremium(econ)) ultraBuyMatching(econ, isNukeWeapon, false);
  if (econ.getCredits() > R && !botOwnsMatching(econ, isBeamWeapon)) ultraBuyMatching(econ, isBeamWeapon, false);
  if (econ.getCredits() > R && !botOwnsMatching(econ, isRadWeapon)) ultraBuyMatching(econ, isRadWeapon, false);
  // A MINE for area denial (cheapest); one is enough.
  if (econ.getCredits() > R && !botOwnsMatching(econ, isExt(EXT_CODE.MINE)))
    ultraBuyMatching(econ, isExt(EXT_CODE.MINE), false);

  // SAVE toward a nuke: if the bot doesn't hold a real nuke yet, STOP here — don't fritter credits
  // on cheap fill; let the balance build up so it can buy a nuke ($4000+) in a turn or two. Only
  // once a nuke is in the bag does it fill out with strong varied rounds (down to the reserve).
  let guard = 0;
  while (
    ultraOwnsPremium(econ) &&
    ultraFiniteOffense(econ) < ULTRA_OFFENSE_STOCK &&
    econ.getCredits() > R &&
    guard++ < 24
  ) {
    if (!ultraBuyBestOffense(econ, econ.getCredits(), rng)) break;
  }
  ctx.onSpent();
}
