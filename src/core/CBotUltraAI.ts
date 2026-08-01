/**
 * CBotUltraAI — the level-11 "Ultra" computer brain.
 *
 * Where levels 1..10 pick a random target + random weapon and then degrade a perfect solve by a
 * difficulty-scaled scatter, Ultra does the opposite: it enumerates every action it could take this
 * turn, scores each in one common "value" currency (≈ life-damage equivalent), and takes the best —
 * so it plays to WIN, not to fire.
 *
 * Actions considered every turn:
 *  • FIRE — for each enemy, solve ONE gust-aware arc (the trajectory is weapon-independent), then
 *    score EVERY owned weapon's blast at that impact over ALL tanks caught. Clustered enemies are
 *    rewarded automatically (multi-hit), kills carry a big bonus, and a nuke is only "worth it" for a
 *    kill or a 2+ hit — otherwise a cheap Shell is fired and the premium ordnance is BANKED.
 *  • MOVE — only ever with a concrete purpose: grab a nearby crate, flee radiation it's standing on,
 *    or reposition to unblock a shot when nothing reaches an enemy. Never the aimless wander lower
 *    levels do.
 *  • BUFF — heal / shield / armor / hazmat when a stat is low and there's no better play.
 *
 * The planner is PURE (all engine coupling is marshalled into `UltraCtx` by the caller), so the whole
 * brain is unit-testable without a running game.
 */
import {bestAim, simulateShot, type Pt, type AimField} from './CBotAI';
import {clamp} from '../math/num';

/** One enemy tank, in the units the scorer needs. `life`/`shield` are 0..maxLife / 0..1000. */
export interface UltraEnemy {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  shield: number;
  hitRadius: number;
  buried: boolean; // sunk under dirt — a nuke/explosive would FREE it, so keep it down with beams
}

/** One owned weapon, pre-resolved to the fields the blast scorer needs (the caller folds in
 *  Explosion Size + resolution so `radius` is the true falloff radius). */
export interface UltraWeapon {
  index: number;
  ext: number;
  cost: number; // credits to buy one (0 for the unlimited Shell staple)
  count: number; // rounds in stock (Infinity for the Shell)
  damage: number;
  radius: number; // outer falloff radius = getRadius × explosionScale × blastScale
  innerR: number; // full-damage core = 0.5 × getSize()
  spread: number; // extra effective reach from cluster/airburst submunitions raining over an area
  dotValue: number; // total damage-over-time a gas/radioactive round lays down (irDmg × irTime)
  earth: number; // dirt-dumping amount (>0 → can bury a target)
  piercing: boolean; // armor-piercing (radioactive) — bypasses shield/armor in the estimate
  isBeam: boolean; // hitscan straight-line ray (no arc; ignores terrain) — safe to fire while buried
  isCleaner: boolean; // earth-remover (no damage) — clears the dirt burying the tank to dig it out
  isMine: boolean; // deploys a persistent mine on impact — area denial that forces the foe to detour
  isPremium: boolean; // nuke / expensive ordnance to reserve for high-value shots
  offensive: boolean; // a damaging round the bot may fire at a target
}

/** A supply crate the bot could drive onto. `bomb` is a trap (negative value). */
export interface UltraCrate {
  x: number;
  kind: 'weapon' | 'credits' | 'health' | 'bomb';
  amount: number; // credits / health payload
  landed: boolean; // false while still under its parachute — not yet where it will settle
}

/** The acting bot's own state. */
export interface UltraSelf {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  shield: number;
  armor: number;
  hazmat: number;
  credits: number;
  onRadiation: boolean; // standing on the fallout carpet right now
  buried: boolean; // sunk under the dirt — a ballistic round would detonate in it and self-damage
  threatened: boolean; // took damage since its last turn → an enemy has its range; seek cover
}

export interface UltraCtx {
  self: UltraSelf;
  enemies: UltraEnemy[];
  weapons: UltraWeapon[];
  crates: UltraCrate[];
  field: AimField;
  wind: Pt;
  gustT0: number; // launch-time gust clock (see CBotAI.simulateShot)
  muzzleFor: (deg: number) => Pt; // barrel tip for a candidate aim
  aimDegToward: (target: Pt) => number; // straight-line aim (for beams)
  moveMaxDist: number; // furthest the bot can drive this turn (0 → no Move utility owned)
  radiationAt: (x: number) => boolean; // is the fallout carpet under column x?
  mines: number[]; // world-x of known mines — a drive must never roll the tank over one
  weights?: UltraWeights; // this bot's personality (defaults to ULTRA_WEIGHTS_DEFAULT when absent)
  rnd: () => number;
}

/** The chosen action. `note` is a short human/debug/test label for WHY. */
export type UltraPlan =
  | {
      action: 'fire';
      weaponIndex: number;
      angleDeg: number;
      power: number;
      targetX: number;
      note: string;
    }
  | {action: 'move'; destX: number; note: string}
  | {action: 'buff'; weaponIndex: number; note: string}
  | {action: 'skip'; note: string};

