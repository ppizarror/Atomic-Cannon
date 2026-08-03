/**
 * Weapon behaviours — one dispatcher over `extType`, the weapon's behaviour selector.
 *
 * Covers per-frame shot dispatch and the detonation path. The mechanics (which
 * extType does what, cluster fan, battery drop, roller/digger motion, radiation
 * fields) are documented in the notes; a couple of pieces (radiation
 * damage-over-time, the `earth` deposit amount) are derived from the data fields.
 */
import {Vec2} from '../../math/Vec2';
import {CShot, REF_TIME_SCALE, SHOT_GRAVITY, SHOT_WIND_ACCEL, launchSpeed} from '../CShot';
import {CTank} from '../CTank';
import {CLand} from '../CLand';
import {CWeapon} from '../CWeapon';
import {GameConfig} from '../CGameConfig';
import {EXT, isBeamExt} from './ExtType';
import {type ExpType} from './ExpType';

export {EXT, isBeamExt} from './ExtType';
export type {ExtType} from './ExtType';

// ==========================================================================
// TUNING
// ==========================================================================

/**
 * Swept-collision resolution: a single Euler step can span 35-50px on big maps vs a ~16px tank hit
 * radius, so the endpoint point-sample can tunnel through a tank / thin ridge the path crossed. We
 * walk the frame's segment in sub-steps ≤ `STEP` px apart.
 */
const CCD = {
  /** Bounds the loop — a real step never exceeds ~50px, so ~13 sub-steps; this is a runaway guard. */
  MAX_SUBS: 16,
  STEP: 4,
} as const;

/**
 * Share of its own crater a blast throws back in as spoil: a small base every cratering weapon
 * returns, plus the part its `fodder` earns — and `fodder` carries most of it, because that is the
 * field that says how much dirt this weapon kicks up.
 *
 * The base is deliberately LOW. At 0.35 even a fodder-0.1 shot puts back nearly 40% of its bowl,
 * which is most of a small crater's depth once the spoil lands mostly inside it — digging with
 * anything but a nuke becomes impossible, and `fodder` stops mattering because the base dwarfs it.
 * At 0.08 a plain shell keeps ~85% of the hole it dug and a nuke still buries a third of its own.
 */
const EJECTA = {
  FILL_BASE: 0.08,
  FILL_FODDER: 0.7,
  /** Ceiling on airborne dirt chunks per blast. Volume beyond it is bought by deepening what each
   *  chunk lays down on landing, so a nuke's spoil costs no more frame time than a bomb's. */
  MAX_CHUNKS: 20000,
} as const;

/**
 * The shot itself.
 */
const SHOT = {
  /** Submunition launch power = this × firing power. */
  CLUSTER_POWER: 0.5,
  /** Max lifetime (s) before it self-detonates. */
  MAX_LIFE: 10,
  /** Roller surface speed (px/s in our space). */
  ROLL_SPEED: 260,
} as const;

/**
 * Homing missile (EXT.HOMING) — a guided round in the Worms mould, kept inside this engine's
 * ballistics rather than turned into a free-flying drone. Its flight has three acts:
 *
 *  1. CRUISE — it leaves the barrel as an ordinary rocket and climbs on momentum alone.
 *  2. COAST — a quarter of the way out the motor cuts and the horizontal speed bleeds to half by
 *     the apex. It never stalls; it slouches, which is what sells the relight that follows.
 *  3. GUIDED — the sustainer lights at the apex and burns the whole way down. The round picks the
 *     enemy nearest where it was going to land, then keeps re-solving as it falls: it can switch
 *     targets mid-descent, and a target that dies stops being chased.
 *
 * Authority is a band of ±`homMaxDeg` (a WEAPON stat, not an engine constant, so a pricier seeker
 * can simply be given more of it) measured from the APEX heading — anchored
 * there, not to the round's current line, so weaving inside it can never ratchet into a U-turn.
 * Within that band the airframe swings at a bounded rate, so every correction is a lean the player
 * can read rather than a kink. The reachable spread across the band is what the on-screen fan
 * draws, and it narrows as the descent runs out of time to turn.
 *
 * The search predicts with the SAME dynamics it will then fly (bounded swing, sustained burn,
 * gravity, wind), so the correction it commits to is one the missile can actually hold.
 */
const HOMING = {
  /** How far from the UNGUIDED impact point a tank can sit and still be acquired (px). */
  ACQUIRE_PX: 300,
  /** Fraction of the predicted range where the motor cuts and the round starts coasting down… */
  COAST_FROM: 0.25,
  /** …reaching this fraction of its launch horizontal speed by the apex. It never stops — it
   *  slouches into the top of the arc, which is what makes the relight afterwards read. */
  COAST_TO: 0.5,
  /** Degrees per second the airframe can swing. The command can jump; the missile cannot, so
   *  every correction is a lean rather than a kink — and a late re-target visibly costs time. */
  TURN_RATE_DEG: 22,
  /** Sustainer burn once relit: fraction of current speed added per second, capped so a long
   *  descent cannot accelerate the round into a railgun. */
  BURN_PER_SEC: 0.55,
  BURN_MAX_SCALE: 2.2,
  /** Guidance re-solves this often (seconds). Every frame is wasted work; too slow and a target
   *  that dies or moves is chased for a visible beat. */
  RESOLVE_SEC: 0.1,
  /** Landing points sampled across the band for the on-screen fan. The drawn edge is smoothed
   *  through them with midpoint quadratics, so this buys shape, not resolution — each extra
   *  sample is a whole extra trajectory prediction. */
  FAN_SAMPLES: 13,
  /** Prediction step — the SIM's step, not a coarser one. A 1/30 prediction is cheaper but its
   *  integration error runs the same way for every candidate turn, so the search happily commits
   *  to a correction that lands ~20px short of where it was told it would. */
  PREDICT_DT: 1 / 60,
  /** Runaway cap ≈10 s of flight — past {@link SHOT.MAX_LIFE}, so it never binds in practice. */
  PREDICT_STEPS: 600,
} as const;

// ==========================================================================
// INTERFACES & TYPES
// ==========================================================================

/** The world a shot behaves against — implemented by the game controller. */
export interface ShotWorld {
  readonly land: CLand;
  readonly tanks: CTank[];

  /** Live effective wind (the same vector shots are integrated against). Homing needs it to
   *  predict where its own corrected arc actually lands. */
  readonly wind: Vec2;

  /** Resolution-based blast scale (√(view area)·C) — sizes the crater/FX/damage radius off the render
   *  surface, exactly like the original. A derived render value (NOT a user setting), so it lives on
   *  the world context, not in GameConfig. */
  readonly blastScale: number;

