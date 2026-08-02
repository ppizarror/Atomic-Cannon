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
import {CBotAI, bestAim, simulateShot, type BotPlan, type Pt, type AimField} from './CBotAI';
import {clamp} from '../math/num';
import {AI_LEVEL_ULTRA} from './CBotAI';

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

/** A living SQUADMATE. Ultra scores splash on its own team as a real COST: friendly damage earns the
 *  shooter nothing, and a friendly kill actively subtracts from its credits and its kill tally (see
 *  handleTankDestroyed / awardKillCredit). A shot that clips an ally is usually worse than no shot. */
export interface UltraAlly {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  shield: number;
  hitRadius: number;
  /** Life this "ally" has taken off its OWN side. A traitor forfeits the protection: the higher this
   *  climbs the more the squad stops treating them as a teammate and starts shooting back. */
  betrayal: number;
  /** Their standing in the race the battle is actually scored on (kills in Deathmatch, damage dealt
   *  in Points/Rounds). Only one team can be top of the board — an ally running away with it is a
   *  rival for the win, which is what makes a late betrayal rational rather than random. */
  score: number;
}

/**
 * What the OPPOSITION is holding, and what it has actually been throwing. Weapons are visible in this
 * game, so Ultra reads the enemy arsenal directly and plans AGAINST it rather than against the terrain
 * alone — this is what lets it answer a nuke build with beams and a self-burial instead of trading
 * shells until it loses. `fired*` are observations (intent) on top of `has*` (capability).
 */
export interface UltraThreat {
  bigBlastDamage: number; // heaviest single round any living enemy could land on us right now
  hasNuke: boolean; // holds nuke-class ordnance — a big blast is coming
  hasBeam: boolean; // holds a beam: a ray that reaches us THROUGH dirt, so burying hides nothing
  hasEarth: boolean; // holds a dirt round — can bury US (pinning us) as easily as we can bury ourselves
  hasCleaner: boolean; // holds an earth-remover — burying THEM only pins them for a turn
  credits: number; // enemy war chest: how fast they can escalate to something worse
  firedNukes: number; // rounds they have ACTUALLY thrown — intent, not just capability
  firedBeams: number;
  firedEarth: number;
  shotsSeen: number; // enemy rounds observed in total (the denominator for the above)
}

/** A blank opposition read — used when the caller supplies no threat model (unit tests). */
export const NO_THREAT: UltraThreat = {
  bigBlastDamage: 0,
  hasNuke: false,
  hasBeam: false,
  hasEarth: false,
  hasCleaner: false,
  credits: 0,
  firedNukes: 0,
  firedBeams: 0,
  firedEarth: 0,
  shotsSeen: 0,
};

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
  score?: number; // our own standing in the scored race (see UltraAlly.score) — for the betrayal call
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
  // ── Optional enrichments. Each has a safe default so the planner still runs on a bare context
  // (unit tests build one by hand); the controller always supplies them in a real match. ──
  allies?: UltraAlly[]; // living squadmates — splash on them is scored as a cost, never ignored
  threat?: UltraThreat; // the opposition read (arsenal + what they've been firing)
  focusX?: number; // world-x of the squad's agreed kill target — team focus fire converges here
  /** Life the fallout at column x would cost over one turn parked there (0 on clean ground). Lets a
   *  move weigh "how much radiation is that, really?" instead of treating any speck as lethal. */
  radiationCostAt?: (x: number) => number;
  /** The battle is nearly decided (few enemies left / final rounds) — the point at which an ally who
   *  is beating us stops being a teammate and starts being the last thing between us and the win. */
  endgame?: boolean;
}

/**
 * The chosen action. Ultra plans in the same vocabulary every brain speaks ({@link BotPlan}), so
 * the controller has one executor rather than a branch per difficulty. Kept as a named alias
 * because the planner's internals and its tests read better talking about an "Ultra plan".
 */
export type UltraPlan = BotPlan;

// ==========================================================================
// TUNING
// ==========================================================================

/**
 * Turtling: digging in under a dirt round rather than trading fire.
 */