// ── Value model (all in ≈ life-damage units, so actions compare directly) ────────────────────────
// Fixed weights (not personality-varied).
const WEAPON_CRATE_VALUE = 260; // a free weapon pickup
const RAD_FLEE_VALUE = 300; // escaping the fallout carpet (avoided DOT over the coming turns)
const REPOSITION_VALUE = 140; // moving to set up a shot beats wasting a turn on a guaranteed miss
const CRATE_CLOSE_TOL = 24; // a crate may pull the bot this much closer to an enemy, no more
// Digging out of a bury with a cleaner. Moderate on purpose: a strong beam attack (esp. a kill, which
// short-circuits earlier) outranks it, so a buried bot still shoots a weak enemy rather than dig.
const DIG_OUT_VALUE = 400;
// Effective damage at/above which a premium (nuke) shot is worth firing even without a kill/multi-hit —
// a big hit is leverage. Below it, a nuke on a graze is wasteful and stays banked.
const PREMIUM_MIN_VALUE = 250;
// At/under this life fraction, a bot that CAN'T heal is desperate — it throws its premium ordnance with
// no reservation (do-or-die). If it can heal, it heals instead (bestBuff's urgency curve wins).
const DESPERATE_LIFE_FRAC = 0.3;
// Against a BURIED enemy: penalise an explosive round — its crater (and a beam's carve) would FREE the
// enemy to move. So the bot doesn't blast/beam a pinned enemy loose unless the shot outright kills.
const UNBURY_PENALTY = 350;
// Laying a mine in the enemy's zone (area denial). Modest — done when there's no strong attack, not
// instead of one. Don't lay a second within MINE_SPACING of an existing one (redundant).
const MINE_VALUE = 130;
const MINE_SPACING = 90;
// Relocating to cover when the enemy already has your range. Beats sitting still to be shelled, but a
// real attack still outranks it.
const COVER_VALUE = 175;
const COVER_MARGIN = 40; // a candidate spot must beat the current one's cover by this much to bother

/**
 * PERSONALITY weights — the knobs that make one Ultra bot play differently from another, so two of
 * them don't converge on identical lines. The controller assigns each Ultra bot a personality per
 * match and folds its weights into {@link UltraCtx}; the planner reads them (falling back to
 * {@link ULTRA_WEIGHTS_DEFAULT} when absent, e.g. in unit tests).
 */
export interface UltraWeights {
  killBonus: number; // bounty added for a kill — higher = more aggressive
  premiumWaste: number; // penalty for a wasteful premium shot — lower = spends nukes more freely
  creditValue: number; // how enticing loot/credits are — higher = greedier
  buryBonus: number; // appeal of trap/earth plays — higher = trickier
  dotWeight: number; // how much sustained gas/DOT damage counts
  trickChance: number; // chance to take a setup play over the raw-best shot
  healBelow: number; // life fraction at/under which it self-heals (higher = more cautious)
  explore: number; // 0..1 — randomness among near-best NON-kill shots (0 = always the top pick)
}

export const ULTRA_WEIGHTS_DEFAULT: UltraWeights = {
  killBonus: 1200,
  premiumWaste: 4000,
  creditValue: 0.35,
  buryBonus: 200,
  dotWeight: 0.5,
  trickChance: 0.15,
  healBelow: 0.6,
  explore: 0.28,
};

/** Named personalities. Each Ultra bot draws one at match start (see the controller), so a ruthless
 *  bot hunts kills and spends nukes while a cautious one turtles and heals early — divergent games. */
export const ULTRA_PERSONALITIES: Record<string, UltraWeights> = {
  balanced: {...ULTRA_WEIGHTS_DEFAULT},
  // Kills at any cost: fat kill bounty, cheap to justify a nuke, rarely bothers with tricks, heals late,
  // and disciplined (low exploration — takes the best shot).
  ruthless: {
    ...ULTRA_WEIGHTS_DEFAULT,
    killBonus: 1600,
    premiumWaste: 1200,
    trickChance: 0.05,
    healBelow: 0.4,
    buryBonus: 120,
    explore: 0.1,
  },
  // Survival first: modest aggression, hoards premiums, heals early, values loot, mixes weapons up.
  cautious: {
    ...ULTRA_WEIGHTS_DEFAULT,
    killBonus: 1000,
    premiumWaste: 6000,
    creditValue: 0.5,
    healBelow: 0.78,
    explore: 0.35,
  },
  // Plays mind-games: loves traps/reposition/bury setups over raw damage, very varied.
  trickster: {
    ...ULTRA_WEIGHTS_DEFAULT,
    trickChance: 0.42,
    buryBonus: 380,
    killBonus: 1100,
    dotWeight: 0.8,
    explore: 0.45,
  },
};
export const ULTRA_PERSONALITY_NAMES = Object.keys(ULTRA_PERSONALITIES);