  /** A GAMEPLAY random in [0,1) from the match-seeded stream — deterministic across
   *  clients (must NOT be Math.random for anything that affects the outcome). */
  random(): number;

  spawnShot(shot: CShot): void;

  /** Detonation FX. `color`/`radiusPx`/`nuclear` tint & scale the burst; `blastPreset`
   *  names its particles.json effect; `expType` + `expBitmap` select the weapon's own explosion
   *  flare sprite and style. `isCleaner` suppresses the big-blast screen flash (an earth-remover
   *  is not a fiery blast). */
  explode(
    x: number,
    y: number,
    scale: number,
    color?: string,
    radiusPx?: number,
    nuclear?: boolean,
    blastPreset?: string,
    expType?: ExpType,
    expBitmap?: string,
    deposit?: boolean,
    isCleaner?: boolean,
  ): void;

  /** Cosmetic dirt spray — chunks that fly and vanish, raising nothing. Distinct from the crater
   *  ejecta on CLand, which writes the heightmap and must stay on the seeded stream. */
  debrisSpray(x: number, y: number, count: number, radius: number, gentle?: boolean): void;

  shake(mag: number, dur: number): void;

  ripple(x: number, y: number, strength: number): void;

  /** Two-radius blast damage + kick + shield/armor. Full `damage` inside `innerRadius`
   *  (the direct-hit core), then LINEAR falloff to zero at `radius` (the outer field). `full`
   *  skips falloff entirely (beams). `piercing` marks a secondary/piercing weapon, so the
   *  target's Hazmat resistance applies. `innerRadius` defaults to 0 (a point core). */
  applyBlast(
    pos: Vec2,
    radius: number,
    damage: number,
    owner: CTank | null,
    full: boolean,
    piercing?: boolean,
    innerRadius?: number,
  ): void;

  aimMarker(x: number, y: number, label?: string): void;

  deployMine(x: number, y: number, owner: CTank | null, weaponIndex: number): void;

  deploySentry(x: number, y: number, owner: CTank | null, weaponIndex: number): void;

  /** Play a weapon's impact sound (`soundHit`) panned to the blast, if audio is wired. */
  hitSound(name: string, x: number): void;
}

export type FlyAction = 'continue' | 'detonate' | 'consumed';

// ==========================================================================
// FLIGHT STEP
// ==========================================================================

/** First live tank whose hit radius contains (x, y), or null. Point test — the swept walk in
 *  weaponFlyStep calls it per sub-step so a fast shot can't step clean over a tank between frames. */
function tankAt(shot: CShot, world: ShotWorld, x: number, y: number): CTank | null {
  const owner = shot.getOwner();
  for (const t of world.tanks) {
    if (!t.isAlive() || t.distanceTo(x, y) >= t.getHitRadius()) continue;
    // A shot can't detonate on its OWN tank until it has cleared the muzzle (see CShot arming) — else
    // a low-power / down-slope shot self-detonates the instant it fires. Other tanks are always fair.
    if (t === owner && !shot.hasLeftOwner()) continue;
    return t;
  }
  return null;
}

/**
 * Per-frame decision for a shot in flight, dispatched on extType. Runs AFTER the
 * shot's integrator step. Returns whether the shot keeps flying, detonates, or
 * was consumed (deployed / left the world) with no explosion.
 */
