/**
 * CTank - Tank Entity Class
 *
 * Handles tank state, movement on terrain, damage, rendering
 */

import {strings, fmt} from '../i18n';
import {Vec2} from '../math/Vec2';
import {clamp, clamp01, TWO_PI} from '../math/num';
import {hexToRgb} from '../math/color';
import {CLand} from './CLand';
import {GameConfig, isWargame} from './CGameConfig';

// Wargame Detail preset — tanks drawn as flat tactical-map silhouettes in this pale blue.
const WARGAME_TINT = '#8ed1ec';
import {getFont, type FontId} from './rendering/BitmapFont';
import type {Sprite, ISpriteSource} from './rendering/sprites';

// Tank-badge text font — small pixel font rendered at NATIVE size (10px) so it
// stays crisp at a compact label size. The name (on its team-colour box) is the
// plain white glyph; the free-floating stat lines use the OUTLINED variant so its
// baked black outline keeps them legible on any terrain WITHOUT a dark backing box
// (the original draws the stat block as plain outlined text, no box).
const BADGE_FONT: FontId = 'silkscreen-8-white';
const STAT_FONT: FontId = 'silkscreen-8-out';

/** A drawable image plus its dimensions. */
// Tank variants
export const PLAYER_TANKS = ['Standard', 'MA1', 'MSPO', 'Green', 'Atomic Cannon'];

// The 16-team palette (0xRRGGBB). Team 0 = blue.
export const TEAM_COLORS: Record<number, string> = {
  0: '#0000ff',
  1: '#ff0000',
  2: '#00ff00',
  3: '#0080ff',
  4: '#f000f0',
  5: '#8000ff',
  6: '#00ffff',
  7: '#800080',
  8: '#000080',
  9: '#008000',
  10: '#800000',
  11: '#ffff00',
  12: '#ff8000',
  13: '#ff0080',
  14: '#00ff80',
  15: '#80ff00',
};

/** The fallback hull colour for a team index not in the palette — team 0's blue. Used
 *  wherever an unresolved team index is mapped to a colour. */
export const DEFAULT_TEAM_COLOR = TEAM_COLORS[0];

// --- per-tank body recolour: modulate the chosen colour by each pixel's luminance
// so the sprite's shading is preserved and the brightest pixel shows the exact colour
// (darker pixels become proportional shades). Reproduces any RGB the player picks.
// Cached per sprite+colour. ----------
const tintCache = new Map<string, HTMLCanvasElement>();

// Cap the sprite-derivation caches (oldest-evicted). Keyed by (hull|colour); the Players editor's
// custom-colour picker can mint arbitrary keys, so bound them like the BitmapFont / particle caches.
const SPRITE_CACHE_MAX = 128;
function capSpriteCache(
  map: Map<string, HTMLCanvasElement>,
  key: string,
  cv: HTMLCanvasElement,
): void {
  map.set(key, cv);
  if (map.size > SPRITE_CACHE_MAX) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
}

// Perceptual luminance of a pixel (0..1).
const lumaOf = (r: number, g: number, b: number): number =>
  (0.299 * r + 0.587 * g + 0.114 * b) / 255;

function tintToColor(sprite: Sprite, hex: string, key: string): HTMLCanvasElement {
  const cached = tintCache.get(key);
  if (cached) return cached;
  const {r: tr, g: tg, b: tb} = hexToRgb(hex);
  const cv = document.createElement('canvas');
  cv.width = sprite.width;
  cv.height = sprite.height;
  const g = cv.getContext('2d', {willReadFrequently: true})!;
  g.imageSmoothingEnabled = false;
  g.drawImage(sprite.bitmap, 0, 0);
  const im = g.getImageData(0, 0, cv.width, cv.height);
  const px = im.data;
  // Pass 1: brightest opaque pixel — it maps to the exact chosen colour.
  let maxL = 0.001;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const l = lumaOf(px[i], px[i + 1], px[i + 2]);
    if (l > maxL) maxL = l;
  }
  // Pass 2: scale the target colour by each pixel's relative luminance.
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue; // keep transparency
    const f = Math.min(1, lumaOf(px[i], px[i + 1], px[i + 2]) / maxL);
    px[i] = Math.round(tr * f);
    px[i + 1] = Math.round(tg * f);
    px[i + 2] = Math.round(tb * f);
  }
  g.putImageData(im, 0, 0);
  capSpriteCache(tintCache, key, cv);
  return cv;
}

// Solid-colour silhouette of a sprite (all opaque pixels → `color`), cached. Used to
// stamp a white outline behind the hull for High Contrast.
const silCache = new Map<string, HTMLCanvasElement>();
function silhouette(sprite: Sprite, color: string, key: string): HTMLCanvasElement {
  const hit = silCache.get(key);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = sprite.width;
  cv.height = sprite.height;
  const g = cv.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(sprite.bitmap, 0, 0);
  g.globalCompositeOperation = 'source-in'; // recolour every opaque pixel
  g.fillStyle = color;
  g.fillRect(0, 0, cv.width, cv.height);
  capSpriteCache(silCache, key, cv);
  return cv;
}

/**
 * Tank health/shield status structure
 */
export interface STankHealth {
  nLife: number; // Current health (0-100 typical)
  nShield: number; // Shield points (absorbed before health)
  nArmor: number; // Armor percentage reduction
  nHazmat: number; // Hazmat percentage (radiation resistance) — HUD "Hazmat %"
  fRadiation: number; // Radiation damage over time
}

/**
 * Tank state flags/members:
 * - Moving state ("Tank is moving")
 * - Underground detection ("underground")
 * - Can move / Can't move messages
 */
export class CTank {
  // ========================================================================
  // CONSTRUCTION & INITIALIZATION
  // ========================================================================

  constructor(sName: string = '', nTeamId: number = 0) {
    this.m_sName = sName; // names keep their given case (upper/lower allowed)
    this.m_nTeamId = nTeamId;
    this.m_sColor = TEAM_COLORS[nTeamId] ?? DEFAULT_TEAM_COLOR; // default until the roster sets it
    this.m_bIsHuman = false;
    this.m_sTankType = PLAYER_TANKS[Math.floor(Math.random() * PLAYER_TANKS.length)];

    // Position and physics
    this.m_vPos = new Vec2(0, 0);
    this.m_vVel = new Vec2(0, 0);
    this.m_fAngle = 0; // Body rotation angle (radians)

    // Turret state
    this.m_fTurretAngle = Math.PI / 4; // Default aim: 45 deg up-right
    this.m_fLastTurretAngle = this.m_fTurretAngle;

    // Health status (life 0..1000, shield 0..1000, armor 0..100%)
    this.m_health.nLife = 1000;
    this.m_health.nShield = 0;
    this.m_health.nArmor = 0;
    this.m_health.nHazmat = 0;
    this.m_health.fRadiation = 0;

    // State flags
    this.m_bIsAlive = true;
    this.m_bIsMoving = false;
    this.m_bFalling = false;
    this.m_bExploded = false;
  }

