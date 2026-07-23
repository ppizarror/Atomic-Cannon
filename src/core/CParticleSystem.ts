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
import particlesRaw from '../data/particles.json';
import {smokeEnabled} from './CGameConfig';
import {between} from '../math/random';
import {hexToRgb, mixToward, WHITE, type RGB} from '../math/color';
import {TWO_PI, deg2rad} from '../math/num';
import {EXP, type ExpType, isNukeExp} from './weapons/ExpType';

// Per-weapon explosion presets from weapons.txt's ParticleEffectTable: each
// weapon's `blast`/`trail` names one of these (colour, count, speed, life,
// spread), giving each weapon its own explosion — e.g. a nuke's giant yellow
// `eYellowPC` burst vs a small `eWhite` puff.
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
// Wind boundary-layer profile thickness (px). INTERP (the binary applies wind UNIFORMLY at every
// height): wind drift ramps from ~0 AT the ground to full at this many px above it, so low-lying
// crater fumes barely drift while high smoke streams — matching an air velocity profile.
const WIND_PROFILE_H = 260;

// Blast radius (px) below which a detonation is drawn as a compact spark-puff rather
// than the full firework — machine gun (r8), shotgun (r4), gatling (r8). Shells and up
// (r≥~20) get the full sequence. See `blast`.
const SMALL_BLAST_R = 14;

// Cap the hollow flare-burst ring count for NON-nuke blasts. The original uses ~r·0.5 particles;
// this caps a wide conventional round (Cleaner r130 → 65) so the ring stays a readable shell rather
// than an over-dense band. Nukes stay uncapped. See `emitFlareBurst`.
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

// A crater "vent": a fresh crater smokes off its disturbed dirt. The original emits ONE cohort at
// detonation — a white streamer every ~6 px across the changed-column strip, each with a lifetime
// PROPORTIONAL TO BLAST RADIUS (so big craters smoke much longer), and never clears prior smoke.
// We match that: no instant cohort during the flash; instead the vent releases its cohort over a
// short window AFTER the bloom fades (so the smoke emerges from the settled dirt and BUILDS UP),
// each puff living ∝ radius so it lingers, and every crater's vent is independent so multi-bomb
// weapons (Black Rain) leave the whole strip smoking — later blasts never wipe earlier smoke.
interface CraterVent {
  x: number;
  y: number;
  r: number;
  age: number;
  life: number;
  acc: number; // per-vent fractional-puff accumulator (independent, so vents don't fight over one)
}
// The vent stays silent this long so smoke emerges AS the explosion bloom fades, not during it.
const VENT_DELAY = 0.45;
// The crater releases its whole smoke cohort over this window (staggered → it visibly builds up
// from the dirt rather than popping in all at once).
const VENT_EMIT = 0.7;
// One streamer per this many px of crater width (the original's ~6 px cadence).
const FUME_STEP = 6;
// Smoke swell for crater fumes (compact vs SMOKE_GROW=5.5 for exhaust/trail).
const FUME_GROW = 2.6;
// Crater-smoke lifetime ∝ radius: life = FUME_LIFE_BASE + radius·[min,max]. Big blasts linger far
// longer than small ones (the grounded behaviour), instead of a flat ~1.5 s that vanishes too fast.
const FUME_LIFE_BASE = 1.2;
const FUME_LIFE_MIN = 0.03;
const FUME_LIFE_MAX = 0.065;
// Crater smoke is nearly buoyancy-neutral (vs the trail's -0.12) so it HANGS over the crater and
// fades in place, instead of ballooning up into the sky as a detached cluster.
const FUME_GRAV = -0.02;

export class CParticleSystem {
  private m_particles: Particle[] = [];
  private m_beams: Beam[] = [];
  private m_explosions: Explosion[] = [];
  private m_craterVents: CraterVent[] = []; // fresh craters venting white fumes over time
  private m_groundAt: ((x: number) => number) | null = null; // surface height under x (for wind + vents)

  /** Give the particle system the terrain surface fn — enables the wind altitude profile and stops
   *  the crater vents from spraying fumes into empty sky where there's no soil. */
  setGroundProvider(fn: (x: number) => number): void {
    this.m_groundAt = fn;
  }

  // Real sprites (looked up lazily each frame; falls back to procedural draws
  // until they finish loading). 'fx:smoke' = gui/smoke.bmp, 'fx:flare' = flares/04.bmp.
  private m_assets: ISpriteSource | null = null;
  private m_warmSmoke: HTMLCanvasElement | null = null; // fire-tinted smoke (young trail puffs)
  private m_whiteSmoke: HTMLCanvasElement | null = null; // white-tinted smoke (crater fumes)