/** Blast damage this weapon would deal to one enemy centred at (cx,cy) — the engine's two-radius
 *  model (full inside the core, linear falloff to zero at the outer edge; beams = full everywhere).
 *  `spread` widens the OUTER reach so cluster/airburst rounds correctly catch tanks spread over an
 *  area (their submunitions rain wide), which is why Ultra reaches for them against a spread group. */
export function blastDamageToEnemy(cx: number, cy: number, w: UltraWeapon, e: UltraEnemy): number {
  const collR = e.hitRadius;
  const outer = Math.max(w.radius + w.spread, 0) + collR;
  const inner = w.innerR + collR;
  const dist = Math.hypot(e.x - cx, e.y - cy);
  if (dist > outer) return 0;
  if (w.isBeam || dist <= inner) return w.damage;
  return w.damage * (1 - dist / outer);
}

/** Effective HP the bot must chew through to KILL an enemy: life plus the shield (armor/hazmat are
 *  percentage soaks we fold in loosely). Piercing rounds bypass the shield. */
function effectiveHp(e: UltraEnemy, piercing: boolean): number {
  return e.life + (piercing ? 0 : e.shield);
}

/** Score a weapon detonating at (cx,cy): total EFFECTIVE damage across all enemies + a kill bonus
 *  per tank it would drop. Effective damage is capped at each tank's HP (no overkill credit). */
function scoreBlast(
  cx: number,
  cy: number,
  w: UltraWeapon,
  enemies: UltraEnemy[],
  wt: UltraWeights,
): {value: number; kills: number; hits: number} {
  let value = 0,
    kills = 0,
    hits = 0;
  for (const e of enemies) {
    const raw = blastDamageToEnemy(cx, cy, w, e);
    if (raw <= 0) continue;
    hits++;
    const hp = effectiveHp(e, w.piercing);
    value += Math.min(raw, hp); // don't reward overkill beyond what removes the tank
    if (raw >= hp) {
      kills++;
      value += wt.killBonus;
    } else if (w.dotValue > 0) {
      // Gas / radioactive round: the fallout keeps chipping the survivor over the coming turns and
      // denies the ground — worth a chunk on top of the direct hit (capped at what remains + weighted,
      // since DOT is spread over time and the tank may crawl off it).
      value += Math.min(w.dotValue, hp - raw) * wt.dotWeight;
    }
  }
  return {value, kills, hits};
}

interface ShotPlan {
  weaponIndex: number;
  angleDeg: number;
  power: number;
  targetX: number; // world-x of the enemy this arc aims at (for cross-turn ranging correction)
  value: number;
  kills: number;
  hits: number;
  note: string;
}

/** The best offensive FIRE this turn, or null if no owned weapon reaches any enemy. One arc is
 *  solved per enemy (trajectory is weapon-independent); every owned weapon is then scored at that
 *  arc's impact so multi-tank blasts and cheap-vs-premium trade-offs are compared head to head. */
