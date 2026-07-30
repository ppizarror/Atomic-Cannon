/**
 * CParticleSystem — explosion, flare, spark and trail particles.
 *
 * A single flat pool of particles integrated with semi-implicit Euler and a
 * per-system gravity, then killed on lifetime or when they leave the clip
 * bounds. Emission is driven by fixed profiles (blast / tank-death / trail);
 * each profile lays down a mix of three render kinds:
 *
 *   - 'disc'  : alpha-blended dot that fades with age   (sparks, debris)
 *   - 'flare' : additive radial glow                     (fireball puffs)
 *   - 'flash' : additive white-out bloom, short-lived    (the nuke flash)
 *
 * Colours come from the firing weapon's effect tint, so each weapon reads
 * differently on impact.
 */

import type {Vec2} from '../math/Vec2';
import type {ISpriteSource} from './rendering/sprites';
import {TintedSpriteCache} from './rendering/TintedSpriteCache';
import particlesRaw from '../data/particles.json';
import {smokeEnabled} from './CGameConfig';
import {boundaryFactor} from './wind';
import {between} from '../math/random';
import {hexToRgb, mixToward, WHITE, type RGB} from '../math/color';
import {TWO_PI, deg2rad} from '../math/num';
import {EXP, type ExpType, isNukeExp} from './weapons/ExpType';

interface ParticlePreset {
  posVar: number;
  density: number;
  minv: number;
  maxv: number;
  minlife: number;
  maxlife: number;
  minTheta: number;
  maxTheta: number;
  colorVar: number;
  colorr: number;
  colorg: number;
  colorb: number;
}

const PRESETS = particlesRaw as unknown as Record<string, ParticlePreset>;

// 'plume' = the bright starburst flare used along a projectile trail (real
// flares/04.bmp sprite, additive). 'smoke' = grey puff (real gui/smoke.bmp).
type RenderKind = 'disc' | 'flare' | 'flash' | 'smoke' | 'plume';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  g: number;
  b: number;
  age: number;
  life: number;
  size: number; // base radius in px
  kind: RenderKind;
  gravMul: number; // gravity scale (smoke is buoyant → negative)
  windMul: number; // how strongly wind pushes this particle sideways
  grow: number; // smoke swell rate over life (small = stays compact; big = billows out)
  op: number; // smoke peak opacity (crater fumes are near-opaque so their dense cohort reads solid)
  spr?: string; // optional sprite key for plume particles (else the default flare)
}

// Default smoke swell rate (muzzle exhaust / shot-trail column billow out strongly).
// Crater fumes override this with a small value so they stay compact and dense.
const SMOKE_GROW = 5.5;
// Default smoke peak opacity (thin, translucent exhaust/trail). Crater fumes override it higher so
// their tightly-packed cohort stacks into an opaque white crescent instead of faint scattered specks.
const SMOKE_OP = 0.5;

// Per-kind physics response: how gravity and wind act on each render kind.
// Light smoke rises and is shoved hard by wind; heavy sparks fall and ignore it.
const KIND_GRAV: Record<RenderKind, number> = {
  disc: 1,
  flare: 0.25,
  flash: 0,
  smoke: -0.12,
  plume: 0.15,
};
const KIND_WIND: Record<RenderKind, number> = {
  disc: 0.15,
  flare: 0.5,
  flash: 0,
  smoke: 1.1, // was 1.6 — the original's grey smoke rides wind at ×1; 1.6 shoved it unnaturally hard
  plume: 0.4,
};
// Blast radius (px) below which a detonation is drawn as a compact spark-puff rather
// than the full firework — machine gun (r8), shotgun (r4), gatling (r8). Shells and up
// (r≥~20) get the full sequence. See `blast`.
const SMALL_BLAST_R = 14;

// Muzzle spark burst (the original's `muzzleSmoke` emitter): a FIXED count of sparks, each with a
// random velocity spread of ±(muzzleSmoke·speed) on both axes — the field scales the SPREAD, not the
// count. `MUZZLE_SPARK_SPEED` maps the field value (usually 2) to a punchy px/s spread.
const MUZZLE_SPARKS = 30;
const MUZZLE_SPARK_SPEED = 45;

// Cap the hollow flare-burst ring count for a plain BURST-style blast (the original's ~r·0.5
// particles); this caps a wide conventional round (Cleaner r130 → 65) so the ring stays a readable
// shell rather than an over-dense band. A DENSE style (~r·2) uses 2× this cap; nukes stay uncapped.
// See `emitFlareBurst`, which selects the density from the weapon's explosion style (expType).
const FLARE_BURST_MAX = 54;

const rnd = () => Math.random();

/** Parse `#rrggbb` (falls back to a warm orange). */
function parseColor(s: string): RGB {
  return s.startsWith('#') && s.length === 7 ? hexToRgb(s) : {r: 255, g: 136, b: 0};
}

/** Nudge a colour toward white (0..1) — hot cores read brighter than the tint. */
function toward255(c: RGB, t: number): RGB {
  return mixToward(c, WHITE, t);
}

// An instantaneous beam flash: the weapon's ray sprite stretched from muzzle to impact,
// fading out. Falls back to a bright coloured line until the sprite loads.
interface Beam {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r: number;
  g: number;
  b: number;
  age: number;
  life: number;
  spr?: string; // beam colour-texture key — TILED end-to-end along the line
  width: number; // beam thickness (px), the weapon's `size`
}

// The main explosion fireball — the real `effects/explosion1.bmp` chromatic
// starburst, blitted additively and scaled up (an "animation" via growth) as it
// fades.
interface Explosion {
  x: number;
  y: number;
  age: number;
  life: number;
  size: number;
  sprite: string;
  shrink?: boolean; // true = flare-burst member: starts at `size` and SHRINKS to 0
  vx?: number; // slow outward drift
  vy?: number;
}

// A crater "vent": a fresh crater smokes off its disturbed dirt. After the flash fades it keeps
// venting fumes for a while — SUCCESSIVE GENERATIONS of white puffs rising off the dirt over a
// radius-scaled window (a big crater smokes longer), tapering out — not one instant cohort. Each
// vent is independent, so multi-bomb weapons (Black Rain) leave the whole strip smoking; a later
// blast in the area clears the fumes there (clearSmoke), so only settled smoke persists.
interface CraterVent {
  x: number;
  y: number;
  r: number;
  age: number;
  life: number; // VENT_DELAY + emission window (window ∝ radius, so big craters smoke longer)
  acc: number; // per-vent fractional-puff accumulator (independent, so vents don't fight over one)
}
// The vent stays silent this long so smoke emerges AS the explosion bloom fades, not during it.
const VENT_DELAY = 0.4;
// Emission window (how long the crater keeps generating fumes) = VENT_WIN_BASE + radius·VENT_WIN_R.
const VENT_WIN_BASE = 7.5;
const VENT_WIN_R = 0.02;
// Puffs emitted per second per unit radius, while venting (tapers to 0 over the window). HIGH so the
// many small puffs overlap into a TIGHT, dense cloud (the legacy look), not spaced distinct blobs.
const FUME_RATE = 3.2;
// Smoke swell for crater fumes — low so puffs stay small and pack tightly (vs SMOKE_GROW=5.5 exhaust).
const FUME_GROW = 2.0;
// Per-puff lifetime ∝ radius: FUME_LIFE_BASE + radius·[min,max]. Each generation rises and fades
// over this; new generations keep coming for the whole emission window.
const FUME_LIFE_BASE = 1.0;
const FUME_LIFE_MIN = 0.02;
const FUME_LIFE_MAX = 0.04;
// Crater smoke has mild buoyancy (vs the trail's -0.12) so each generation drifts gently UP off the
// dirt and fades — a steady rising stream — without ballooning to the top of the screen.
const FUME_GRAV = -0.05;

