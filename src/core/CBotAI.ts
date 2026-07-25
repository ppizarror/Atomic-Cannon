/**
 * CBotAI — the computer players' aiming and decision-making.
 *
 * The hard part of artillery AI is the fire solution: what angle + power lands a
 * shot on a moving-terrain target with gravity AND wind in play. Rather than a
 * closed-form solve (which can't see hills in the way), we **simulate** candidate
 * shots with the exact projectile physics (`SHOT_*` from CShot) and search for the
 * arc that passes closest to the target — naturally flying over intervening
 * terrain. A coarse grid over (angle, power) finds the basin; a fine pass refines.
 *
 * Difficulty (`level`, higher = harder) then degrades that ideal aim: it adds a
 * random angle/power error that shrinks toward zero at the top level, and steers
 * target/weapon choice from "random" (easy) toward "best" (hard).
 */
import {SHOT_GRAVITY, SHOT_WIND_ACCEL, SHOT_DRAG_K, launchSpeed} from './CShot';
import {GameConfig} from './CGameConfig';
import {windProfile, isRealisticWind, gustFactor} from './wind';
import {weaponEnabled} from './CGameContent';
import {WEAPON_DATABASE, getDefaultWeaponIndex} from './CWeapon';
import {clamp, deg2rad} from '../math/num';

// extType codes the bot decision reads directly (the original stores extType as the weapon's
// "type" float, so these ARE the type constants). Utility/non-offensive types the random
// offensive pick never draws — Move, Tracer, Shield, Heal, Armor, Death, Hazmat, Mine, Jet
// (mirrors the original's buy-candidate filter). The self-buff types are a subset of these.
const BOT_EXT = {
  ROLLER: 2,
  BEAM: 5,
  BEAM_ALT: 6,
  SHIELD: 7,
  ESCAPE: 8,
  REBOUND: 9,
  HEAL: 10,
  ARMOR: 11,
  DEATH: 12,
  HAZMAT: 14,
} as const;
export const BOT_UTILITY_EXT = new Set([3, 4, 7, 10, 11, 12, 14, 16, 17]);

/** Is this extType one the bot applies to ITSELF (shield/heal/armor/hazmat) rather than firing? */
export function isBotSelfBuff(ext: number): boolean {
  return ext === 7 || ext === 10 || ext === 11 || ext === 14;
}

/** A bot's live defensive stats, in the port's units (shield/life 0..1000, armor/hazmat 0..100%). */
export interface BotStats {
  shield: number;
  armor: number;
  hazmat: number;
  life: number;
  maxLife: number;
}

// Difficulty is a single skill level (0 = "Dummy": never aims; 10 = perfect aim). Level 11 = ULTRA,
// a wholly different brain (see CBotUltraAI): not just perfect aim but expected-value shot planning,
// nuke reservation, purposeful movement (crate/radiation/reposition), and self-preservation. 5 is a
// reasonable mid default. Levels 1..10 behave exactly as before; only 11 routes to the Ultra planner.
export const AI_LEVEL_MIN = 0;
export const AI_LEVEL_MAX = 11;
export const AI_DEFAULT_LEVEL = 5;
/** The top difficulty: routes the turn to the Ultra planner instead of the scatter-degraded solve. */
export const AI_LEVEL_ULTRA = 11;

// Aim search bounds (power in the game's 10..1000 scale; the sweep covers 100+).
const P_MIN = 100;
const P_MAX = 1000;
const COARSE_A = 5; // deg
const COARSE_P = 70; // power
const FINE_A = 1;
const FINE_P = 15;

export interface Pt {
  x: number;
  y: number;
}
export interface AimField {
  heightAt(x: number): number;
  width: number;
  height: number;
}
export interface AimResult {
  angleDeg: number;
  power: number;
  dist: number;
}

/**
 * Probability that the bot computes a FRESH firing solution this turn (vs. firing
 * with its stale aim). Rolls `rand%10 < level` twice and ORs them:
 * P = 1 − (1 − level/10)². L0→0%, L5→75%, L10→100%.
 */
export function aimProbability(level: number): number {
  const p = clamp(level / 10, 0, 1);
  return 1 - (1 - p) * (1 - p);
}

/**
 * Random angle scatter (degrees) added to the aim, scaling with how far the level
 * is below max. Magnitude is uniform in [0.2·(10−L), 0.8·(10−L)] with a random
 * sign; 0 at level ≥ 10. Power is never perturbed.
 */