export function weaponFlyStep(
  shot: CShot,
  weapon: CWeapon,
  world: ShotWorld,
  dt: number,
): FlyAction {
  const land = world.land;
  let p = shot.getPosition();

  // Left the world entirely.
  if (p.x < -60 || p.x > land.width + 60 || p.y > land.height + 80) return 'consumed';

  const ext = weapon.getExtType();
  const isBeam = isBeamExt(ext);

  // Battery: primary shots drop a bomblet straight down every batSec while descending.
  if (!isBeam) batteryTick(shot, weapon, world, dt);

  // Homing: the ONLY thing that separates this from a plain missile. Everything else — collision,
  // detonation, crater — is the ballistic path below; guidance just steers the velocity, and only
  // from the apex onward. Runs before the sweep so the new heading is what the NEXT frame flies.
  if (ext === EXT.HOMING) homingStep(shot, weapon, world, dt);

  // Swept collision: walk this frame's segment (prev→cur) so a fast shot can't tunnel a tank/ridge.
  const prev = shot.getPrevPosition();
  const segX = p.x - prev.x;
  const segY = p.y - prev.y;
  const segLen = Math.hypot(segX, segY);
  const subs = segLen > CCD.STEP ? Math.min(CCD.MAX_SUBS, Math.ceil(segLen / CCD.STEP)) : 1;

  // Earliest TANK contact along the path (k=subs is the endpoint, so this subsumes a plain point
  // test there). Snap the shot to that point so the blast centres on the impact, not a step beyond it.
  // Every ext detonates on a tank hit (mine/sentry deploy only when they instead meet ground first),
  // so snapping is always followed by detonate/deploy — never a mutated position that keeps flying.
  let hit: CTank | null = null;
  let hitK = 0; // the sub-step index of the tank contact (for tank-vs-terrain ordering in the default case)
  for (let k = 1; k <= subs && !hit; k++) {
    const sx = prev.x + (segX * k) / subs;
    const sy = prev.y + (segY * k) / subs;
    const t = tankAt(shot, world, sx, sy);
    if (t) {
      hit = t;
      hitK = k;
      shot.setPosition(sx, sy);
      p = shot.getPosition();
    }
  }

  const surfaceY = land.getHeightAt(Math.floor(p.x));
  const belowSurface = p.y >= surfaceY - 4;

  // Lifetime cap (rebound/roller can loop) — detonate rather than fly forever.
  if (shot.getAge() > SHOT.MAX_LIFE) return 'detonate';

  switch (ext) {
    case EXT.BEAM:
    case EXT.BEAM_ALT:
      // Hitscan: straight line (no gravity, set at launch). Detonates on a tank.
      return hit ? 'detonate' : 'continue';

    case EXT.AIRBURST:
      // Detonate at the apex (once it starts descending) — but ONLY the PRIMARY (gen 0). Its cluster
      // submunitions are fanned out from the apex (some downward like shrapnel, some up-and-over like
      // sky.cluster) and MUST NOT airburst themselves — they'd all pop at the top instead of arcing
      // down. So gen≥1 fly ballistically and burst on impact (they still rain down either way).
      if (hit || belowSurface) return 'detonate';
      return shot.getGeneration() === 0 && shot.isMovingDown() ? 'detonate' : 'continue';

    case EXT.DIGGER:
      // PENETRATES terrain along its full ballistic arc (no straight-down override) —
      // it can tunnel through a mountain and come out the far side. It detonates:
      //   (b) on a tank, (c) if it's buried but NOT descending (entered while rising, or
      //   its arc bottomed out inside the mass) → blow up right there, or (a) once it has
      //   burrowed within a random margin of the WORLD FLOOR. Emerging into open air does
      //   NOT detonate — it keeps flying (and detonates when it re-impacts the far side).
      if (hit) return 'detonate';
      if (belowSurface) {
        if (!shot.isMovingDown()) return 'detonate'; // (c) buried, not descending
        if (shot.digEntryY < 0) shot.digEntryY = p.y; // anchor the fractional dig-depth calc
        // Descending through the mass: cut a NARROW disc at the current position each step and
        // let the soil cave straight back in — a continuous bore that wipes a thin channel which
        // immediately fills (no open tunnel; no damage while travelling), then detonate at depth.
        if (p.y < diggerDetonateY(shot, land, world)) {
          digCarve(shot, weapon, land, p, world.blastScale);
          return 'continue';
        }
        return 'detonate'; // reached its dig depth (or the world floor)
      }
      return 'continue'; // open air: before entry OR emerged on the far side — keep arcing

    case EXT.ESCAPE:
      // Mirror of Digger: bores through the mass while RISING (tunnels up and out), carving the
      // same continuous narrow channel; detonates once it starts falling.
      if (hit) return 'detonate';
      if (belowSurface) {
        if (shot.isMovingDown()) return 'detonate';
        digCarve(shot, weapon, land, p, world.blastScale);
        return 'continue';
      }
      return 'continue';

    case EXT.ROLLER:
      return rollerStep(shot, world, surfaceY, hit);

    case EXT.REBOUND:
      // Rebounder: dip into terrain → anti-grav jets it back up and OUT; then, once it re-emerges into
      // open air, gravity is restored so it arcs back DOWN and detonates on the next impact. (Anti-grav
      // latches while it's inside the mass — set every sub-surface frame — so it doesn't oscillate on
      // the surface line; it clears exactly once, on emergence, marking the shot "rebounded".) Without
      // the clear it accelerated upward forever, flew off the (unbounded) top of the world, and idled
      // ~10s until the lifetime cap fired a harmless sky detonation — a dead turn that did no damage.
      if (hit) return 'detonate';
      if (shot.hasRebounded()) return belowSurface ? 'detonate' : 'continue'; // falling back → impact
      if (belowSurface) {
        shot.setAntiGrav(true); // buried: jet up and out
      } else if (shot.isAntiGrav()) {
        shot.setAntiGrav(false); // emerged: restore gravity so it arcs back down
        shot.setRebounded(true);
      }
      return 'continue';

    case EXT.MINE:
      if (belowSurface) {
        world.deployMine(p.x, surfaceY, shot.getOwner(), weapon.getIndex());
        return 'consumed';
      }
      return hit ? 'detonate' : 'continue';

    case EXT.SENTRY:
      if (belowSurface) {
        world.deploySentry(p.x, surfaceY, shot.getOwner(), weapon.getIndex());
        return 'consumed';
      }
      return hit ? 'detonate' : 'continue';

    default: {
      // Ballistic (Shell/Bomb/Rocket/Dirt/Cleaner/NUKE/DOT/Organic/Missile/Homing/Tracer/Death).
      // A homing round lands here too: guidance above only bent its velocity, so from the
      // collision's point of view it is an ordinary missile. Detonate at
      // the EARLIER of the tank contact and the first terrain crossing along the swept segment — a fast
      // shot must not tunnel through a ridge to hit a tank sitting behind it. Snap the crater onto it.
      let terrK = -1;
      let terrX = 0;
      let terrY = 0;
      for (let k = 1; k <= subs; k++) {
        const sx = prev.x + (segX * k) / subs;
        const sy = prev.y + (segY * k) / subs;
        if (sy >= land.getHeightAt(Math.floor(sx)) - 4) {
          terrK = k;
          terrX = sx;
          terrY = sy;
          break;
        }
      }
      // Tank first (or tied): the sweep already snapped the shot to the tank contact. Terrain first
      // (or the only contact): re-snap the crater onto the ridge/ground it hit.
      if (hit && (terrK < 0 || hitK <= terrK)) return 'detonate';
      if (terrK >= 0) {
        shot.setPosition(terrX, terrY);
        return 'detonate';
      }
      return 'continue';
    }
  }
}

/**
 * True when a shot has been fired from INSIDE solid terrain and should detonate right at its
 * muzzle — a buried tank (Bury Tanks on, whole hull under the dirt) whose barrel tip sits below
 * the piled-up surface. Its shot must blow up in place, clearing the dirt around the tank, instead
 * of flying the normal arc: the regular `weaponFlyStep` collision runs only AFTER the first full
 * integration step, so a fast shot clears the thin dirt column before it is ever tested.
 *
 * Gated on the FIRER actually being buried (not merely a muzzle dipping underground) so a normal
 * tank aiming steeply DOWNWARD — whose barrel tip can legitimately dip below its own surface column
 * — is not affected. Terrain-only: never a tank test, because the muzzle sits inside the firer's
 * own hit radius. Sub-surface specialists are exempt — they handle being underground themselves
 * (diggers/escapers tunnel, rebounders jet out, rollers roll, mines/sentries deploy, beams hitscan).
 */
export function firedIntoTerrain(shot: CShot, weapon: CWeapon, world: ShotWorld): boolean {
  const ext = weapon.getExtType();
  if (
    ext === EXT.DIGGER ||
    ext === EXT.ROLLER ||
    ext === EXT.ESCAPE ||
    ext === EXT.REBOUND ||
    ext === EXT.MINE ||
    ext === EXT.SENTRY ||
    isBeamExt(ext)
  )
    return false;
  const owner = shot.getOwner();
  if (!owner || !owner.isBuried()) return false; // only a genuinely buried firer
  const p = shot.getPosition();
  return p.y >= world.land.getHeightAt(Math.floor(p.x)) - 4; // muzzle truly inside the dirt
}

// ==========================================================================
// EXT BEHAVIOURS
// ==========================================================================

/** The screen-Y a digger detonates at. The original is floor-relative ("floor − rand"),
 *  which on our terrain proportions either pops shallow (entry near the floor) or bottoms
 *  out at the world origin. Instead we detonate part-way DOWN from where the shot ENTERED —
 *  a per-shot random FRACTION of the distance to the floor — so it always blows up INSIDE
 *  the mass (the middle), never at the very bottom and never a shallow pop. */