export function bestOffensiveShot(ctx: UltraCtx): ShotPlan | null {
  const {enemies, weapons, field, wind, gustT0, muzzleFor} = ctx;
  const wt = ctx.weights ?? ULTRA_WEIGHTS_DEFAULT;
  let firers = weapons.filter(w => w.offensive && w.count > 0 && w.damage > 0);
  // BURIED: a ballistic round would detonate in the surrounding dirt and hurt the tank — only BEAMS
  // (which fire as a straight ray through terrain) are safe to attack with.
  if (ctx.self.buried) firers = firers.filter(w => w.isBeam);
  if (!firers.length || !enemies.length) return null;

  // Desperate = near death AND can't heal → drop premium reservation and throw everything.
  const canHeal = weapons.some(w => w.ext === 10 && w.count > 0);
  const desperate = ctx.self.life < ctx.self.maxLife * DESPERATE_LIFE_FRAC && !canHeal;

  const cands: ShotPlan[] = [];
  const consider = (p: ShotPlan) => cands.push(p);
  // Higher value wins; at equal value the CHEAPER weapon does (bank the pricey stuff).
  const better = (a: ShotPlan, b: ShotPlan): boolean =>
    a.value > b.value ||
    (a.value === b.value &&
      weaponCost(weapons, a.weaponIndex) < weaponCost(weapons, b.weaponIndex));

  for (const e of enemies) {
    // BEAMS are hitscan straight rays: only score them when the LINE from the muzzle to the enemy is
    // CLEAR — a beam can't shoot through a mountain (scoring it as an always-hit is why it used to be
    // over-picked and nukes never fired). Aim straight at the enemy, no arc.
    //
    // EXCEPT while BURIED, where the check must be skipped: the muzzle sits UNDER the dirt, so the ray
    // starts inside terrain and beamBlocked rejects every beam on its first sample — yet the buried
    // filter above has already narrowed the pool to beams alone. The two rules cancelled out, leaving a
    // buried bot with NO candidate action at all: it skipped its turn, nothing about its situation
    // changed, and it skipped again every round for the rest of the battle. A beam is genuinely fine
    // here — the engine's beam is pure hitscan that only ever stops on a TANK (see EXT.BEAM in
    // WeaponBehavior), so shooting it out from under the dirt is exactly what it's for.
    const beamAngle = ctx.aimDegToward({x: e.x, y: e.y});
    const beamClear =
      ctx.self.buried || !beamBlocked(muzzleFor(beamAngle), {x: e.x, y: e.y}, field);
    if (beamClear)
      for (const w of firers.filter(f => f.isBeam)) {
        const s = scoreBlast(e.x, e.y, w, enemies, wt);
        if (s.hits > 0)
          consider({
            weaponIndex: w.index,
            angleDeg: beamAngle,
            power: 1000,
            targetX: e.x,
            value: adjustForPremium(w, s.value, s.kills, s.hits, wt, desperate),
            kills: s.kills,
            hits: s.hits,
            note: `beam ${describe(s)}`,
          });
      }

    // BALLISTIC: solve one arc to this enemy, then score every arced weapon at its impact.
    const arc = bestAim(muzzleFor, {x: e.x, y: e.y}, wind, field, gustT0);
    const origin = muzzleFor(arc.angleDeg);
    const shot = simulateShot(
      origin,
      arc.angleDeg,
      arc.power,
      wind,
      field,
      {x: e.x, y: e.y},
      gustT0,
    );
    // The engine detonates a shell on PROXIMITY (within the tank's hit radius) or on terrain — NOT on
    // a near-miss graze. So a direct hit explodes on the tank; anything else explodes where it lands.
    // Scoring an overshoot at its true far landing (not the fly-by point) is what stops Ultra firing a
    // phantom "hit" forever — a real miss scores hits=0 and the planner repositions/ranges instead.
    const directHit = shot.minDist <= e.hitRadius;
    const cx = directHit ? shot.nearX : shot.hitX;
    const cy = directHit ? shot.nearY : shot.hitY;
    if (!shot.hitGround && !directHit) continue; // sailed off the field → no blast

    for (const w of firers.filter(f => !f.isBeam)) {
      const s = scoreBlast(cx, cy, w, enemies, wt);
      if (s.hits === 0) continue;
      let value = adjustForPremium(w, s.value, s.kills, s.hits, wt, desperate);
      // Trap play: an earth (dirt-dumping) weapon on a weak, low target is worth a little extra even
      // when it barely damages — it buries them.
      if (w.earth > 0 && s.kills === 0 && enemyIsWeak(enemies, cx, cy)) value += wt.buryBonus;
      // Don't blast a BURIED enemy free: an explosive round's crater un-buries it — unless it KILLS
      // (then who cares). Penalise it so a beam is preferred while the enemy is pinned.
      if (e.buried && s.kills === 0 && w.earth <= 0) value -= UNBURY_PENALTY;
      consider({
        weaponIndex: w.index,
        angleDeg: arc.angleDeg,
        power: arc.power,
        targetX: e.x,
        value,
        kills: s.kills,
        hits: s.hits,
        note: `${directHit ? 'hit' : 'splash'} ${describe(s)}`,
      });
    }
  }
  if (!cands.length) return null;
  const best = cands.reduce((b, c) => (better(c, b) ? c : b));
  // A KILL is taken deterministically (the cheapest lethal shot — banks the pricey stuff). Otherwise
  // EXPLORE: pick at random among shots within the personality's band of the best value, so the bot
  // varies its weapon/target instead of firing the single top pick every turn.
  if (best.kills > 0 || wt.explore <= 0) return best;
  const floor = best.value - Math.abs(best.value) * wt.explore;
  const near = cands.filter(c => c.kills === 0 && c.value >= floor);
  return weightedPick(near.length ? near : [best], ctx.rnd);
}

/** Random pick weighted toward higher value (shifted positive) — the exploration selector. */
function weightedPick(cands: ShotPlan[], rnd: () => number): ShotPlan {
  if (cands.length === 1) return cands[0];
  const minV = Math.min(...cands.map(c => c.value));
  const weights = cands.map(c => c.value - minV + 1); // +1 so the lowest still has a chance
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < cands.length; i++) {
    r -= weights[i];
    if (r <= 0) return cands[i];
  }
  return cands[cands.length - 1];
}

const weaponCost = (weapons: UltraWeapon[], index: number): number =>
  weapons.find(w => w.index === index)?.cost ?? 0;

/**
 * Ranging correction: given where the LAST shot landed vs where it was aimed, return the power to
 * fire next. Range grows ∝ power², so `dPower ≈ power/(2·range) · missAlongRange` (a Newton step) —
 * overshoot lowers power, undershoot raises it, and applied off the last FIRED power it converges as
 * the miss shrinks. A landing within `hitTol` is treated as on-target (no change). This is the
 * empirical loop that walks an Ultra bot's shots onto a target the drift-blind solver keeps missing.
 */