export function angleError(level: number, rnd: () => number = Math.random): number {
  const span = Math.max(0, 10 - level);
  if (span === 0) return 0;
  const base = 0.8 * span;
  const floor = 0.2 * span;
  const mag = floor + (base - floor) * rnd();
  return (rnd() < 0.5 ? -1 : 1) * mag;
}

const ONE_GUST = {x: 1, y: 1}; // neutral gust factor (Linear mode / gustT0 omitted)

/** Full result of a virtual shot: the closest approach to the aim `target` (with the position
 *  there) AND the terminal impact point (terrain contact, or where it left the field). The Ultra
 *  planner centres a weapon's blast on the impact — or the near point for a direct hit — to score
 *  multi-tank damage; the plain aim solver only needs `minDist`. */
export interface ShotResult {
  minDist: number; // closest the arc passes to the aim target
  nearX: number; // position at that closest approach (blast centre for a direct hit)
  nearY: number;
  hitX: number; // terminal point: terrain contact or field exit (blast centre for a near-miss)
  hitY: number;
  hitGround: boolean; // true if it stopped ON terrain (a real detonation), false if it flew off
}

/**
 * Fly a virtual shot with the exact projectile physics and return where it goes ({@link ShotResult}).
 * Uses the same semi-implicit Euler integrator as a real shot, so the aim it finds transfers exactly.
 * Stops on terrain contact or leaving the field.
 *
 * `gustT0` (Realistic wind) is the gust-clock time AT LAUNCH: each step re-samples the shared gust
 * envelope at `gustT0 + i·dt` and scales the base `wind` by it, so the predicted arc rides the same
 * breathing wind the real shot will — a bot then leads the gust instead of aiming at the mean.
 * Omit it (or Linear mode) → the gust factor is a flat 1, i.e. the sustained wind as before.
 */
export function simulateShot(
  origin: Pt,
  angleDeg: number,
  power: number,
  wind: Pt,
  field: AimField,
  target: Pt,
  gustT0?: number,
): ShotResult {
  const r = deg2rad(angleDeg);
  // Match the REAL launch physics exactly (incl. the √worldScale zoom) so the solver's
  // prediction stays accurate on scaled maps — otherwise bots would over/undershoot.
  const ws = Math.sqrt(GameConfig.worldScale);
  const speed = launchSpeed(power);
  let vx = Math.cos(r) * speed;
  let vy = -Math.sin(r) * speed;
  let x = origin.x,
    y = origin.y;
  const dt = 1 / 30;
  const drag = isRealisticWind(); // match the real shot's Realistic-mode air drag
  let minD = Math.hypot(x - target.x, y - target.y);
  let nearX = x,
    nearY = y;
  let hitGround = false;

  for (let i = 0; i < 500; i++) {
    vy += SHOT_GRAVITY * ws * dt;
    // Same wind altitude profile the real shot uses (uniform in Linear mode, boundary-layer
    // ramp in Realistic) so the predicted arc matches what actually flies.
    const wf = windProfile(field.heightAt(clamp(x, 0, field.width - 1)) - y);
    // Gust: scale the base wind by the shared envelope at this flight instant (flat 1 in Linear /
    // when gustT0 omitted), so the arc breathes exactly like the real shot's m_effWind.
    const g = gustT0 === undefined ? ONE_GUST : gustFactor(gustT0 + i * dt);
    vx += wind.x * g.x * SHOT_WIND_ACCEL * ws * wf * dt;
    vy += wind.y * g.y * SHOT_WIND_ACCEL * ws * wf * dt;
    if (drag) {
      const loss = SHOT_DRAG_K * Math.hypot(vx, vy) * dt;
      vx -= vx * loss;
      vy -= vy * loss;
    }
    x += vx * dt;
    y += vy * dt;

    const d = Math.hypot(x - target.x, y - target.y);
    if (d < minD) {
      minD = d;
      nearX = x;
      nearY = y;
    }

    if (x < -40 || x > field.width + 40 || y > field.height + 60) break;
    if (y >= field.heightAt(clamp(x, 0, field.width - 1))) {
      hitGround = true;
      break; // hit ground
    }
  }
  return {minDist: minD, nearX, nearY, hitX: x, hitY: y, hitGround};
}