  /**
   * Initialize tank at position with given player data
   */
  init(x: number, pLand: CLand): void {
    this.m_vPos = new Vec2(x, 0);
    // Snap tank onto the terrain surface at its spawn column
    this.computePosition(pLand);

    // Spawn at full health — Tank → Hitpoints sets the starting/max life.
    this.m_maxLife = GameConfig.hitpoints;
    this.m_health.nLife = this.m_maxLife;
    // Zero the defensive pools too (defensive — init runs on a fresh CTank where these are already 0,
    // but mirror respawn so a future reuse of init() on a live tank can't leak a stale shield/armor).
    this.m_health.nShield = 0;
    this.m_health.nArmor = 0;
    this.m_health.nHazmat = 0;
    this.m_health.fRadiation = 0;
    this.m_lastDamager = null; // no attacker yet this match
    // A fresh tank starts a new war with a clean scorecard.
    this.resetStats();
  }

  /** Respawn for the next battle of a war: restore full battle state (life, alive,
   *  position) but KEEP the cumulative war stats (kills/deaths/accuracy/damage) and
   *  credits — the standings table totals across the whole war. */
  respawn(x: number, pLand: CLand): void {
    this.m_vPos = new Vec2(x, 0);
    this.computePosition(pLand);
    this.m_vVel = new Vec2(0, 0);
    this.m_maxLife = GameConfig.hitpoints;
    this.m_health.nLife = this.m_maxLife;
    this.m_health.nShield = 0;
    this.m_health.nArmor = 0;
    this.m_health.nHazmat = 0;
    this.m_health.fRadiation = 0;
    this.m_lastDamager = null;
    this.m_bIsAlive = true;
    this.m_bIsMoving = false;
    this.m_bFalling = false;
    this.m_bExploded = false;
    // Clear in-progress motion state too, so a tank respawned while a drive/jet was queued at the
    // previous battle's end doesn't crawl toward a stale target or fly on leftover fuel on its first
    // update. m_bBuried self-recomputes next tick, but reset it so it isn't stale for that frame's
    // queries (aim gate / move-range planner / HUD read it at the battle boundary).
    this.m_driveTargetX = null;
    this.m_fJetFuel = 0;
    this.m_jetInput = {up: false, left: false, right: false};
    this.m_bBuried = false;
  }

  /** Zero the cumulative war scorecard (called on a fresh tank / new war). */
  resetStats(): void {
    this.m_kills = 0;
    this.m_deaths = 0;
    this.m_shotsFired = 0;
    this.m_hitsLanded = 0;
    this.m_damageDealt = 0;
  }

  // --- War stats (accumulate across the battles of a war; feed the standings) -----
  addShot(): void {
    this.m_shotsFired++;
  }
  /** Record a landed hit and the life it removed (signed: self/friendly damage and
   *  healing shots subtract, so Damage/hit can go negative — matching the original). */
  addHit(lifeRemoved: number): void {
    this.m_hitsLanded++;
    this.m_damageDealt += lifeRemoved;
  }
  addKill(): void {
    this.m_kills++;
  }
  /** Kill-count penalty for a friendly-fire / self kill (never below 0). */
  loseKill(): void {
    this.m_kills = Math.max(0, this.m_kills - 1);
  }
  addDeath(): void {
    this.m_deaths++;
  }
  getKills(): number {
    return this.m_kills;
  }
  getDeaths(): number {
    return this.m_deaths;
  }
  getShotsFired(): number {
    return this.m_shotsFired;
  }
  getHitsLanded(): number {
    return this.m_hitsLanded;
  }
  getDamageDealt(): number {
    return this.m_damageDealt;
  }

  /** Full/starting life (Hitpoints) — the denominator for life bars/percent. */
  getMaxLife(): number {
    return this.m_maxLife;
  }

  /** Override the max life and refill to it — used to give a deployed Sentry its own
   *  (weapon-defined) hit points, independent of the tank Hitpoints setting. */
  setMaxLife(n: number): void {
    this.m_maxLife = Math.max(1, Math.round(n));
    this.m_health.nLife = this.m_maxLife;
  }

  /** Shot-collision radius (scales with Player Size). */
  getHitRadius(): number {
    return tankRadius();
  }

  /**
   * Compute tank's Y position based on terrain surface (called each frame)
   */
  computePosition(pLand: CLand): void {
    if (!pLand) return;

    const nTerrainHeight = pLand.getHeightAt(Math.floor(this.m_vPos.x));

    // Tank sits on top of terrain
    this.m_vPos.y = nTerrainHeight - tankHeight();

    // Align the body to the local slope immediately — so a freshly-placed tank already rests
    // TILTED to the terrain under it (the original does this on placement), not flat at 0° until
    // the first physics tick runs.
    this.m_fAngle = this.computeBodyTilt(pLand);
    // (No underground check here: the line above snaps y ONTO the surface (nTerrainHeight − height),
    // which is always above it, so any `y > nTerrainHeight` test would be dead. Burial/fall is driven
    // by the physics tick + the Bury-Tanks flag, not this placement snap.)
  }

  /** Body tilt = the angle of the AVERAGE terrain normal across the tank's FOOTPRINT (its tread
   *  span), not a single column — the original averages the normal over the columns under the
   *  tank. Averaging smooths per-pixel terrain noise so the hull rests stably on the slope instead
   *  of jittering on bumps. 0 on flat ground. */
  private computeBodyTilt(pLand: CLand): number {
    const cx = Math.floor(this.m_vPos.x);
    const half = Math.max(2, Math.round(tankRadius())); // half the tread footprint
    let nx = 0,
      ny = 0;
    for (let c = cx - half; c <= cx + half; c++) {
      const n = pLand.getNormal(clamp(c, 1, pLand.width - 2));
      nx += n.x;
      ny += n.y;
    }
    return Math.atan2(nx, -ny); // average normal → hull tilt (same convention as before)
  }

  // ========================================================================
  // PHYSICS & MOVEMENT
  // ========================================================================