export function rangePowerCorrection(opts: {
  selfX: number;
  targetX: number;
  lastPower: number;
  landedX: number;
  hitTol: number;
  gain: number;
}): number {
  const {selfX, targetX, lastPower, landedX, hitTol, gain} = opts;
  const dir = Math.sign(targetX - selfX) || 1; // firing direction (+right / −left)
  const miss = (landedX - targetX) * dir; // >0 overshoot (past the target), <0 fell short
  if (Math.abs(miss) <= hitTol) return lastPower; // last shot was on target — hold
  const range = Math.max(50, Math.abs(targetX - selfX));
  const dP = gain * (lastPower / (2 * range)) * miss;
  return clamp(lastPower - dP, 100, 1000);
}

/** Premium ordnance (nuke) is worth firing for a KILL, a 2+ hit, OR big single-target damage — the
 *  "first to nuke has leverage" play that forces the fight. Only a genuinely wasteful premium shot
 *  (little damage, no kill) is penalised so it isn't thrown away on a graze. */
function adjustForPremium(
  w: UltraWeapon,
  value: number,
  kills: number,
  hits: number,
  wt: UltraWeights,
  desperate: boolean,
): number {
  // DESPERATE (near death, can't heal): no reservation — throw everything, it's do-or-die.
  if (!w.isPremium || desperate || kills > 0 || hits >= 2 || value >= PREMIUM_MIN_VALUE)
    return value;
  return value - wt.premiumWaste;
}

/** Is there a weak (≤40% life) enemy near the blast — a good candidate to bury rather than kill? */
function enemyIsWeak(enemies: UltraEnemy[], cx: number, cy: number): boolean {
  return enemies.some(
    e => e.life <= e.maxLife * 0.4 && Math.hypot(e.x - cx, e.y - cy) < e.hitRadius + 40,
  );
}

const describe = (s: {kills: number; hits: number}) => `k${s.kills} h${s.hits}`;

// ── Non-firing options ───────────────────────────────────────────────────────────────────────────

/** Value + destination of the best crate to grab (or null). Only LANDED crates are grabbed (a
 *  still-parachuting crate hasn't reached where it will settle — wait a turn), bomb crates are traps
 *  (never grabbed), and a crate that would bring the bot CLOSER to an enemy is skipped: an artillery
 *  bot keeps its distance rather than driving into the enemy's lap for a pickup. */
function bestCrateGrab(ctx: UltraCtx): {destX: number; value: number; note: string} | null {
  const {self, crates, enemies, moveMaxDist} = ctx;
  if (moveMaxDist <= 0) return null;
  const distToEnemies = (x: number) =>
    enemies.length ? Math.min(...enemies.map(e => Math.abs(e.x - x))) : Infinity;
  const dNow = distToEnemies(self.x);
  let best: {destX: number; value: number; note: string} | null = null;
  for (const c of crates) {
    if (!c.landed) continue; // still under its chute — not where it'll settle; wait for it to land
    if (Math.abs(c.x - self.x) > moveMaxDist) continue; // out of drive range
    if (c.kind === 'bomb') continue; // a trap — never a grab
    if (distToEnemies(c.x) < dNow - CRATE_CLOSE_TOL) continue; // don't close on the enemy for loot
    if (unsafeMoveTo(ctx, c.x)) continue; // don't drive over a mine / into fallout for loot
    let value: number;
    if (c.kind === 'credits') value = c.amount * (ctx.weights ?? ULTRA_WEIGHTS_DEFAULT).creditValue;
    else if (c.kind === 'health') value = Math.min(c.amount, self.maxLife - self.life);
    else value = WEAPON_CRATE_VALUE; // weapon
    if (value <= 0) continue;
    if (!best || value > best.value) best = {destX: c.x, value, note: `crate:${c.kind}`};
  }
  return best;
}

/** Nearest clean-ground destination within drive range when standing on fallout (or null). Scans
 *  outward from the bot so it hops just off the carpet rather than driving to the far edge. */