const BURY = {
  /** A dirt round must pile at least this much to be worth burying under. */
  SELF_MIN_EARTH: 30,
  /** Net life saved (after the round's own blast) below which it is not worth a turn. */
  SELF_MIN_GAIN: 120,
  /** How big an incoming round has to look before turtling is even considered, when the enemy holds
   *  no outright nuke. Below this we just trade fire. */
  SELF_MIN_THREAT: 260,
  /** Fraction of an incoming ground-burst the dirt overhead soaks once we are buried: the round
   *  detonates on the surface ABOVE the tank instead of on the hull, so the engine's distance
   *  falloff does the work. */
  SOAK_FRAC: 0.45,
} as const;

/**
 * What has to be true before the bot walks away from a shot.
 */
const PRIORITY = {
  /** A non-attacking play (flee / buff / bury) must beat the best available SHOT by this factor to
   *  take the turn instead of it. Ultra is here to win, not to potter about: with a real shot on
   *  the table, wandering off has to be clearly better, not merely comparable. */
  NON_ATTACK_MARGIN: 1.35,
  /** Above this shot value the bot never takes a "cunning" setup play instead — a big hit is the
   *  play. */
  TRICK_MAX_SHOT_VALUE: 500,
} as const;

/**
 * Squad play. Splash on a SQUADMATE costs more than the life it removes: the shooter earns no
 * credit for it and a friendly kill subtracts a kill from its tally on top.
 */
const TEAM = {
  /** Converging the squad on ONE target: everyone shooting the same tank turns chip damage into
   *  kills (credits + a standings point) instead of leaving three enemies half-hurt and still
   *  firing back. */
  FOCUS: 220,
  /** An enemy within this of the focus point counts as "the focus target". */
  FOCUS_TOL: 90,
  /** Priced above 1:1 so a shot that catches an ally has to be genuinely devastating to the enemy
   *  before it is taken. */
  FRIENDLY_FIRE_COST: 2.2,
  /** Killing your own tank is a catastrophe, not a trade. */
  FRIENDLY_KILL_COST: 2000,
} as const;

/**
 * What each non-shooting play is worth, so it can be ranked against a shot.
 */
const VALUE = {
  /** Relocating to cover when the enemy already has your range. Beats sitting still to be shelled,
   *  but a real attack still outranks it. */
  COVER: 175,
  /** A candidate spot must beat the current one's cover by this much to bother. */
  COVER_MARGIN: 40,
  /** A crate may pull the bot this much closer to an enemy, no more. */
  CRATE_CLOSE_TOL: 24,
  /** At/under this life fraction, a bot that CAN'T heal is desperate — it throws its premium
   *  ordnance with no reservation (do-or-die). If it can heal, it heals instead (bestBuff's urgency
   *  curve wins). */
  DESPERATE_LIFE_FRAC: 0.3,
  /** Digging out of a bury with a cleaner. Moderate on purpose: a strong beam attack (esp. a kill,
   *  which short-circuits earlier) outranks it, so a buried bot still shoots a weak enemy rather
   *  than dig. */
  DIG_OUT: 400,
  /** Laying a mine in the enemy's zone (area denial). Modest — done when there is no strong attack,
   *  not instead of one. */
  MINE: 130,
  /** Don't lay a second within this of an existing one (redundant). */
  MINE_SPACING: 90,
  /** Effective damage at/above which a premium (nuke) shot is worth firing even without a
   *  kill/multi-hit — a big hit is leverage. Below it, a nuke on a graze is wasteful and stays
   *  banked. */
  PREMIUM_MIN: 250,
  /** Escaping the fallout carpet (avoided DOT over the coming turns). */
  RAD_FLEE: 300,
  /** Moving to set up a shot beats wasting a turn on a guaranteed miss. */
  REPOSITION: 140,
  /** Against a BURIED enemy: penalise an explosive round — its crater (and a beam's carve) would
   *  FREE the enemy to move. So the bot doesn't blast/beam a pinned enemy loose unless the shot
   *  outright kills. */
  UNBURY_PENALTY: 350,
  /** A free weapon pickup. */
  WEAPON_CRATE: 260,
} as const;