// Rocket-exhaust trail: each puff picks a random angle in the backward spread cone that sets BOTH
// its perpendicular DRIFT (which side of the tube it settles on) and its gui/rocket plume.bmp ROW
// (its colour). So the outer edge reads the light UPPER rows and the inner edge the dark LOWER rows
// — a coherent graded TUBE that emerges statistically (grounded: row = the emission-angle fraction).
const EXHAUST_PUFFS = 5; // small puffs per sub-step (dense — the trail is many overlapping puffs)
const EXHAUST_PERP = 16; // perpendicular drift speed (px/s) → puffs SPREAD apart as they age (tube widens toward the tail)
const EXHAUST_HALF = 1; // initial perpendicular half-offset (px) → puffs START close together at the nozzle

// Cull margin (px) — a puff whose CENTRE is this far outside the view is skipped in draw
// (big enough to cover a fully-swelled puff's radius so nothing pops at the edge).
const CULL_MARGIN = 140;

export class CParticleSystem {
  private m_particles: Particle[] = [];
  private m_beams: Beam[] = [];
  private m_explosions: Explosion[] = [];
  private m_craterVents: CraterVent[] = []; // fresh craters venting white fumes over time
  private m_groundAt: ((x: number) => number) | null = null; // surface height under x (for wind + vents)
  // Viewport (world-X of the view's left edge + view size), set each frame by the controller.
  // Enables off-screen culling and the half-resolution smoke layer; ≤0 width = disabled (tests).
  private m_viewCamX = 0;
  private m_viewW = 0;
  private m_viewH = 0;
  private m_smokeBuf: HTMLCanvasElement | null = null; // half-res offscreen for the smoke layer

  /** Per-frame view rectangle (world-X of the left edge + on-screen size). Drives off-screen culling
   *  and the half-res smoke buffer. Pass width 0 to disable both (headless tests draw everything). */
  setViewport(camX: number, viewW: number, viewH: number): void {
    this.m_viewCamX = camX;
    this.m_viewW = viewW;
    this.m_viewH = viewH;
  }

  /** Give the particle system the terrain surface fn — enables the wind altitude profile and stops
   *  the crater vents from spraying fumes into empty sky where there's no soil. */
  setGroundProvider(fn: (x: number) => number): void {
    this.m_groundAt = fn;
  }

  // Real sprites (looked up lazily each frame; falls back to procedural draws
  // until they finish loading). 'fx:smoke' = gui/smoke.bmp, 'fx:flare' = flares/04.bmp.
  private m_assets: ISpriteSource | null = null;
  private m_whiteSmoke: HTMLCanvasElement | null = null; // cool-white smoke (crater fumes)

  setAssets(a: ISpriteSource): void {
    this.m_assets = a;
    this.m_whiteSmoke = null;
    this.m_plumeImg = null;
  }

  /** gui/rocket plume.bmp as a raw 2-D pixel table (read once): X = age, Y = height. Exhaust puffs
   *  sample it at (age, height) for their colour. Null until the sprite/canvas is available. */
  private plumeImg(): ImageData | null {
    if (this.m_plumeImg) return this.m_plumeImg;
    if (typeof document === 'undefined') return null;
    const spr = this.m_assets?.getSprite('fx:plume');
    if (!spr) return null;
    const w = spr.width,
      h = spr.height;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d', {willReadFrequently: true})!;
    g.drawImage(spr.bitmap, 0, 0, w, h);
    this.m_plumeImg = g.getImageData(0, 0, w, h);
    return this.m_plumeImg;
  }