function bestRadiationEscape(ctx: UltraCtx): {destX: number; value: number; note: string} | null {
  const {self, moveMaxDist, radiationAt, field} = ctx;
  if (!self.onRadiation || moveMaxDist <= 0) return null;
  const reachableCleanSafe = (x: number): boolean =>
    x >= 20 && x <= field.width - 20 && !radiationAt(x) && !pathHitsMine(self.x, x, ctx.mines);
  // Flee value scales STEEPLY with damage taken: near-zero while healthy (so ANY real shot beats it and
  // the bot fires back, eating a little DOT, rather than running) → high near death (survival). This is
  // what stops it fleeing over firing — it only runs once genuinely hurt.
  const lifeFrac = self.maxLife > 0 ? self.life / self.maxLife : 1;
  const value = RAD_FLEE_VALUE * Math.max(0.12, (1 - lifeFrac) * 1.4); // ~0.12× full → ~1.4× near 0
  // When it DOES flee, prefer escaping TOWARD a reachable crate — ONE move both flees and grabs the
  // loot. Same value as a plain flee (the crate is a free bonus of the destination, not a reason to run
  // when healthy), so it never overrides a shot the low base wouldn't.
  const crate = ctx.crates.find(
    c =>
      c.landed &&
      c.kind !== 'bomb' &&
      Math.abs(c.x - self.x) <= moveMaxDist &&
      reachableCleanSafe(c.x),
  );
  if (crate) return {destX: crate.x, value, note: 'flee-to-crate'};
  // Else hop to the nearest clean ground (fully off the carpet, so it's a ONE-turn escape).
  for (let d = 8; d <= moveMaxDist; d += 8) {
    for (const dir of [-1, 1]) {
      const x = self.x + dir * d;
      if (reachableCleanSafe(x)) return {destX: x, value, note: 'flee-radiation'};
    }
  }
  return null;
}

const nearestEnemy = (ctx: UltraCtx): UltraEnemy =>
  ctx.enemies.reduce((n, e) => (Math.abs(e.x - ctx.self.x) < Math.abs(n.x - ctx.self.x) ? e : n));

/** Drive toward the nearest enemy to set up a shot next turn — the answer to "nothing reaches". */
function bestReposition(ctx: UltraCtx): {destX: number; value: number; note: string} | null {
  const {self, enemies, moveMaxDist, field} = ctx;
  if (moveMaxDist <= 0 || !enemies.length) return null;
  const near = nearestEnemy(ctx);
  const dir = near.x >= self.x ? 1 : -1;
  const destX = clampX(self.x + dir * moveMaxDist, field);
  if (Math.abs(destX - self.x) < 4) return null; // already as close as we can get
  if (unsafeMoveTo(ctx, destX)) return null; // don't drive over a mine / into fallout
  return {destX, value: REPOSITION_VALUE, note: 'reposition'};
}

/** How much COVER a spot at column x has from an enemy at ex: the tallest terrain BETWEEN them that
 *  rises above the spot's own surface (that ridge blocks the enemy's arcs). Higher = safer. */
function coverScore(x: number, ex: number, field: AimField): number {
  const sx = field.heightAt(clampX(x, field)); // this spot's surface Y (bigger = lower ground)
  let ridge = sx; // tallest terrain (smallest surface Y) on the line to the enemy
  const lo = Math.min(x, ex),
    hi = Math.max(x, ex);
  for (let t = lo; t <= hi; t += 16) ridge = Math.min(ridge, field.heightAt(clampX(t, field)));
  return sx - ridge; // >0 when a ridge between us and the enemy stands taller than we do
}

/** True if terrain blocks the straight LINE from `a` to `b` — a beam can't pass through a hill. */
function beamBlocked(a: Pt, b: Pt, field: AimField): boolean {
  const steps = Math.max(2, Math.floor(Math.abs(b.x - a.x) / 12));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t; // the ray's height at column x
    if (y >= field.heightAt(clampX(x, field))) return true; // ray at/below the ground → blocked
  }
  return false;
}

/** True if driving from `fromX` to `toX` would roll the tank over a mine / hazard — never do that. */
function pathHitsMine(fromX: number, toX: number, mines: number[]): boolean {
  const lo = Math.min(fromX, toX) - 12,
    hi = Math.max(fromX, toX) + 12;
  return mines.some(mx => mx >= lo && mx <= hi);
}

/** A destination is UNSAFE to drive to if the path crosses a mine or the spot sits on radiation. */
function unsafeMoveTo(ctx: UltraCtx, destX: number): boolean {
  return pathHitsMine(ctx.self.x, destX, ctx.mines) || ctx.radiationAt(destX);
}

/** Relocate to COVER when the enemy already has our range: scan drivable spots for the one best shielded
 *  by an intervening ridge (and lower-lying). Skips spots on radiation or paths over a mine. Only moves
 *  if it's meaningfully safer than sitting still. */
function bestCoverMove(ctx: UltraCtx): {destX: number; value: number; note: string} | null {
  const {self, moveMaxDist, field, enemies} = ctx;
  if (!self.threatened || self.buried || moveMaxDist <= 0 || !enemies.length) return null;
  const ex = nearestEnemy(ctx).x;
  const here = coverScore(self.x, ex, field);
  let best: {destX: number; cover: number} | null = null;
  for (let d = 12; d <= moveMaxDist; d += 12) {
    for (const dir of [-1, 1]) {
      const x = clampX(self.x + dir * d, field);
      if (unsafeMoveTo(ctx, x)) continue; // don't hide in fallout or drive over a mine
      const cover = coverScore(x, ex, field);
      if (cover > here + COVER_MARGIN && (!best || cover > best.cover)) best = {destX: x, cover};
    }
  }
  return best ? {destX: best.destX, value: COVER_VALUE, note: 'cover'} : null;
}