/** Re-exported for the controller's autobuy, which shops for a dirt round big enough to hide under. */
export const SELF_BURY_MIN_EARTH = BURY.SELF_MIN_EARTH;

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
  finisherBonus: number; // pressure on an already-WEAK tank: the same damage is worth more when it
  //                        converts to a kill sooner (credits + a point, and it stops shooting back)
  teamplay: number; // 0..1 — how hard it converges on the squad's shared focus target
  paranoia: number; // 0..1 — how strongly an enemy nuke build pushes it to turtle (bury / beam up)
  treachery: number; // 0..1 — willingness to turn on a WINNING teammate once the battle is all but
  //                    decided. 0 = loyal to the end. Retaliation against someone who shot US first
  //                    is separate (see hostility) and every personality does that.
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
  finisherBonus: 420,
  teamplay: 0.7,
  paranoia: 0.6,
  treachery: 0.12, // mostly loyal; will pounce if a teammate is running away with a decided battle
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
    finisherBonus: 620, // hunts the wounded — finishes tanks off rather than spreading damage
    teamplay: 0.85,
    paranoia: 0.25, // rarely turtles; answers a nuke by killing them first
    treachery: 0.55, // only one tank can top the board, and it intends to be the one
  },
  // Survival first: modest aggression, hoards premiums, heals early, values loot, mixes weapons up.
  cautious: {
    ...ULTRA_WEIGHTS_DEFAULT,
    killBonus: 1000,
    premiumWaste: 6000,
    creditValue: 0.5,
    healBelow: 0.78,
    explore: 0.35,
    finisherBonus: 330,
    teamplay: 0.6,
    paranoia: 1, // the turtle: reads an enemy nuke and digs in behind beams
    treachery: 0, // never turns on its own side — it still shoots back at one that turns on it
  },
  // Plays mind-games: loves traps/reposition/bury setups over raw damage, very varied.
  trickster: {
    ...ULTRA_WEIGHTS_DEFAULT,
    trickChance: 0.42,
    buryBonus: 380,
    killBonus: 1100,
    dotWeight: 0.8,
    explore: 0.45,
    finisherBonus: 380,
    teamplay: 0.45, // freelances more than the others
    paranoia: 0.8,
    treachery: 0.3,
  },
};
export const ULTRA_PERSONALITY_NAMES = Object.keys(ULTRA_PERSONALITIES);

/** Blast damage this weapon would deal to one enemy centred at (cx,cy) — the engine's two-radius
 *  model (full inside the core, linear falloff to zero at the outer edge; beams = full everywhere).
 *  `spread` widens the OUTER reach so cluster/airburst rounds correctly catch tanks spread over an
 *  area (their submunitions rain wide), which is why Ultra reaches for them against a spread group. */
export function blastDamageToEnemy(
  cx: number,
  cy: number,
  w: UltraWeapon,
  e: {x: number; y: number; hitRadius: number},
): number {
  const collR = e.hitRadius;
  const outer = Math.max(w.radius + w.spread, 0) + collR;
  const inner = w.innerR + collR;
  const dist = Math.hypot(e.x - cx, e.y - cy);
  if (dist > outer) return 0;
  if (w.isBeam || dist <= inner) return w.damage;
  return w.damage * (1 - dist / outer);
}

/** Effective HP the bot must chew through to KILL a tank: life plus the shield (armor/hazmat are
 *  percentage soaks we fold in loosely). Piercing rounds bypass the shield. */
function effectiveHp(e: {life: number; shield: number}, piercing: boolean): number {
  return e.life + (piercing ? 0 : e.shield);
}

/** How hurt a tank already is, 0 (untouched) … 1 (on its last legs) — the "shoot the weak one" term. */
function weakness(e: {life: number; maxLife: number}): number {
  return clamp(1 - e.life / Math.max(1, e.maxLife), 0, 1);
}

/**
 * How much of a teammate's protection they've forfeited, 0..1. A clean ally is 1 (fully protected);
 * one that has been shelling its own side slides toward 0, at which point the squad scores a shot at
 * them exactly like a shot at the enemy. Nobody keeps covering for the guy who keeps hitting them.
 */