  /**
   * Main update tick - called every frame during battle
   */
  update(pLand: CLand, dt: number): void {
    if (!pLand) return;

    // Where the tank rests when sitting on the current terrain surface.
    const surf = pLand.getHeightAt(Math.floor(this.m_vPos.x));
    const fRestY = surf - tankHeight();

    // BURIED / underground: only with Bury Tanks on, and only when the surface has risen ABOVE the
    // tank's TOP — i.e. the whole hull is under the dirt. A few px of blast EJECTA lapping the hull
    // does NOT count (the tank can still crawl out — the drive hugs any terrain); the old 0.5px
    // hair-trigger flagged any dusting as "underground". Recomputed each frame so it clears the
    // instant the ground is lowered back to (or below) the tank.
    this.m_bBuried = GameConfig.buryTanks && this.m_vPos.y > surf;

    // Jet flight (extType 17): while fuel remains the player thrusts against
    // gravity. UP = -1.2g vertical (net -0.2g, a gentle rise), L/R = ∓0.1g
    // horizontal; fuel drains on real dt.
    // At empty this branch is skipped and the tank simply falls & lands below.
    if (this.m_fJetFuel > 0) {
      this.m_fJetFuel = Math.max(0, this.m_fJetFuel - dt);
      const {up, left, right} = this.m_jetInput;
      const airborne = this.m_vPos.y < fRestY - 0.5;

      if (airborne || up) {
        // Semi-implicit Euler: gravity, then thrust, then integrate.
        this.m_vVel.y += TANK_GRAVITY * dt;
        if (up) this.m_vVel.y += JET_UP_ACCEL * dt; // -1.2g
        if (left) this.m_vVel.x += JET_SIDE_ACCEL * dt; // -0.1g
        if (right) this.m_vVel.x -= JET_SIDE_ACCEL * dt; // +0.1g
        this.m_vPos.x += this.m_vVel.x * dt;
        this.m_vPos.y += this.m_vVel.y * dt;
        this.m_bFalling = true;
        this.m_bIsMoving = true;

        // Ceiling clamp at the top of the map.
        if (this.m_vPos.y < JET_CEILING) {
          this.m_vPos.y = JET_CEILING;
          if (this.m_vVel.y < 0) this.m_vVel.y = 0;
        }
        this.m_vPos.x = clamp(this.m_vPos.x, tankRadius(), pLand.width - tankRadius());

        // Land when descending onto the surface (keeps fuel for re-lift).
        const fLandY = pLand.getHeightAt(Math.floor(this.m_vPos.x)) - tankHeight();
        if (this.m_vVel.y >= 0 && this.m_vPos.y >= fLandY) {
          this.m_vPos.y = fLandY;
          this.m_vVel = new Vec2(0, 0);
          this.m_bFalling = false;
          this.m_bIsMoving = false;
          this.m_fAngle = this.computeBodyTilt(pLand);
        }
      } else {
        // Grounded, engine idle: rest on the surface but keep the fuel.
        this.m_vPos.y = fRestY;
        this.m_vVel = new Vec2(0, 0);
        this.m_bIsMoving = false;
        this.m_fAngle = this.computeBodyTilt(pLand);
      }
      this.m_fLastTurretAngle = this.m_fTurretAngle;
      return;
    }

    // Airborne when above the surface (crater under us) or moving from a kick.
    const bKicked = Math.abs(this.m_vVel.x) > 1 || this.m_vVel.y < -1;

    if (this.m_vPos.y < fRestY - 0.5 || bKicked) {
      // Fly under gravity, carrying any kick velocity, until we land.
      this.m_vVel.y += TANK_GRAVITY * dt;
      this.m_vPos.x += this.m_vVel.x * dt;
      this.m_vPos.y += this.m_vVel.y * dt;
      this.m_bFalling = true;

      // Keep within the battlefield.
      this.m_vPos.x = clamp(this.m_vPos.x, tankRadius(), pLand.width - tankRadius());

      const fLandY = pLand.getHeightAt(Math.floor(this.m_vPos.x)) - tankHeight();
      if (this.m_vVel.y >= 0 && this.m_vPos.y >= fLandY) {
        this.m_vPos.y = fLandY;
        this.m_vVel = new Vec2(0, 0);
        this.m_bFalling = false;
        this.m_bIsMoving = false; // settled — clears the motion loop / flight exit
      }
    } else if (this.m_driveTargetX !== null) {
      // Driving along the surface toward a queued destination (bot reposition).
      this.stepDrive(pLand, dt);
      this.m_fAngle = this.computeBodyTilt(pLand);
    } else {
      // Resting on the surface: stay glued to it as the terrain deforms, and tilt the body
      // to match the local slope. Bury Tanks (Tank option): if the tank is BELOW the surface
      // top — e.g. dirt was piled on it — leave it buried instead of lifting it back out.
      // (A genuine downward landing still settles it via the airborne branch above.)
      if (!(GameConfig.buryTanks && this.m_vPos.y > fRestY + 0.5)) this.m_vPos.y = fRestY;
      this.m_vVel = new Vec2(0, 0);
      this.m_bFalling = false;
      this.m_bIsMoving = false;
      this.m_fAngle = this.computeBodyTilt(pLand);
    }

    this.m_fLastTurretAngle = this.m_fTurretAngle;
  }

  /**
   * Check if tank can move to new position
   */
  canMove(pLand: CLand): boolean {
    const nX = Math.floor(this.m_vPos.x);

    // Check bounds (against the real map width, not a hardcoded 800)
    if (nX < tankRadius() || nX > pLand.width - tankRadius()) {
      return false;
    }

    // Can't move only when the ground surface has risen ABOVE the tank's TOP — fully underground.
    // Incidental blast ejecta lapping the hull (a few px) is NOT "underground": the tank can still
    // crawl out (the drive hugs any terrain). This matches update()'s buried flag / isBuried().
    return Math.floor(this.m_vPos.y) <= pLand.getHeightAt(nX);
  }

  /**
   * Stop tank movement
   */
  stopMoving(): void {
    this.m_bIsMoving = false;
    this.m_vVel = new Vec2(0, 0);
    this.m_driveTargetX = null;
  }

  // ── Ground drive (repositioning along the terrain surface) ───────────────

  /**
   * Begin driving toward `targetX`, crawling along the terrain surface. Stops on
   * arrival, at the map edge, or against a wall too steep to climb. `update()`
   * advances it while grounded; `isMoving()` stays true until it settles.
   */
  startDrive(targetX: number): void {
    if (!this.m_bIsAlive || this.m_bBuried) return; // a buried tank can't drive until it's dug out
    this.m_driveTargetX = targetX;
    this.m_bIsMoving = true;
  }

  isDriving(): boolean {
    return this.m_driveTargetX !== null;
  }

  /** True while the tank is trapped below the surface (Bury Tanks on + dirt piled over it) — it
   *  can neither drive nor fly until the ground is lowered back to it. */
  isBuried(): boolean {
    return this.m_bBuried;
  }

  /** One step of a ground drive: crawl toward the target, hugging the surface. */
  private stepDrive(pLand: CLand, dt: number): void {
    const target = this.m_driveTargetX as number;
    const dir = Math.sign(target - this.m_vPos.x);
    if (dir === 0) {
      this.endDrive(pLand);
      return;
    }

    const stepPx = Math.min(Math.abs(target - this.m_vPos.x), TANK_DRIVE_SPEED * dt);
    const newX = this.m_vPos.x + dir * stepPx;

    // Stop at the battlefield edge.
    if (newX < tankRadius() || newX > pLand.width - tankRadius()) {
      this.endDrive(pLand);
      return;
    }

    // The original drives the tank over ANY terrain — up walls, down cliffs, however spiky —
    // simply hugging the ground to the destination. There is NO steepness gate: a per-column
    // slope check halted the crawl on ordinary bumpy terrain (natural columns differ by several
    // px, more than a sub-pixel step allows), so the tank barely moved. Just follow the surface.
    this.m_vPos.x = newX;
    this.m_vPos.y = pLand.getHeightAt(Math.floor(newX)) - tankHeight();
    this.m_bIsMoving = true;
    if (Math.abs(newX - target) < 0.5) this.endDrive(pLand);
  }

  private endDrive(pLand: CLand): void {
    this.m_driveTargetX = null;
    this.m_bIsMoving = false;
    this.m_vPos.y = pLand.getHeightAt(Math.floor(this.m_vPos.x)) - tankHeight();
  }

  // ── Jet flight (extType 17) ──────────────────────────────────────────────

  /** Light the jet with `fuelSeconds` of fuel (the weapon's damage field). Refused (returns false)
   *  when the tank is buried — it can't fly out until it's dug free. Returns true when it lit. */
  igniteJet(fuelSeconds: number): boolean {
    if (this.m_bBuried) return false;
    this.m_fJetFuel = Math.max(0, fuelSeconds);
    return true;
  }