/** Closest distance a virtual shot passes to `target` — the aim solver's objective. Thin wrapper
 *  over {@link simulateShot} (same integrator), kept for the many call sites that only need the miss. */
export function simulateMiss(
  origin: Pt,
  angleDeg: number,
  power: number,
  wind: Pt,
  field: AimField,
  target: Pt,
  gustT0?: number,
): number {
  return simulateShot(origin, angleDeg, power, wind, field, target, gustT0).minDist;
}

/**
 * Search for the angle + power that lands nearest the target. `muzzleFor(deg)` is
 * the barrel-tip position for a given aim (so the launch point is exact). Fires on
 * the target's side of the tank; returns the best arc found.
 */
export function bestAim(
  muzzleFor: (deg: number) => Pt,
  target: Pt,
  wind: Pt,
  field: AimField,
  gustT0?: number,
): AimResult {
  const up = muzzleFor(90);
  const aimRight = target.x >= up.x;
  const loA = aimRight ? 8 : 98;
  const hiA = aimRight ? 82 : 172;

  let best: AimResult = {angleDeg: aimRight ? 45 : 135, power: 500, dist: Infinity};

  const scan = (a0: number, a1: number, aStep: number, p0: number, p1: number, pStep: number) => {
    for (let a = a0; a <= a1; a += aStep) {
      const o = muzzleFor(a);
      for (let p = p0; p <= p1; p += pStep) {
        if (p < P_MIN || p > P_MAX) continue;
        const d = simulateMiss(o, a, p, wind, field, target, gustT0);
        if (d < best.dist) best = {angleDeg: a, power: p, dist: d};
      }
    }
  };

  scan(loA, hiA, COARSE_A, P_MIN, P_MAX, COARSE_P); // coarse basin
  scan(
    best.angleDeg - COARSE_A,
    best.angleDeg + COARSE_A,
    FINE_A, // refine
    best.power - COARSE_P,
    best.power + COARSE_P,
    FINE_P,
  );
  return best;
}

/**
 * Choose whom to shoot. Deliberate targeting fires only for a high-skill bot (level > 7) IN
 * DEATHMATCH: a 40% / 40% / 20% split between the weakest enemy, the nearest enemy, and a random
 * one. Outside Deathmatch (Rounds/Points), OR at any lower level, the pick is a uniformly random
 * enemy — the original gates the split on both the skill level AND the game mode being Deathmatch,
 * so a Points bot doesn't preferentially hammer the weakest tank.
 */