function trust(a: UltraAlly): number {
  return clamp(1 - a.betrayal / GRUDGE_FULL_BETRAYAL, 0, 1);
}
const GRUDGE_FULL_BETRAYAL = 450; // friendly damage at which an ally is treated as an outright enemy

/** A teammate paired with how much of a legitimate TARGET they currently are (see {@link hostility}). */
interface AllyTarget {
  ally: UltraAlly;
  hostility: number;
}

/**
 * How much this teammate has stopped being one, 0..1 — the number that lets one continuous rule cover
 * "cover your squad", "shoot back at the guy who shelled you" and "the last ally standing between you
 * and the win". Two ways a teammate becomes a target:
 *  • GRUDGE — they've been putting rounds into their own side. Retaliation needs no further excuse,
 *    scales with how much they've done, and is what stops a traitor farming their own team for free.
 *  • BETRAYAL — cold, deliberate, and deliberately rare: only once the battle is nearly decided, only
 *    against a teammate who is actually BEATING us on the board (one team tops it, and if they're ahead
 *    it won't be us), and only as far as this bot's `treachery` allows. A cautious bot never does it;
 *    a ruthless one will. That combination is what makes it read as a decision rather than a glitch.
 */
function hostility(a: UltraAlly, ctx: UltraCtx, wt: UltraWeights): number {
  const grudge = 1 - trust(a);
  if (grudge > 0.01) return grudge;
  if (!ctx.endgame || wt.treachery <= 0) return 0;
  const mine = ctx.self.score ?? 0;
  if (a.score <= mine) return 0; // not the one standing between us and the win — leave them alone
  return wt.treachery;
}

/**
 * Score a weapon detonating at (cx,cy). Sums EFFECTIVE damage across every enemy it catches (capped
 * at each tank's HP — no overkill credit) plus a kill bounty, and then SUBTRACTS what it does to our
 * own squad. On top of raw damage it prices the two things a good human player is actually tracking:
 *  • FINISHER — the same 200 damage is worth far more on a tank that only has 250 left than on a
 *    fresh one: it converts into a kill (credits + a standings point) and takes a gun off the board.
 *  • FOCUS — everyone in the squad shooting the SAME tank ends the fight; three half-dead enemies
 *    still shoot back, one dead one doesn't.
 */