  /** Cut the engine — drops remaining fuel (turn-end / early-out). */
  cutJet(): void {
    this.m_fJetFuel = 0;
    this.m_jetInput = {up: false, left: false, right: false};
  }

  hasJetFuel(): boolean {
    return this.m_fJetFuel > 0;
  }

  getJetFuel(): number {
    return this.m_fJetFuel;
  }

  /** Held thrust input for this frame (up/left/right). */
  setJetInput(up: boolean, left: boolean, right: boolean): void {
    this.m_jetInput = {up, left, right};
  }

  /** True while the up-thrust is firing with fuel — drives the jet.wav loop. */
  isThrustingUp(): boolean {
    return this.m_fJetFuel > 0 && this.m_jetInput.up;
  }

  isFalling(): boolean {
    return this.m_bFalling;
  }

  /**
   * Apply knockback to tank (from explosions)
   */
  kick(dir: Vec2, fForce: number): void {
    // Apply impulse velocity from kick direction
    this.m_vVel.x += dir.x * fForce;
    this.m_vVel.y += dir.y * fForce;

    this.m_bFalling = true;
    this.m_bIsMoving = false;
  }

  // ========================================================================
  // COMBAT & DAMAGE
  // ========================================================================

  /**
   * Apply damage to tank (called from hit detection)
   */
  /** Apply damage. Returns the LIFE actually removed (post shield/hazmat/armor), which is
   *  what the earning economy credits — absorbed damage counts as 0. Pipeline (matches the
   *  original): SHIELD → HAZMAT (piercing weapons only) → ARMOR → LIFE.
   *  `piercing` = the weapon's piercing/secondary flag; only then does Hazmat resistance apply. */
  hit(fDamage: number, piercing: boolean = false): number {
    if (!this.m_bIsAlive) return 0;

    const lifeBefore = this.m_health.nLife;
    let dmg = fDamage;

    // SHIELD (a 0..1000 pool) is ALL-OR-NOTHING: it blocks the shot only if it strictly
    // exceeds that shot's damage (shield -= dmg, nothing passes). The first hit that
    // exceeds the shield DESTROYS it and the FULL damage still passes through — the shield's
    // remaining value is NOT subtracted from the overflow (no partial soak).
    if (this.m_health.nShield > dmg) {
      this.m_health.nShield -= dmg;
      dmg = 0;
    } else if (this.m_health.nShield > 0) {
      this.m_health.nShield = 0;
    }

    if (dmg > 0) {
      // HAZMAT — a % reducer applied ONLY to piercing/secondary weapons, BEFORE armor.
      if (piercing) dmg *= 1 - this.m_health.nHazmat / 100;
      // ARMOR — a % reducer applied to EVERY hit. It is NOT extra HP and is never
      // depleted; it multiplies the through-damage by (1 − armor%).
      dmg *= 1 - this.m_health.nArmor / 100;
      this.m_health.nLife -= dmg;
    }

    if (this.m_health.nLife <= 0) {
      this.m_health.nLife = 0;
      // Rounds/Point mode is non-lethal: the tank bottoms out at 0 life but is NEVER destroyed —
      // it keeps taking turns and the round is scored by damage points (faithful to the original,
      // which gates the dead-flag/explosion to Deathmatch). Only Deathmatch kills.
      if (GameConfig.lethalDamage) {
        this.m_bExploded = true;
        this.m_bIsAlive = false;
      }
    }

    return lifeBefore - this.m_health.nLife;
  }

  /** Force this tank into its destroyed (wreck) state, bypassing the damage pipeline. Used for the
   *  end-of-battle "explode the losers" cinematic — a Rounds tank is never killed by damage, so the
   *  controller detonates the non-winning teams directly once the result is decided. Idempotent. */
  explode(): void {
    this.m_health.nLife = 0;
    this.m_bExploded = true;
    this.m_bIsAlive = false;
  }

  /**
   * Apply radiation fallout damage-over-time. Radiation is a PIERCING/secondary source, so it
   * routes through the same pipeline as a piercing hit — SHIELD soaks it first, then HAZMAT
   * resistance (the whole point of a Hazmat suit), then Armor, then Life. (The original binary has
   * no fallout DOT consumer at all — radiation is cosmetic there — so this is our interpretation,
   * following how it treats a piercing weapon: shield → hazmat → armor → life.)
   */
  applyRadiationDamage(fAmount: number, _dt: number): void {
    if (!this.m_bIsAlive) return;
    this.m_health.fRadiation += fAmount;

    let dmg = fAmount;
    // Shield absorbs the tick first (chips down as it soaks the fallout).
    if (this.m_health.nShield >= dmg) {
      this.m_health.nShield -= dmg;
      dmg = 0;
    } else {
      dmg -= this.m_health.nShield;
      this.m_health.nShield = 0;
    }
    if (dmg > 0) {
      dmg *= 1 - this.m_health.nHazmat / 100; // Hazmat = radiation resistance (piercing resist)
      dmg *= 1 - this.m_health.nArmor / 100; // Armor
      this.m_health.nLife -= dmg;
    }

    if (this.m_health.nLife <= 0) {
      this.m_health.nLife = 0;
      // Rounds/Point mode is non-lethal: the tank bottoms out at 0 life but is NEVER destroyed —
      // it keeps taking turns and the round is scored by damage points (faithful to the original,
      // which gates the dead-flag/explosion to Deathmatch). Only Deathmatch kills.
      if (GameConfig.lethalDamage) {
        this.m_bExploded = true;
        this.m_bIsAlive = false;
      }
    }
  }

  // ========================================================================
  // RENDERING
  // ========================================================================

