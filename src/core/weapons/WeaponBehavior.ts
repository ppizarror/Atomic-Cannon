/**
 * Weapon behaviours — one dispatcher over `extType`, the weapon's behaviour selector.
 *
 * Covers per-frame shot dispatch and the detonation path. The mechanics (which
 * extType does what, cluster fan, battery drop, roller/digger motion, radiation
 * fields) are documented in the notes; a couple of pieces (radiation
 * damage-over-time, the `earth` deposit amount) are derived from the data fields.
 */
import {Vec2} from '../../math/Vec2';
import {CShot, REF_TIME_SCALE, launchSpeed} from '../CShot';
import {CTank} from '../CTank';
import {CLand} from '../CLand';
import {CWeapon} from '../CWeapon';
import {GameConfig} from '../CGameConfig';
import {EXT, isBeamExt} from './ExtType';
import {type ExpType} from './ExpType';

// `EXT` / `ExtType` / `toExtType` — the authoritative behaviour-selector table — live in
// ./ExtType so `CWeapon.getExtType()` can return the typed value without a circular import.
// Re-exported here because this dispatcher is the natural place callers look for them.
export {EXT, isBeamExt} from './ExtType';
export type {ExtType} from './ExtType';

// Submunition launch power = 0.5x firing power.
const CLUSTER_POWER = 0.5;
// Roller surface speed (px/s in our space).
const ROLL_SPEED = 260;
// Max shot lifetime before it self-detonates (10.0s).
const MAX_LIFE = 10;
// Swept-collision resolution: a single Euler step can span 35-50px on big maps vs a ~16px tank hit
// radius, so the endpoint point-sample can tunnel through a tank / thin ridge the path crossed. We
// walk the frame's segment in sub-steps ≤ CCD_STEP px apart; CCD_MAX_SUBS bounds the loop (a real
// step never exceeds ~50px, so ~13 sub-steps; the cap is a runaway guard).
const CCD_STEP = 4;
const CCD_MAX_SUBS = 16;

/** The world a shot behaves against — implemented by the game controller. */
export interface ShotWorld {
  readonly land: CLand;
  readonly tanks: CTank[];

  /** Resolution-based blast scale (√(view area)·C) — sizes the crater/FX/damage radius off the render
   *  surface, exactly like the original. A derived render value (NOT a user setting), so it lives on
   *  the world context, not in GameConfig. */
  readonly blastScale: number;

  /** A GAMEPLAY random in [0,1) from the match-seeded stream — deterministic across
   *  clients (must NOT be Math.random for anything that affects the outcome). */
  random(): number;

  spawnShot(shot: CShot): void;

  /** Detonation FX. `color`/`radiusPx`/`nuclear` tint & scale the burst; `blastPreset`
   * names its particles.json effect; `expType` + `expBitmap` select the weapon's own explosion
   * flare sprite and style. `isCleaner` suppresses the big-blast screen flash (an earth-remover
   * is not a fiery blast). */
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

  shake(mag: number, dur: number): void;

  ripple(x: number, y: number, strength: number): void;

  /** Two-radius blast damage + kick + shield/armor. Full `damage` inside `innerRadius`
   * (the direct-hit core), then LINEAR falloff to zero at `radius` (the outer field). `full`
   * skips falloff entirely (beams). `piercing` marks a secondary/piercing weapon, so the
   * target's Hazmat resistance applies. `innerRadius` defaults to 0 (a point core). */
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

  // Swept collision: walk this frame's segment (prev→cur) so a fast shot can't tunnel a tank/ridge.
  const prev = shot.getPrevPosition();
  const segX = p.x - prev.x;
  const segY = p.y - prev.y;
  const segLen = Math.hypot(segX, segY);
  const subs = segLen > CCD_STEP ? Math.min(CCD_MAX_SUBS, Math.ceil(segLen / CCD_STEP)) : 1;