  /** Lazily build a bright, COOL-tinted copy of the smoke sprite for crater fumes — the grey
   *  `smoke.bmp` lifted toward a light blue-grey-white with `screen` (NOT a flat white fill), so its
   *  internal fluffy TEXTURE survives: highlights near-white, crevices a cool blue-grey. That shading
   *  is what makes the packed puffs read as distinct 3-D tufts rather than one flat white blob. */
  private whiteSmoke(): HTMLCanvasElement | null {
    if (this.m_whiteSmoke) return this.m_whiteSmoke;
    if (typeof document === 'undefined') return null; // headless (tests): no canvas to tint
    const spr = this.m_assets?.getSprite('fx:smoke');
    if (!spr) return null;
    const w = spr.width,
      h = spr.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    g.drawImage(spr.bitmap, 0, 0, w, h); // grey textured puff
    g.globalCompositeOperation = 'screen'; // lift toward cool-white, KEEPING the texture gradients
    g.fillStyle = 'rgb(150,162,190)'; // cool blue-grey — screen brightens grey toward this
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in'; // re-mask to the sprite's own alpha shape
    g.drawImage(spr.bitmap, 0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
    this.m_whiteSmoke = c;
    return this.m_whiteSmoke;
  }

  // Pre-baked soft radial glow. The old draw path allocated a fresh
  // createRadialGradient (+3 addColorStop) for EVERY flare/flash/plume/smoke
  // fallback, every frame — hundreds of allocations per blast frame. Instead we
  // bake one white glow sprite once, tint it per colour into a small cache, and
  // blit it with drawImage — the hot path then allocates nothing.
  private static readonly GLOW_SRC = 32; // master glow radius (px); scaled up per particle
  // The master glow's falloff mirrors the old flare/flash gradient exactly — solid core,
  // half-alpha midpoint, transparent rim — so blitting it under 'lighter' reproduces the look.
  // Tinting quantises to 4 bits/channel (see TintedSpriteCache): a preset's jittered tints
  // (e.g. an eOrange cluster) fold to a handful of buckets while distinct weapon colours stay
  // apart — invisible on a soft additive glow, and it keeps the count under the cache cap.
  private readonly m_glowCache = new TintedSpriteCache(CParticleSystem.GLOW_SRC, (g, R) => {
    const grad = g.createRadialGradient(R, R, 0, R, R, R);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.4)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, R * 2, R * 2);
  });

  /**
   * Blit the tinted glow centred at (x,y) with the given radius and alpha, under whatever
   * composite op the caller has set. When no baked canvas is available (headless tests) it
   * draws the equivalent radial gradient itself, so callers never branch on the fallback.
   */
  private blitGlow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
  ): void {
    const t = this.m_glowCache.tint(r, g, b);
    if (t) {
      const d = radius * 2;
      ctx.globalAlpha = alpha;
      ctx.drawImage(t, x - radius, y - radius, d, d);
      ctx.globalAlpha = 1;
      return;
    }
    // No baked glow canvas — approximate with the radial gradient the master encodes
    // (0 → mid 0.4 → transparent), the same 3-stop the flare/flash path used inline.
    const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0, `rgba(${r | 0},${g | 0},${b | 0},${alpha})`);
    grad.addColorStop(0.5, `rgba(${r | 0},${g | 0},${b | 0},${alpha * 0.4})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TWO_PI);
    ctx.fill();
  }

  // ---- Rocket-exhaust PUFF: a soft round disc (a "cotton ball"), coloured from the
  // gui/rocket plume.bmp hot→cool STRIP by particle age. This is the trail's real look —
  // distinct from the fuzzy crater cloud (gui/smoke.bmp) — so exhaust reads as overlapping
  // round puffs that widen with age into a thick, soft ribbon.
  private m_plumeImg: ImageData | null = null; // gui/rocket plume.bmp as a 2-D (age × height) table
  private static readonly PUFF_SRC = 32;
  // White master puff: a SOLID-ish core with a soft edge (a cotton ball), vs the glow's diffuse
  // falloff — a SOFT falloff (no hard core/edge) so overlapping puffs blur together into a smooth
  // fluffy cloud rather than crisp distinct circles. Same 4-bit tint cache as the glow.
  private readonly m_puffCache = new TintedSpriteCache(CParticleSystem.PUFF_SRC, (g, R) => {
    const grad = g.createRadialGradient(R, R, 0, R, R, R);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    grad.addColorStop(0.75, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, R * 2, R * 2);
  });

  // Downward acceleration (px/s^2). Sparks and debris arc and fall; flares and
  // the flash are short-lived enough that gravity barely moves them.
  private m_gravity = 240;

  // Clip bounds — particles outside are reaped. Grown generously past the
  // viewport so nothing pops at the edges.
  private m_minX = -200;
  private m_minY = -400;
  private m_maxX = 4000;
  private m_maxY = 3000;

  /** Keep the clip window in step with the render surface. */
  setBounds(width: number, height: number): void {
    this.m_minX = -200;
    this.m_minY = -400;
    this.m_maxX = width + 200;
    this.m_maxY = height + 200;
  }

  /** Wipe every live effect — called when a new battle/match generates fresh terrain, so smoke,
   *  fumes, debris and fireballs from the previous battle don't linger over the new map. */
  clear(): void {
    this.m_particles.length = 0;
    this.m_beams.length = 0;
    this.m_explosions.length = 0;
    this.m_craterVents.length = 0;
  }

  // ---------------------------------------------------------------- emitters

  private add(
    x: number,
    y: number,
    vx: number,
    vy: number,
    c: RGB,
    life: number,
    size: number,
    kind: RenderKind,
    spr?: string,
    grow: number = SMOKE_GROW,
    op: number = SMOKE_OP,
    gravMul: number = KIND_GRAV[kind],
  ): void {
    this.m_particles.push({
      x,
      y,
      vx,
      vy,
      r: c.r,
      g: c.g,
      b: c.b,
      age: 0,
      life,
      size,
      kind,
      gravMul,
      windMul: KIND_WIND[kind],
      grow,
      op,
      spr,
    });
  }

  /** Radial burst: `count` particles fanned across all angles, speed ∈ [smin,smax]. */
  private emitRadial(
    x: number,
    y: number,
    count: number,
    smin: number,
    smax: number,
    lmin: number,
    lmax: number,
    size: number,
    c: RGB,
    kind: RenderKind,
    upBias = 0,
  ): void {
    for (let i = 0; i < count; i++) {
      const a = rnd() * TWO_PI;
      const sp = between(smin, smax);
      this.add(
        x,
        y,
        Math.cos(a) * sp,
        Math.sin(a) * sp - upBias,
        c,
        between(lmin, lmax),
        size,
        kind,
      );
    }
  }

  /** Box burst: per-axis velocity ∈ [-speed, speed] (the classic spark spray). */
  private emitBox(
    x: number,
    y: number,
    count: number,
    speed: number,
    lmin: number,
    lmax: number,
    size: number,
    c: RGB,
    kind: RenderKind,
  ): void {
    for (let i = 0; i < count; i++) {
      this.add(
        x,
        y,
        between(-speed, speed),
        between(-speed, speed) - speed * 0.4,
        c,
        between(lmin, lmax),
        size,
        kind,
      );
    }
  }

  /** A row of rising fire streamers across ±half px of the impact column. */
  private emitFireLine(x: number, y: number, half: number, c: RGB): void {
    const step = Math.max(3, half / 5);
    const hot = toward255(c, 0.4);
    for (let fx = x - half; fx <= x + half; fx += step) {
      this.add(
        fx,
        y,
        between(-20, 20),
        between(-140, -60),
        hot,
        between(0.5, 1.0),
        between(2.5, 4),
        'flare',
      );
    }
  }

  /** Additive white-out bloom centred on the blast. */
  private spawnFlash(x: number, y: number, size: number, c: RGB, life: number): void {
    this.add(x, y, 0, 0, c, life, size, 'flash');
  }

  // ---------------------------------------------------------------- profiles

  /** The generic coloured fireball ring — `count` flares on a shared life/size/colour tail, their
   *  SPEED scaled by the blast radius (the original scales its flare speed ∝ blast magnitude).
   *  Shared by the dirt-deposit blast and the fiery non-preset blast so the magic tail can't drift.
   *
   *  The speeds used to be fixed px/s, which made the spray's REACH a constant while the crater
   *  scaled: 200 px/s over a 0.7 s life throws a spark 140 px, i.e. 1.5·r out of a 90-radius hole
   *  but 2.3·r out of a 60-radius one. That is the "offside sparks" a Plasma (r 60) flung into the
   *  sky while a Plasma Bomb (r 90) — same style, same sprite — looked contained. Scaling on r
   *  keeps the spray at ~0.3..1.5·r for every weapon; the factors are calibrated at r = 90 so the
   *  sizes that already read correctly are unchanged. */
  private emitFireballRing(x: number, y: number, r: number, count: number, c: RGB): void {
    const tail = toward255(c, 0.3);
    // Ember SIZE is a radius fed to the glow blit, which scales it by 1.7 — so the old `r·0.14 + 2`
    // drew each ember at 0.30·r, i.e. one "spark" nearly as wide as the crater itself, and 33 of
    // them read as floating orbs rather than a fireball. `r·0.045` puts a member at ~0.12·r.
    // SPEED tops out at r·1.4 so the furthest ember travels ≈ r over its 0.7 s life and the fireball
    // stays in the hole it fills; r·2.2 let the tail carry 1.5·r past the rim.
    const size = r * 0.045 + 1.5; // floor keeps a tiny blast's embers visible
    this.emitRadial(x, y, count, r * 0.5, r * 1.4, 0.35, 0.7, size, tail, 'flare');
  }

  /**
   * Weapon detonation, staged as a multi-phase explosion sequence:
   *   Stage 1 — a brief central fireball (the weapon's own `expBitmap` flare) + a
   *             hot flash; big/nuclear rounds also trigger the full-viewport
   *             white-out (a DOM overlay, driven from the controller — see `explode`).
   *   Stage 2 — the FIREWORK: the weapon's flare sprite scattered many times as
   *             blobs radiating outward (nuke = white puffs, ring-flares = rings),
   *             plus a circular ejecta ring for big blasts.
   *   Stage 3 — sparks, a fire line, and a lingering smoke column (+ the caller's
   *             dirt shower / radiation specks in CLand).
   * `presetName` (particles.json) drives the fireball's colour/density/speed/spread.
   */
  blast(
    x: number,
    y: number,
    radiusPx: number,
    color: string,
    nuclear = false,
    presetName?: string,
    expType: ExpType = EXP.PLAIN,
    expBitmap?: string,
    deposit = false,
    isCleaner = false,
  ): void {
    // `eLlightBlue` is a typo in the weapon data table for `eLightBlue`.
    const preset = presetName
      ? (PRESETS[presetName] ?? PRESETS[presetName.replace('Llight', 'Light')])
      : undefined;
    const c = preset ? {r: preset.colorr, g: preset.colorg, b: preset.colorb} : parseColor(color);
    // Floor low so a small round (machine gun r8, shotgun r4) stays a small puff —
    // the old floor of 12 forced every blast to grenade size, so bullets "exploded".
    const r = Math.max(4, radiusPx);
    // A blast disperses/consumes any smoke in its area — so a later close explosion wipes the
    // intermediate smoke (only the after-settle smoke remains), and a Cleaner that removes the dirt
    // also clears the fumes that were floating over it (no dirt left to smoke).
    this.clearSmoke(x, y, r);
    const big = isNukeExp(expType) || nuclear; // nuke style = the full-screen white-out
    // Small rounds — bullets/pellets/cannon-shells — get a compact pop, not the full
    // firework. The original scales its detonation FX by blast size and GATES the
    // fire streamers by a size threshold, so tiny rounds throw only debris + a spark
    // puff (no fireball storm, radial rings, fire line or ejecta ring).
    const small = !big && r < SMALL_BLAST_R;

    // Central fireball. A NUKE gets the bright generic chromatic starburst (`explosion1.bmp`); a
    // small round gets a quick pop of its own flare. A conventional blast gets NO bright central
    // bloom — its hollow flare-burst (below) forms the whole look and the CENTRE STAYS CLEAR, so
    // the crater/tank shows through (the original's burst is the weapon's own — often DIM — sprite,
    // never a synthesized white core).
    const flareSpr = expBitmap ? `fx:${expBitmap}` : 'fx:explosion';
    if (big) this.spawnExplosion(x, y, r * 2.2, 0.35, 'fx:explosion');
    else if (small) this.spawnExplosion(x, y, r * 1.1, 0.32, flareSpr);

    // The flare BURST — the weapon's own `expBitmap` scattered on a HOLLOW RING (an annulus: each
    // particle is born on radius r·[0.5..0.8], NEVER the centre, so the shell is hollow), drifting
    // slowly outward and shrinking to nothing. Blitted ADDITIVELY at the sprite's TRUE intensity, so
    // the per-weapon look emerges from the sprite alone: a dim sprite (Cleaner flares/02, peak ~55)
    // reads as translucent grey-blue smoke bubbles with a clear centre; a bright one (nuke flares/00,
    // peak ~229; bomb flares/07 orange) reads as a hot fireball ring. No white boost, no ×N stacking.
    if (!small) this.emitFlareBurst(x, y, r, flareSpr, expType, big);

    // A hot white-out flash is a NUKE thing ONLY — never a conventional or Cleaner blast.
    if (big) this.spawnFlash(x, y, r * 2.4, {r: 255, g: 255, b: 255}, 0.3);

    // Dirt/deposit weapons (Dirty Boy, Mountain, …) get the coloured FIREBALL + crater fumes (the
    // original's blast over the small crater they cut) but skip the heavy fire/ejecta of a fiery bomb.
    if (deposit) {
      if (preset) this.emitPreset(x, y, r, preset);
      else this.emitFireballRing(x, y, r, Math.round(r * 1.2) + 22, c);
      this.ventCrater(x, y, r);
      return;
    }

    // Compact spark puff for small rounds, then stop — no firework/rings/fire/ejecta.
    if (small) {
      this.emitBox(x, y, Math.round(r * 1.2) + 4, 20, 0.25, 0.6, 1.1, toward255(c, 0.2), 'disc');
      return;
    }

    // A CLEANER is an earth-remover, NOT a fiery blast: its whole look is the dim smoke-shell
    // (annulus above) + the grey ground fumes (below). No coloured fireball, no fire, no ejecta —
    // just a light ember spray that flies OUT (a slow/dense box would clump at the centre and
    // re-fill the hollow shell).
    if (isCleaner) {
      this.emitBox(x, y, 14, 150, 0.3, 0.7, 1.3, toward255(c, 0.2), 'disc');
    } else {
      // A fiery blast (bomb/rocket/nuke) also gets the coloured radial fireball (its preset colour or
      // generic rings) filling the shell; the ejecta ring + spark storm are BIG/nuke-only.
      if (preset) {
        this.emitPreset(x, y, r, preset);
      } else {
        const ring = Math.round(r * 1.2) + (nuclear ? 70 : 22);
        const n = big ? ring : Math.round(ring * 0.35);
        this.emitFireballRing(x, y, r, n, c);
        if (big) this.emitRadial(x, y, ring * 2, 25, 110, 0.5, 1.1, r * 0.11 + 2, c, 'flare');
      }
      if (big) {
        this.emitEjectaRing(x, y, r);
        this.emitBox(x, y, Math.round(r * 1.4) + 26, 190, 0.4, 1.1, 1.6, toward255(c, 0.2), 'disc');
      } else {
        // Spark spray, speed scaled by the crater for the same reason as emitFireballRing: a fixed
        // 90 px/s threw a small blast's sparks clear of its own hole. `r` reproduces the old reach
        // at r ≈ 90 and stays proportional below/above it.
        this.emitBox(x, y, Math.round(r * 0.7) + 16, r, 0.4, 1.0, 1.5, toward255(c, 0.2), 'disc');
      }
    }

    // WHITE fume curtain over the fresh crater FLOOR — for ANY crater-cutting blast (a fiery bomb OR
    // a Cleaner like Earth Destroy; the original gates it on fire-detail + blast size, NOT weapon
    // type). An immediate DENSE cohort lays down the packed white crescent lining the bowl, and the
    // The crater smoke emerges AFTER the flash (delayed vent), not during it. Skipped for tiny rounds
    // and pure deposits (deposits vent above).
    if (!small && !deposit) {
      this.ventCrater(x, y, r);
    }
  }

  /**
   * The flare BURST as a HOLLOW annulus (the original's ring burst), its DENSITY set by the weapon's
   * explosion STYLE (expType) — the original scatters `mag·0.5` flares for a plain BURST and `mag·2`
   * (4× denser) for a DENSE one, while a SINGLE style emits no ring at all (just the central puff):
   *   • SINGLE — central puff only, no ring (beams, rain, most bombs — the 51-weapon common case).
   *   • BURST  — ring of ~r·0.5 flares + puff (Bomb, Cleaner, Grave Digger).
   *   • DENSE  — ring of ~r·2 flares (4× BURST) + puff (Cluster, Digger, Plasma) → a packed shell.
   *   • NUKE / nuclear — the widest ring (~r·0.9) + puff; the full-screen white-out is fired by the
   *     caller. `big` (nuke-tier OR the `nuclear` flag) always takes this branch regardless of style.
   * Ring particles are born on radius `r·[0.5..0.8]` — never the centre — each starting at
   * `r·[0.167..0.333]` px and shrinking to nothing while drifting slowly outward, so the shell
   * EXPANDS and the centre stays clear. The central puff of the same sprite adds ~nothing for a dim
   * sprite (the centre reads through) and a hot core for a bright one. All additive at true intensity.
   */
  private emitFlareBurst(
    x: number,
    y: number,
    r: number,
    sprite: string,
    expType: ExpType,
    big: boolean,
  ): void {
    // PLAIN (style 0) emits no burst at all — but those are small kinetic rounds that never reach
    // here (the `small` gate handles them); guard anyway so a big-radius PLAIN weapon stays quiet.
    if (!big && expType === EXP.PLAIN) return;
    // Ring density by style. DENSE is 4× BURST (mag·2 vs mag·0.5) with a matching higher cap so the
    // packed shell can actually read; SINGLE emits no ring (count 0 → central puff only).
    let count: number;
    if (big) count = Math.round(r * 0.9);
    else if (expType === EXP.DENSE)
      count = Math.min(FLARE_BURST_MAX * 2, Math.max(6, Math.round(r * 2))); // prettier-ignore
    else if (expType === EXP.BURST)
      count = Math.min(FLARE_BURST_MAX, Math.max(3, Math.round(r * 0.5))); // prettier-ignore
    else count = 0; // SINGLE
    for (let i = 0; i < count; i++) {
      const ang = rnd() * TWO_PI;
      const off = between(r * 0.5, r * 0.8); // born on the ring, so the centre is empty
      const size = between(r * 0.167, r * 0.333);
      const life = between(0.5, 0.95);
      const spd = off * between(0.35, 0.6); // slow radial outward drift → the shell expands a little
      this.m_explosions.push({
        x: x + Math.cos(ang) * off,
        y: y + Math.sin(ang) * off,
        age: 0,
        life,
        size,
        sprite,
        shrink: true,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
      });
    }
    // One central puff (the burst's central member): large, shrinks, same sprite.
    this.m_explosions.push({x, y, age: 0, life: big ? 0.5 : 0.85, size: r * 1.4, sprite, shrink: true}); // prettier-ignore
  }

  /** Disperse SMOKE particles within `r` of a blast — later close explosions wipe intermediate
   *  smoke (only the after-settle smoke survives), and a Cleaner removing the dirt clears the fumes
   *  that were floating over it. Only 'smoke' is cleared — sparks/flares/fireball are untouched. */
  private clearSmoke(x: number, y: number, r: number): void {
    const reach = r * 1.15; // cover the visible blast area
    let w = 0;
    for (const p of this.m_particles) {
      if (p.kind === 'smoke' && Math.hypot(p.x - x, p.y - y) < reach) continue; // drop it
      this.m_particles[w++] = p;
    }
    this.m_particles.length = w;
  }

  /** Register a crater VENT. It stays silent for VENT_DELAY (smoke emerges AS the bloom fades),
   *  then releases its cohort over VENT_EMIT (so it builds up from the dirt). Each vent is
   *  independent — multi-bomb weapons leave every crater smoking. Fires for ANY crater (bomb or
   *  Cleaner), gated only on the Draw-Smoke toggle. */
  private ventCrater(x: number, y: number, r: number): void {
    if (!smokeEnabled()) return; // Graphics → Draw Smoke (+ Detail gating)
    // Only vent when the blast actually reaches the SOIL. An AIRBURST (Sky Bomb, Sky Cluster, …)
    // detonates high in mid-air and carves no crater — its blast sphere never touches the ground —
    // so it must NOT fume from the dirt far below. Skip if the sphere's bottom is above the surface.
    if (this.m_groundAt && y + r < this.m_groundAt(x)) return;
    const window = VENT_WIN_BASE + r * VENT_WIN_R; // how long this crater keeps smoking (∝ radius)
    this.m_craterVents.push({x, y, r, age: 0, life: VENT_DELAY + window, acc: 0});
  }

  /** One white smoke puff rising off the disturbed dirt across the crater width. Spawned at the
   *  REAL post-carve surface (so it comes from the earth), white, gently rising and fading — one of
   *  many successive generations the vent keeps producing while it smokes. */
  private spawnVentPuff(x: number, y: number, r: number): void {
    const dx = between(-r * 0.85, r * 0.85); // across the disturbed strip (stay off the far rim)
    const fx = x + dx + between(-3, 3);
    // The actual carved surface at this column = the dirt the smoke rises from (fallback: bowl arc).
    const surf = this.m_groundAt
      ? this.m_groundAt(fx)
      : y + Math.sqrt(Math.max(0, r * r - dx * dx)) * 0.7;
    // Fume only from SOIL. Where the ground has been eroded down to the world floor (surface at the
    // view height → no land left in this column), there's nothing to smoke — don't puff into the void.
    if (this.m_groundAt && this.m_viewH > 0 && surf >= this.m_viewH) return;
    const fy = surf - between(0, 4); // just at the dirt
    const v = 225 + Math.floor(rnd() * 28); // near-white 225..253
    const life = FUME_LIFE_BASE + r * between(FUME_LIFE_MIN, FUME_LIFE_MAX); // ∝ radius
    // Small, near-white puffs (0.6 opacity) — many of these, packed tightly by the high emission
    // rate, overlap into a dense fine-grained cloud (the legacy tight-puff look). Gentle rise + mild
    // buoyancy (FUME_GRAV) so each generation drifts up off the dirt and fades.
    this.add(fx, fy, between(-5, 5), -between(8, 18), {r: v, g: v, b: v}, life, between(3, 5), 'smoke', undefined, FUME_GROW, 0.6, FUME_GRAV); // prettier-ignore
  }

  /**
   * Stage-2 circular ejecta: a fast, near-uniform ring of dirt launched radially
   * outward so it reads as an expanding shockwave shell around the crater.
   */
  private emitEjectaRing(x: number, y: number, r: number): void {
    const n = Math.round(r * 4.5) + 50;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TWO_PI + between(-0.06, 0.06); // evenly around the circle
      const sp = between(320, 520); // narrow band → a clean, wide shell
      const g = 100 + Math.floor(rnd() * 110); // brighter, warmer dirt
      this.add(
        x,
        y,
        Math.cos(a) * sp,
        Math.sin(a) * sp * 0.55 - between(30, 120), // out and slightly up
        {r: g, g: Math.round(g * 0.55), b: g >> 3},
        between(0.45, 0.9),
        between(1, 1.8),
        'disc',
      );
    }
  }

  /**
   * Emit a fireball from a ParticleEffectTable preset: `density` → count (scaled
   * by blast radius), `minv/maxv` → speed, `minlife/maxlife` → life,
   * `minTheta/maxTheta` → launch angle span, `posVar`/`colorVar` → jitter.
   */
  private emitPreset(x: number, y: number, r: number, p: ParticlePreset): void {
    const count = Math.max(14, Math.min(360, Math.round(p.density * (r / 110))));
    const t0 = Math.min(p.minTheta, p.maxTheta),
      t1 = Math.max(p.minTheta, p.maxTheta);
    const size = r * 0.12 + 2;
    for (let i = 0; i < count; i++) {
      const theta = deg2rad(t0 + rnd() * (t1 - t0));
      const speed = (p.minv + rnd() * (p.maxv - p.minv)) * 14 + 20; // preset units → px/s
      const life = (p.minlife + rnd() * (p.maxlife - p.minlife)) * 0.16 + 0.25;
      const jc = (base: number) => Math.max(0, Math.min(255, base + (rnd() * 2 - 1) * p.colorVar));
      this.add(
        x + (rnd() * 2 - 1) * p.posVar,
        y + (rnd() * 2 - 1) * p.posVar,
        Math.cos(theta) * speed,
        -Math.sin(theta) * speed, // screen-Y down: -sin → 90° is up
        {r: jc(p.colorr), g: jc(p.colorg), b: jc(p.colorb)},
        life,
        size,
        'flare',
      );
    }
  }

  /** Tank/vehicle destruction — the fixed white-flare + spark + fire profile. */
  tankDeath(x: number, y: number): void {
    const white: RGB = {r: 255, g: 255, b: 255};
    const fire: RGB = {r: 255, g: 150, b: 40};
    this.spawnFlash(x, y, 90, white, 0.3);
    this.emitRadial(x, y, 40, 90, 240, 0.4, 0.8, 5, white, 'flare'); // ring 1 (speed 80, ~40)
    this.emitRadial(x, y, 80, 40, 140, 0.5, 1.0, 4, white, 'flare'); // ring 2 (speed 40, ~80)
    this.emitBox(x, y, 60, 200, 0.5, 1.2, 1.8, fire, 'disc'); // 60 sparks
    this.emitFireLine(x, y, 12, fire); // ±10px fire line
    this.emitSmokeColumn(x, y, 20, 16); // lingering smoke
  }

  /** In-flight trail — call each frame while a shot flies. A hot leading glow
   * plus a grey smoke puff that lingers and drifts downwind. */
  trail(
    x: number,
    y: number,
    _color: string,
    vx = 0,
    vy = 0,
    trailType = 1,
    trailLength = 0,
    dt = 0.016,
    motorBurning = true,
  ): void {
    if (trailType <= 0) return; // no trail (nukes / beams / diggers)
    const speed = Math.hypot(vx, vy);
    const rocket = trailType >= 2; // rocket/missile exhaust
    // Rocket exhaust smokes only while the motor is burning. The caller computes `motorBurning`
    // as max(MIN_BURN, time-to-apex): the authentic apex cutoff for arced shots, but with a
    // minimum burn so a downward/flat shot (which never ascends) still emits an initial plume
    // instead of nothing. Once the motor cuts out the rocket coasts silently. Ballistic shells
    // (else branch) have no motor gate — they trace the whole flight.
    if (rocket && !motorBurning) return;
    const lenScale = trailLength > 0 ? 0.6 + trailLength / 100 : 1; // trailLength 80 → 1.4
    // Fill the segment travelled this frame so the trail is CONTINUOUS, not blobs spaced one-per-
    // frame; rockets sub-step FINER so the exhaust reads as a dense, connected ribbon.
    const steps = Math.max(rocket ? 3 : 1, Math.ceil((speed * dt) / (rocket ? 1.5 : 3)));
    const nx = speed > 1e-3 ? vx / speed : 1;
    const ny = speed > 1e-3 ? vy / speed : 0;
    const eject = 0.1 * speed; // exhaust throw = 0.1 × |shot velocity|, BACKWARD (grounded)
    // Perpendicular unit pointing UP / OUTER (away from the arc's centre of curvature).
    let perpx = -ny,
      perpy = nx;
    if (perpy > 0) {
      perpx = -perpx;
      perpy = -perpy;
    }
    for (let s = 0; s < steps; s++) {
      const f = s / steps; // 0 = head, →1 = last-frame position
      const px = x - vx * dt * f,
        py = y - vy * dt * f;
      if (rocket) {
        // MANY small exhaust puffs per point. Each picks a random cone angle `a` (−1 = inner/down,
        // +1 = outer/up); it sets the puff's perpendicular DRIFT (→ its side of the tube) AND its
        // plume.bmp ROW (stored in `g`), so outer puffs read the light rows, inner the dark — a
        // coherent graded tube that self-organises instead of a random cloud. Colour comes from the
        // plume table at draw (by age × this row); r=150 marks it as exhaust.
        for (let n = 0; n < EXHAUST_PUFFS; n++) {
          const a = between(-1, 1);
          const rowFrac = (1 - a) / 2; // +1 (outer) → row 0 (light); −1 (inner) → row 1 (dark)
          const drift = a * EXHAUST_PERP;
          this.add(
            px + perpx * a * EXHAUST_HALF + between(-1, 1),
            py + perpy * a * EXHAUST_HALF + between(-1, 1),
            -nx * eject + perpx * drift,
            -ny * eject + perpy * drift,
            {r: 150, g: Math.round(rowFrac * 255), b: 150},
            between(0.9, 1.6) * lenScale,
            between(2.5, 4), // larger
            'smoke',
            undefined,
            2.2, // start small at the nozzle, grow larger toward the tail
            0.6, // lower peak opacity → overlapping soft puffs blend into a blurry cloud, not crisp discs
          );
        }
      } else if (s === 0) {
        // BALLISTIC (trailType 1: rail/artillery/shell/BOMB, trailLength 0) — the original lays NO
        // exhaust/smoke here, just a faint white spark. ONE small, SHORT, NON-additive white dot per
        // frame dropped in place (NOT the per-step ribbon rockets get — additive plumes stacked into a
        // bright exhaust streak on a fast-falling Black Rain sub-bomb). So a Bomb barely sparkles.
        const v = 226 + Math.floor(rnd() * 26); // near-white 226..252
        this.add(px, py, 0, 0, {r: v, g: v, b: v}, between(0.05, 0.11), between(1, 1.5), 'disc'); // prettier-ignore
      }
    }
  }

  /** Tracer ranging round — a thin WHITE ARC. One small stationary white puff per
   *  frame planted on the flight path (velocity 0, so each hangs and fades exactly
   *  where the round passed), the segment filled so it's a continuous line, not
   *  spaced blobs. No exhaust, no smoke, no fire — the line of white puffs IS the
   *  tracer streak, and because a tracer emits on the way up AND down it traces the
   *  whole arc. */
  tracerTrail(x: number, y: number, vx = 0, vy = 0, dt = 0.016): void {
    const speed = Math.hypot(vx, vy);
    const steps = Math.max(1, Math.ceil((speed * dt) / 3));
    for (let s = 0; s < steps; s++) {
      const f = s / steps;
      this.add(x - vx * dt * f, y - vy * dt * f, 0, 0, {r: 255, g: 255, b: 255}, 1.5, 2.5, 'disc');
    }
  }

  /** A glowing flare riding on the projectile (rocket `flareType`/`flareBmp`). */
  inflightFlare(x: number, y: number, sprite: string, size: number): void {
    this.add(x, y, 0, 0, {r: 255, g: 255, b: 255}, 0.14, Math.max(4, size), 'plume', sprite);
  }

  /**
   * Muzzle FLASH — the bright burst at the barrel the instant a round leaves. The original
   * emits, FIRST, a single bright white `flares/04` star that hangs at the muzzle (velocity 0)
   * and shrinks/fades in place — that fading star is the whole "flash → dissipate" read — plus
   * a spark burst thrown along the barrel. There is NO grey smoke at the barrel; smoke (our
   * interpretation) is ramped in AFTERWARDS by the caller, so the effect always reads flash-first.
   */
  muzzleFlash(x: number, y: number, dx: number, dy: number, flash: number, color: string): void {
    if (flash <= 0) return;
    const sp = Math.hypot(dx, dy);
    const dir = sp > 1e-3 ? {x: dx / sp, y: dy / sp} : {x: 1, y: 0};
    const c = toward255(parseColor(color), 0.7); // hot, near-white at the core
    // The bright star at the muzzle tip: additive flares/04, hangs (vel 0), punchy short fade.
    this.add(
      x + dir.x * 3,
      y + dir.y * 3,
      0,
      0,
      {r: 255, g: 240, b: 205},
      0.3,
      4 + Math.min(6, flash * 3),
      'plume',
      'fx:flare',
    );
    // A tight forward spark burst along the barrel heading (warm embers).
    const sparks = 14 + Math.round(flash * 6);
    for (let i = 0; i < sparks; i++) {
      const s = between(70, 260);
      const a = between(-0.5, 0.5); // rad spread around the heading
      const bx = dir.x * Math.cos(a) - dir.y * Math.sin(a);
      const by = dir.x * Math.sin(a) + dir.y * Math.cos(a);
      this.add(
        x,
        y,
        bx * s,
        by * s - between(0, 18),
        c,
        between(0.12, 0.3),
        between(1, 2.4),
        'disc',
      );
    }
  }

  /**
   * Muzzle SPARK burst — the original's `muzzleSmoke` emitter: a FIXED ~30-particle burst at the
   * barrel, each spark thrown with a random velocity spread of ±(muzzleSmoke·speed) on BOTH axes
   * (the field scales the SPREAD, not the count), in randomized WARM colours. Additive and
   * short-lived, so it reads as a hot muzzle spray. (Was a grey smoke puff — an interpretation;
   * this matches the original emitter.) The caller schedules it a beat AFTER `muzzleFlash`.
   */
  muzzleSmoke(x: number, y: number, _dx: number, _dy: number, smoke: number, color: string): void {
    if (smoke <= 0) return;
    const spread = smoke * MUZZLE_SPARK_SPEED; // ± velocity on each axis, scaled by the field
    const tint = parseColor(color);
    for (let i = 0; i < MUZZLE_SPARKS; i++) {
      // Warm ember: a hot yellow-white core grading toward the weapon's colour, randomized per spark.
      const t = between(0, 1);
      const c = {
        r: 255,
        g: Math.round(230 + (tint.g - 230) * t),
        b: Math.round(90 + (tint.b - 90) * t),
      };
      this.add(
        x,
        y,
        between(-spread, spread),
        between(-spread, spread),
        c,
        between(0.15, 0.4),
        between(1, 2.6),
        'flare',
      );
    }
  }

  /** A slow column of grey smoke rising from a blast site (lingers after the flash). */
  private emitSmokeColumn(x: number, y: number, count: number, scale: number): void {
    if (!smokeEnabled()) return; // Graphics → Draw Smoke (+ Detail gating) (lingering ground plumes)
    for (let i = 0; i < count; i++) {
      const g = 90 + between(-25, 45);
      this.add(
        x + between(-scale, scale),
        y + between(-scale * 0.4, scale * 0.2),
        between(-14, 14),
        between(-40, -12),
        {r: g, g, b: g},
        between(0.9, 1.9),
        between(3, 6) * (0.6 + scale / 40),
        'smoke',
      );
    }
  }

  /** Generic burst (used by mines and any caller without a weapon tint). */
  explode(x: number, y: number, scale = 1): void {
    this.blast(x, y, 26 * scale, '#ff8c22', false);
  }

  /** A beam from muzzle to impact. `spr` is the weapon's colour texture; `width` its
   *  drawn thickness (the weapon `size`); `life` how long it stays on screen — set this
   *  to the collapse delay so the ray VANISHES the instant the earth falls. */
  beam(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
    spr?: string,
    width = 8,
    life = 0.5,
  ): void {
    const c = parseColor(color);
    this.m_beams.push({x0, y0, x1, y1, r: c.r, g: c.g, b: c.b, age: 0, life, spr, width});
  }

  /** Spawn the expanding fireball sprite (the weapon's own `expBitmap` flare). */
  private spawnExplosion(x: number, y: number, size: number, life: number, sprite: string): void {
    this.m_explosions.push({x, y, age: 0, life, size, sprite});
  }

  // ------------------------------------------------------------------ update

  /**
   * Integrate one step. `wind` (the game's ±5 drift vector) is applied as a horizontal acceleration
   * scaled per particle — smoke gets shoved, sparks barely move. `groundAt(x)` (optional) supplies the
   * surface height so the shared boundary-layer factor (core/wind.ts `boundaryFactor`) can attenuate
   * drift near the ground: low fumes hug the crater, high smoke streams. This easing is applied to
   * smoke UNCONDITIONALLY (NOT gated by the Wind Model setting) — otherwise a puff would gain full
   * wind the instant it left the soil. When `groundAt` is omitted (tests) the drift is uniform.
   */
  update(dt: number, wind?: Vec2): void {
    if (dt <= 0) return;
    const windAx = wind ? wind.x * 26 : 0; // ±5 wind → up to ±130 px/s^2 on light smoke
    const windAy = wind ? wind.y * 26 : 0;
    const groundAt = this.m_groundAt;

    let w = 0;
    for (let i = 0; i < this.m_particles.length; i++) {
      const p = this.m_particles[i];

      // Altitude factor: the boundary-layer ramp (0 at ground → 1 aloft) is applied to smoke
      // UNCONDITIONALLY — independent of the Wind Model setting — so low crater fumes never gain
      // full wind right off the soil (they'd rocket sideways). Uniform when no ground provider (tests).
      const alt = groundAt ? boundaryFactor(groundAt(p.x) - p.y) : 1;
      p.vx += windAx * p.windMul * alt * dt;
      p.vy += (this.m_gravity * p.gravMul + windAy * p.windMul * alt) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.age += dt;

      const dead =
        p.age >= p.life ||
        p.x < this.m_minX ||
        p.y < this.m_minY ||
        p.x >= this.m_maxX ||
        p.y >= this.m_maxY;

      if (!dead) this.m_particles[w++] = p; // compact live particles forward
    }
    this.m_particles.length = w;

    let bw = 0;
    for (let i = 0; i < this.m_beams.length; i++) {
      const b = this.m_beams[i];
      b.age += dt;
      if (b.age < b.life) this.m_beams[bw++] = b;
    }
    this.m_beams.length = bw;

    let ew = 0;
    for (let i = 0; i < this.m_explosions.length; i++) {
      const e = this.m_explosions[i];
      e.age += dt;
      if (e.vx) e.x += e.vx * dt;
      if (e.vy) e.y += e.vy * dt;
      if (e.age < e.life) this.m_explosions[ew++] = e;
    }
    this.m_explosions.length = ew;

    // Crater vents: after VENT_DELAY (the flash has faded), keep venting fumes for the whole window
    // — successive generations of rising puffs at a rate ∝ radius that TAPERS to 0 as the vent ages,
    // so the crater smokes for a while then peters out. Each puff lives ∝ radius (spawnVentPuff) and
    // dies independently, so the fumes linger past the vent. Per-vent accumulator → independent craters.
    let vw = 0;
    for (let i = 0; i < this.m_craterVents.length; i++) {
      const v = this.m_craterVents[i];
      v.age += dt;
      if (v.age >= v.life) continue; // vent spent → drop (its puffs live on independently)
      if (v.age >= VENT_DELAY) {
        const env = 1 - (v.age - VENT_DELAY) / (v.life - VENT_DELAY); // 1 → 0 across the window
        v.acc += v.r * FUME_RATE * env * dt;
        while (v.acc >= 1) {
          v.acc -= 1;
          this.spawnVentPuff(v.x, v.y, v.r);
        }
      }
      this.m_craterVents[vw++] = v;
    }
    this.m_craterVents.length = vw;
  }

  // -------------------------------------------------------------------- draw

  /** Render all particles. Additive kinds are batched to set the blend once. */
  private drawSmokeLayer(ctx: CanvasRenderingContext2D, cullMin: number, cullMax: number): void {
    if (this.m_viewW > 0 && this.m_viewH > 0 && typeof document !== 'undefined') {
      const bw = Math.max(1, Math.ceil(this.m_viewW / 2));
      const bh = Math.max(1, Math.ceil(this.m_viewH / 2));
      if (!this.m_smokeBuf) this.m_smokeBuf = document.createElement('canvas');
      if (this.m_smokeBuf.width !== bw || this.m_smokeBuf.height !== bh) {
        this.m_smokeBuf.width = bw;
        this.m_smokeBuf.height = bh;
      }
      const bctx = this.m_smokeBuf.getContext('2d');
      if (bctx) {
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.clearRect(0, 0, bw, bh);
        bctx.setTransform(0.5, 0, 0, 0.5, -this.m_viewCamX * 0.5, 0); // world → half-res VIEW space
        this.drawSmoke(bctx, cullMin, cullMax);
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        // Blit at world x = camX (→ the view's left edge in the camera-translated ctx), upscaled 2×.
        ctx.drawImage(this.m_smokeBuf, this.m_viewCamX, 0, this.m_viewW, this.m_viewH);
        return;
      }
    }
    this.drawSmoke(ctx, cullMin, cullMax);
  }

  /** Draw every 'smoke' puff to `g` (the main ctx or the half-res buffer). Grey (r<200) = rocket
   *  exhaust (gui/rocket plume.bmp colour table); white (r≥200) = crater fumes (soft white sprite). */
  private drawSmoke(g: CanvasRenderingContext2D, cullMin: number, cullMax: number): void {
    const smokeSpr = this.m_assets?.getSprite('fx:smoke') ?? null;
    for (const p of this.m_particles) {
      if (p.kind !== 'smoke') continue;
      if (p.x < cullMin || p.x > cullMax) continue;
      const t = p.age / p.life;
      if (t >= 1) continue;
      const alpha = Math.sin(Math.min(1, t) * Math.PI) * p.op; // per-particle peak opacity
      if (alpha <= 0.01) continue;
      const d = p.size * (0.9 + t * p.grow) * 2; // small at birth → grows over life
      if (p.r < 200) {
        // Grey = ROCKET EXHAUST: colour from the gui/rocket plume.bmp TABLE (X=age, Y=row via `g`).
        const img = this.plumeImg();
        let cr = 210,
          cg = 216,
          cb = 226;
        if (img) {
          const cx = Math.min(img.width - 1, (Math.min(1, t) * img.width) | 0);
          const cy = Math.min(img.height - 1, ((p.g / 255) * img.height) | 0);
          const i = (cy * img.width + cx) * 4;
          cr = img.data[i];
          cg = img.data[i + 1];
          cb = img.data[i + 2];
        }
        // Billow to ~3.4× by t=0.72 then shrink+dissolve.
        const gs = t < 0.72 ? 0.5 + 2.9 * (t / 0.72) : 3.4 * (1 - (t - 0.72) / 0.28);
        const de = p.size * gs * 2;
        const ea = Math.min(1, t / 0.1) * (t > 0.72 ? (1 - t) / 0.28 : 1) * p.op;
        const puff = this.m_puffCache.tint(cr, cg, cb);
        if (puff) {
          g.globalAlpha = ea;
          g.drawImage(puff, p.x - de / 2, p.y - de / 2, de, de);
          g.globalAlpha = 1;
        } else {
          this.blitGlow(g, p.x, p.y, de / 2, cr, cg, cb, ea);
        }
      } else if (smokeSpr) {
        // White = CRATER FUMES: the soft white sprite.
        g.globalAlpha = alpha;
        g.drawImage(this.whiteSmoke() ?? smokeSpr.bitmap, p.x - d / 2, p.y - d / 2, d, d);
        g.globalAlpha = 1;
      } else {
        this.blitGlow(g, p.x, p.y, d / 2, p.r, p.g, p.b, alpha);
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const ps = this.m_particles;
    const flareSpr = this.m_assets?.getSprite('fx:flare') ?? null; // flares/04.bmp

    // Cull range (world X): skip particles whose centre is outside the view. Disabled (viewW≤0) in
    // headless tests → everything draws.
    const cull = this.m_viewW > 0;
    const cullMin = cull ? this.m_viewCamX - CULL_MARGIN : -Infinity;
    const cullMax = cull ? this.m_viewCamX + this.m_viewW + CULL_MARGIN : Infinity;

    // Pass 1a: crisp sparks/debris (normal blend, full-res).
    for (const p of ps) {
      if (p.kind !== 'disc') continue;
      if (p.x < cullMin || p.x > cullMax) continue;
      const t = p.age / p.life;
      if (t >= 1) continue;
      const a = 1 - t;
      ctx.fillStyle = `rgba(${p.r | 0},${p.g | 0},${p.b | 0},${a})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.6, p.size * (0.5 + a * 0.5)), 0, TWO_PI);
      ctx.fill();
    }

    // Pass 1b: smoke — rendered to a HALF-RES offscreen then upscaled (smoke is soft, so the ½-res
    // is invisible but the alpha fill drops ~4×). Direct full-res when no viewport is set (tests).
    this.drawSmokeLayer(ctx, cullMin, cullMax);

    // Pass 2: additive — explosion fireball, trail plumes, glows, flashes.
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';

    // The expanding fireball — each weapon's own explosion flare (expBitmap),
    // grows and fades as the main body of the blast under everything else.
    for (const e of this.m_explosions) {
      const t = e.age / e.life;
      if (t >= 1) continue;
      // Flare-burst members START big and SHRINK to nothing (the original's contracting
      // white flash); the central bloom GROWS. Both additive, so overlapping shrink flares
      // stack into a bright core that collapses inward.
      const d = e.shrink ? e.size * (1 - t) : e.size * (0.7 + t * 1.8) * 2;
      const a = e.shrink ? (1 - t) * 0.9 : (1 - t) * (t < 0.15 ? t / 0.15 : 1);
      const spr =
        this.m_assets?.getSprite(e.sprite) ?? this.m_assets?.getSprite('fx:explosion') ?? null;
      if (spr) {
        ctx.globalAlpha = a;
        ctx.drawImage(spr.bitmap, e.x - d / 2, e.y - d / 2, d, d);
        ctx.globalAlpha = 1;
      } else {
        this.blitGlow(ctx, e.x, e.y, d / 2, 255, 220, 150, a);
      }
    }

    // Plume embers: an additive sprite blitted along the trail — the weapon's
    // own sprite (rocket plume / in-flight flare) or the default flares/04 star.
    for (const p of ps) {
      if (p.kind !== 'plume') continue;
      if (p.x < cullMin || p.x > cullMax) continue;
      const t = p.age / p.life;
      if (t >= 1) continue;
      const a = (1 - t) * 0.9;
      const d = p.size * (2.6 - t * 1.2) * 3;
      const pspr = p.spr ? (this.m_assets?.getSprite(p.spr) ?? flareSpr) : flareSpr;
      if (pspr) {
        ctx.globalAlpha = a;
        ctx.drawImage(pspr.bitmap, p.x - d / 2, p.y - d / 2, d, d);
        ctx.globalAlpha = 1;
      } else {
        this.blitGlow(ctx, p.x, p.y, d / 2, p.r, p.g, p.b, a);
      }
    }

    for (const p of ps) {
      if (p.kind !== 'flare' && p.kind !== 'flash') continue;
      if (p.x < cullMin || p.x > cullMax) continue;
      const t = p.age / p.life;
      if (t >= 1) continue;

      const glow =
        p.kind === 'flash'
          ? p.size * (1 + t * 1.2) // flash expands as it fades
          : p.size * (1.7 - t * 0.9); // flare shrinks
      const alpha =
        p.kind === 'flash'
          ? (1 - t) * (1 - t) * 0.9 // quick, punchy falloff
          : (1 - t) * 0.5; // softer, so overlapping flares keep their hue
      if (glow <= 0 || alpha <= 0) continue;

      // Blit the pre-baked glow (its baked 0.4 midpoint matches the old 3-stop
      // gradient); fall back to the gradient only where no canvas exists (tests).
      this.blitGlow(ctx, p.x, p.y, glow, p.r, p.g, p.b, alpha);
    }

    this.drawBeams(ctx);
    ctx.globalCompositeOperation = prev;
  }

  /**
   * Beam flashes — a soft coloured halo line under a thin white-hot core. The bolt SHOOTS OUT
   * from the muzzle: the tip races to the target over the first ~35% of the life, then the full
   * line holds and fades (a fired beam, not an instant pop). A bright head rides the advancing
   * tip while it's extending.
   */
  private drawBeams(ctx: CanvasRenderingContext2D): void {
    for (const b of this.m_beams) {
      const t = b.age / b.life;
      if (t >= 1) continue;
      // Hold at full strength almost the whole life, then vanish over the last ~15%.
      // The beam's life is set to the collapse delay, so the ray disappears at the
      // SAME instant the earth falls (not a fade, then a gap, then the collapse).
      const a = t < 0.85 ? 1 : 1 - (t - 0.85) / 0.15;
      const grow = Math.min(1, t / 0.12); // 0→1 as the tip advances
      const ex = b.x0 + (b.x1 - b.x0) * grow,
        ey = b.y0 + (b.y1 - b.y0) * grow;
      const ang = Math.atan2(ey - b.y0, ex - b.x0);
      const len = Math.hypot(ex - b.x0, ey - b.y0);
      const spr = b.spr ? this.m_assets?.getSprite(b.spr) : null;
      if (spr) {
        // The weapon's colour texture TILED along the bolt — pasted end-to-end at its
        // native aspect (thickness = `width`), NOT stretched to the full length. A
        // patterned beam (wave, grate) therefore shows a repeating train of its motif
        // instead of one smeared streak. Drawn additively → glowing energy in the
        // sprite's colour. Each blit steps one tile-length (sprite width × fit-scale).
        const nw = spr.width,
          nh = spr.height;
        const scale = b.width / nh; // fit the sprite's height to the beam thickness
        const tileW = Math.max(2, nw * scale); // one tile's length along the beam
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(b.x0, b.y0);
        ctx.rotate(ang);
        ctx.imageSmoothingEnabled = false; // crisp tiles, no seam bleed
        // Snap each tile's dest edges to whole pixels so consecutive tiles ABUT on the
        // same column (tile N ends exactly where N+1 begins). At a fractional boundary the
        // rasteriser hard-cuts each tile independently (smoothing off) and can skip the
        // straddling column, opening a thin gap — and under 'lighter' that gap shows as a
        // dark sky line THROUGH the beam. Rounding both edges closes it with no overlap
        // (an overlap would instead double-add into a bright seam).
        for (let d = 0; d < len; d += tileW) {
          const end = Math.min(d + tileW, len); // far edge (clip the final partial tile)
          const x0 = Math.round(d),
            x1 = Math.round(end);
          const w = x1 - x0;
          if (w <= 0) continue;
          const srcW = ((end - d) / tileW) * nw; // sprite fraction shown (full tile → nw)
          ctx.drawImage(spr.bitmap, 0, 0, srcW, nh, x0, -b.width / 2, w, b.width);
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      } else {
        // Fallback coloured halo until the sprite loads.
        ctx.lineCap = 'round';
        ctx.strokeStyle = `rgba(${b.r | 0},${b.g | 0},${b.b | 0},${a * 0.6})`;
        ctx.lineWidth = 8 * a + 2;
        ctx.beginPath();
        ctx.moveTo(b.x0, b.y0);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }
      // Thin white-hot core down the middle. Kept FAINT over a textured beam so the
      // tiled motif (wave/grate) reads through it; full strength on the fallback line.
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(255,255,255,${a * (spr ? 0.18 : 1)})`;
      ctx.lineWidth = Math.max(1, b.width * (spr ? 0.06 : 0.12)) * a + 1;
      ctx.beginPath();
      ctx.moveTo(b.x0, b.y0);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      // Bright muzzle-flash head at the advancing tip while extending.
      if (grow < 1) {
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.beginPath();
        ctx.arc(ex, ey, Math.max(4, b.width * 0.4) * a + 2, 0, TWO_PI);
        ctx.fill();
      }
    }
  }

  hasActiveExplosions(): boolean {
    return this.m_particles.length > 0 || this.m_beams.length > 0 || this.m_explosions.length > 0;
  }

  /**
   * Whether the EXPLOSION itself is still playing — the fireball/flare burst (`m_explosions`), a
   * beam sweep, or its fire/spark particles. Unlike `hasActiveExplosions`, this deliberately IGNORES
   * the lingering grey `smoke`/`plume` puffs: those are a port embellishment (the original blasts
   * emit only flares + fire streamers, no drifting smoke), so their multi-second fade must NOT hold
   * the turn open. Gates turn hand-off; the render gate still uses `hasActiveExplosions` so the smoke
   * keeps drawing (and drifting) into the next player's aim phase.
   */
  hasActiveBlast(): boolean {
    if (this.m_explosions.length > 0 || this.m_beams.length > 0) return true;
    for (const p of this.m_particles) if (p.kind !== 'smoke' && p.kind !== 'plume') return true;
    return false;
  }

  /** Live particle count (diagnostics / tests). */
  count(): number {
    return this.m_particles.length;
  }
}