  setAssets(a: ISpriteSource): void {
    this.m_assets = a;
    this.m_warmSmoke = null;
    this.m_whiteSmoke = null;
  }

  /** Lazily build a WHITE copy of the smoke sprite (its own alpha shape recoloured to white).
   *  Crater fumes draw this instead of the grey `smoke.bmp` so their packed cohort stacks into a
   *  bright white crescent — the grey sprite is kept for exhaust/trail smoke. Null until it loads. */
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
    g.drawImage(spr.bitmap, 0, 0, w, h);
    g.globalCompositeOperation = 'source-in'; // recolour to white, keep the puff's soft alpha shape
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
    this.m_whiteSmoke = c;
    return this.m_whiteSmoke;
  }

  /** Lazily build a warm-tinted copy of the smoke sprite (keeps its texture+alpha).
   *  Blitted additively over young trail smoke so fresh puffs near the exhaust glow
   *  like fire, cooling to plain grey as they age. Null until the sprite exists. */
  private warmSmoke(): HTMLCanvasElement | null {
    if (this.m_warmSmoke) return this.m_warmSmoke;
    if (typeof document === 'undefined') return null; // headless (tests): no canvas to tint
    const spr = this.m_assets?.getSprite('fx:smoke');
    if (!spr) return null;
    const w = spr.width,
      h = spr.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    g.drawImage(spr.bitmap, 0, 0, w, h);
    g.globalCompositeOperation = 'multiply'; // fire-orange tint, keep the puff texture
    g.fillStyle = 'rgb(255,140,55)';
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in'; // re-mask to the smoke's own alpha
    g.drawImage(spr.bitmap, 0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
    this.m_warmSmoke = c;
    return this.m_warmSmoke;
  }

  // Pre-baked soft radial glow. The old draw path allocated a fresh
  // createRadialGradient (+3 addColorStop) for EVERY flare/flash/plume/smoke
  // fallback, every frame — hundreds of allocations per blast frame. Instead we
  // bake one white glow sprite once, tint it per colour into a small cache, and
  // blit it with drawImage — the hot path then allocates nothing.
  private m_glow: HTMLCanvasElement | null = null;
  private m_glowNA = false; // no DOM (unit tests) → callers fall back to a gradient
  private m_tints = new Map<number, HTMLCanvasElement>(); // quantised colour → tinted glow
  private static readonly GLOW_SRC = 32; // master glow radius (px); scaled up per particle

  /**
   * The white master glow (built once). Its falloff mirrors the old flare/flash
   * gradient exactly — solid core, half-alpha midpoint, transparent rim — so
   * blitting it under 'lighter' reproduces the previous look. Returns null where
   * there is no canvas (the Node test runner), signalling a gradient fallback.
   */
  private glowMaster(): HTMLCanvasElement | null {
    if (this.m_glow || this.m_glowNA) return this.m_glow;
    if (typeof document === 'undefined') {
      this.m_glowNA = true;
      return null;
    }
    const R = CParticleSystem.GLOW_SRC;
    const cv = document.createElement('canvas');
    cv.width = cv.height = R * 2;
    const g = cv.getContext('2d');
    if (!g) {
      this.m_glowNA = true;
      return null;
    }
    const grad = g.createRadialGradient(R, R, 0, R, R, R);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.4)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, R * 2, R * 2);
    this.m_glow = cv;
    return cv;
  }

  /**
   * The master glow tinted to (r,g,b), cached by colour. `source-in` keeps the
   * glow's alpha shape and swaps in the solid colour.
   *
   * Quantise to 4 bits/channel: a preset's jittered tints (e.g. a cluster of
   * eOrange flares spans ~300 distinct 5-bit buckets) collapse to a handful, while
   * genuinely different weapon colours stay apart — the coarser step is invisible
   * on a soft additive glow. At 5 bits the count blew past the cache cap and, with
   * the old clear()-on-overflow, every colour then MISSED and rebuilt a glow canvas
   * every frame (a ~55ms/frame rebuild storm on a Porcupine cluster).
   */
  private tintedGlow(r: number, g: number, b: number): HTMLCanvasElement | null {
    const master = this.glowMaster();
    if (!master) return null;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const hit = this.m_tints.get(key);
    if (hit) return hit;
    const R = CParticleSystem.GLOW_SRC;
    const cv = document.createElement('canvas');
    cv.width = cv.height = R * 2;
    const c = cv.getContext('2d')!;
    c.drawImage(master, 0, 0);
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
    c.fillRect(0, 0, R * 2, R * 2);
    // Evict the OLDEST entry (Map preserves insertion order), NOT the whole cache:
    // a full clear() turns an overflow into a per-frame rebuild storm. 4-bit keys
    // top out at 4096 buckets but real scenes use far fewer, so this rarely fires.
    if (this.m_tints.size >= 512) this.m_tints.delete(this.m_tints.keys().next().value as number);
    this.m_tints.set(key, cv);
    return cv;
  }

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
    const t = this.tintedGlow(r, g, b);
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
    if (!small) this.emitFlareBurst(x, y, r, flareSpr, big);

    // A hot white-out flash is a NUKE thing ONLY — never a conventional or Cleaner blast.
    if (big) this.spawnFlash(x, y, r * 2.4, {r: 255, g: 255, b: 255}, 0.3);

    // Dirt/deposit weapons (Dirty Boy, Mountain, …) get the coloured FIREBALL + crater fumes (the
    // original's blast over the small crater they cut) but skip the heavy fire/ejecta of a fiery bomb.
    if (deposit) {
      if (preset) this.emitPreset(x, y, r, preset);
      else this.emitRadial(x, y, Math.round(r * 1.2) + 22, 70, 200, 0.35, 0.7, r * 0.14 + 2, toward255(c, 0.3), 'flare'); // prettier-ignore
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
        this.emitRadial(x, y, n, 70, 200, 0.35, 0.7, r * 0.14 + 2, toward255(c, 0.3), 'flare');
        if (big) this.emitRadial(x, y, ring * 2, 25, 110, 0.5, 1.1, r * 0.11 + 2, c, 'flare');
      }
      if (big) {
        this.emitEjectaRing(x, y, r);
        this.emitBox(x, y, Math.round(r * 1.4) + 26, 190, 0.4, 1.1, 1.6, toward255(c, 0.2), 'disc');
      } else {
        this.emitBox(x, y, Math.round(r * 0.7) + 16, 90, 0.4, 1.0, 1.5, toward255(c, 0.2), 'disc');
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
   * The flare BURST as a HOLLOW annulus (the original's ring burst). `count ≈ r·0.5` particles are
   * born on a ring of radius `r·[0.5..0.8]` — never the centre — each starting at `r·[0.167..0.333]`
   * px and shrinking to nothing while drifting slowly outward, so the shell EXPANDS and the centre
   * stays clear. Plus ONE big central puff of the same sprite: for a dim sprite it adds ~nothing (the
   * centre reads through); for a bright one it gives the hot core. All additive at true intensity.
   */
  private emitFlareBurst(x: number, y: number, r: number, sprite: string, big: boolean): void {
    const count = big ? Math.round(r * 0.9) : Math.min(FLARE_BURST_MAX, Math.max(3, Math.round(r * 0.5))); // prettier-ignore
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
    this.m_craterVents.push({x, y, r, age: 0, life: VENT_DELAY + VENT_EMIT, acc: 0});
  }

  /** One white smoke puff rising off the disturbed dirt across the crater width. Spawned at the
   *  REAL post-carve surface (so it comes from the earth), white, gently rising, LIFE ∝ radius so
   *  big craters keep smoking far longer than small ones. */
  private spawnVentPuff(x: number, y: number, r: number): void {
    const dx = between(-r * 0.85, r * 0.85); // across the disturbed strip (stay off the far rim)
    const fx = x + dx + between(-3, 3);
    // The actual carved surface at this column = the dirt the smoke rises from (fallback: bowl arc).
    const surf = this.m_groundAt
      ? this.m_groundAt(fx)
      : y + Math.sqrt(Math.max(0, r * r - dx * dx)) * 0.7;
    const fy = surf - between(0, 4); // just at the dirt
    const v = 225 + Math.floor(rnd() * 28); // near-white 225..253
    const life = FUME_LIFE_BASE + r * between(FUME_LIFE_MIN, FUME_LIFE_MAX); // ∝ radius → lingers
    // Very gentle rise + near-neutral buoyancy (FUME_GRAV) so the puff hangs over the crater and
    // fades in place; low swell keeps it a soft wisp, not a blob.
    this.add(fx, fy, between(-5, 5), -between(3, 9), {r: v, g: v, b: v}, life, between(3, 5.5), 'smoke', undefined, FUME_GROW, 0.5, FUME_GRAV); // prettier-ignore
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
    withFire = true,
  ): void {
    if (trailType <= 0) return; // no trail (nukes / beams / diggers)
    const speed = Math.hypot(vx, vy);
    const rocket = trailType >= 2; // rocket/missile exhaust
    const lenScale = trailLength > 0 ? 0.6 + trailLength / 100 : 1; // trailLength 80 → 1.4
    // Fill the segment the shot travelled this frame so the trail is CONTINUOUS, not blobs
    // spaced one-per-frame — the original drops ~1 puff per frame; we sub-step the segment so
    // faster shots still lay a connected streak. Combined with the WHOLE-flight emission and a
    // long puff life, the trail BUILDS UP into a connected ribbon that lengthens as the shot arcs.
    const steps = Math.max(rocket ? 2 : 1, Math.ceil((speed * dt) / 3));
    const nx = speed > 1e-3 ? vx / speed : 1;
    const ny = speed > 1e-3 ? vy / speed : 0;
    const eject = 0.1 * speed; // exhaust throw = 0.1 × |shot velocity|, BACKWARD (grounded)
    for (let s = 0; s < steps; s++) {
      const f = s / steps; // 0 = head, →1 = last-frame position
      const px = x - vx * dt * f,
        py = y - vy * dt * f;
      // White smoke — near-dropped in place (small backward throw) so puffs stay on the path and
      // overlap into a connected WHITE ribbon; long-lived so the whole arc's worth stays visible.
      const v = 226 + Math.floor(rnd() * 26); // near-white 226..252
      if (rocket) {
        // Hot exhaust FIRE near the nozzle — only while the motor burns (ascending).
        if (withFire) {
          this.add(px, py, -nx * eject + between(-4, 4), -ny * eject + between(-4, 4), {r: 255, g: 195, b: 95}, between(0.12, 0.22) * lenScale, between(2, 3.5), 'plume'); // prettier-ignore
        }
        // Thick billowing white column (grows over life via SMOKE_GROW).
        this.add(px + between(-2, 2), py + between(-2, 2), -nx * eject + between(-3, 3), -ny * eject + between(-3, 3), {r: v, g: v, b: v}, between(0.9, 1.5) * lenScale, between(5, 8), 'smoke', undefined, SMOKE_GROW, 0.55); // prettier-ignore
      } else {
        // BALLISTIC shell (trailType 1: rail/artillery/shell) — a finer white smoke trace planted
        // (vel ≈ 0) along the path; thinner and lower-swell than a rocket's billowing column.
        this.add(px + between(-1, 1), py + between(-1, 1), between(-2, 2), between(-2, 2), {r: v, g: v, b: v}, between(0.5, 0.85) * lenScale, between(2.6, 4), 'smoke', undefined, 3, 0.5); // prettier-ignore
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
   * Muzzle SMOKE — a grey puff at the barrel. The original has none here (its only smoke is the
   * traveling in-flight trail); this is our interpretation, and the caller schedules it a beat
   * AFTER `muzzleFlash` so it emerges as the flash dies rather than burying it.
   */
  muzzleSmoke(x: number, y: number, dx: number, dy: number, smoke: number, _color: string): void {
    if (smoke <= 0) return;
    const sp = Math.hypot(dx, dy);
    const dir = sp > 1e-3 ? {x: dx / sp, y: dy / sp} : {x: 1, y: 0};
    for (let i = 0; i < smoke * 4; i++) {
      const g = 150 + between(-25, 25);
      this.add(
        x + between(-4, 4),
        y + between(-4, 4),
        dir.x * between(0, 60) + between(-20, 20),
        between(-30, 5),
        {r: g, g, b: g},
        between(0.5, 1.1),
        between(3, 5),
        'smoke',
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
   * scaled per particle — smoke gets shoved, sparks barely move. `groundAt(x)` (optional) enables a
   * boundary-layer wind PROFILE: drift ramps from ~0 at the ground to full `WIND_PROFILE_H` px above
   * it, so low fumes hug the crater and high smoke streams. INTERP — the original winds uniformly; if
   * `groundAt` is omitted (tests) the drift is uniform (factor 1), matching the binary's model.
   */
  update(dt: number, wind?: Vec2): void {
    if (dt <= 0) return;
    const windAx = wind ? wind.x * 26 : 0; // ±5 wind → up to ±130 px/s^2 on light smoke
    const windAy = wind ? wind.y * 26 : 0;
    const groundAt = this.m_groundAt;

    let w = 0;
    for (let i = 0; i < this.m_particles.length; i++) {
      const p = this.m_particles[i];

      // Altitude factor: 0 at/below the ground under this particle → 1 at WIND_PROFILE_H above it.
      // Uniform (1) when no ground provider is supplied (faithful fallback).
      let alt = 1;
      if (groundAt) {
        const g = groundAt(p.x);
        alt = g - p.y < 0 ? 0 : g - p.y > WIND_PROFILE_H ? 1 : (g - p.y) / WIND_PROFILE_H;
      }
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

    // Crater vents: after VENT_DELAY (the flash has faded), release the crater's smoke cohort over
    // VENT_EMIT so it emerges from the dirt and builds up. One puff per FUME_STEP px of crater width,
    // spread across the emit window; each puff then lives ∝ radius (spawnVentPuff), so the smoke
    // lingers well after the vent itself is spent. Per-vent accumulator → independent craters.
    let vw = 0;
    for (let i = 0; i < this.m_craterVents.length; i++) {
      const v = this.m_craterVents[i];
      v.age += dt;
      if (v.age >= v.life) continue; // vent spent → drop (its puffs live on independently)
      if (v.age >= VENT_DELAY) {
        const perSec = (2 * v.r) / FUME_STEP / VENT_EMIT; // whole cohort released over VENT_EMIT
        v.acc += perSec * dt;
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
  draw(ctx: CanvasRenderingContext2D): void {
    const ps = this.m_particles;
    const smokeSpr = this.m_assets?.getSprite('fx:smoke') ?? null; // gui/smoke.bmp
    const flareSpr = this.m_assets?.getSprite('fx:flare') ?? null; // flares/04.bmp

    // Pass 1: normal-blend — sparks/debris (crisp dots) and smoke (grey puffs).
    for (const p of ps) {
      const t = p.age / p.life;
      if (t >= 1) continue;

      if (p.kind === 'disc') {
        const a = 1 - t;
        ctx.fillStyle = `rgba(${p.r | 0},${p.g | 0},${p.b | 0},${a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.6, p.size * (0.5 + a * 0.5)), 0, TWO_PI);
        ctx.fill();
      } else if (p.kind === 'smoke') {
        // Grey puff: starts SMALL and SWELLS strongly over its life (the fumes
        // grow as they drift back), alpha peaks early then fades out.
        const alpha = Math.sin(Math.min(1, t) * Math.PI) * p.op; // per-particle peak opacity
        if (alpha <= 0.01) continue;
        const d = p.size * (0.9 + t * p.grow) * 2; // small at birth → grows over life (per-particle rate)
        if (smokeSpr) {
          // Warm (fire tint) ONLY at the very nozzle — the plume cools to grey smoke fast, then
          // the grey column lingers (the original's fire→smoke ramp cross-fades quickly).
          const warmth = Math.max(0, 1.2 - t * 9);
          // Grey base — full grey once cooled, dimmed while warm.
          ctx.globalAlpha = Math.min(1, alpha * (0.45 + 0.55 * (1 - warmth)));
          // White-colour smoke (crater fumes) draws the white-tinted sprite; grey exhaust/trail
          // smoke keeps the raw grey sprite.
          const base = p.r >= 200 ? (this.whiteSmoke() ?? smokeSpr.bitmap) : smokeSpr.bitmap;
          ctx.drawImage(base, p.x - d / 2, p.y - d / 2, d, d);
          // Fire tint only on young GREY smoke (exhaust nozzle) — never on the clean white earth fumes.
          const warm = p.r < 200 && warmth > 0.02 ? this.warmSmoke() : null;
          if (warm) {
            const op = ctx.globalCompositeOperation;
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = alpha * warmth * 1.3;
            ctx.drawImage(warm, p.x - d / 2, p.y - d / 2, d, d);
            ctx.globalCompositeOperation = op;
          }
          ctx.globalAlpha = 1;
        } else {
          this.blitGlow(ctx, p.x, p.y, d / 2, p.r, p.g, p.b, alpha);
        }
      }
    }

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
      const d = e.shrink ? e.size * (1 - t) * 2 : e.size * (0.7 + t * 1.8) * 2;
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

    // Beam flashes — a soft coloured halo line under a thin white-hot core. The
    // bolt SHOOTS OUT from the muzzle: the tip races to the target over the first
    // ~35% of the life, then the full line holds and fades (a fired beam, not an
    // instant pop). A bright head rides the advancing tip while it's extending.
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
        for (let d = 0; d < len; d += tileW) {
          const w = Math.min(tileW, len - d); // clip the final partial tile
          ctx.drawImage(spr.bitmap, 0, 0, (w / tileW) * nw, nh, d, -b.width / 2, w, b.width);
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

    ctx.globalCompositeOperation = prev;
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