function scoreBlast(
  cx: number,
  cy: number,
  w: UltraWeapon,
  enemies: UltraEnemy[],
  wt: UltraWeights,
  allies: AllyTarget[] = [],
  focusX?: number,
): {value: number; kills: number; hits: number; allyHits: number; damage: number} {
  let value = 0,
    kills = 0,
    hits = 0,
    allyHits = 0,
    damage = 0;
  for (const e of enemies) {
    const raw = blastDamageToEnemy(cx, cy, w, e);
    if (raw <= 0) continue;
    hits++;
    const hp = effectiveHp(e, w.piercing);
    const dealt = Math.min(raw, hp); // don't reward overkill beyond what removes the tank
    value += dealt;
    damage += dealt;
    // FINISHER: a WOUNDED tank is worth hitting more than a healthy one — the same round converts into
    // a kill (credits + a standings point) far sooner, and a dead tank stops shooting back. Keyed on
    // how hurt the TARGET already is, not on how big our round is, so it steers WHO we shoot without
    // disturbing WHICH weapon we pick for the job.
    value += weakness(e) * wt.finisherBonus;
    // FOCUS: the squad's agreed target. Converging turns three wounded enemies into one dead one.
    if (focusX !== undefined && Math.abs(e.x - focusX) <= TEAM.FOCUS_TOL)
      value += TEAM.FOCUS * wt.teamplay;
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
  // OUR OWN SQUAD. Splash on a teammate earns nothing and a friendly kill costs credits AND a kill off
  // our tally, so it's priced ABOVE the life it removes: a shot that clips an ally has to be
  // devastating to the enemy before it's worth taking. `hostility` (0..1) is how much that teammate has
  // stopped being one — retaliation against someone who shelled us, or a cold late-game move on the
  // squadmate who's about to take the win. It slides the same tank continuously from "protect at all
  // costs" to "score exactly like an enemy".
  for (const {ally: a, hostility: h} of allies) {
    const raw = blastDamageToEnemy(cx, cy, w, a);
    if (raw <= 0) continue;
    allyHits++;
    const hp = effectiveHp(a, w.piercing);
    const dealt = Math.min(raw, hp);
    const friend = 1 - h;
    // What we'd gain if they're fair game…
    value += h * (dealt + weakness(a) * wt.finisherBonus);
    if (raw >= hp) value += h * wt.killBonus;
    // …and what it costs us while they're still a teammate.
    value -= friend * dealt * TEAM.FRIENDLY_FIRE_COST;
    if (raw >= hp) value -= friend * TEAM.FRIENDLY_KILL_COST;
  }
  return {value, kills, hits, allyHits, damage};
}

/** Anything we're willing to point the gun at — an enemy, or a teammate who has become one. */
type AimTarget = {x: number; y: number; hitRadius: number; buried?: boolean};

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
  const desperate = ctx.self.life < ctx.self.maxLife * VALUE.DESPERATE_LIFE_FRAC && !canHeal;

  const cands: ShotPlan[] = [];
  const consider = (p: ShotPlan) => cands.push(p);
  // Higher value wins; at equal value the CHEAPER weapon does (bank the pricey stuff).
  const better = (a: ShotPlan, b: ShotPlan): boolean =>
    a.value > b.value ||
    (a.value === b.value &&
      weaponCost(weapons, a.weaponIndex) < weaponCost(weapons, b.weaponIndex));

  // Our own squad, each priced by how much of a target they've become (grudge / late-game betrayal).
  const allies: AllyTarget[] = (ctx.allies ?? []).map(a => ({
    ally: a,
    hostility: hostility(a, ctx, wt),
  }));
  const focusX = ctx.focusX;
  // Where we're willing to AIM. Enemies always; a teammate only once they're a real target — otherwise
  // we'd never solve an arc onto them and a traitor could shell their own side unanswered forever.
  const aimAt: AimTarget[] = [
    ...enemies,
    ...allies.filter(t => t.hostility > 0.05).map(t => t.ally),
  ];

  for (const e of aimAt) {
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
        const s = scoreBlast(e.x, e.y, w, enemies, wt, allies, focusX);
        if (s.hits + s.allyHits > 0)
          consider({
            weaponIndex: w.index,
            angleDeg: beamAngle,
            power: 1000,
            targetX: e.x,
            value: adjustForPremium(w, s.value, s.kills, s.hits, wt, desperate, s.damage),
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
      const s = scoreBlast(cx, cy, w, enemies, wt, allies, focusX);
      if (s.hits + s.allyHits === 0) continue;
      let value = adjustForPremium(w, s.value, s.kills, s.hits, wt, desperate, s.damage);
      // Trap play: an earth (dirt-dumping) weapon on a weak, low target is worth a little extra even
      // when it barely damages — it buries them.
      if (w.earth > 0 && s.kills === 0 && enemyIsWeak(enemies, cx, cy)) value += wt.buryBonus;
      // Don't blast a BURIED enemy free: an explosive round's crater un-buries it — unless it KILLS
      // (then who cares). Penalise it so a beam is preferred while the enemy is pinned.
      if (e.buried && s.kills === 0 && w.earth <= 0) value -= VALUE.UNBURY_PENALTY;
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
  damage: number, // EFFECTIVE damage this round would actually land, not the composite value
): number {
  // DESPERATE (near death, can't heal): no reservation — throw everything, it's do-or-die.
  // The "is this shot big enough to be worth a nuke?" test reads raw DAMAGE on purpose: the composite
  // value carries positional bonuses (finisher/focus) that say nothing about whether the round itself
  // landed hard, and letting those inflate it past the bar would spend nukes on grazes.
  if (!w.isPremium || desperate || kills > 0 || hits >= 2 || damage >= VALUE.PREMIUM_MIN)
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

// Fraction of our REMAINING life the fallout at a destination may cost before that destination is off
// the table entirely. Below it the radiation is priced as a cost and weighed against the prize.
const RAD_VETO_FRAC = 0.35;

/**
 * Life the fallout at column x would cost if we parked there for a turn, or `undefined` when the
 * caller gave us no dosimeter. This is what turns "never step on green" into an actual judgement
 * call: a dying speck carpet costs a few points and a fresh crater costs a third of your health, and
 * the bot should cross the first for a weapon crate while refusing the second for anything.
 *
 * With no reading available we return undefined rather than a guess, and every caller falls back to
 * the old conservative rule (any fallout = keep off). Unknown dose is not the same as small dose.
 */
function radCost(ctx: UltraCtx, x: number): number | undefined {
  return ctx.radiationCostAt ? Math.max(0, ctx.radiationCostAt(x)) : undefined;
}

/** Radiation cost as a plain number for arithmetic — 0 when unmeasured (the veto has already dealt
 *  with the unknown case, so this only ever discounts a value we've decided is reachable). */
const radPenalty = (ctx: UltraCtx, x: number): number => radCost(ctx, x) ?? 0;

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
    if (distToEnemies(c.x) < dNow - VALUE.CRATE_CLOSE_TOL) continue; // don't close on the enemy for loot
    if (unsafeMoveTo(ctx, c.x)) continue; // don't drive over a mine / into fallout for loot
    let value: number;
    if (c.kind === 'credits') value = c.amount * (ctx.weights ?? ULTRA_WEIGHTS_DEFAULT).creditValue;
    else if (c.kind === 'health') value = Math.min(c.amount, self.maxLife - self.life);
    else value = VALUE.WEAPON_CRATE; // weapon
    // Net of the dose we'd take standing on that ground: a crate sitting in fallout is worth grabbing
    // only if the payload beats the health it costs us.
    value -= radPenalty(ctx, c.x);
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
  // What running is actually WORTH: the dose we'd eat by staying put, scaled by how badly we can
  // afford it. 200 damage of fallout on a full-health tank is an annoyance it can shoot through; the
  // same carpet on a tank with 250 life left is the whole game, so the urgency curve climbs steeply as
  // life falls. Measured dose beats the old flat guess in both directions — it stops the bot sprinting
  // off a dying speck carpet, and stops it standing in a fresh crater trading shots.
  const lifeFrac = self.maxLife > 0 ? self.life / self.maxLife : 1;
  const urgency = Math.max(0.5, (1 - lifeFrac) * 2.2);
  const dose = radCost(ctx, self.x);
  const value =
    dose !== undefined && dose > 0
      ? dose * urgency
      : VALUE.RAD_FLEE * Math.max(0.12, (1 - lifeFrac) * 1.4);
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
  const value = VALUE.REPOSITION - radPenalty(ctx, destX); // net of the dose waiting at the new spot
  return value > 0 ? {destX, value, note: 'reposition'} : null;
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

/**
 * A destination is UNSAFE to drive to if the path crosses a mine (instant, heavy, non-negotiable) or
 * the fallout waiting there would eat a serious slice of the life we have left. Light contamination is
 * NOT a veto — it comes back as a cost the caller subtracts from the prize, so the bot can decide that
 * a weapon crate is worth walking through a thin carpet while refusing to park in a fresh hot zone.
 */
function unsafeMoveTo(ctx: UltraCtx, destX: number): boolean {
  if (pathHitsMine(ctx.self.x, destX, ctx.mines)) return true;
  const dose = radCost(ctx, destX);
  if (dose === undefined) return ctx.radiationAt(destX); // no reading → assume the worst, keep off
  return dose >= Math.max(1, ctx.self.life) * RAD_VETO_FRAC;
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
      // A ridge that shields us is worth less if we have to stand in fallout to get behind it — price
      // the dose against the cover before deciding this spot is "safer".
      const cover = coverScore(x, ex, field) - radPenalty(ctx, x);
      if (cover > here + VALUE.COVER_MARGIN && (!best || cover > best.cover))
        best = {destX: x, cover};
    }
  }
  return best ? {destX: best.destX, value: VALUE.COVER, note: 'cover'} : null;
}

/**
 * TURTLE UP — bury ourselves on purpose. Reading the enemy arsenal (weapons are visible) and finding a
 * nuke pointed our way, the answer isn't to trade shells with it: it's to pile dirt over our own hull
 * so their round detonates on the surface ABOVE us instead of on it, and keep fighting from underneath
 * with a beam, which is a straight ray that doesn't care about the dirt in the way.
 *
 * Deliberately narrow, because being buried is also a cage — no driving, no ballistic rounds:
 *  • only against a real big-blast threat, and only if they DON'T hold a beam of their own (a beam
 *    reaches us underground just as well as it reaches us on the surface, so digging in buys nothing);
 *  • only if we hold a beam with ammo, so we can still shoot back from down there;
 *  • only if the dirt saves meaningfully more life than the round we drop on ourselves costs.
 */
function bestSelfBury(ctx: UltraCtx): {plan: UltraPlan; value: number} | null {
  const {self} = ctx;
  const wt = ctx.weights ?? ULTRA_WEIGHTS_DEFAULT;
  const threat = ctx.threat ?? NO_THREAT;
  if (self.buried || wt.paranoia <= 0) return null;
  if (threat.hasBeam) return null; // they can shoot us through the dirt — a hole is just a hole
  const incoming = threat.bigBlastDamage;
  if (!threat.hasNuke && incoming < BURY.SELF_MIN_THREAT) return null;
  if (!ctx.weapons.some(w => w.isBeam && w.count > 0)) return null; // nothing to fight back with
  // The dirt round to drop on ourselves: enough earth to actually cover the hull, and of those the one
  // that hurts us least (it detonates on our own hull, so its damage is paid in full).
  const dirt = ctx.weapons
    .filter(w => w.earth >= BURY.SELF_MIN_EARTH && w.count > 0)
    .sort((a, b) => a.damage - b.damage || a.cost - b.cost)[0];
  if (!dirt) return null;
  const saved = incoming * BURY.SOAK_FRAC * wt.paranoia;
  const value = saved - dirt.damage;
  if (value < BURY.SELF_MIN_GAIN) return null;
  return {
    plan: {
      action: 'fire',
      weaponIndex: dirt.index,
      angleDeg: 90,
      power: 300,
      targetX: self.x,
      note: 'self-bury',
    },
    value,
  };
}

/** Lay a mine in the nearest enemy's zone (area denial). Fired as a normal arc; it plants a mine where
 *  it lands, forcing the foe to detour. Only when we hold a mine and aren't buried. */
function bestMineLay(ctx: UltraCtx): {plan: UltraPlan; value: number} | null {
  if (ctx.self.buried) return null;
  const mine = ctx.weapons.find(w => w.isMine && w.count > 0);
  if (!mine || !ctx.enemies.length) return null;
  const e = nearestEnemy(ctx);
  // Pointless to lay another mine where one already pins the enemy — one is enough.
  if (ctx.mines.some(mx => Math.abs(mx - e.x) < VALUE.MINE_SPACING)) return null;
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
    value: VALUE.MINE,
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

const clampX = (x: number, field: AimField): number => clamp(x, 20, field.width - 20);

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
    value: VALUE.DIG_OUT,
  };
}

/**
 * LAST RESORT — the play when every scored option came back empty (no arc reaches anyone, nothing to
 * grab, nowhere to drive, no buff worth taking). Doing nothing is never the right answer: the bot's
 * situation doesn't change on its own, so a skipped turn repeats every round for the rest of the
 * battle. Fire the CHEAPEST offensive round it holds (never burn a nuke on a shot this hopeless):
 *  • BURIED — straight up at its own column. The muzzle is inside the dirt, so the round detonates
 *    right there and blasts the tank free. It eats that blast, which is why a cleaner (no damage,
 *    scored at VALUE.DIG_OUT) always wins when one is in stock — but taking the hit beats being
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

  // ATTACK FIRST. With a real shot on the table, every alternative has to CLEARLY beat it — not merely
  // match it — before the bot spends its turn on anything else. A tank that answers fire with fire wins
  // games; one that keeps repositioning to a marginally better hill loses them slowly.
  const attackFloor = canHit ? shot!.value * PRIORITY.NON_ATTACK_MARGIN : 0;
  const offer = (plan: UltraPlan, value: number, trick = false): void => {
    if (value > attackFloor) cands.push({plan, value, trick});
  };

  // BURIED: dig out with a cleaner (no self-damage) — usually the best use of a stuck turn.
  const dig = bestCleanSelf(ctx);
  if (dig) offer(dig.plan, dig.value);

  // TURTLE: read the enemy arsenal and, against an incoming nuke we can't out-trade, dig IN instead —
  // dirt over the hull, then fight on from underneath with a beam.
  const turtle = bestSelfBury(ctx);
  if (turtle) offer(turtle.plan, turtle.value);

  // SURVIVAL plays: flee the fallout you're standing on, and self-buff/heal when hurt. Both still have
  // to clear the attack floor — a scratch is not a reason to stop shooting.
  const flee = bestRadiationEscape(ctx);
  if (flee) offer({action: 'move', destX: flee.destX, note: flee.note}, flee.value);
  const buff = bestBuff(ctx);
  if (buff) offer({action: 'buff', weaponIndex: buff.weaponIndex, note: buff.note}, buff.value);

  // POSITIONING / LOOT plays — ONLY when the bot can't actually hit an enemy this turn. Firing always
  // comes first: a bot with a real shot shoots, it doesn't wander off for a crate or into cover.
  if (!canHit) {
    const crate = bestCrateGrab(ctx);
    if (crate) offer({action: 'move', destX: crate.destX, note: crate.note}, crate.value, true);
    const cover = bestCoverMove(ctx);
    if (cover) offer({action: 'move', destX: cover.destX, note: cover.note}, cover.value, true);
    const mine = bestMineLay(ctx);
    if (mine) offer(mine.plan, mine.value, true);
    const repo = bestReposition(ctx);
    if (repo) offer({action: 'move', destX: repo.destX, note: repo.note}, repo.value, true);
  }

  // Nothing scored at all — take the desperation shot rather than passing the turn (a pass would just
  // repeat next round, since nothing about the bot's position changes while it stands there).
  if (!cands.length) return lastResortShot(ctx) ?? {action: 'skip', note: 'no-action'};

  cands.sort((a, b) => b.value - a.value);
  const top = cands[0];

  // Human-ish cunning: occasionally take a near-as-good SETUP play (crate/reposition) over the
  // raw-best shot — but never pass up a kill, and never instead of a genuinely BIG hit. Being unpredictable
  // is worth a little expected value; passing on a shot that would take a third of someone's health is not.
  const trickChance = (ctx.weights ?? ULTRA_WEIGHTS_DEFAULT).trickChance;
  const bigHit = (shot?.value ?? 0) >= PRIORITY.TRICK_MAX_SHOT_VALUE;
  if (
    top.plan.action === 'fire' &&
    !bigHit &&
    (shot?.kills ?? 0) === 0 &&
    ctx.rnd() < trickChance
  ) {
    const trick = cands.find(c => c.trick && c.value >= top.value * 0.6);
    if (trick) return trick.plan;
  }
  return top.plan;
}

/**
 * CBotUltraAI — the level-11 brain, as an object.
 *
 * Where the classic brain fires and hopes, this enumerates every action available this turn,
 * scores each in one life-damage currency, and takes the best (see {@link planUltraTurn} for the
 * doctrine). It is a {@link CBotAI} specialisation over the richer {@link UltraCtx}: same
 * `planTurn` contract, same {@link BotPlan} out, strictly more world in.
 */
export class CBotUltraAI extends CBotAI<UltraCtx> {
  constructor() {
    super(AI_LEVEL_ULTRA);
  }

  planTurn(ctx: UltraCtx): BotPlan {
    return planUltraTurn(ctx);
  }
}