  /**
   * Render the tank to the canvas. Uses the loaded hull sprite when available
   * and falls back to a vector silhouette while assets are still loading.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    assets?: ISpriteSource,
    showDetail = false,
    withBadge = true,
  ): void {
    if (!this.m_bIsAlive && !this.m_bExploded) return;

    const cx = this.m_vPos.x;
    const surfaceY = this.m_vPos.y + tankHeight(); // ground contact line

    const bodyKey = `tanks/${this.m_sTankType} ${this.m_bExploded ? 'wreck' : 'body'}`;
    const sprite = assets?.getSprite(bodyKey) ?? null;

    // Booster-jet exhaust: the real jet flame (gui/jet.bmp) hanging below the tank
    // while it thrusts, drawn straight down (not tilted) and additively so its black
    // background drops out. Behind the hull so the tank rides on top of the flame.
    if (this.m_bIsAlive && !this.m_bExploded && this.isThrustingUp()) {
      const jet = assets?.getSprite('gui/jet');
      if (jet) {
        const fw = tankWidth() * 0.7;
        const fh = (jet.height / jet.width) * fw;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(jet.bitmap, cx - fw / 2, surfaceY - fh * 0.1, fw, fh);
        ctx.restore();
      }
    }

    ctx.save();
    ctx.translate(cx, surfaceY);
    ctx.rotate(this.m_fAngle); // tilt to terrain slope

    if (sprite) {
      const w = hullDrawWidth(sprite);
      const h = (sprite.height / sprite.width) * w;
      // Recolour the hull (not the wreck) to the tank's own colour, keeping its
      // shading (Tank → Colorize Team).
      const img =
        this.m_bExploded || !GameConfig.colorizeTeam
          ? sprite.bitmap
          : tintToColor(sprite, this.m_sColor, `${bodyKey}|${this.m_sColor}`);
      // Wargame Detail preset: draw the hull as a flat pale-blue silhouette (tactical-map
      // look), not the textured/coloured sprite.
      if (isWargame() && !this.m_bExploded) {
        ctx.drawImage(silhouette(sprite, WARGAME_TINT, `${bodyKey}|wargame`), -w / 2, -h, w, h);
      } else {
        // High Contrast: stamp a white silhouette at 8 offsets behind the hull so the
        // tank reads as white-outlined against busy terrain.
        if (GameConfig.highContrast && !this.m_bExploded) {
          const sil = silhouette(sprite, '#ffffff', `${bodyKey}|white`);
          const o = Math.max(1.5, w * 0.045);
          for (const [ox, oy] of [
            [-o, 0],
            [o, 0],
            [0, -o],
            [0, o],
            [-o, -o],
            [o, -o],
            [-o, o],
            [o, o],
          ])
            ctx.drawImage(sil, -w / 2 + ox, -h + oy, w, h);
        }
        ctx.drawImage(img, -w / 2, -h, w, h);
      }
    } else {
      this.drawVectorHull(ctx);
    }
    ctx.restore();

    // Shield DOME — concentric team-colour rings enveloping the tank while shielded (the
    // shimmering bubble). Drawn over the body, under the badge so the label stays readable.
    // The body is drawn rotated about its GROUND-CONTACT pivot (cx, surfaceY), so on a slope its
    // sprite centre swings out — track that rotated centre so the bubble stays concentric.
    if (this.m_bIsAlive && this.m_health.nShield > 0) {
      const bodyH = sprite ? (sprite.height / sprite.width) * hullDrawWidth(sprite) : tankHeight();
      const halfH = bodyH * 0.5;
      const a = this.m_fAngle;
      this.drawShieldDome(ctx, cx + halfH * Math.sin(a), surfaceY - halfH * Math.cos(a));
    }

    // Barrel + turret dome (aim is independent of body tilt)
    if (!this.m_bExploded && this.m_bIsAlive) {
      this.drawBarrel(ctx, assets);
      // The badge (name / life-shield-armour bars / hover stats) is normally drawn
      // on a SEPARATE overlay layer above the HUD (so a low tank's readouts aren't
      // clipped at the HUD edge) — see paintBadge + the fx overlay. `withBadge`
      // stays true only for callers that still want it inline (e.g. wreckage).
      if (withBadge) this.drawBadge(ctx, surfaceY, showDetail, assets);
    }
  }

  /** Draw ONLY the on-field badge (name + bars + hover stats) — used by the
   *  foreground overlay canvas that sits above the HUD, so readouts for a tank low
   *  on screen render over the HUD instead of being clipped at the world's edge. */
  paintBadge(ctx: CanvasRenderingContext2D, showDetail: boolean, assets?: ISpriteSource): void {
    if (this.m_bExploded || !this.m_bIsAlive) return;
    this.drawBadge(ctx, this.m_vPos.y + tankHeight(), showDetail, assets);
  }