export function pickTarget(
  enemies: {x: number; y: number; healthFrac: number}[],
  botX: number,
  botY: number,
  level: number,
  deathmatch: boolean,
  rnd: () => number = Math.random,
): number {
  if (enemies.length === 0) return -1;
  if (enemies.length === 1) return 0;

  if (level > 7 && deathmatch) {
    const r = rnd();
    if (r < 0.4) {
      // weakest (lowest health)
      let best = 0;
      for (let i = 1; i < enemies.length; i++)
        if (enemies[i].healthFrac < enemies[best].healthFrac) best = i;
      return best;
    }
    if (r < 0.8) {
      // nearest — by EUCLIDEAN distance² (dx²+dy²), matching the original; a bot dug into a pit
      // shouldn't read a tank across a valley as "nearest" just because their columns are close.
      let best = 0,
        bestD = Infinity;
      for (let i = 0; i < enemies.length; i++) {
        const dx = enemies[i].x - botX,
          dy = enemies[i].y - botY;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    }
    // else fall through to random
  }
  return Math.floor(rnd() * enemies.length);
}

/** Indices of the Move utilities (Move Near/Mid/Far), in range order. Matched on the
 *  stable weapon id, never the localised display name. */
export function moveWeaponIndices(): number[] {
  return ['move.near', 'move.mid', 'move.far']
    .map(id => WEAPON_DATABASE.findIndex(w => w.id === id))
    .filter(i => i >= 0);
}

/** Pick a random Move utility to spend a turn moving, or -1 if none exist. */
export function pickMoveWeapon(rnd: () => number = Math.random): number {
  const idxs = moveWeaponIndices();
  return idxs.length ? idxs[Math.floor(rnd() * idxs.length)] : -1;
}

/** Indices of weapons a bot can aim as a simple ballistic arc (damage on impact). */
export function ballisticWeaponIndices(): number[] {
  const ok = new Set(['Shell', 'Bomb', 'Rocket', 'Missile', 'NUKE', 'Organic', 'DOT']);
  return WEAPON_DATABASE.filter(
    w => ok.has(String(w.type)) && w.damage > 0 && weaponEnabled(w.index),
  ).map(w => w.index);
}

/**
 * Choose a weapon to fire: a random ballistic round, except a level-8+ bot has a
 * 70% chance to grab its highest-"power" (damage) weapon instead (the
 * `level>8 && rand%100<70` upgrade).
 */
export function pickWeapon(level: number, rnd: () => number = Math.random): number {
  const pool = ballisticWeaponIndices();
  if (pool.length === 0) return 0;
  if (level > 8 && rnd() < 0.7) {
    let best = pool[0];
    for (const i of pool) if (WEAPON_DATABASE[i].damage > WEAPON_DATABASE[best].damage) best = i;
    return best;
  }
  return pool[Math.floor(rnd() * pool.length)];
}

/**
 * The computer player's full weapon/utility decision, over the bot's OWNED inventory.
 * In order: a random offensive round (never Shell, never Death); a level>8
 * "strongest weapon" upgrade (70%); a no-arc FALLBACK ladder when the solver found no hitting shot
 * (Escape → Cleaner → Rebound → Beam — weapons that don't need a good arc); then a DEFENSIVE
 * self-buff pass that overwrites the choice when a stat is low, last-match-wins so Heal > Hazmat >
 * Armor > Shield. Returns the chosen weapon index (into WEAPON_DATABASE).
 *
 * `owned` = indices the bot has in stock (the Shell staple always among them). `solutionFound` =
 * the ballistic solver found an arc that actually hits (so the fallback is skipped).
 */
export function chooseBotWeapon(
  owned: number[],
  level: number,
  solutionFound: boolean,
  stats: BotStats,
  rnd: () => number = Math.random,
): number {
  const db = WEAPON_DATABASE;
  const shell = getDefaultWeaponIndex();
  const ext = (i: number): number => db[i].extType ?? 0;
  const val = (i: number): number => db[i].damage; // the magnitude field (dmg / heal / shield / armor value)
  const firstOwned = (e: number): number | undefined => owned.find(i => ext(i) === e);

  // Random OFFENSIVE pick: any owned non-Shell, non-utility, damaging weapon, skipping Death.
  const offensive = owned.filter(i => i !== shell && !BOT_UTILITY_EXT.has(ext(i)) && val(i) > 0);
  const nonDeath = offensive.filter(i => ext(i) !== BOT_EXT.DEATH);
  let sel = nonDeath.length ? nonDeath[Math.floor(rnd() * nonDeath.length)] : shell;

  // "Strongest weapon" upgrade: level>8, 70% → the highest-power (damage) non-Death round.
  if (level > 8 && rnd() < 0.7 && nonDeath.length) {
    sel = nonDeath.reduce((b, i) => (val(i) > val(b) ? i : b), nonDeath[0]);
  }

  // No-arc fallback (level>4, the solver found no hitting arc): reach for a weapon that
  // doesn't need one, in the original's order. Leave the pick as-is if none are owned.
  if (level > 4 && !solutionFound) {
    const ladder = [
      firstOwned(BOT_EXT.ESCAPE),
      owned.find(i => db[i].id === 'cleaner'),
      firstOwned(BOT_EXT.REBOUND),
      firstOwned(BOT_EXT.BEAM),
    ];
    const pick = ladder.find(i => i !== undefined);
    if (pick !== undefined) sel = pick;
  }

  // Defensive self-buff (each overwrites `sel`; last match wins → Heal > Hazmat > Armor > Shield).
  const s7 = firstOwned(BOT_EXT.SHIELD);
  const s11 = firstOwned(BOT_EXT.ARMOR);
  const s14 = firstOwned(BOT_EXT.HAZMAT);
  const s10 = firstOwned(BOT_EXT.HEAL);
  if (s7 !== undefined && stats.shield < 1000 - val(s7)) sel = s7; // won't overflow the 1000 cap
  if (s11 !== undefined && stats.armor < val(s11)) sel = s11; // upgrade to a better armor level
  if (s14 !== undefined && stats.hazmat < val(s14)) sel = s14;
  if (s10 !== undefined && stats.life < stats.maxLife - val(s10) * 0.7) sel = s10; // hurt enough to heal

  return sel;
}