function diggerDetonateY(shot: CShot, land: CLand, world: ShotWorld): number {
  if (shot.digDepth < 0) shot.digDepth = 0.45 + world.random() * 0.25; // fraction to the floor
  return shot.digEntryY + (land.height - shot.digEntryY) * shot.digDepth;
}

/** Continuous burrow carve. Each step a Digger/Escape shot spends underground it cuts a NARROW
 *  disc at its current ballistic position — radius = the small `size` field (NOT the big blast
 *  `radius`) — and the soil above caves straight back in, so the channel is a thin, arc-following
 *  trench that fills as fast as it's dug (the original cuts one such crater every frame). The carve
 *  runs with slump OFF: the overburden drops straight down by the removed thickness (grass ends up
 *  that much lower) and the walls stay put — with slump on, the steep bore avalanches sideways and
 *  stacks into a wide funnel. Throttled to ~half a disc of travel so overlapping cuts stay clean. */
function digCarve(shot: CShot, weapon: CWeapon, land: CLand, p: Vec2, blastScale: number): void {
  const r = Math.max(3, weapon.getSize() * GameConfig.explosionScale * blastScale);
  const cols = (shot.digCols ??= new Set<number>());
  land.carveBore(p.x, p.y, r, cols);
}

function rollerStep(shot: CShot, world: ShotWorld, surfaceY: number, hit: CTank | null): FlyAction {
  if (hit) return 'detonate';
  const land = world.land;
  const p = shot.getPosition();
  if (p.y < surfaceY - 6) return 'continue'; // still airborne, keep arcing

  // On the surface: snap to it. Sample the neighbours 2px either side (smaller Y = higher).
  const left = land.getHeightAt(Math.max(0, Math.floor(p.x) - 2));
  const right = land.getHeightAt(Math.min(land.width - 1, Math.floor(p.x) + 2));
  shot.setPosition(p.x, surfaceY);
  const vx = shot.getVelocity().x;

  let dir: number;
  if (!shot.grounded) {
    shot.grounded = true;
    // First contact sitting in a pit (both neighbours higher) → detonate.
    if (left < surfaceY - 1 && right < surfaceY - 1) return 'detonate';
    // Otherwise COMMIT to rolling toward the lower side (ignoring incoming momentum).
    dir = right > left ? 1 : left > right ? -1 : Math.sign(vx) || 1;
  } else {
    // Keep the committed direction — the sign of the velocity we set last frame. Re-picking
    // toward the momentary-lower side every frame makes the roller ping-pong across a valley
    // floor forever (a visible vibration, and camera jitter with it); a real roller rolls one way
    // until it meets a rise, then detonates.
    dir = Math.sign(vx) || 1;
  }
  // Surface AHEAD in the roll direction rises >1px (a wall, or the far side of a valley it
  // rolled down into) → detonate. This is what stops it, so it never oscillates.
  const ahead = dir > 0 ? right : left;
  if (ahead < surfaceY - 1) return 'detonate';

  shot.setVelocity(dir * SHOT.ROLL_SPEED, 0);
  return 'continue';
}

// ---- HOMING GUIDANCE ----------------------------------------------------
// Arms at the apex, eases a bounded correction in while the sustainer burns. See the HOMING
// tuning block for what each number buys.

/** Turn a velocity by `deg` degrees. Screen space (+Y down), so a positive angle swings the
 *  heading clockwise as drawn; guidance searches both signs, so the convention only has to be
 *  consistent between the prediction and the live step. */
function turnVel(vx: number, vy: number, deg: number): {x: number; y: number} {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a),
    s = Math.sin(a);
  return {x: vx * c - vy * s, y: vx * s + vy * c};
}

/**
 * Fly a copy of the round forward with `turnDeg` committed: the SAME ease + sustainer burn +
 * gravity + wind the live step applies, walked to the ground (or out of the world). Predicting
 * with the real dynamics is the point — a straight-line or unpowered-ballistic guess would pick a
 * correction the missile cannot actually fly.
 *
 * Returns where the round would DETONATE, applying the same two stopping rules the live sweep
 * does: contact with `aim` inside `aimR`, or the ground. Both matter. Ranking corrections purely
 * on the ground crossing biases every one of them short, because the live round stops early on a
 * hull it would have flown past; ranking on closest approach over-corrects the other way, sending
 * the missile over the target's head to land well beyond it.
 *
 * Two deliberate omissions, both worth far less than the ±15° authority they feed: Realistic-mode
 * air drag, and the near-ground wind profile.
 */
function predictArc(
  shot: CShot,
  world: ShotWorld,
  turnDeg: number,
  aim?: Vec2,
  aimR = 0,
  path?: {x: number; y: number}[],
): {x: number; y: number} {
  const land = world.land;
  const p = shot.getPosition();
  const v = shot.getVelocity();
  let x = p.x,
    y = p.y,
    vx = v.x,
    vy = v.y,
    swung = 0; // degrees of `turnDeg` the airframe has worked through so far
  const cap = launchSpeed(shot.getPower()) * HOMING.BURN_MAX_SCALE;
  const ws = Math.sqrt(GameConfig.worldScale);
  const g = SHOT_GRAVITY * ws;
  const wx = world.wind.x * SHOT_WIND_ACCEL * ws;
  const wy = world.wind.y * SHOT_WIND_ACCEL * ws;
  const dt = HOMING.PREDICT_DT;
  const clearance = (px: number, py: number): number =>
    py - (land.getHeightAt(Math.min(land.width - 1, Math.max(0, Math.floor(px)))) - 4);
  for (let i = 0; i < HOMING.PREDICT_STEPS; i++) {
    // Mirror the live frame ORDER exactly — CShot.update integrates gravity and moves, and only
    // then does weaponFlyStep steer. Rotating first instead applies each slice of the turn to a
    // velocity one gravity-step out of date, which is another way to drift off the real arc.
    vy += g * dt;
    vx += wx * dt;
    vy += wy * dt;
    const px = x,
      py = y,
      above = clearance(x, y);
    x += vx * dt;
    y += vy * dt;
    if (path && i % 5 === 0) path.push({x, y}); // sparse — it is drawn, not integrated
    // Hull contact stops the live round right here, so it has to stop the prediction too.
    if (aim && Math.hypot(x - aim.x, y - aim.y) <= aimR) return {x, y};
    // Same swing-at-a-bounded-rate + sustained burn the live step flies. Predicting an INSTANT
    // turn instead would promise arcs the airframe can't hold, and the search would keep choosing
    // them.
    const want = turnDeg - swung;
    const step = Math.sign(want) * Math.min(Math.abs(want), HOMING.TURN_RATE_DEG * dt);
    if (step !== 0) {
      const r = turnVel(vx, vy, step);
      vx = r.x;
      vy = r.y;
      swung += step;
    }
    if (Math.hypot(vx, vy) < cap) {
      const burn = 1 + HOMING.BURN_PER_SEC * dt;
      vx *= burn;
      vy *= burn;
    }
    if (x < -60 || x > land.width + 60 || y > land.height + 80) break;
    const below = clearance(x, y);
    if (below >= 0) {
      // INTERPOLATE the crossing inside this step rather than returning the step's endpoint, so
      // the impact point isn't reported up to a whole step past the ground.
      const f = below !== above ? above / (above - below) : 1;
      return {x: px + (x - px) * f, y: py + (y - py) * f};
    }
  }
  return {x, y};
}