  /**
   * The shield bubble: up to five concentric circle outlines in the tank's TEAM colour,
   * centred on the tank, semi-transparent. More rings appear as the shield gets stronger —
   * a base ring always, then outer rings unlock at shield 200 / 400 / 600 / 800. Ring alphas
   * (inner→outer) 100 / 150 / 200 / 100 / 50 give the layered, shimmering look.
   */
  private drawShieldDome(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    const shield = this.m_health.nShield;
    // Base ring radius is proportional to the tank's on-screen radius (the original uses ~2.5×,
    // but its exact base is unrecoverable); feeding our chunkier collision radius at 2.5× made the
    // bubble too big, so the base is tuned to hug the hull like the original.
    const r = tankRadius() * 1.7; // snug base ring radius
    const rings: [number, number][] = [[r - 1, 100]]; // the always-on inner ring
    if (shield > 200) rings.push([r + 1, 150]);
    if (shield > 400) rings.push([r + 3, 200]);
    if (shield > 600) rings.push([r + 5, 100]);
    if (shield > 800) rings.push([r + 7, 50]);
    ctx.save();
    ctx.strokeStyle = this.m_sColor;
    ctx.lineWidth = 1;
    for (const [rad, a] of rings) {
      ctx.globalAlpha = a / 255;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, TWO_PI);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Simple colour silhouette used until the hull sprite loads. */
  private drawVectorHull(ctx: CanvasRenderingContext2D): void {
    const color = this.m_sColor;
    const w = tankWidth();

    ctx.fillStyle = this.m_bExploded ? '#333333' : color;
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    ctx.lineTo(w / 2, 0);
    ctx.lineTo(w / 2 - 5, -10);
    ctx.lineTo(-w / 2 + 5, -10);
    ctx.closePath();
    ctx.fill();

    // Rounded turret base
    ctx.beginPath();
    ctx.arc(0, -10, 7, Math.PI, 0);
    ctx.fill();
  }

  /** Draw the gun barrel from the turret pivot along the aim direction. */
  private drawBarrel(ctx: CanvasRenderingContext2D, assets?: ISpriteSource): void {
    const pivot = this.getTurretPivot();
    const aim = this.aimUnit();

    // Use the tank's own turret sprite (coloured to match the hull). It points
    // right; we rotate it along the aim and mirror it vertically when aiming
    // left so the art stays upright. Scaled so its length = the muzzle offset.
    const turret = assets?.getSprite(`tanks/${this.m_sTankType} turret`) ?? null;
    if (turret) {
      const scale = turretLen() / turret.width;
      const tw = turret.width * scale,
        th = turret.height * scale;
      const turretKey = `tanks/${this.m_sTankType} turret`;
      const img = isWargame()
        ? silhouette(turret, WARGAME_TINT, `${turretKey}|wargame`) // tactical-map silhouette
        : GameConfig.colorizeTeam
          ? tintToColor(turret, this.m_sColor, `${turretKey}|${this.m_sColor}`)
          : turret.bitmap;
      ctx.save();
      ctx.translate(pivot.x, pivot.y);
      ctx.rotate(Math.atan2(aim.y, aim.x));
      if (aim.x < 0) ctx.scale(1, -1); // mirror when facing left
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, -th / 2, tw, th); // base at the pivot
      ctx.restore();
      return;
    }

    // Fallback: a simple grey barrel until the sprite loads.
    const muzzle = this.getMuzzlePosition();
    ctx.strokeStyle = '#d0d0d0';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pivot.x, pivot.y);
    ctx.lineTo(muzzle.x, muzzle.y);
    ctx.stroke();
  }

  /**
   * The on-field badge, stacked upward above the tank:
   * name box (team colour) → shield bar (if any) → armour strip (if any) →
   * life bar → full stat lines (only on hover / detail). Life & shield are
   * green/blue fills over black with a red/grey depleted remainder.
   */
  private drawBadge(
    ctx: CanvasRenderingContext2D,
    surfaceY: number,
    showDetail: boolean,
    assets?: ISpriteSource,
  ): void {
    const w = Math.round(tankWidth() * 0.8); // bars a little narrower than the hull
    const cx = this.m_vPos.x;
    const team = this.m_sColor;
    const life = clamp01(this.m_health.nLife / this.m_maxLife);
    const shield = clamp01(this.m_health.nShield / 1000);
    const armor = this.m_health.nArmor;
    const BH = 2; // thin bar

    // Bar: coloured fill over a black border + a "depleted" remainder.
    const bar = (y: number, frac: number, fill: string, empty: string): number => {
      const x = cx - w / 2;
      ctx.fillStyle = '#000';
      ctx.fillRect(x - 1, y - 1, w + 2, BH + 2);
      ctx.fillStyle = empty;
      ctx.fillRect(x, y, w, BH);
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w * frac, BH);
      return y + BH + 2;
    };

    // Draw a bitmap-font stat line centred at cx, at NATIVE size (1:1 — never
    // downscaled, or the 1-bit glyphs go jaggy). No dark backing box: the OUTLINED
    // font carries its own black outline, so the text reads on any terrain — matching
    // the original, which draws the stat block as plain outlined text.
    const line = (text: string, y: number): number => {
      const lab = getFont(STAT_FONT).renderCached(text, {spacing: -1}); // tighter letter spacing
      const lx = Math.round(cx - lab.width / 2),
        ly = Math.round(y);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(lab, lx, ly);
      return y + lab.height - 1;
    };

    // The badge sits UNDER the tank, stacked downward.
    // Offset clears the tank even when it's tilted on a slope.
    let y = surfaceY + 11;
    // Life / shield bars + armour/hazmat strip (Graphics → Show Power).
    if (GameConfig.showPowerBars) {
      y = bar(y, life, '#00ff00', '#ff0000'); // life (green / red)
      // Shield: a clean BLUE bar. The depleted remainder is near-black (not the light grey
      // that read as a stray white bar) so only the blue shield reads.
      if (shield > 0) y = bar(y, shield, '#0000ff', '#0a0a1e');
      // Armour/Hazmat strip: a thin YELLOW line = armour%, a thin WHITE line = hazmat%
      // (each only when > 0). These are 1px lines, not full bars.
      const hazmat = this.m_health.nHazmat;
      if (armor > 0 || hazmat > 0) {
        const x0 = cx - w / 2;
        const rows = (armor > 0 ? 1 : 0) + (hazmat > 0 ? 1 : 0);
        ctx.fillStyle = '#000';
        ctx.fillRect(x0 - 1, y - 1, w + 2, rows + 2);
        if (armor > 0) {
          ctx.fillStyle = '#ffff00';
          ctx.fillRect(x0, y, w * Math.min(1, armor / 100), 1);
          y += 1;
        }
        if (hazmat > 0) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x0, y, w * Math.min(1, hazmat / 100), 1);
          y += 1;
        }
        y += 2;
      }
    }

    // --- name box (team colour @ 50% + solid outline). The shield icon is drawn OUTSIDE the
    // box, hanging off its LEFT edge (as in the original), NOT crammed inside next to the name.
    // Gated by Graphics → Show Team Color. Native bitmap-font size. ---
    if (GameConfig.showTeamColor) {
      const name = this.m_sName || strings.value.game.noName;
      const lab = getFont(BADGE_FONT).renderCached(name);
      const nameW = lab.width;
      const pad = [3, 2]; // Horizontal, Vertical
      // Pad around the VISIBLE glyph ink, not the font strip (which carries blank
      // rows top/bottom) — otherwise the vertical padding reads far bigger than the
      // horizontal. `ink.top` is the blank offset to pull back when drawing.
      const ink = getFont(BADGE_FONT).contentBounds(name);
      const bw = Math.round(pad[0] * 2 + nameW);
      const bh = ink.height + pad[1] * 2;
      const bx = Math.round(cx - bw / 2),
        by = Math.round(y + 2);

      ctx.globalAlpha = 0.5;
      ctx.fillStyle = team;
      ctx.fillRect(bx, by, bw, bh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = team;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(lab, Math.round(bx + pad[0]), Math.round(by + pad[1] - ink.top));

      // Shield icon (gui/shield.bmp, native 12×15) OUTSIDE the box, hanging off its RIGHT edge —
      // shown only while shielded. Drawn at NATIVE size (the badge blits its sprites 1:1; the
      // original's ×2 is the double-size-badge flag we don't run), matching the on-badge emblem.
      if (shield > 0) {
        const icon = assets?.getSprite('gui/shield');
        if (icon) {
          const iw = icon.width, // 12
            ih = icon.height; // 15
          ctx.drawImage(
            icon.bitmap,
            Math.round(bx + bw - 2),
            Math.round(by + (bh - ih) / 2),
            iw,
            ih,
          );
        }
      }
      y = by + bh + 1;
    }

    // --- full stat lines: on hover, or via the two disjoint always-on toggles —
    // Show Tank Stats for the human's own tanks, Show AI Stats ("Show the computer's
    // stats") for the computer tanks. Each toggle owns exactly its tank type. ---
    if (
      showDetail ||
      (GameConfig.showTankStats && !this.isBot()) ||
      (GameConfig.showAiStats && this.isBot())
    ) {
      const g = strings.value.game;
      y = line(fmt(g.tankTeam, {n: this.m_nTeamId + 1}), y);
      y = line(fmt(g.tankLife, {n: Math.round(this.m_health.nLife)}), y);
      if (armor > 0) y = line(fmt(g.tankArmor, {n: Math.round(armor)}), y);
      if (this.m_health.nShield > 0)
        y = line(fmt(g.tankShield, {n: Math.round(this.m_health.nShield)}), y);
      // Floored (not rounded) to match the depot's credit readout and affordability —
      // credits accumulate fractional damage-based earnings, but only whole credits are
      // spendable, so show the whole part.
      y = line(fmt(g.tankCredits, {n: Math.floor(this.m_credits)}), y);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // ========================================================================
  // TURRET CONTROL
  // ========================================================================

  /**
   * Aim the turret from a UI angle in degrees measured counter-clockwise from
   * horizontal-right: 0 = right, 90 = straight up, 180 = left, and NEGATIVE
   * values point below the horizon (e.g. -45 = down-right). Stored directly as
   * that angle in radians — a single full-circle value, so any direction
   * (including below-horizon aim) is representable.
   */
  setTurretAngle(fDegrees: number): void {
    this.m_fLastTurretAngle = this.m_fTurretAngle;
    this.m_fTurretAngle = (fDegrees * Math.PI) / 180;
  }

  /** The barrel's actual WORLD angle (radians). Relative Turrets (Tank option) makes the
   *  HUMAN's stored aim relative to the tank body, so add the body's terrain tilt — "up"
   *  then follows the tank on a slope. Bots always solve and fire absolute angles, so the
   *  aid never applies to them (matching the original, where the AI compensates for it). */
  firingAngle(): number {
    return (
      this.m_fTurretAngle + (GameConfig.relativeTurrets && this.m_bIsHuman ? this.m_fAngle : 0)
    );
  }

  /**
   * Unit vector the barrel points along, matching the projectile launch
   * direction. Screen-Y is down, so up = negative-Y: (cos θ, -sin θ) for all θ.
   */
  aimUnit(): Vec2 {
    const r = this.firingAngle();
    return new Vec2(Math.cos(r), -Math.sin(r));
  }

  /**
   * World position of the turret pivot — a point on the hull (top-centre),
   * carried along the body's terrain tilt so the barrel stays attached.
   */
  getTurretPivot(): Vec2 {
    const groundX = this.m_vPos.x;
    const groundY = this.m_vPos.y + tankHeight(); // ground-contact line
    const up = turretHgt(this.m_sTankType); // turret height above ground (per-hull)
    const s = Math.sin(this.m_fAngle),
      c = Math.cos(this.m_fAngle);
    return new Vec2(groundX + up * s, groundY - up * c); // (0,-up) rotated by body tilt
  }

  /**
   * World position of the barrel tip, where a shot should spawn.
   */
  getMuzzlePosition(): Vec2 {
    const pivot = this.getTurretPivot();
    const aim = this.aimUnit();
    return new Vec2(pivot.x + aim.x * turretLen(), pivot.y + aim.y * turretLen());
  }

  /**
   * Muzzle position the barrel WOULD have if aimed at `deg` (UI degrees), without
   * moving the turret. Lets the AI evaluate a candidate shot's true spawn point.
   */
  muzzleForAngle(deg: number): Vec2 {
    const r = (deg * Math.PI) / 180;
    const aim = new Vec2(Math.cos(r), -Math.sin(r));
    const pivot = this.getTurretPivot();
    return new Vec2(pivot.x + aim.x * turretLen(), pivot.y + aim.y * turretLen());
  }

  // ========================================================================
  // ACCESSORS & STATE QUERIES
  // ========================================================================

  isAlive(): boolean {
    return this.m_bIsAlive;
  }

  isMoving(): boolean {
    return this.m_bIsMoving;
  }

  isBot(): boolean {
    return !this.isHuman();
  }

  isHuman(): boolean {
    return this.m_bIsHuman;
  }

  /** Deployed auto-turret (Sentry Turret / Minigun) — drives its own aim-and-fire turn,
   *  is excluded from team standings, and never taunts. */
  isSentry(): boolean {
    return this.m_sTankType === 'Sentry';
  }

  setHuman(bHuman: boolean): void {
    this.m_bIsHuman = bHuman;
  }

  getName(): string {
    return this.m_sName;
  }

  // Each tank keeps its OWN selected weapon so one player's choice never leaks
  // into another's turn.
  getWeaponIndex(): number {
    return this.m_weaponIndex;
  }

  setWeaponIndex(i: number): void {
    this.m_weaponIndex = i;
  }

  // Likewise, each tank keeps its OWN aim (UI angle in degrees, 0..180) and
  // power (10..1000) so they persist across turns and never leak between players.
  getAimAngle(): number {
    return this.m_aimAngle;
  }

  setAimAngle(deg: number): void {
    this.m_aimAngle = deg;
  }

  getPower(): number {
    return this.m_power;
  }

  setPower(p: number): void {
    this.m_power = p;
  }

  // The power + angle of this tank's LAST real shot,
  // saved on every non-utility fire. The reset button (↺) restores the current
  // aim to these — "set power and angle to your last shot." Seeded to the
  // starting aim so reset is sane before the first shot of a battle.
  getLastShotAngle(): number {
    return this.m_lastShotAngle;
  }

  getLastShotPower(): number {
    return this.m_lastShotPower;
  }

  saveLastShot(angleDeg: number, power: number): void {
    this.m_lastShotAngle = angleDeg;
    this.m_lastShotPower = power;
  }

  getCredits(): number {
    return this.m_credits;
  }

  setCredits(n: number): void {
    this.m_credits = Math.max(0, n);
  }

  /** Overwrite position + health + credits from an authoritative network snapshot
   *  (getPosition/getHealth hand out copies, so a spectator can't just mutate those). */
  setNetState(s: {
    x: number;
    y: number;
    life: number;
    shield: number;
    armor: number;
    hazmat: number;
    credits: number;
    /** Explicit alive flag — a Rounds/Points tank sits at 0 life yet ALIVE, so alive can't be
     *  derived from life. Optional for back-compat; falls back to `life > 0` if absent. */
    alive?: boolean;
  }): void {
    // Defence-in-depth: the server validates the snapshot, but never trust the wire — a non-finite
    // field slipping through would poison m_vPos/getHeightAt and cascade with no recovery.
    const num = (v: number, prev: number): number => (Number.isFinite(v) ? v : prev);
    this.m_vPos.x = num(s.x, this.m_vPos.x);
    this.m_vPos.y = num(s.y, this.m_vPos.y);
    this.m_vVel.x = 0;
    this.m_vVel.y = 0;
    this.m_health.nLife = num(s.life, this.m_health.nLife);
    this.m_health.nShield = num(s.shield, this.m_health.nShield);
    this.m_health.nArmor = num(s.armor, this.m_health.nArmor);
    this.m_health.nHazmat = num(s.hazmat, this.m_health.nHazmat);
    // Alive is a FLAG, not derived from life (a Rounds tank is alive at 0 life). Use the snapshot's
    // explicit flag; fall back to life>0 only for an older snapshot that predates the field.
    this.m_bIsAlive = s.alive ?? s.life > 0;
    // If the authoritative snapshot says this tank is alive, clear a locally-predicted explosion — a
    // client that mispredicted the death (m_bExploded=true) would otherwise render a LIVE tank as a
    // wreck (no barrel/badge) until its next respawn.
    if (this.m_bIsAlive) this.m_bExploded = false;
    this.setCredits(num(s.credits, this.m_credits));
  }

  /** Add (or subtract) credits, floored at 0. Used by the earning economy. */
  addCredits(n: number): void {
    this.m_credits = Math.max(0, this.m_credits + n);
  }

  /** Whether this tank may open the depot right now (Economy → Buy Time gates it). */
  canBuy(): boolean {
    return this.m_canBuy;
  }
  setCanBuy(on: boolean): void {
    this.m_canBuy = on;
  }

  /** The last tank to deal LIFE damage to this one — the kill-credit attribution
   *  ("killer"). Set on every damaging hit, cleared on spawn. */
  getLastDamager(): CTank | null {
    return this.m_lastDamager;
  }

  setLastDamager(t: CTank | null): void {
    this.m_lastDamager = t;
  }

  getColor(): string {
    return this.m_sColor;
  }

  setColor(hex: string): void {
    this.m_sColor = hex;
  }

  setTankType(sType: string): void {
    this.m_sTankType = sType;
  }

  getTankType(): string {
    return this.m_sTankType;
  }

  /** Screen/world hit-test for hover (badge detail). */
  isPointInside(px: number, py: number): boolean {
    const dx = px - this.m_vPos.x,
      dy = py - (this.m_vPos.y + tankHeight() / 2);
    return dx * dx + dy * dy < (tankRadius() + 8) * (tankRadius() + 8);
  }

  getPosition(): Vec2 {
    return this.m_vPos.clone();
  }

  getVelocity(): Vec2 {
    return this.m_vVel.clone();
  }

  getHealth(): STankHealth {
    return {...this.m_health};
  }

  // Utility-weapon effects (extType 7/10/11): boost shield, repair, set armor.
  addShield(n: number): void {
    this.m_health.nShield = clamp(this.m_health.nShield + n, 0, 1000);
  }

  addLife(n: number): void {
    // Heal caps at the tank's MAX life, not a hard 1000 — HitPoints is a setting (100–5000), so a
    // Repair/Medkit refills toward THIS match's max (a 5000-HP tank isn't stuck at 1000, a 100-HP
    // tank can't overheal to 10×). The `hit` path floors at 0; this floors there too via clamp.
    this.m_health.nLife = clamp(this.m_health.nLife + n, 0, this.m_maxLife);
  }

  // Armor and Hazmat are SET stats (a level), NOT additive pools like shield/life — the
  // original writes `armor = weapon.dmg·k` on use, so buying a second armor does NOT stack;
  // it re-sets to the item's level. (Only Shield/Heal add.) Upgrade-only: never downgrade a
  // stronger existing level, matching the "buy only if it improves you" purchase gate.
  setArmor(pct: number): void {
    this.m_health.nArmor = Math.max(this.m_health.nArmor, clamp(pct, 0, 100));
  }

  setHazmat(pct: number): void {
    this.m_health.nHazmat = Math.max(this.m_health.nHazmat, clamp(pct, 0, 100));
  }

  getTeamId(): number {
    return this.m_nTeamId;
  }

  /**
   * Sprites this tank needs, as {logical name, file path} pairs. The logical
   * names match what draw() looks up, so the loader and renderer stay in sync.
   */
  getRequiredSprites(): {name: string; file: string}[] {
    return ['body', 'wreck', 'turret'].map(part => ({
      name: `tanks/${this.m_sTankType} ${part}`,
      file: `/assets/tanks/${this.m_sTankType} ${part}.bmp`,
    }));
  }

  distanceTo(x: number, y: number): number {
    const dx = x - this.m_vPos.x;
    const dy = y - (this.m_vPos.y + tankHeight() / 2);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** The tank's collision CENTRE — the point `distanceTo` measures from, and what a shot/beam should
   *  aim AT (its `getPosition` is the top of the hull, so aiming there grazes high). */
  getBodyCenter(): Vec2 {
    return new Vec2(this.m_vPos.x, this.m_vPos.y + tankHeight() / 2);
  }

  // ========================================================================
  // MEMBER VARIABLES
  // ========================================================================

  private m_nTeamId: number = 0; // Team assignment (tanks sharing a colour are a team)
  private m_sColor: string = DEFAULT_TEAM_COLOR; // Hull colour (per player; the team is its grouping)
  private m_sName: string = ''; // Display name (e.g. "Player", "BrainBot")
  private m_credits: number = 0; // Economy credits (per-tank balance; shown in the badge)
  private m_canBuy: boolean = true; // Economy → Buy Time: may this tank open the depot now
  private m_lastDamager: CTank | null = null; // kill-credit attribution ("killer")
  // War scorecard — accumulates across the battles of a war (standings table).
  private m_kills: number = 0;
  private m_deaths: number = 0;
  private m_shotsFired: number = 0;
  private m_hitsLanded: number = 0;
  private m_damageDealt: number = 0; // signed net life removed (self/friendly can subtract)
  private m_weaponIndex: number = 0; // This tank's own selected weapon
  private m_aimAngle: number = 45; // This tank's own aim (UI degrees, 0..180)
  private m_power: number = 500; // This tank's own firing power (10..1000)
  private m_lastShotAngle: number = 45; // aim of the last real shot (reset target)
  private m_lastShotPower: number = 500;
  private m_bIsHuman: boolean = false; // True for the human-controlled tank
  private m_sTankType: string = 'Standard'; // Hull sprite variant

  // Position and movement
  public m_vPos: Vec2; // Tank center position
  private m_vVel: Vec2; // Velocity vector
  private m_fAngle: number; // Body rotation angle

  // Turret state
  private m_fTurretAngle: number; // Current aim direction (radians)
  public m_fLastTurretAngle: number;

  // Health status
  private m_health: STankHealth = {
    nLife: 1000,
    nShield: 0,
    nArmor: 0,
    nHazmat: 0,
    fRadiation: 0,
  };
  // Full/starting life — set from Tank → Hitpoints on spawn. Denominator for the
  // life bar and the life-percent status so custom hitpoints scale correctly.
  private m_maxLife = 1000;

  // Jet flight (extType 17): fuel in seconds remaining, and the current held
  // thrust input. Flying == fuel > 0 (there is no separate flag).
  private m_fJetFuel: number = 0;
  private m_jetInput = {up: false, left: false, right: false};

  // State flags
  public m_bIsAlive: boolean = true;
  public m_bIsMoving: boolean = false;
  private m_bFalling: boolean = false;
  private m_driveTargetX: number | null = null; // ground-drive destination, or null
  private m_bBuried: boolean = false; // trapped below the surface (Bury Tanks) → can't drive/fly
  public m_bExploded: boolean = false;
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Base tank geometry (px). Player Size (Settings → Tank) scales all of it uniformly
// via GameConfig at read time, so a Small/Large tank draws, sits and collides at the
// chosen size. Accessors below are used everywhere in place of the raw constants.
const TSZ_R = 16; // Half-width of tank collision box
const TSZ_H = 24; // Approximate height in pixels
const TSZ_TLEN = 20; // Turret barrel length for muzzle calc
const TSZ_THGT = 15; // Turret pivot height above the ground line
const TSZ_W = 46; // On-screen hull width in pixels
// Native width (px) of the reference hull bitmap (the standard tanks are ~64–70). Every
// hull is drawn at TSZ_W wide, EXCEPT sprites narrower than this reference — e.g. the
// compact Sentry (37px) — which keep their true proportion instead of being scaled up to
// full tank width. Wider sprites still clamp to TSZ_W, so the player hulls are unchanged.
const REF_HULL_W = 64;
const hullDrawWidth = (sprite: {width: number}) =>
  tankWidth() * Math.min(1, sprite.width / REF_HULL_W);
const tankRadius = () => TSZ_R * GameConfig.tankSizeScale;
const tankHeight = () => TSZ_H * GameConfig.tankSizeScale;
const turretLen = () => TSZ_TLEN * GameConfig.tankSizeScale;
// Turret pivot height above the ground line. Default TSZ_THGT nests the pivot inside every hull
// EXCEPT the short "Atomic Cannon" one (drawn body-top ≈ 13px < 15), where it floats — so that hull
// gets a lower pivot that seats the barrel back on it. Taller hulls keep the default, so they're
// unchanged. Keyed on tank type (the muzzle/aim path has no sprite handy, so this is a static fact
// about the art, not read from the bitmap each call).
const TURRET_HGT_BY_TYPE: Record<string, number> = {
  'Atomic Cannon': 11,
};
const turretHgt = (type: string) =>
  (TURRET_HGT_BY_TYPE[type] ?? TSZ_THGT) * GameConfig.tankSizeScale;
const tankWidth = () => TSZ_W * GameConfig.tankSizeScale;
const TANK_GRAVITY = 400; // Fall acceleration when unsupported (px/s^2)
const TANK_DRIVE_SPEED = 70; // Ground-drive crawl speed (px/s) — climbs ANY terrain, no steepness gate

// Jet thrust as multiples of gravity.
// UP = -1.2g (net -0.2g up while held); L/R = ∓0.1g. Ceiling at the map top.
const JET_UP_ACCEL = -1.2 * TANK_GRAVITY;
const JET_SIDE_ACCEL = -0.1 * TANK_GRAVITY;
const JET_CEILING = 8;