/** Lay a mine in the nearest enemy's zone (area denial). Fired as a normal arc; it plants a mine where
 *  it lands, forcing the foe to detour. Only when we hold a mine and aren't buried. */
function bestMineLay(ctx: UltraCtx): {plan: UltraPlan; value: number} | null {
  if (ctx.self.buried) return null;
  const mine = ctx.weapons.find(w => w.isMine && w.count > 0);
  if (!mine || !ctx.enemies.length) return null;
  const e = nearestEnemy(ctx);
  // Pointless to lay another mine where one already pins the enemy — one is enough.
  if (ctx.mines.some(mx => Math.abs(mx - e.x) < MINE_SPACING)) return null;
  const arc = bestAim(ctx.muzzleFor, {x: e.x, y: e.y}, ctx.wind, ctx.field, ctx.gustT0);
  return {
    plan: {
      action: 'fire',
      weaponIndex: mine.index,
      angleDeg: arc.angleDeg,
      power: arc.power,
      targetX: e.x,
      note: 'mine',
    },
    value: MINE_VALUE,
  };
}

/** Best self-buff when a stat is low (heal ≻ shield ≻ armor ≻ hazmat), scored by what it restores. */
function bestBuff(ctx: UltraCtx): {weaponIndex: number; value: number; note: string} | null {
  const {self, weapons} = ctx;
  const own = (ext: number) => weapons.find(w => w.ext === ext && w.count > 0);
  let best: {weaponIndex: number; value: number; note: string} | null = null;
  const offer = (w: UltraWeapon | undefined, value: number, note: string) => {
    if (w && value > 0 && (!best || value > best.value)) best = {weaponIndex: w.index, value, note};
  };
  // Heal (ext 10): a DESPERATION curve. Below the personality's threshold the heal is worth only ~0.4×
  // the life it restores (so near full a strong attack still wins — no turtling), but the value climbs
  // steeply as life falls — up to ~1.6× near death — so a badly-hurt bot with a heal in stock USES it
  // instead of trading chip damage. A guaranteed kill still short-circuits, so a low bot with a lethal
  // shot takes the kill.
  const healBelow = (ctx.weights ?? ULTRA_WEIGHTS_DEFAULT).healBelow;
  const lifeFrac = self.maxLife > 0 ? self.life / self.maxLife : 1;
  if (lifeFrac < healBelow) {
    const urgency = 0.4 + Math.max(0, (healBelow - lifeFrac) / healBelow) * 1.2; // 0.4 → ~1.6 near 0
    offer(own(10), (self.maxLife - self.life) * urgency, 'heal');
  }
  // Shield (ext 7): defensive stock when low and enemies are around.
  if (self.shield < 300) offer(own(7), (1000 - self.shield) * 0.25, 'shield');
  // Armor (ext 11) / Hazmat (ext 14): smaller top-ups.
  if (self.armor <= 0) offer(own(11), 120, 'armor');
  if (self.hazmat <= 0 && self.onRadiation) offer(own(14), 150, 'hazmat');
  return best;
}

const clampX = (x: number, field: AimField): number => Math.max(20, Math.min(field.width - 20, x));

/** When BURIED, dig out with a cleaner (an earth-remover — deals NO damage): fired near-vertically so
 *  it clears the dirt on/around the tank without hurting it. High value: being buried blocks driving
 *  AND firing normal rounds, so freeing itself is usually the best a buried turn can do. Returns a
 *  ready 'fire' plan (aimed straight up, low power, at its own column) or null. */
function bestCleanSelf(ctx: UltraCtx): {plan: UltraPlan; value: number} | null {
  if (!ctx.self.buried) return null;
  const cleaner = ctx.weapons.find(w => w.isCleaner && w.count > 0);
  if (!cleaner) return null;
  return {
    plan: {
      action: 'fire',
      weaponIndex: cleaner.index,
      angleDeg: 90,
      power: 300,
      targetX: ctx.self.x,
      note: 'clean-self',
    },
    value: DIG_OUT_VALUE,
  };
}

/**
 * LAST RESORT — the play when every scored option came back empty (no arc reaches anyone, nothing to
 * grab, nowhere to drive, no buff worth taking). Doing nothing is never the right answer: the bot's
 * situation doesn't change on its own, so a skipped turn repeats every round for the rest of the
 * battle. Fire the CHEAPEST offensive round it holds (never burn a nuke on a shot this hopeless):
 *  • BURIED — straight up at its own column. The muzzle is inside the dirt, so the round detonates
 *    right there and blasts the tank free. It eats that blast, which is why a cleaner (no damage,
 *    scored at DIG_OUT_VALUE) always wins when one is in stock — but taking the hit beats being
 *    pinned forever. This is the self-rescue levels 1..10 get for free by always firing.
 *  • otherwise — the solved arc at the nearest enemy even though it scored no hit: a round that lands
 *    SOMEWHERE reshapes the ground and feeds the cross-turn ranging correction, so the next turn is
 *    better informed than another turn of standing still.
 */