/** Progress along the predicted unguided range, 0 at the muzzle and 1 at the impact point. Drives
 *  the coast-down profile, so "a quarter of the way out" means the same on any map. */
function homingProgress(shot: CShot): number {
  if (shot.homingSpanX <= 1) return 0;
  return Math.abs(shot.getPosition().x - shot.homingX0) / shot.homingSpanX;
}

/** The enemy tank nearest `to`, within acquisition range. Team-mates are never candidates — a
 *  guided round that hunts its own squad is a trap, not a weapon. In a free-for-all every other
 *  tank is its own team, so nothing is excluded there. */
function homingTargetNear(shot: CShot, world: ShotWorld, to: {x: number; y: number}): CTank | null {
  const owner = shot.getOwner();
  let best: CTank | null = null;
  let nearest: number = HOMING.ACQUIRE_PX;
  for (const t of world.tanks) {
    if (!t.isAlive() || t === owner) continue;
    if (owner && t.getTeamId() === owner.getTeamId()) continue;
    const tp = t.getPosition();
    const d = Math.hypot(tp.x - to.x, tp.y - to.y);
    if (d < nearest) {
      nearest = d;
      best = t;
    }
  }
  return best;
}

/**
 * Re-solve guidance from the CURRENT state: which enemy is worth steering at, and which offset
 * inside the remaining authority band reaches it best. Runs repeatedly through the descent, not
 * once at the apex — so a round can switch targets mid-fall if a better one comes into range, and
 * a target that dies stops being chased.
 *
 * `base` is the apex heading, and offsets are measured from it, so the band stays anchored where
 * the missile committed rather than sliding along with each correction it makes.
 */
function homingSolve(shot: CShot, weapon: CWeapon, world: ShotWorld): void {
  const maxTurn = weapon.getHomingMaxTurn();
  const rel = shot.homingApplied; // where the airframe is now, relative to the band centre
  const free = predictArc(shot, world, 0);
  const target = homingTargetNear(shot, world, free);
  shot.homingTarget = target;
  if (!target) {
    shot.homingAim = rel; // nothing to chase: hold the current line rather than snapping back
    return;
  }

  const tp = target.getPosition();
  const tr = target.getHitRadius();
  let best = rel;
  let bestMiss = Infinity;
  const consider = (off: number): void => {
    if (off < -maxTurn || off > maxTurn) return;
    // `predictArc` turns relative to the CURRENT heading, while offsets are relative to the band
    // centre — so what it must fly from here is the difference.
    const end = predictArc(shot, world, off - rel, tp, tr);
    const miss = Math.hypot(end.x - tp.x, end.y - tp.y);
    if (miss < bestMiss) {
      bestMiss = miss;
      best = off;
    }
  };
  consider(rel); // holding course competes on equal terms, so it only steers when that helps
  const step = weapon.getHomingStep();
  for (let d = -maxTurn; d <= maxTurn; d += step) consider(d);
  const coarse = best;
  const fine = weapon.getHomingFineStep();
  for (let k = -9; k <= 9; k++) if (k !== 0) consider(coarse + k * fine);
  shot.homingAim = best;
}

/** Sample where the round could still put itself across the whole band — the region drawn under
 *  it. Widest at the apex and closing as the descent runs out of time to turn, which is exactly
 *  the information a player wants: how much correction is left.
 *
 *  Returns the landing arc AND the two extreme trajectories bounding it. The bounding paths are
 *  what the region is drawn along: a straight chord from the missile to a landing point passes
 *  under any ground that rises in between, so a chord-built wedge gets clipped short on a slope
 *  and parts company with the very landing points it is supposed to span. */
function homingFan(
  shot: CShot,
  weapon: CWeapon,
  world: ShotWorld,
): {
  land: {x: number; y: number}[];
  left: {x: number; y: number}[];
  right: {x: number; y: number}[];
} {
  const rel = shot.homingApplied;
  const land: {x: number; y: number}[] = [];
  const left: {x: number; y: number}[] = [];
  const right: {x: number; y: number}[] = [];
  const maxTurn = weapon.getHomingMaxTurn();
  const n = HOMING.FAN_SAMPLES;
  for (let i = 0; i < n; i++) {
    const off = -maxTurn + (2 * maxTurn * i) / (n - 1);
    const edge = i === 0 ? left : i === n - 1 ? right : undefined;
    land.push(predictArc(shot, world, off - rel, undefined, 0, edge));
  }
  return {land, left, right};
}

/**
 * Per-frame guidance, in three acts.
 *
 *  1. CRUISE — nothing to do; it flies like any rocket.
 *  2. COAST — from {@link HOMING.COAST_FROM} of the way out, the motor cuts and the horizontal
 *     speed bleeds toward {@link HOMING.COAST_TO} by the apex. The round visibly slouches into
 *     the top of its arc.
 *  3. GUIDED — at the apex the sustainer relights: it re-solves toward a target, swings at a
 *     bounded rate inside its band, and accelerates the whole way down.
 *
 * Submunitions are never guided — only the round the player fired.
 */