  // Earliest TANK contact along the path (k=subs is the endpoint, so this subsumes the old point
  // test). Snap the shot to that point so the blast centres on the impact, not a step beyond it.
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
  if (shot.getAge() > MAX_LIFE) return 'detonate';

  switch (ext) {
    case EXT.BEAM:
    case EXT.BEAM_ALT:
      // Hitscan: straight line (no gravity, set at launch). Detonates on a tank.
      return hit ? 'detonate' : 'continue';

    case EXT.AIRBURST:
      // Detonate at the apex (once it starts descending) — but ONLY the PRIMARY
      // (gen 0). Its cluster submunitions are launched DOWNWARD from the apex, so
      // they're already "moving down"; if they also airburst they'd all pop at the
      // top instead of raining down. Gen≥1 fly ballistically and burst on impact.
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
      // Ballistic (Shell/Bomb/Rocket/Dirt/Cleaner/NUKE/DOT/Organic/Missile/Tracer/Death). Detonate at
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
    // toward the momentary-lower side every frame made the roller ping-pong across a valley
    // floor forever (the "vibration"/camera-jitter bug); a real roller rolls one way until it
    // meets a rise, then detonates.
    dir = Math.sign(vx) || 1;
  }
  // Surface AHEAD in the roll direction rises >1px (a wall, or the far side of a valley it
  // rolled down into) → detonate. This is what stops it, so it never oscillates.
  const ahead = dir > 0 ? right : left;
  if (ahead < surfaceY - 1) return 'detonate';

  shot.setVelocity(dir * ROLL_SPEED, 0);
  return 'continue';
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
    // chunks here landed on the still-caving crater/trench columns and stranded as "floating dirt".
    land.addShowerParticles(
      Math.floor(pos.x),
      Math.floor(surfaceY),
      Math.min(2500, Math.round(fodder * craterR * 100 + craterR * 4)),
      craterR,
      false,
    );
  } else if (!isBeam && reachesGround) {
    // Nukes (expType 4) blow a much wider crater than their base radius.
    const heavy = weapon.isNukeClass();
    const craterR = Math.round(radiusPx * (heavy ? 1.35 : 1));
    // Unified crater: remove the DISC and let the overburden cave in under gravity — NEVER strip the
    // whole column from surface to blast (which let a low shot fired into a slope erase the mass above
    // it). Same primitive the digger + cleaner use; `carveDiscCollapse` also clears radiation/heat here.
    // coatDirt=true → the fresh crater face is coated with soil (the blastCircle "filled dirt bowl"
    // look). Smooth rim (bomb rag was false in the original blastCircle call).
    land.carveDiscCollapse(Math.floor(pos.x), Math.floor(pos.y), craterR, true, false, true);
    // SCORCH is driven by the weapon's `crackle` (burnt-rim intensity) — a Shell (crackle 0)
    // leaves no burn; a nuke (0.7) scorches wide. Scaled by crackle, skipped when it's 0.
    scorchRim(craterR);
    // DEBRIS/ejecta count is driven by the weapon's `fodder` (how much dirt it kicks up) — a
    // Shell (fodder 0) throws almost none, a nuke (0.5) throws a huge spray. The chunks fly out and
    // settle, each RAISING its landing column → rim mounds (the smoothing pass rounds them).
    const chunks = Math.min(6500, Math.round(fodder * radiusPx * 100 + radiusPx * 0.8));
    land.addShowerParticles(
      Math.floor(pos.x),
      Math.floor(Math.min(pos.y, surfaceY)),
      chunks,
      Math.round(radiusPx * (heavy ? 1.6 : 1)),
    );
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
  // it is NOT a spatial radius, so it must not size the zone. Nukes throw a slightly
  // wider field, tracking their heavier (×1.35) crater.
  const rad = weapon.getRadiation();
  if (rad.time > 0 && rad.dmg > 0) {
    const big = weapon.isNukeClass();
    const zoneR = Math.round(radiusPx * (big ? 1.4 : 1));
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
  const childPower = Math.max(1, basePower * CLUSTER_POWER);
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