function lastResortShot(ctx: UltraCtx): UltraPlan | null {
  const firers = ctx.weapons.filter(w => w.offensive && w.count > 0 && w.damage > 0);
  if (!firers.length) return null;
  const w = firers.reduce((b, c) => (c.cost < b.cost ? c : b));
  if (ctx.self.buried)
    return {
      action: 'fire',
      weaponIndex: w.index,
      angleDeg: 90,
      power: 300,
      targetX: ctx.self.x,
      note: 'dig-blast',
    };
  if (!ctx.enemies.length) return null;
  const e = nearestEnemy(ctx);
  const arc = bestAim(ctx.muzzleFor, {x: e.x, y: e.y}, ctx.wind, ctx.field, ctx.gustT0);
  return {
    action: 'fire',
    weaponIndex: w.index,
    angleDeg: arc.angleDeg,
    power: arc.power,
    targetX: e.x,
    note: 'last-resort',
  };
}

/**
 * The full Ultra decision: score every candidate action in one currency and take the best, with a
 * small "human-ish" chance to prefer a setup/trap play over the raw-best shot so it feels cunning
 * rather than robotic. Returns a {@link UltraPlan} the caller executes.
 */
export function planUltraTurn(ctx: UltraCtx): UltraPlan {
  type Cand = {plan: UltraPlan; value: number; trick: boolean};
  const cands: Cand[] = [];

  const shot = bestOffensiveShot(ctx);
  const firePlan = (): UltraPlan => ({
    action: 'fire',
    weaponIndex: shot!.weaponIndex,
    angleDeg: shot!.angleDeg,
    power: shot!.power,
    targetX: shot!.targetX,
    note: shot!.note,
  });
  // A guaranteed KILL is never passed up for a crate/move/buff — take the shot.
  if (shot && shot.kills > 0) return firePlan();
  if (shot) cands.push({plan: firePlan(), value: shot.value, trick: false});
  const canHit = !!shot && shot.hits > 0; // a shot that actually reaches an enemy

  // BURIED: dig out with a cleaner (no self-damage) — usually the best use of a stuck turn.
  const dig = bestCleanSelf(ctx);
  if (dig) cands.push({plan: dig.plan, value: dig.value, trick: false});

  // SURVIVAL plays are always in the running (they can rightly override a mediocre shot): flee the
  // fallout you're standing on, and self-buff/heal when hurt.
  const flee = bestRadiationEscape(ctx);
  if (flee)
    cands.push({
      plan: {action: 'move', destX: flee.destX, note: flee.note},
      value: flee.value,
      trick: false,
    });
  const buff = bestBuff(ctx);
  if (buff)
    cands.push({
      plan: {action: 'buff', weaponIndex: buff.weaponIndex, note: buff.note},
      value: buff.value,
      trick: false,
    });

  // POSITIONING / LOOT plays — ONLY when the bot can't actually hit an enemy this turn. Firing always
  // comes first: a bot with a real shot shoots, it doesn't wander off for a crate or into cover.
  if (!canHit) {
    const crate = bestCrateGrab(ctx);
    if (crate)
      cands.push({
        plan: {action: 'move', destX: crate.destX, note: crate.note},
        value: crate.value,
        trick: true,
      });
    const cover = bestCoverMove(ctx);
    if (cover)
      cands.push({
        plan: {action: 'move', destX: cover.destX, note: cover.note},
        value: cover.value,
        trick: true,
      });
    const mine = bestMineLay(ctx);
    if (mine) cands.push({plan: mine.plan, value: mine.value, trick: true});
    const repo = bestReposition(ctx);
    if (repo)
      cands.push({
        plan: {action: 'move', destX: repo.destX, note: repo.note},
        value: repo.value,
        trick: true,
      });
  }

  // Nothing scored at all — take the desperation shot rather than passing the turn (a pass would just
  // repeat next round, since nothing about the bot's position changes while it stands there).
  if (!cands.length) return lastResortShot(ctx) ?? {action: 'skip', note: 'no-action'};

  cands.sort((a, b) => b.value - a.value);
  const top = cands[0];

  // Human-ish cunning: occasionally take a near-as-good SETUP play (crate/reposition) over the
  // raw-best shot — but never pass up a kill. The chance is the personality's `trickChance`.
  const trickChance = (ctx.weights ?? ULTRA_WEIGHTS_DEFAULT).trickChance;
  if (top.plan.action === 'fire' && (shot?.kills ?? 0) === 0 && ctx.rnd() < trickChance) {
    const trick = cands.find(c => c.trick && c.value >= top.value * 0.6);
    if (trick) return trick.plan;
  }
  return top.plan;
}