function homingStep(shot: CShot, weapon: CWeapon, world: ShotWorld, dt: number): void {
  shot.homingBurn = false;
  if (shot.getGeneration() !== 0) return;

  // Capture the launch geometry once, so the phase clock has a range to measure against.
  if (shot.homingSpanX <= 0) {
    const p = shot.getPosition();
    shot.homingX0 = p.x;
    shot.homingVx0 = shot.getVelocity().x;
    shot.homingSpanX = Math.max(1, Math.abs(predictArc(shot, world, 0).x - p.x));
  }

  // --- act 3: powered guidance -------------------------------------------
  if (!Number.isNaN(shot.homingBase) || shot.isMovingDown()) {
    if (Number.isNaN(shot.homingBase)) {
      const v = shot.getVelocity();
      shot.homingBase = (Math.atan2(v.y, v.x) * 180) / Math.PI;
      shot.homingApplied = 0;
      shot.homingFanAge = Infinity; // force a fan on the very first guided frame
      homingSolve(shot, weapon, world);
    } else if ((shot.homingFanAge += dt) >= HOMING.RESOLVE_SEC) {
      shot.homingFanAge = 0;
      homingSolve(shot, weapon, world);
      const f = homingFan(shot, weapon, world);
      shot.homingFan = f.land;
      shot.homingFanL = f.left;
      shot.homingFanR = f.right;
    }

    // Swing toward the command at a bounded rate — the airframe leans, it never kinks.
    const want = shot.homingAim - shot.homingApplied;
    const step = Math.sign(want) * Math.min(Math.abs(want), HOMING.TURN_RATE_DEG * dt);
    const v = shot.getVelocity();
    const r = step !== 0 ? turnVel(v.x, v.y, step) : {x: v.x, y: v.y};
    shot.homingApplied += step;

    // Sustainer: burns for the whole descent (that is what a homing round IS), capped so a long
    // fall cannot wind it up indefinitely.
    const speed = Math.hypot(r.x, r.y);
    const cap = launchSpeed(shot.getPower()) * HOMING.BURN_MAX_SCALE;
    const burn = speed < cap ? 1 + HOMING.BURN_PER_SEC * dt : 1;
    shot.setVelocity(r.x * burn, r.y * burn);
    shot.homingBurn = true;
    return;
  }

  // --- act 2: coast down --------------------------------------------------
  if (homingProgress(shot) > HOMING.COAST_FROM) {
    const v = shot.getVelocity();
    if (shot.homingVyCut === 0) shot.homingVyCut = Math.min(-1, v.y); // v.y < 0 while rising
    // Bleed the HORIZONTAL component only, so the arc still rises and falls under gravity as
    // normal — it just stops reaching, which is what makes the apex feel like a hand-off. The
    // ramp runs on how much CLIMB is left, so it lands exactly on COAST_TO as the round tips over.
    const k = Math.min(1, Math.max(0, 1 - v.y / shot.homingVyCut));
    const want = shot.homingVx0 * (1 + (HOMING.COAST_TO - 1) * k);
    if (Math.abs(want) < Math.abs(v.x)) shot.setVelocity(want, v.y);
  }
}

/** Battery: drop bomblets straight down at a steady cadence while a primary descends. */
function batteryTick(shot: CShot, weapon: CWeapon, world: ShotWorld, _dt: number): void {
  const batSec = weapon.getBatterySeconds();
  if (batSec <= 0 || shot.getGeneration() !== 0 || !shot.isMovingDown()) return;
  // Latch the apex the first descending frame, so the cadence starts at the top of the
  // fall (not from launch — otherwise a long ascent would dump a catch-up burst).
  if (shot.batteryApex < 0) shot.batteryApex = shot.getAge();
  const interval = Math.max(0.03, batSec * REF_TIME_SCALE); // floor = pathological guard only
  const due = Math.floor((shot.getAge() - shot.batteryApex) / interval) + 1; // 1st drop at apex
  if (due <= shot.batteryDrops) return;
  shot.batteryDrops = due;
  const p = shot.getPosition();
  const child = new CShot();
  child.initFromVelocity(p, 0, 0, weapon.getDamage(), weapon.getRadius(), shot.getOwner());
  child.setWeaponIndex(weapon.getIndex());
  child.setGeneration(1);
  world.spawnShot(child);
}

// ==========================================================================
// DETONATION
// ==========================================================================

/**
 * Detonate a shot: FX + terrain effect + blast damage + radiation + cluster.
 * extType tweaks the terrain effect (Dirt raises, Beam craters nothing) and adds
 * a tracer marker; everything else is common.
 */
export function weaponDetonate(shot: CShot, weapon: CWeapon, world: ShotWorld): void {
  shot.kill();
  const land = world.land;
  const ext = weapon.getExtType();
  // The blast happens exactly where the shot is — for a Digger that's its BURIED position
  // inside the mass (it detonates deep after tunnelling through, or wherever it re-impacts
  // on the far side). It is NOT relocated to the surface.
  const pos = shot.getPosition();
  const isPrimary = shot.getGeneration() === 0;
  const isBeam = isBeamExt(ext);
  // Cleaner (Cleaner/Plower/Dirt Destroy/Earth Destroy): a large-radius EARTH-REMOVER
  // to unbury a tank — it just carves terrain. No blast damage, no ejecta, no shake.
  const isCleaner = weapon.isCleaner();
  // Blast radius = weapon.radius × Explosion Size (user) × the resolution-based blastScale — sizing
  // crater, damage reach and FX together, exactly as the original's `explosionScale` did (off SCREEN
  // size, NOT map size). See `computeBlastScale` for the formula.
  const radiusPx = shot.getRadius() * GameConfig.explosionScale * world.blastScale;
  const surfaceY = land.getHeightAt(Math.floor(pos.x));

  // A Tracer is a RANGING round — 0 damage, 0 radius. It does NOTHING to the land or
  // tanks: no blast, no crater, no scorch, no ejecta, no shake. It only plants a
  // persistent numbered marker where it lands (its white in-flight streak already
  // traced the arc). Handle it here and return before any terrain/damage happens.
  if (ext === EXT.TRACER) {
    const owner = shot.getOwner();
    const range = owner ? Math.round(Math.abs(pos.x - owner.getPosition().x)) : 0;
    world.aimMarker(pos.x, Math.floor(surfaceY), String(range));
    world.hitSound(weapon.getHitSound(), pos.x); // faint spotting-round report
    return;
  }

  world.explode(
    pos.x,
    pos.y,
    isPrimary ? 1.5 : 0.9,
    weapon.getColor(),
    radiusPx,
    weapon.isNuclear(),
    weapon.getBlastParticle(),
    weapon.getExpType(),
    weapon.getExpBitmap(),
    weapon.getEarth() > 0, // Dirt/deposit weapons skip the fiery firework — just the flare + puff.
    isCleaner, // earth-remover → no big-blast screen flash
  );
  world.hitSound(weapon.getHitSound(), pos.x); // soundHit, panned to the blast
  // Camera shake is a port embellishment — the original never shakes on impact (it
  // only warps the screen for nukes). So reserve it for genuinely BIG blasts: nukes
  // and bomb/rocket-scale craters (radius ≥ 45). Small rounds — machine gun, shells,
  // cannon — land with no shake, matching how they read in the original.
  const bigBlast = weapon.isBigBlast(radiusPx);
  if (GameConfig.cameraShake && !isCleaner && bigBlast) {
    // A NUKE also fires the full-screen white-out (`flashScreen(1)`, ~0.6s fade) — a static overlay
    // that covers the whole viewport, so a short 0.3s shake plays out entirely BEHIND it and is
    // never seen. Give nukes a stronger, LONGER rumble that outlasts the flash: it decays past the
    // ~0.6s white-out so the ground is still visibly shaking once the scene reappears. Conventional
    // big blasts keep the short punch (their flash is only partial, so their shake already shows).
    const nuke = weapon.isNukeClass();
    world.shake(nuke ? (isPrimary ? 16 : 10) : isPrimary ? 8 : 4, nuke ? 1.0 : 0.3);
  }

  // A blast only craters/scorches the GROUND when its radius spans the gap from the detonation
  // point down to the surface. An AIRBURST (extType 13) detonates high at the apex, so it does
  // NOT cut a crater or scorch the ground below — it just rains its fallout down from the air.
  const reachesGround = surfaceY - pos.y < radiusPx;

  // Per-weapon blast-FX intensities: `fodder` = how much dirt ejecta it kicks up, `crackle` =
  // how much it scorches the ground (both 0 for clean weapons like the Shell).
  const fodder = weapon.getFodder();
  const crackle = weapon.getCrackle();

  // Radiation, resolved BEFORE the terrain effect because the earth this blast throws is itself the
  // contaminated material — the spoil has to be tagged as it is launched, not dusted afterwards.
  const rad = weapon.getRadiation();
  const irradiates = rad.time > 0 && rad.dmg > 0;
  const radSlot = irradiates ? land.radiationSlot(rad.rgb) : -1;

  // Burnt-rim scorch scaled by `crackle` (skipped when it's 0); `craterR` differs per branch.
  const scorchRim = (craterR: number) => {
    if (crackle > 0) {
      land.scorch(
        Math.floor(pos.x),
        Math.floor(surfaceY),
        Math.round(craterR * (0.4 + crackle * 0.85)),
      );
    }
  };

  // Terrain effect.
  const earth = weapon.getEarth();
  if (earth > 0) {
    // Dirt: the original cuts a SMALL crater at the impact and THEN throws the earth
    // cloud that arcs up and rains back down, piling into a mound. The crater is the "dirt replace"
    // at the landing point; the debris overtops it, so the mound wins.
    if (reachesGround) {
      // Same unified crater primitive (fuzzy rim + soil coat, as the original blastCircle call); slump
      // OFF so its avalanche doesn't fight the depositDirt mound that immediately overtops this dimple.
      land.carveDiscCollapse(Math.floor(pos.x), Math.floor(pos.y), Math.round(radiusPx * 0.35), false, true, true); // prettier-ignore
    }
    land.depositDirt(Math.floor(pos.x), Math.floor(surfaceY), radiusPx, earth);
  } else if (isCleaner) {
    // Cleaner: remove its DISC of earth and let the ground ABOVE cave in under gravity — it consumes
    // only the radius, it does NOT strip the whole column from the surface down to the blast (which
    // let a big cleaner "clean everything up to the top" / erase a mountain when it detonated deep).
    // `carveDiscCollapse` cuts the disc at the impact and drops the overburden as a falling block;
    // for a shallow/surface hit the disc simply removes a bowl. No fresh dirt (earth-remover).
    land.carveDiscCollapse(Math.floor(pos.x), Math.floor(pos.y), radiusPx);
  } else if (ext === EXT.DIGGER || ext === EXT.ESCAPE) {
    // Digger/Escape explode where the shot IS — deep in the mass (or wherever they
    // re-impacted after crossing to the far side). The blast removes only its DISC of
    // soil and the ground ABOVE caves IN under gravity to fill it — so the surface sags
    // by ~the crater size, it does NOT strip the whole column from the blast up to the
    // surface. Per-column noise keeps the collapse ragged, not flat/circular.
    // The burrow channel itself is already carved step-by-step during flight (digCarve); here
    // we only cut the final, WIDER detonation crater at the shot's resting depth (big blast
    // `radius`, vs the narrow `size` bore) and let its overburden cave in.
    const craterR = Math.round(radiusPx);
    land.carveDiscCollapse(Math.floor(pos.x), Math.floor(pos.y), craterR);
    scorchRim(craterR);
    // Cosmetic dirt spray only (deposit=false): a BURIED digger blast displaces its dirt into
    // its own cave-in crater, it doesn't fountain depositing earth onto the surface. Depositing
    // chunks here land on the still-caving crater/trench columns and strand as "floating dirt".
    world.debrisSpray(
      Math.floor(pos.x),
      Math.floor(surfaceY),
      Math.min(2500, Math.round(fodder * craterR * 100 + craterR * 4)),
      craterR,
    );
  } else if (!isBeam && reachesGround) {
    // Crater radius is `radius × explosionScale` and NOTHING else. The original stamps a burst MASK
    // whose pixel radius is exactly that, and its crater code has no nuke branch at all — a nuke
    // digs a big hole purely because its authored `radius` is big (Uranium 140 vs a bomb's 50). No
    // nuke bonus here either: widening a nuke's bowl a further 1.35×, and throwing its ejecta
    // across a disc 1.6× wider still, births most of the earth it digs OUTSIDE the hole so it rains
    // down beyond the rim — a crater half a screen across that its own spoil can never refill. A
    // nuke gets the same geometry every other weapon does.
    const heavy = weapon.isNukeClass();
    const craterR = Math.round(radiusPx);
    // Unified crater: remove the DISC and let the overburden cave in under gravity — NEVER strip the
    // whole column from surface to blast (which let a low shot fired into a slope erase the mass above
    // it). Same primitive the digger + cleaner use; `carveDiscCollapse` also clears radiation/heat here.
    // coatDirt=true → the fresh crater face is coated with soil (the blastCircle "filled dirt bowl"
    // look). Smooth rim (bomb rag was false in the original blastCircle call).
    land.carveDiscCollapse(Math.floor(pos.x), Math.floor(pos.y), craterR, true, false, true);
    // SCORCH is driven by the weapon's `crackle` (burnt-rim intensity) — a Shell (crackle 0)
    // leaves no burn; a nuke (0.7) scorches wide. Scaled by crackle, skipped when it's 0.
    scorchRim(craterR);
    // DEBRIS/ejecta is driven by the weapon's `fodder` (how much dirt it kicks up) — a Shell
    // (fodder 0) throws almost none, a nuke a huge spray. Each landed chunk RAISES its column, so
    // what is computed here is the VOLUME of earth thrown back: it is what decides how far the
    // crater refills, not just how busy the spray looks.
    //
    // That volume has to be measured against the HOLE, not against the radius. A count growing
    // linearly with radius, against a bowl that grows with the SQUARE of it, makes the refilled
    // fraction fall off as ~1/r — a 50px bomb puts back a third of its crater, Uranium a fifth,
    // Isotope 244 a tenth. That is the "big weapons leave a bare pit" mismatch: not too little dirt
    // in absolute terms, too little *for their crater*. Sizing the throw off the crater's own
    // excavated cross-section makes every weapon return the same fraction of what it dug.
    const craterVol = (Math.PI * craterR * craterR) / 2; // half-disc — the earth a surface burst removes
    // NO linear floor. A minimum like `fodder · radiusPx · 290` reintroduces exactly what the area
    // scaling exists to avoid: being linear in r it wins for every SMALL weapon, so those refill a
    // fixed depth of a crater that is only so deep — a low-fodder shot throws back nearly
    // everything it dug and cannot make a hole at all. Area alone, all the way down.
    const volume = Math.round(craterVol * (EJECTA.FILL_BASE + fodder * EJECTA.FILL_FODDER));
    // Past a few thousand, extra chunks cost frame time without reading as more dirt — so buy the
    // remaining volume with DEPTH per chunk rather than with more of them (the same trade the
    // fallout grains make). Below the cap this stays at 1px/chunk.
    const perChunk = Math.max(1, Math.ceil(volume / EJECTA.MAX_CHUNKS));
    land.addShowerParticles(
      Math.floor(pos.x),
      Math.floor(Math.min(pos.y, surfaceY)),
      Math.round(volume / perChunk),
      craterR, // born across the crater's own disc, so the spoil rains back into the hole it came from
      false,
      perChunk,
      radSlot, // a nuke's spoil IS the fallout — it lands hot, it is not clean fill dusted later
    );
    // SOIL COMPACTION (Gameplay switch, off by default): a nuke-class blast drives a compression
    // wave out through the ground. Soil it passes over is squeezed rather than excavated, so the
    // land SINKS well beyond the crater — and the tanks standing on it sink with it. Nuke-only:
    // it takes a blast of that order to shift ground at range, and applying it to every shell
    // would erode the map into a bowl over a match.
    if (heavy && GameConfig.soilCompaction)
      land.shockCompact(Math.floor(pos.x), Math.round(craterR * 2.6), Math.round(radiusPx * 0.22));
  }

  // The screen refraction / shockwave warp is a NUKE-only effect.
  if (isPrimary && weapon.isNukeClass()) {
    world.ripple(pos.x, pos.y, 2.6 + radiusPx / 120);
  }

  // Damage: beams do full damage to what they touch; everything else falls off.
  // Cleaners deal NO damage — they only reshape terrain. Radioactive/DOT rounds count as
  // PIERCING, so a target's Hazmat resistance (not its Armor) applies to them.
  if (!isCleaner)
    world.applyBlast(
      pos,
      radiusPx, // outer field (zero-damage boundary) — radius × explosionScale × √worldScale
      shot.getDamage(),
      shot.getOwner(),
      isBeam,
      weapon.isRadioactive(),
      0.5 * weapon.getSize(), // inner full-damage core (half the sprite size; collR added per-target)
    );

  // Radiation zone (NUKE/DOT/Organic/…): irDmg/sec for irTime s, tinted irRGB.
  // The fallout scatters as a speck cloud out of the crater — each speck lands at
  // `dist = rand01 * radius` and the density is ∝ radius. So the zone spreads within
  // the BLAST RADIUS, never a separate scale. `iradiate` is only the on/off gate
  // (tested as `threshold < iradiate`, already covered by rad.time/rad.dmg > 0 here) —
  // it is NOT a spatial radius, so it must not size the zone.
  if (irradiates) {
    // MATCHES THE CRATER exactly — `radiusPx`, the same figure the carve above uses. The fallout
    // lines the hole the same blast just dug, so a zone even slightly wider than the crater puts
    // glowing ground outside the earth the explosion turned over: a rim of fallout on undisturbed
    // terrain. No nuke multiplier here either — the crater has none for it to track.
    const zoneR = Math.round(radiusPx);
    // The damage zone + ground glow settle on the SURFACE; but for an airburst the fallout is
    // thrown from the mid-air burst point and RAINS down onto the ground (not up out of a crater).
    land.blastIradiate(
      Math.floor(pos.x),
      Math.floor(surfaceY),
      zoneR,
      rad.dmg * 60,
      rad.time,
      rad.rgb,
      reachesGround ? undefined : Math.floor(pos.y), // speck origin: air burst point when high up
      !reachesGround, // raining
    );
  }

  spawnCluster(shot, weapon, world, pos);
}

// ==========================================================================
// CLUSTER SPAWNING
// ==========================================================================

/**
 * Cluster: on detonation spawn cluNum submunitions at the impact point, fanning
 * cluStart→cluEnd degrees, each at 0.5x power, re-clustering until the generation
 * reaches cluRecurse. Angle convention: vel = (cos a°, sin a°) (90°=down).
 *
 * Power is a flat 0.5× the ORIGINAL firing power at every recursion depth (via the shot's
 * carried base power), NOT 0.5× the parent submunition — otherwise deep drillers (Sabot, Six
 * Under, Grave Digger, Toxic Grave) would telescope to a quarter/eighth power and barely move.
 */
export function spawnCluster(parent: CShot, weapon: CWeapon, world: ShotWorld, pos: Vec2): void {
  const cluNum = weapon.getClusterCount();
  if (cluNum <= 0) return;
  const gen = parent.getGeneration();
  if (gen >= weapon.getClusterRecurse()) return;

  const [startDeg, endDeg] = weapon.getClusterSpread();
  const step = (endDeg - startDeg) / cluNum;
  const basePower = parent.getBasePower(); // the firing power, unchanged down the chain
  const childPower = Math.max(1, basePower * SHOT.CLUSTER_POWER);
  const speed = launchSpeed(childPower);

  for (let k = 0; k < cluNum; k++) {
    const aDeg = startDeg - k * step; // fan angle by subtraction
    const a = (aDeg * Math.PI) / 180;
    const vx = Math.cos(a) * speed;
    const vy = Math.sin(a) * speed; // screen-Y down: 90°→down, 270°→up

    const child = new CShot();
    child.initFromVelocity(pos, vx, vy, weapon.getDamage(), weapon.getRadius(), parent.getOwner());
    child.setWeaponIndex(weapon.getIndex());
    child.setGeneration(gen + 1);
    child.setPower(childPower);
    child.setBasePower(basePower); // carry the ORIGINAL firing power, so re-clusters stay flat 0.5×
    world.spawnShot(child);
  }
}
