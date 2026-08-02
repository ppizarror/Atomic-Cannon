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
import type {ISpriteSource, Sprite} from './rendering/sprites';
import {capSet} from '../util/cache';
import {PixelBlitter} from '../util/PixelBlitter';
import {tryCanvas2d} from '../util/canvas';
import {TintedSpriteCache} from './rendering/TintedSpriteCache';
import particlesRaw from '../data/particles.json';
import {smokeEnabled} from './CGameConfig';
import {boundaryFactor, windProfile} from './wind';
import {between} from '../math/random';
import {hexToRgb, mixToward, WHITE, type RGB} from '../math/color';
import {TWO_PI, clamp, deg2rad} from '../math/num';
import {EXP, type ExpType, isNukeExp} from './weapons/ExpType';

// ==========================================================================
// INTERFACES & TYPES
// ==========================================================================

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

type RenderKind = 'disc' | 'flare' | 'flash' | 'smoke' | 'plume' | 'exhaust' | 'heat' | 'fume';

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
  // ---- 'exhaust' clusters only (0/1/0 on every other kind, so the pool keeps ONE object shape).
  // The baked cell is authored in LOCAL space with +X along the emission perpendicular, so the
  // blit is rotated by this unit vector — stored as cos/sin (= the perpendicular itself) to keep
  // atan2/cos/sin out of the per-frame draw loop.
  exCos: number;
  exSin: number;
  exVariant: number; // which baked seed row to sample (kills the repeating-stamp read)
  exScale: number; // cluster life / EXHAUST_ATLAS.REF_LIFE — see `exhaustAtlas` on why the blit scales
  // ---- 'heat' wisps only: a slow tumble, so the haze churns instead of sliding up rigidly.
  rot: number;
  spin: number;
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
  age: number; // total time since the blast — only the silent delay is measured against this
  delay: number; // silent period before venting can start (∝ radius: a nuke's bloom lasts longer)
  ramp: number; // seconds to build from a wisp to full emission (∝ radius)
  seed: number; // where along the crater this vent lit first, as a fraction of r in [-0.85, 0.85]
  wait: number; // time spent HELD because the ground was still moving (capped by FUME.VENT.MAX_WAIT)
  emit: number; // emission clock — advances only while actually venting, so a hold costs no window
  window: number; // how long this crater vents once it starts (∝ radius)
  acc: number; // per-vent fractional-puff accumulator (independent, so vents don't fight over one)
}
/** One flying dirt chunk: a single opaque pixel. `rgba` is the packed colour for the buffer path,
 *  `color` the CSS string for the headless / too-wide fallback. */
interface Debris {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rgba: number;
  color: string;
}

/**
 * Somewhere for the smoke layer to go other than the 2D canvas. The particle system describes each
 * puff exactly as it would to `drawImage` — a source canvas, a sub-rect, a destination box — so it
 * needs no knowledge of the renderer on the other side. The compositor implements this on top of a
 * GPU ParticleContainer, which collapses the whole layer into one draw call.
 */
export interface ISmokeSink {
  /** Place the layer in the frame: camera, screen-shake, and the logical view being presented. */
  setSmokeTransform(
    camX: number,
    shakeX: number,
    shakeY: number,
    viewW: number,
    viewH: number,
  ): void;
  /** Puffs are re-emitted from scratch each frame; these bracket one frame's worth. */
  smokeBegin(): void;
  smokeEnd(): void;
  smokeQuad(
    src: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    x: number,
    y: number,
    w: number,
    h: number,
    rotation: number,
    alpha: number,
    /** Multiplied into the sprite — lets one white master serve every colour, instead of a
     *  separate tinted canvas per colour (each of which would be its own batch). */
    tint?: number,
  ): void;
}

// ==========================================================================
// TUNING
// ==========================================================================

/**
 * The one-off bursts a detonation fires, as opposed to the smoke it leaves behind.
 */
const BLAST = {
  /** Cap the hollow flare-burst ring count for a plain BURST-style blast (the original's ~r·0.5
   *  particles); this caps a wide conventional round (Cleaner r130 → 65) so the ring stays a
   *  readable shell rather than an over-dense band. A DENSE style (~r·2) uses 2× this cap; nukes
   *  stay uncapped. See `emitFlareBurst`, which selects the density from the weapon's explosion
   *  style (expType). */
  FLARE_BURST_MAX: 54,
  /** Muzzle spark burst (the original's `muzzleSmoke` emitter): a FIXED count of sparks, each with
   *  a random velocity spread of ±(muzzleSmoke·speed) on both axes — the field scales the SPREAD,
   *  not the count. */
  MUZZLE_SPARKS: 30,
  /** …and what maps that field value (usually 2) to a punchy px/s spread. */
  MUZZLE_SPARK_SPEED: 45,
  /** Blast radius (px) below which a detonation is drawn as a compact spark-puff rather than the
   *  full firework — machine gun (r8), shotgun (r4), gatling (r8). Shells and up (r≥~20) get the
   *  full sequence. See `blast`. */
  SMALL_R: 14,
} as const;

/** Cull margin (px) — a puff whose CENTRE is this far outside the view is skipped in draw (big
 *  enough to cover a fully-swelled puff's radius so nothing pops at the edge). */
const CULL_MARGIN = 140;

/**
 * Cosmetic dirt spray. A beam cut or a buried digger throws dirt that lands and simply VANISHES —
 * no column is raised, nothing is written to the heightmap, and the throw is drawn from
 * Math.random. That makes it pure decoration, so it lives here. Its depositing sibling (crater
 * ejecta) does NOT: that one raises columns, stamps radiation and draws from CLand's seeded LCG
 * because it has to stay identical on every client in a network match. Moving THAT into this system
 * would put lockstep-critical state behind Math.random, so it stays terrain — see
 * CLand.addShowerParticles.
 *
 * Chunks are single opaque 1px dots, which is what lets them be an order of magnitude cheaper than
 * a smoke puff: instead of one canvas call each they are plotted into a pixel buffer and blitted
 * once, so a 15k cloud costs ONE drawImage. Measured 0.062 µs/chunk against 0.59 µs for a puff.
 */
const DEBRIS = {
  /** Above this bbox area the scratch buffer costs more to clear and upload than the per-chunk
   *  canvas calls it saves, so a cloud spread that wide falls back to plain fillRects. */
  BLIT_MAX_AREA: 1_600_000,
  GRAVITY: 500,
  WIND_ACCEL: 12,
} as const;

/**
 * Rocket-exhaust trail: each puff picks a random angle in the backward spread cone that sets BOTH
 * its perpendicular DRIFT (which side of the tube it settles on) and its gui/rocket plume.bmp ROW
 * (its colour). So the outer edge reads the light UPPER rows and the inner edge the dark LOWER rows
 * — a coherent graded TUBE that emerges statistically (grounded: row = the emission-angle fraction).
 *
 * Exported so the tests track these knobs instead of pinning literals that tuning would break.
 */
export const EXHAUST = {
  /** The billow curve's peak: puff diameter tops out at `size · this · 2` (see the `gs` curve). */
  GROW_MAX: 3.4,
  /** Initial perpendicular half-offset (px) → puffs START close together at the nozzle. */
  HALF: 1,
  /** Puff life, before the weapon's trailLength scaling (`lenScale`). */
  LIFE: [0.9, 1.6],
  /** Peak opacity — low, so overlapping soft puffs blend into a blurry cloud rather than reading as
   *  crisp discs. */
  OP: 0.6,
  /** Perpendicular drift speed (px/s) → puffs SPREAD apart as they age (the tube widens toward the
   *  tail). */
  PERP: 16,
  /** Puffs per sub-step (dense — the trail is many overlapping puffs). On the BAKED path these are
   *  free: the whole cohort is one blit whatever this says, so it costs only load-time bake work. */
  PUFFS: 10,
  /** Per-puff size range — shared by the live path and the bake, so the baked cell reproduces
   *  `drawSmoke`'s exhaust branch exactly. */
  SIZE: [2.5, 4],
} as const;

/**
 * Baked exhaust clusters. A sub-step's cohort of `EXHAUST.PUFFS` puffs shares one origin and one
 * velocity; the ONLY thing that differs between them is a random cone angle `a` that sets both the
 * perpendicular drift and the plume.bmp colour row, plus ±1px jitter. So the whole cohort's
 * appearance is a deterministic function of its normalised age — which means it can be rendered
 * ONCE, offline, into an animation strip and replayed at runtime with a single rotated blit instead
 * of `EXHAUST.PUFFS` blits.
 *
 * That matters because canvas2d smoke is bound by drawImage CALL COUNT, not by fill: measured on a
 * 6-rocket Stingers volley, 11k puff blits cost ~5.8ms/frame while the same painted area in 1/5 the
 * calls costs ~0.95ms. Pixels are free; calls are not.
 *
 * What stays live: gravity, buoyancy and wind act on the cluster as a whole. The puffs sit within
 * ~40px of each other and share the boundary-layer factor, so their individual wind response was
 * already indistinguishable. What is baked: the intra-cluster spread, per-puff growth, the
 * plume.bmp colour ramp and each puff's own fade — including its life stagger, so the cohort still
 * dissolves raggedly rather than snapping out together.
 */
const EXHAUST_ATLAS = (() => {
  // Reference life the cell geometry is authored at (the midpoint of the `between(0.9, 1.6)` draw).
  // A cluster whose life differs blits the cell scaled by life/REF_LIFE: the perpendicular drift is
  // a constant VELOCITY, so total spread is proportional to life and the tube must widen with it
  // (trailLength 0→100 maps to lenScale 0.9→1.6). Scaling the cell scales the puff radii along with
  // the spread — a ±30% systematic size shift that sits well inside the existing per-puff random
  // range (2.5..4), so it reads as a beefier trail rather than as an error.
  const REF_LIFE = 1.25;
  // Cell half-extents in world px at REF_LIFE. The cell is a WIDE, SHORT rectangle, not a square:
  // puffs fan out only along the perpendicular (local X), so local Y spans nothing but the ±1px
  // jitter plus a puff radius. Sizing the two axes independently costs ~2.4× less texture, which is
  // what buys the 32 variants below.
  const HALF_W = Math.ceil(EXHAUST.HALF + EXHAUST.PERP * REF_LIFE + 1 + EXHAUST.SIZE[1] * EXHAUST.GROW_MAX); // prettier-ignore
  const HALF_H = Math.ceil(1 + EXHAUST.SIZE[1] * EXHAUST.GROW_MAX);
  return {
    /** Texture px per cell (1:1 with world px at the reference life). */
    CELL_H: HALF_H * 2,
    CELL_W: HALF_W * 2,
    /** Animation frames per variant. */
    FRAMES: 24,
    HALF_H,
    HALF_W,
    REF_LIFE,
    /** Independently-seeded strips, picked at random per cluster. This has to be GENEROUS: a
     *  cluster is a rigid stamp, so with too few seeds consecutive sub-steps reuse the same
     *  silhouette and the ribbon reads as a chain of identical beads instead of a continuous cloud
     *  (clearly visible at 8). */
    VARIANTS: 32,
  } as const;
})();

/**
 * Crater fumes: a fresh crater smokes off its disturbed dirt in SUCCESSIVE GENERATIONS of white
 * puffs rising over a radius-scaled window, tapering out — not one instant cohort.
 */
const FUME = {
  /** Seconds to reach full opacity after birth. */
  FADE_IN: 0.35,
  /** Mild buoyancy (vs the trail's -0.12) so each generation drifts gently UP off the dirt and
   *  fades — a steady rising stream — without ballooning to the top of the screen. */
  GRAV: -0.048,
  /** Smoke swell for crater fumes. Deliberately targets GROWTH rather than birth size: the gaps
   *  open up in the dispersed, aged part of the cloud, while fresh puffs at the vent are already
   *  packed tight. */
  GROW: 3.6,
  /** Fraction of life held at full opacity before the tail fade begins. */
  HOLD: 0.55,
  /** Per-puff lifetime ∝ radius: `LIFE_BASE + radius · LIFE_R`. Each generation rises and fades over
   *  this; new generations keep coming for the whole emission window. Kept SHORT on purpose. With a
   *  long life the puffs simply outlive the crater: they rise clear of the bowl and consolidate into
   *  a tall rounded plume floating above it, which is why the cloud stopped covering the crater it
   *  came from (emission across the width is uniform — measured at 0% skipped, evenly bucketed — so
   *  the drift, not the spawn, is what empties the ends). */
  LIFE_BASE: 1,
  LIFE_R: [0.018, 0.034],
  /** Peak opacity of a single crater-fume puff. */
  OP: 0.125,
  /** Puffs emitted per second per unit radius, while venting (tapers to 0 over the window). HIGH so
   *  the many small puffs overlap into a TIGHT, dense cloud (the legacy look), not spaced distinct
   *  blobs. Raised together with `GROW`: a puff's SOFT falloff (see `whiteSmoke`) leaves its outer
   *  ~60% nearly transparent, so its effective footprint is well under its drawn diameter. That
   *  coverage has to be bought back with SIZE and COUNT, not with opacity — raising opacity instead
   *  thins the cloud out into visibly separate bubbles. */
  RATE: 5,
  /** How much of its size a puff gives up across the tail fade (0 = none, 1 = shrinks to nothing).
   *  Mirrors the exhaust puffs, which contract as they dissolve — see the draw path for why a puff
   *  that fades at CONSTANT size is what exposes its own outline as the cloud dies. */
  SHRINK: 0.35,
  /** Puff size scales with the BLAST RADIUS, as in the original: its crater streamers take their
   *  size from `(rand + base) * radius`, so a small round throws small smoke. The scaling is what
   *  keeps the cloud reading as a cloud at both ends — a flat size in the `between(2.5, 7)` range
   *  makes one puff ~105% of the crater width at r=30 (a few giant blobs) while measuring only 13%
   *  at r=250. The BASE term is our own: a pure ratio leaves a grenade's puffs at ~5px, and these
   *  are soft blobs rather than the original's fire streamers, so they need a floor to stay
   *  legible. */
  SIZE_BASE: 1.5,
  SIZE_R: 0.013,
  SIZE_VAR: [0.65, 1.55],
  /** Soot. A detonation's first smoke is unburnt and nearly black; as the fire dies the plume pales
   *  to ordinary grey. `SHADE_RAMP` is the fraction of the emission window over which that happens,
   *  and `SHADE_VAR` is the per-puff spread that stops any one generation reading as a flat block. */
  SHADE_DARK: 62,
  SHADE_LIGHT: 232,
  SHADE_RAMP: 0.38,
  SHADE_VAR: 26,
  /** Seconds for a puff to reach ~63% of its swell. A fume puff's swell and fade run on ABSOLUTE
   *  age against these time constants, NOT on the normalised age/life. Life scales with the crater
   *  (measured: 3.7s at r=90, 8.6s at r=250), so a curve spread across it swells the puff by only
   *  ~2× over eight seconds — far too slow to register as motion, leaving a big crater's cloud
   *  looking frozen despite a healthy frame rate. Pinning the swell to a fixed ~1s constant means
   *  every puff visibly blooms as it leaves the dirt regardless of how long it then drifts, and the
   *  long life still carries the tall plume. */
  SWELL_TAU: 0.9,
  /** The EMITTER: when a crater starts smoking, how hard, and for how long. Kept as a sub-group
   *  rather than a second top-level object — a vent and its fumes are one effect, and splitting them
   *  had the emission RATE sitting on the particle side. */
  VENT: {
    /** Stays silent at least this long so smoke emerges AS the explosion bloom fades, not during
     *  it. Scaled by radius on top (`DELAY_R`): a nuke's fireball and its rain of spoil both last
     *  far longer than a grenade's, so a flat delay had big blasts smoking mid-debris. */
    DELAY: 0.4,
    DELAY_R: 0.006,
    /** Fumes are the AFTERMATH: after the delay the vent still holds while the ground is physically
     *  moving — spoil raining down, overburden collapsing, the surface sinking — so smoke rises off
     *  earth that has come to rest. Capped, so a map that never fully settles still gets its smoke. */
    MAX_WAIT: 8,
    /** How far through the window the emission FRONT takes to reach the full crater width. Each vent
     *  picks a random column to start from and spreads outward from there, so the crater catches
     *  light at one point and the smoke creeps along it — instead of the entire rim igniting on the
     *  same frame. A port embellishment: the original seeds every column in one pass at detonation. */
    SPREAD: 0.4,
    /** Seconds to ramp emission 0 → full (`RAMP + radius · RAMP_R`). Without it the vent switched on
     *  at full rate and read as a chimney being lit; a crater should start with a wisp and build. */
    RAMP: 0.9,
    RAMP_R: 0.006,
    /** Emission window (how long the crater keeps generating fumes) = `WIN_BASE + radius · WIN_R`. */
    WIN_BASE: 7.5,
    WIN_R: 0.02,
  },
} as const;

/** How much a radioactive heat wisp widens over its life. Modest: the haze is meant to read as a
 *  fine shimmer over the fallout, not as billowing smoke. */
const HEAT_GROW = 1.4;

/** Cap on the per-hue radiation smoke-tint cache (see `m_heatTints`). Sprite-sized canvases, and
 *  a match only ever shows a handful of distinct radiation hues at once. */
const HEAT_TINT_CACHE_MAX = 64;

/**
 * Per-kind physics response: how gravity and wind act on each render kind. Light smoke rises and is
 * shoved hard by wind; heavy sparks fall and ignore it. Annotated rather than `as const` so a new
 * `RenderKind` fails to compile until both tables cover it.
 */
const KIND: {GRAV: Record<RenderKind, number>; WIND: Record<RenderKind, number>} = {
  GRAV: {
    disc: 1,
    flare: 0.25,
    flash: 0,
    smoke: -0.12,
    plume: 0.15,
    exhaust: -0.12, // a baked cluster IS trail smoke — same buoyancy as the puffs it replaces
    heat: 0, // haze lifts at a constant rate set at birth (bigger wisps lift faster), no accel
    fume: -0.048, // mirrors FUME.GRAV, which the emitter passes explicitly anyway
  },
  WIND: {
    disc: 0.15,
    flare: 0.5,
    flash: 0,
    smoke: 1.1, // the original's grey smoke rides wind at ×1; much past that shoves it unnaturally hard
    plume: 0.4,
    exhaust: 1.1, // ditto — wind acts on the cluster; the intra-cluster drift is baked
    heat: 0, // ground haze carries its own sideways drift; wind must not smear it off the fallout
    fume: 1.1, // crater smoke rides the wind like the rest of the smoke family
  },
};

/**
 * Defaults for the generic smoke kinds (muzzle exhaust / shot-trail column). Crater fumes override
 * both — see `FUME`.
 */
const SMOKE = {
  /** Swell rate; the exhaust and trail columns billow out strongly. */
  GROW: 5.5,
  /** Peak opacity — thin and translucent. The fumes override it higher so their tightly-packed
   *  cohort stacks into an opaque white crescent instead of faint scattered specks. */
  OP: 0.5,
} as const;

/**
 * A crater "vent": how long a fresh crater keeps smoking. Each vent is independent, so multi-bomb
 * weapons (Black Rain) leave the whole strip smoking.
 */

// ==========================================================================
// CParticleSystem CLASS
// ==========================================================================

export class CParticleSystem {
  // ========================================================================
  // PURE HELPERS
  // ========================================================================

  /** Parse `#rrggbb` (falls back to a warm orange). */
  private static parseColor(s: string): RGB {
    return s.startsWith('#') && s.length === 7 ? hexToRgb(s) : {r: 255, g: 136, b: 0};
  }

  /** Nudge a colour toward white (0..1) — hot cores read brighter than the tint. */
  private static toward255(c: RGB, t: number): RGB {
    return mixToward(c, WHITE, t);
  }

  // ========================================================================
  // SETUP & LIFECYCLE
  // ========================================================================

  /** Wipe every live effect — called when a new battle/match generates fresh terrain, so smoke,
   *  fumes, debris and fireballs from the previous battle don't linger over the new map. */
  clear(): void {
    this.m_particles.length = 0;
    this.m_debris.length = 0;
    this.m_beams.length = 0;
    this.m_explosions.length = 0;
    this.m_craterVents.length = 0;
  }

  /** Build the baked exhaust atlas up front (it needs gui/rocket plume.bmp, so call this once the
   *  sprites have loaded). Purely an optimisation: without it the atlas builds lazily on the first
   *  rocket, which would put its one-off cost on that frame. Safe to call repeatedly. */
  prewarm(): void {
    this.exhaustAtlas();
  }

  setAssets(a: ISpriteSource): void {
    this.m_assets = a;
    this.m_whiteSmoke = null;
    this.m_plumeImg = null;
    this.m_exAtlas = null; // the bake samples plume.bmp — rebuild it against the new sprite set
    this.m_heatTints.clear(); // tinted from smoke.bmp — rebuild against the new sprite set
  }

  /** Keep the clip window in step with the render surface. */
  setBounds(width: number, height: number): void {
    this.m_minX = -200;
    this.m_minY = -400;
    this.m_maxX = width + 200;
    this.m_maxY = height + 200;
  }

  // Is the ground still physically resolving? Read-only, same shape as the surface provider — the
  // crater vents hold on it so their smoke reads as aftermath (see the vent update). Null = never
  // holds, which is what headless tests and any host without a terrain want.
  private m_settling: (() => boolean) | null = null;

  /** Tell the vents when the ground has come to rest (debris landed, collapses finished). */
  setSettleProvider(fn: (() => boolean) | null): void {
    this.m_settling = fn;
  }

  /** Give the particle system the terrain surface fn — enables the wind altitude profile and stops
   *  the crater vents from spraying fumes into empty sky where there's no soil. */
  setGroundProvider(fn: (x: number) => number): void {
    this.m_groundAt = fn;
  }

  /** Route the smoke layer to a batched renderer. Null (tests, no compositor) keeps the 2D path. */
  setSmokeSink(sink: ISmokeSink | null): void {
    this.m_smokeSink = sink;
  }

  /** Per-frame view rectangle (world-X of the left edge + on-screen size). Drives off-screen culling
   *  and the half-res smoke buffer. Pass width 0 to disable both (headless tests draw everything). */
  setViewport(camX: number, viewW: number, viewH: number): void {
    this.m_viewCamX = camX;
    this.m_viewW = viewW;
    this.m_viewH = viewH;
  }

  // ========================================================================
  // BAKED SPRITES & ATLASES
  // ========================================================================

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

  /**
   * Render the exhaust cohort's whole life into an atlas, once.
   *
   * Each cell composites EXHAUST.PUFFS sub-puffs at the state they'd hold at that frame's
   * normalised age, mirroring `drawSmoke`'s exhaust branch term for term: the plume.bmp colour
   * lookup (X = age, Y = the puff's cone-angle row), the billow curve `gs`, and the fade `ea`.
   * Because the sub-puffs composite source-over into a transparent cell and the cell is then
   * composited source-over onto the scene, the result is IDENTICAL to blitting them individually —
   * source-over is associative that way. The bake is lossless, not an approximation.
   *
   * Consequence worth knowing: sub-puffs inside a cell are FREE at runtime — the cost is one blit
   * regardless of how many are baked in. EXHAUST.PUFFS is therefore a pure quality knob now.
   */
  private exhaustAtlas(): HTMLCanvasElement | null {
    if (this.m_exAtlas) return this.m_exAtlas;
    const img = this.plumeImg(); // the colour table the exhaust reads — required
    if (!img) return null;
    const made = tryCanvas2d(
      EXHAUST_ATLAS.CELL_W * EXHAUST_ATLAS.FRAMES,
      EXHAUST_ATLAS.CELL_H * EXHAUST_ATLAS.VARIANTS,
    );
    if (!made) return null;
    const {cv, ctx: g} = made;

    for (let v = 0; v < EXHAUST_ATLAS.VARIANTS; v++) {
      // Draw this variant's cohort once, then replay it across the frame columns. Each sub-puff
      // keeps its own cone angle, jitter, size and life fraction for the whole strip, so the
      // variant is a single coherent cohort animating — not independent noise per frame.
      const puffs = [];
      for (let i = 0; i < EXHAUST.PUFFS; i++) {
        const a = between(-1, 1); // cone angle: −1 = inner/dark row, +1 = outer/light row
        puffs.push({
          a,
          jx: between(-1, 1),
          jy: between(-1, 1),
          size: between(...EXHAUST.SIZE),
          // Per-puff life as a fraction of the cluster's: the live path draws each puff's life
          // independently over a 0.9..1.6 range (a 1.78× spread), so short-lived members wink out
          // early and the cohort frays instead of vanishing as one block.
          lifeFrac: between(EXHAUST.LIFE[0] / EXHAUST.LIFE[1], 1),
          row: Math.min(img.height - 1, (((1 - a) / 2) * img.height) | 0),
        });
      }
      for (let f = 0; f < EXHAUST_ATLAS.FRAMES; f++) {
        const t = (f + 0.5) / EXHAUST_ATLAS.FRAMES; // sample each frame at its midpoint
        const ox = f * EXHAUST_ATLAS.CELL_W + EXHAUST_ATLAS.HALF_W;
        const oy = v * EXHAUST_ATLAS.CELL_H + EXHAUST_ATLAS.HALF_H;
        // Spread uses the CLUSTER's age, not the puff's: drift is a constant velocity in the live
        // path, so a short-lived puff simply dies partway along the same trajectory.
        const spread = EXHAUST.HALF + EXHAUST.PERP * EXHAUST_ATLAS.REF_LIFE * t;
        for (const p of puffs) {
          const tp = t / p.lifeFrac; // this puff's own normalised age
          if (tp >= 1) continue; // already dead — the cohort frays
          const cx = Math.min(img.width - 1, (tp * img.width) | 0);
          const i = (p.row * img.width + cx) * 4;
          const cr = img.data[i],
            cg = img.data[i + 1],
            cb = img.data[i + 2];
          // Billow to EXHAUST.GROW_MAX by tp=0.72, then shrink and dissolve (drawSmoke's curve).
          const gs =
            tp < 0.72
              ? 0.5 + (EXHAUST.GROW_MAX - 0.5) * (tp / 0.72)
              : EXHAUST.GROW_MAX * (1 - (tp - 0.72) / 0.28);
          const rad = p.size * gs;
          const ea = Math.min(1, tp / 0.1) * (tp > 0.72 ? (1 - tp) / 0.28 : 1) * EXHAUST.OP;
          if (rad <= 0 || ea <= 0.004) continue;
          const px = ox + p.a * spread + p.jx;
          const py = oy + p.jy;
          // The soft cotton-ball falloff of m_puffCache, with the fade folded into the stops —
          // equivalent to blitting the white master at globalAlpha = ea, minus the state change.
          const grad = g.createRadialGradient(px, py, 0, px, py, rad);
          const rgb = `${cr},${cg},${cb}`;
          grad.addColorStop(0, `rgba(${rgb},${0.9 * ea})`);
          grad.addColorStop(0.4, `rgba(${rgb},${0.6 * ea})`);
          grad.addColorStop(0.75, `rgba(${rgb},${0.22 * ea})`);
          grad.addColorStop(1, `rgba(${rgb},0)`);
          g.fillStyle = grad;
          g.beginPath();
          g.arc(px, py, rad, 0, TWO_PI);
          g.fill();
        }
      }
    }
    this.m_exAtlas = cv;
    return cv;
  }

  /** The soft warm glow used until the real smoke sprite is available. */
  private heatFallback(): HTMLCanvasElement | null {
    if (this.m_heatFallback) return this.m_heatFallback;
    const S = 32;
    const made = tryCanvas2d(S, S);
    if (!made) return null;
    const {cv: c, ctx: g} = made;
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(255,150,70,0.9)');
    grad.addColorStop(0.4, 'rgba(255,90,40,0.4)');
    grad.addColorStop(1, 'rgba(255,60,30,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    this.m_heatFallback = c;
    return c;
  }

  /**
   * Recolour the smoke sprite and dissolve its rim — the ONE build behind both smoke variants,
   * which differed only in the blend op and the fill colour (see {@link heatTint} for `multiply`
   * and {@link whiteSmoke} for `screen`). The steps and their order matter:
   *   1. draw the grey textured puff,
   *   2. blend `color` over it with `op` — colouring/lifting it while KEEPING the texture
   *      gradients (a flat fill would erase them),
   *   3. re-mask to the sprite's own alpha, then
   *   4. feather that mask with {@link SOFT_FALLOFF} — still under `destination-in`, so it
   *      multiplies the mask rather than painting over the texture.
   */
  private tintedSmoke(
    op: 'multiply' | 'screen',
    color: string,
    spr: Sprite,
  ): HTMLCanvasElement | null {
    const w = spr.width,
      h = spr.height;
    const made = tryCanvas2d(w, h); // null when headless (tests): no canvas to tint
    if (!made) return null;
    const {cv: c, ctx: g} = made;
    g.drawImage(spr.bitmap, 0, 0, w, h);
    g.globalCompositeOperation = op;
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(spr.bitmap, 0, 0, w, h);
    CParticleSystem.featherEdge(g, w, h);
    g.globalCompositeOperation = 'source-over';
    return c;
  }

  /**
   * The MONOTONIC alpha falloff every tinted smoke puff's rim gets. Its shape matters more than
   * the fact of feathering: a ramp with a FLAT CORE (opaque out to ~0.45r, then falling) turns each
   * puff into a clean circular disc, so the cloud reads as a heap of balls. Falling continuously
   * from the centre leaves no radius at which an edge can be perceived, so overlaps merge. Keep it
   * monotonic.
   *
   * (`m_puffCache`'s master uses a similar but separately-tuned curve — deliberately NOT shared:
   * its stops aren't a scaled copy of these, so folding them would change how the trail reads.)
   */
  private static readonly SOFT_FALLOFF: readonly (readonly [number, number])[] = [
    [0, 1],
    [0.4, 0.75],
    [0.75, 0.35],
    [1, 0],
  ];

  /** Paint {@link SOFT_FALLOFF} as a centred radial gradient over the whole `w`×`h` canvas. The
   *  caller sets the composite op — under `destination-in` this multiplies the existing alpha. */
  private static featherEdge(g: CanvasRenderingContext2D, w: number, h: number): void {
    const cx = w / 2,
      cy = h / 2;
    const soft = g.createRadialGradient(cx, cy, 0, cx, cy, Math.min(cx, cy));
    for (const [stop, a] of CParticleSystem.SOFT_FALLOFF) {
      soft.addColorStop(stop, `rgba(0,0,0,${a})`);
    }
    g.fillStyle = soft;
    g.fillRect(0, 0, w, h);
  }

  /** The smoke sprite tinted to a weapon's radiation hue (hydrogen blue / plutonium green /
   *  uranium red), cached per colour (capped — a jittered hue per blast would otherwise mint a
   *  fresh canvas forever). `multiply` colours the grey smoke while keeping its texture. */
  private heatTint(r: number, g: number, b: number): HTMLCanvasElement | null {
    const spr = this.m_assets?.getSprite('fx:smoke');
    if (!spr) return null;
    const key = `${r},${g},${b}`;
    const hit = this.m_heatTints.get(key);
    if (hit) return hit;
    const c = this.tintedSmoke('multiply', `rgb(${r},${g},${b})`, spr);
    if (c) capSet(this.m_heatTints, key, c, HEAT_TINT_CACHE_MAX);
    return c;
  }

  /** gui/rocket plume.bmp as a raw 2-D pixel table (read once): X = age, Y = height. Exhaust puffs
   *  sample it at (age, height) for their colour. Null until the sprite/canvas is available. */
  private plumeImg(): ImageData | null {
    if (this.m_plumeImg) return this.m_plumeImg;
    const spr = this.m_assets?.getSprite('fx:plume');
    if (!spr) return null;
    const w = spr.width,
      h = spr.height;
    const made = tryCanvas2d(w, h, {willReadFrequently: true});
    if (!made) return null;
    made.ctx.drawImage(spr.bitmap, 0, 0, w, h);
    this.m_plumeImg = made.ctx.getImageData(0, 0, w, h);
    return this.m_plumeImg;
  }

  /** Lazily build a bright, COOL-tinted copy of the smoke sprite for crater fumes — the grey
   *  `smoke.bmp` lifted toward a light blue-grey-white with `screen` (NOT a flat white fill), so its
   *  internal fluffy TEXTURE survives: highlights near-white, crevices a cool blue-grey. The rim
   *  then gets the shared {@link SOFT_FALLOFF}, which is why these read as one blended cloud while
   *  raw smoke.bmp reads as pasted-on stamps: the bitmap's own mask ends in a hard edge, so every
   *  puff keeps a legible outline no matter how densely they pack. Built once, then cached. */
  private whiteSmoke(): HTMLCanvasElement | null {
    if (this.m_whiteSmoke) return this.m_whiteSmoke;
    const spr = this.m_assets?.getSprite('fx:smoke');
    if (!spr) return null;
    // cool blue-grey — `screen` brightens the grey toward it
    this.m_whiteSmoke = this.tintedSmoke('screen', 'rgb(150,162,190)', spr);
    return this.m_whiteSmoke;
  }

  // ========================================================================
  // EMISSION
  // ========================================================================

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
    grow: number = SMOKE.GROW,
    op: number = SMOKE.OP,
    gravMul: number = KIND.GRAV[kind],
  ): Particle {
    // Every field is written here (including the 'exhaust'-only ones) so the pool holds a single
    // object shape — a mixed shape would deoptimise the hot update/draw loops that walk it.
    const p: Particle = {
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
      windMul: KIND.WIND[kind],
      grow,
      op,
      spr,
      exCos: 1,
      exSin: 0,
      exVariant: 0,
      exScale: 1,
      rot: 0,
      spin: 0,
    };
    this.m_particles.push(p);
    return p;
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
    const c = CParticleSystem.parseColor(color);
    this.m_beams.push({x0, y0, x1, y1, r: c.r, g: c.g, b: c.b, age: 0, life, spr, width});
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
    const c = preset
      ? {r: preset.colorr, g: preset.colorg, b: preset.colorb}
      : CParticleSystem.parseColor(color);
    // Floor low so a small round (machine gun r8, shotgun r4) stays a small puff — a floor up at
    // grenade radius would force every blast to grenade size and make bullets "explode".
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
    const small = !big && r < BLAST.SMALL_R;

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
      this.emitBox(
        x,
        y,
        Math.round(r * 1.2) + 4,
        20,
        0.25,
        0.6,
        1.1,
        CParticleSystem.toward255(c, 0.2),
        'disc',
      );
      return;
    }

    // A CLEANER is an earth-remover, NOT a fiery blast: its whole look is the dim smoke-shell
    // (annulus above) + the grey ground fumes (below). No coloured fireball, no fire, no ejecta —
    // just a light ember spray that flies OUT (a slow/dense box would clump at the centre and
    // re-fill the hollow shell).
    if (isCleaner) {
      this.emitBox(x, y, 14, 150, 0.3, 0.7, 1.3, CParticleSystem.toward255(c, 0.2), 'disc');
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
        this.emitBox(
          x,
          y,
          Math.round(r * 1.4) + 26,
          190,
          0.4,
          1.1,
          1.6,
          CParticleSystem.toward255(c, 0.2),
          'disc',
        );
      } else {
        // Spark spray, speed scaled by the crater for the same reason as emitFireballRing: a fixed
        // px/s throws a small blast's sparks clear of its own hole. Feeding `r` in as the speed
        // gives ~90 px/s of reach at r ≈ 90 and stays proportional below and above it.
        this.emitBox(
          x,
          y,
          Math.round(r * 0.7) + 16,
          r,
          0.4,
          1.0,
          1.5,
          CParticleSystem.toward255(c, 0.2),
          'disc',
        );
      }
    }

    // WHITE fume curtain over the fresh crater FLOOR — for ANY crater-cutting blast (a fiery bomb OR
    // a Cleaner like Earth Destroy; the original gates it on fire-detail + blast size, NOT weapon
    // type). The crater smoke emerges AFTER the flash (delayed vent), not during it. Skipped for
    // tiny rounds and pure deposits (deposits vent above).
    if (!small && !deposit) {
      this.ventCrater(x, y, r);
    }
  }

  /** Disperse SMOKE particles within `r` of a blast — later close explosions wipe intermediate
   *  smoke (only the after-settle smoke survives), and a Cleaner removing the dirt clears the fumes
   *  that were floating over it. Only 'smoke' is cleared — sparks/flares/fireball are untouched. */
  private clearSmoke(x: number, y: number, r: number): void {
    const reach = r * 1.15; // cover the visible blast area
    let w = 0;
    for (const p of this.m_particles) {
      const smoke = p.kind === 'smoke' || p.kind === 'exhaust' || p.kind === 'fume';
      if (smoke && Math.hypot(p.x - x, p.y - y) < reach) continue; // drop it
      this.m_particles[w++] = p;
    }
    this.m_particles.length = w;
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

  /**
   * Stage-2 circular ejecta: a fast, near-uniform ring of dirt launched radially
   * outward so it reads as an expanding shockwave shell around the crater.
   */
  private emitEjectaRing(x: number, y: number, r: number): void {
    const n = Math.round(r * 4.5) + 50;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TWO_PI + between(-0.06, 0.06); // evenly around the circle
      const sp = between(320, 520); // narrow band → a clean, wide shell
      const g = 100 + Math.floor(Math.random() * 110); // brighter, warmer dirt
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

  /** A row of rising fire streamers across ±half px of the impact column. */
  private emitFireLine(x: number, y: number, half: number, c: RGB): void {
    const step = Math.max(3, half / 5);
    const hot = CParticleSystem.toward255(c, 0.4);
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

  /** The generic coloured fireball ring — `count` flares on a shared life/size/colour tail, their
   *  SPEED scaled by the blast radius (the original scales its flare speed ∝ blast magnitude).
   *  Shared by the dirt-deposit blast and the fiery non-preset blast so the magic tail can't drift.
   *
   *  The speeds must stay proportional to r. A fixed px/s makes the spray's REACH a constant while
   *  the crater scales: 200 px/s over a 0.7 s life throws a spark 140 px, i.e. 1.5·r out of a
   *  90-radius hole but 2.3·r out of a 60-radius one — a Plasma (r 60) then flings offside sparks
   *  into the sky while a Plasma Bomb (r 90), same style and same sprite, reads as contained.
   *  Scaling on r keeps the spray at ~0.3..1.5·r for every weapon; the factors are calibrated at
   *  r = 90. */
  private emitFireballRing(x: number, y: number, r: number, count: number, c: RGB): void {
    const tail = CParticleSystem.toward255(c, 0.3);
    // Ember SIZE is a radius fed to the glow blit, which scales it by 1.7, so `r·0.045` puts an
    // ember at ~0.12·r. The coefficient has to stay that small: at `r·0.14` each ember draws at
    // 0.30·r — one "spark" nearly as wide as the crater itself — and 33 of them read as floating
    // orbs rather than a fireball. SPEED tops out at r·1.4 so the furthest ember travels ≈ r over
    // its 0.7 s life and the fireball stays in the hole it fills; at r·2.2 the tail carries 1.5·r
    // past the rim.
    const size = r * 0.045 + 1.5; // floor keeps a tiny blast's embers visible
    this.emitRadial(x, y, count, r * 0.5, r * 1.4, 0.35, 0.7, size, tail, 'flare');
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
      count = Math.min(BLAST.FLARE_BURST_MAX * 2, Math.max(6, Math.round(r * 2))); // prettier-ignore
    else if (expType === EXP.BURST)
      count = Math.min(BLAST.FLARE_BURST_MAX, Math.max(3, Math.round(r * 0.5))); // prettier-ignore
    else count = 0; // SINGLE
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * TWO_PI;
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
      const theta = deg2rad(t0 + Math.random() * (t1 - t0));
      const speed = (p.minv + Math.random() * (p.maxv - p.minv)) * 14 + 20; // preset units → px/s
      const life = (p.minlife + Math.random() * (p.maxlife - p.minlife)) * 0.16 + 0.25;
      const jc = (base: number) =>
        Math.max(0, Math.min(255, base + (Math.random() * 2 - 1) * p.colorVar));
      this.add(
        x + (Math.random() * 2 - 1) * p.posVar,
        y + (Math.random() * 2 - 1) * p.posVar,
        Math.cos(theta) * speed,
        -Math.sin(theta) * speed, // screen-Y down: -sin → 90° is up
        {r: jc(p.colorr), g: jc(p.colorg), b: jc(p.colorb)},
        life,
        size,
        'flare',
      );
    }
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
      const a = Math.random() * TWO_PI;
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
    const c = CParticleSystem.toward255(CParticleSystem.parseColor(color), 0.7); // hot, near-white at the core
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
   * short-lived, so it reads as a hot muzzle spray rather than a grey smoke puff. The caller
   * schedules it a beat AFTER `muzzleFlash`.
   */
  muzzleSmoke(x: number, y: number, _dx: number, _dy: number, smoke: number, color: string): void {
    if (smoke <= 0) return;
    const spread = smoke * BLAST.MUZZLE_SPARK_SPEED; // ± velocity on each axis, scaled by the field
    const tint = CParticleSystem.parseColor(color);
    for (let i = 0; i < BLAST.MUZZLE_SPARKS; i++) {
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

  /** Spawn the expanding fireball sprite (the weapon's own `expBitmap` flare). */
  private spawnExplosion(x: number, y: number, size: number, life: number, sprite: string): void {
    this.m_explosions.push({x, y, age: 0, life, size, sprite});
  }

  /** Additive white-out bloom centred on the blast. */
  private spawnFlash(x: number, y: number, size: number, c: RGB, life: number): void {
    this.add(x, y, 0, 0, c, life, size, 'flash');
  }

  /** One white smoke puff rising off the disturbed dirt across the crater width. Spawned at the
   *  REAL post-carve surface (so it comes from the earth), white, gently rising and fading — one of
   *  many successive generations the vent keeps producing while it smokes. */
  private spawnVentPuff(x: number, y: number, r: number, prog = 1, seed = 0): void {
    // The emission FRONT: puffs start clustered at this vent's seed column and the window widens
    // with progress until it spans the whole disturbed strip, so the crater lights at a point and
    // spreads. Clamped to ±0.85r either side, which keeps it off the far rim as before.
    const reach = 1.7 * Math.min(1, prog / FUME.VENT.SPREAD);
    const lo = Math.max(-0.85, seed - reach),
      hi = Math.min(0.85, seed + reach);
    const dx = between(lo, hi) * r; // across the disturbed strip (stay off the far rim)
    const fx = x + dx + between(-3, 3);
    // The actual carved surface at this column = the dirt the smoke rises from (fallback: bowl arc).
    const surf = this.m_groundAt
      ? this.m_groundAt(fx)
      : y + Math.sqrt(Math.max(0, r * r - dx * dx)) * 0.7;
    // Fume only from SOIL. Where the ground has been eroded down to the world floor (surface at the
    // view height → no land left in this column), there's nothing to smoke — don't puff into the void.
    if (this.m_groundAt && this.m_viewH > 0 && surf >= this.m_viewH) return;
    const fy = surf - between(0, 4); // just at the dirt
    // SOOT: the first smoke off a detonation is unburnt and nearly black, paling to ordinary grey
    // as the fire dies. `prog` is how far through its emission window the vent is, so the colour
    // belongs to the GENERATION rather than to the puff's own age — a late puff is grey the moment
    // it is born. The per-puff spread on top keeps a generation from reading as one flat block.
    const k = Math.min(1, prog / FUME.SHADE_RAMP);
    const shade = FUME.SHADE_DARK + (FUME.SHADE_LIGHT - FUME.SHADE_DARK) * k;
    const v = clamp(Math.round(shade + between(-FUME.SHADE_VAR, FUME.SHADE_VAR)), 12, 255);
    const life = FUME.LIFE_BASE + r * between(...FUME.LIFE_R); // ∝ radius
    const size = (FUME.SIZE_BASE + r * FUME.SIZE_R) * between(...FUME.SIZE_VAR); // ∝ radius
    // Small, near-white, FAINT puffs (FUME.OP) — many of these, packed tightly by the high emission
    // rate, overlap into a dense fine-grained cloud (the legacy tight-puff look); the density comes
    // from the stacking, not from any one puff. Gentle rise + mild buoyancy (FUME.GRAV) so each
    // generation drifts up off the dirt and fades.
    this.add(fx, fy, between(-5, 5), -between(5, 26), {r: v, g: v, b: v}, life, size, 'fume', undefined, FUME.GROW, FUME.OP, FUME.GRAV); // prettier-ignore
  }

  // Soot-shaded copies of the white fume sprite, bucketed 5 bits deep — only the 2D fallback needs
  // these; the GPU path tints per particle. Bounded, so a full range of shades costs 32 canvases.
  private readonly m_fumeShades = new Map<number, HTMLCanvasElement>();

  /** The fume sprite multiplied down to brightness `v` (0..255), cached per bucket. */
  private fumeShade(v: number): HTMLCanvasElement | null {
    const base = this.whiteSmoke();
    if (!base) return null;
    const key = v >> 3;
    const hit = this.m_fumeShades.get(key);
    if (hit) return hit;
    const made = tryCanvas2d(base.width, base.height);
    if (!made) return null;
    const {cv: c, ctx: g} = made;
    g.drawImage(base, 0, 0);
    g.globalCompositeOperation = 'multiply'; // darken, keeping the puff's texture
    const k = (key << 3) | 4;
    g.fillStyle = `rgb(${k},${k},${k})`;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-in'; // re-mask to the sprite's alpha
    g.drawImage(base, 0, 0);
    g.globalCompositeOperation = 'source-over';
    this.m_fumeShades.set(key, c);
    return c;
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
        const life = between(...EXHAUST.LIFE) * lenScale;
        const atlas = this.exhaustAtlas();
        if (atlas) {
          // BAKED: one particle carrying the whole cohort, drawn as a single rotated blit. The
          // cluster keeps only the motion its members SHARE — the backward exhaust throw — because
          // the perpendicular drift that fans them apart is already baked into the strip.
          const p = this.add(
            px,
            py,
            -nx * eject,
            -ny * eject,
            {r: 150, g: 128, b: 150}, // unused: the colour is baked from the plume table
            life,
            EXHAUST_ATLAS.HALF_W,
            'exhaust',
          );
          // The cell is authored with +X along the emission perpendicular, so the blit rotates by
          // that unit vector; the strip is scaled to this cluster's life (see EXHAUST_ATLAS.REF_LIFE).
          p.exCos = perpx;
          p.exSin = perpy;
          p.exVariant = (Math.random() * EXHAUST_ATLAS.VARIANTS) | 0;
          p.exScale = life / EXHAUST_ATLAS.REF_LIFE;
        } else {
          // LIVE fallback (no plume table yet, or headless): MANY small exhaust puffs per point.
          // Each picks a random cone angle `a` (−1 = inner/down, +1 = outer/up); it sets the puff's
          // perpendicular DRIFT (→ its side of the tube) AND its plume.bmp ROW (stored in `g`), so
          // outer puffs read the light rows, inner the dark — a coherent graded tube that
          // self-organises instead of a random cloud. Colour comes from the plume table at draw
          // (by age × this row); r=150 marks it as exhaust. This is what the atlas bakes.
          for (let n = 0; n < EXHAUST.PUFFS; n++) {
            const a = between(-1, 1);
            const rowFrac = (1 - a) / 2; // +1 (outer) → row 0 (light); −1 (inner) → row 1 (dark)
            const drift = a * EXHAUST.PERP;
            this.add(
              px + perpx * a * EXHAUST.HALF + between(-1, 1),
              py + perpy * a * EXHAUST.HALF + between(-1, 1),
              -nx * eject + perpx * drift,
              -ny * eject + perpy * drift,
              {r: 150, g: Math.round(rowFrac * 255), b: 150},
              life,
              between(...EXHAUST.SIZE), // larger
              'smoke',
              undefined,
              2.2, // start small at the nozzle, grow larger toward the tail
              EXHAUST.OP,
            );
          }
        }
      } else if (s === 0) {
        // BALLISTIC (trailType 1: rail/artillery/shell/BOMB, trailLength 0) — the original lays NO
        // exhaust/smoke here, just a faint white spark. ONE small, SHORT, NON-additive white dot per
        // frame dropped in place (NOT the per-step ribbon rockets get — additive plumes stacked into a
        // bright exhaust streak on a fast-falling Black Rain sub-bomb). So a Bomb barely sparkles.
        const v = 226 + Math.floor(Math.random() * 26); // near-white 226..252
        this.add(px, py, 0, 0, {r: v, g: v, b: v}, between(0.05, 0.11), between(1, 1.5), 'disc'); // prettier-ignore
      }
    }
  }

  /** Register a crater FUME.VENT. It stays silent for FUME.VENT.DELAY (smoke emerges AS the bloom fades),
   *  then releases its cohort over VENT_EMIT (so it builds up from the dirt). Each vent is
   *  independent — multi-bomb weapons leave every crater smoking. Fires for ANY crater (bomb or
   *  Cleaner), gated only on the Draw-Smoke toggle. */
  private ventCrater(x: number, y: number, r: number): void {
    if (!smokeEnabled()) return; // Graphics → Draw Smoke (+ Detail gating)
    // Only vent when the blast actually reaches the SOIL. An AIRBURST (Sky Bomb, Sky Cluster, …)
    // detonates high in mid-air and carves no crater — its blast sphere never touches the ground —
    // so it must NOT fume from the dirt far below. Skip if the sphere's bottom is above the surface.
    if (this.m_groundAt && y + r < this.m_groundAt(x)) return;
    this.m_craterVents.push({
      x,
      y,
      r,
      age: 0,
      delay: FUME.VENT.DELAY + r * FUME.VENT.DELAY_R,
      ramp: FUME.VENT.RAMP + r * FUME.VENT.RAMP_R,
      seed: between(-0.85, 0.85),
      wait: 0,
      emit: 0,
      window: FUME.VENT.WIN_BASE + r * FUME.VENT.WIN_R, // how long this crater smokes (∝ radius)
      acc: 0,
    });
  }

  // ========================================================================
  // COSMETIC DIRT SPRAY
  // ========================================================================

  /** Live cosmetic chunks (diagnostics / tests). */
  debrisCount(): number {
    return this.m_debris.length;
  }

  /**
   * Throw `count` cosmetic dirt chunks from (x, y) across the blast disc. Nothing here lands on the
   * heightmap — these vanish on contact — so the throw uses Math.random freely. `gentle` gives the
   * near-zero launch a beam cut wants (grains DROP rather than fountain).
   */
  debrisSpray(x: number, y: number, count: number, radius = 24, gentle = false): void {
    const pool = this.m_debrisPool;
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * TWO_PI;
      // Dirt brown (R=v, G≈v/2, B=0), occasionally a darker clod for texture.
      let v = 24 + Math.floor(Math.random() * 116);
      if (Math.random() < 0.25) v = Math.floor(v * 0.55);
      const speed = gentle ? Math.random() * 10 : 30 + Math.random() * (radius * 2.4);
      const up = gentle ? 0 : radius * (0.3 + Math.random() * 1.3);
      const d: Debris = pool.pop() ?? {x: 0, y: 0, vx: 0, vy: 0, rgba: 0, color: ''};
      const bd = Math.sqrt(Math.random()) * radius; // uniform over the disc AREA, no central spike
      d.x = x + Math.cos(ang) * bd;
      d.y = y + Math.sin(ang) * bd * 0.4;
      // Cosmetic spray is always FLUNG on the wide radial arc — nothing lands, so where it flies is
      // purely a matter of looks (the depositing sibling splits its throw; this one needn't).
      d.vx = Math.cos(ang) * speed;
      d.vy = gentle ? Math.random() * 12 : Math.sin(ang) * speed * 0.7 - up;
      d.rgba = (0xff000000 | (0 << 16) | ((v >> 1) << 8) | v) >>> 0; // ABGR little-endian
      d.color = this.m_debrisColors[v] ?? (this.m_debrisColors[v] = `rgb(${v},${v >> 1},0)`);
      this.m_debris.push(d);
    }
  }

  /**
   * Draw the dirt spray. Every chunk is a single opaque pixel, so instead of one canvas call each
   * they are plotted into a scratch pixel buffer sized to the cloud's bounding box and blitted once
   * — the whole cloud costs ONE drawImage however many chunks it holds. Falls back to per-chunk
   * fillRects with no DOM, or when the cloud has spread so wide the buffer stops paying for itself.
   */
  drawDebris(ctx: CanvasRenderingContext2D): void {
    if (!this.m_debris.length) return;
    let bx0 = Infinity,
      bx1 = -Infinity,
      by0 = Infinity,
      by1 = -Infinity;
    for (const d of this.m_debris) {
      const x = Math.floor(d.x),
        y = Math.floor(d.y);
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
    if (bx1 < bx0) return;
    const dw = bx1 - bx0 + 1,
      dh = by1 - by0 + 1;
    if (typeof document === 'undefined' || dw * dh > DEBRIS.BLIT_MAX_AREA) {
      for (const d of this.m_debris) {
        ctx.fillStyle = d.color;
        ctx.fillRect(Math.floor(d.x), Math.floor(d.y), 1, 1);
      }
      return;
    }
    const buf = this.m_blit.begin(dw, dh); // transparent — the scene must show through the gaps
    if (!buf) return;
    for (const d of this.m_debris) {
      const x = Math.floor(d.x) - bx0,
        y = Math.floor(d.y) - by0;
      buf[y * dw + x] = d.rgba;
    }
    this.m_blit.end(ctx, dw, dh, bx0, by0);
  }

  /** Integrate the dirt spray: gravity, an eased wind push, then die on the ground or off-field. */
  private updateDebris(dt: number, wind?: Vec2): void {
    if (!this.m_debris.length) return;
    const windX = wind ? wind.x * DEBRIS.WIND_ACCEL : 0;
    const windY = wind ? wind.y * DEBRIS.WIND_ACCEL : 0;
    const groundAt = this.m_groundAt;
    let w = 0;
    for (let i = 0; i < this.m_debris.length; i++) {
      const d = this.m_debris[i];
      if (windX !== 0 || windY !== 0) {
        // Same boundary-layer easing the rest of the system uses: chunks near the ground barely
        // drift while high-arcing ones lean on the wind.
        const wf = groundAt ? windProfile(groundAt(d.x) - d.y) : 1;
        d.vx += windX * wf * dt;
        d.vy += windY * wf * dt;
      }
      d.vy += DEBRIS.GRAVITY * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      // NB the ground is sampled again HERE, at the post-step x — a fast chunk crosses columns
      // within a frame, so on a slope this is a different height than the wind easing used.
      if (d.x < this.m_minX || d.x >= this.m_maxX || d.y >= this.m_maxY) {
        this.m_debrisPool.push(d);
        continue; // left the field → recycle
      }
      if (d.vy > 0 && groundAt && d.y >= groundAt(d.x)) {
        this.m_debrisPool.push(d);
        continue; // reached the surface → vanish (it raises nothing)
      }
      this.m_debris[w++] = d;
    }
    this.m_debris.length = w;
  }

  // ========================================================================
  // RADIOACTIVE HEAT HAZE (IFxSink)
  //
  // CLand owns the fallout map and the terrain surface, so it decides WHERE and IN WHAT COLOUR a
  // wisp rises. Everything after that decision — the pool, the physics, the sprite cache, the draw
  // — is particle work and lives here, so CLand runs no private particle system of its own.
  // ========================================================================

  /** Drop every heat wisp — the land is being regenerated, so its haze goes with it. */
  clearAllHeat(): void {
    let w = 0;
    for (const p of this.m_particles) if (p.kind !== 'heat') this.m_particles[w++] = p;
    this.m_particles.length = w;
  }

  /** Drop heat wisps inside a disc — an earth-remover that clears the fallout clears its haze too. */
  clearHeat(x: number, y: number, r: number): void {
    const r2 = r * r;
    let w = 0;
    for (const p of this.m_particles) {
      if (p.kind === 'heat') {
        const dx = p.x - x,
          dy = p.y - y;
        if (dx * dx + dy * dy <= r2) continue; // inside the cleared disc → drop
      }
      this.m_particles[w++] = p;
    }
    this.m_particles.length = w;
  }

  /**
   * Draw the radioactive heat haze. Kept OUT of `draw()` on purpose: these wisps belong visually to
   * the ground, so the controller calls this immediately after the terrain — under the tanks and
   * the aim overlay — rather than with the rest of the particle pool, which paints over both.
   */
  drawHeat(ctx: CanvasRenderingContext2D): void {
    const fallback = this.heatFallback();
    const prev = ctx.globalCompositeOperation;
    // Additive, so the tinted smoke reads as a warm GLOWING haze over any backdrop.
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.m_particles) {
      if (p.kind !== 'heat') continue;
      const t = p.age / p.life;
      if (t >= 1) continue;
      const a = Math.sin(Math.PI * t) * 0.1; // ease in, ease out — a faint hint, not a cloud
      if (a <= 0.005) continue;
      const d = p.size * (1 + t * p.grow); // widen as it rises
      const spr = this.heatTint(p.r, p.g, p.b) ?? fallback;
      if (!spr) continue;
      ctx.globalAlpha = a;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.drawImage(spr, -d, -d, d * 2, d * 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = prev;
  }

  /** Live heat wisps — CLand caps emission on this. */
  heatCount(): number {
    let n = 0;
    for (const p of this.m_particles) if (p.kind === 'heat') n++;
    return n;
  }

  /** Emit one heat wisp. `lift` is its constant rise rate (bigger wisps lift faster). */
  heatWisp(
    x: number,
    y: number,
    size: number,
    life: number,
    vx: number,
    lift: number,
    r: number,
    g: number,
    b: number,
  ): void {
    const p = this.add(x, y, vx, -lift, {r, g, b}, life, size, 'heat', undefined, HEAT_GROW);
    p.rot = Math.random() * TWO_PI;
    p.spin = between(-0.8, 0.8);
  }

  // ========================================================================
  // SIMULATION
  // ========================================================================

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
    this.updateDebris(dt, wind);
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
      if (p.spin !== 0) p.rot += p.spin * dt; // heat wisps tumble slowly as they lift

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

    // Crater vents: after FUME.VENT.DELAY (the flash has faded), keep venting fumes for the whole window
    // — successive generations of rising puffs at a rate ∝ radius that TAPERS to 0 as the vent ages,
    // so the crater smokes for a while then peters out. Each puff lives ∝ radius (spawnVentPuff) and
    // dies independently, so the fumes linger past the vent. Per-vent accumulator → independent craters.
    let vw = 0;
    const settling = this.m_settling;
    for (let i = 0; i < this.m_craterVents.length; i++) {
      const v = this.m_craterVents[i];
      v.age += dt;
      // 1. Silent while the fireball is still blooming.
      if (v.age < v.delay) {
        this.m_craterVents[vw++] = v;
        continue;
      }
      // 2. Then HOLD while the ground is still resolving — spoil in the air, overburden falling,
      //    the surface sinking. This is what makes the fumes read as aftermath instead of arriving
      //    with the blast; without it a nuke smoked while its own ejecta was still coming down.
      if (v.wait < FUME.VENT.MAX_WAIT && settling?.()) {
        v.wait += dt;
        this.m_craterVents[vw++] = v;
        continue;
      }
      // 3. Vent. `emit` is its own clock, so time spent held above costs no emission window.
      v.emit += dt;
      if (v.emit >= v.window) continue; // spent → drop (its puffs live on independently)
      const prog = v.emit / v.window;
      // Emission = a RAMP UP multiplied by the taper. The taper alone starts at full rate, which
      // reads as a chimney being switched on; a crater should open with a wisp and build.
      const attack = Math.min(1, v.emit / v.ramp);
      const env = attack * (1 - prog);
      v.acc += v.r * FUME.RATE * env * dt;
      while (v.acc >= 1) {
        v.acc -= 1;
        this.spawnVentPuff(v.x, v.y, v.r, prog, v.seed);
      }
      this.m_craterVents[vw++] = v;
    }
    this.m_craterVents.length = vw;
  }

  // ========================================================================
  // RENDERING
  // ========================================================================

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

      // Blit the pre-baked glow (its baked 0.4 midpoint is the 3-stop gradient's);
      // fall back to a live gradient only where no canvas exists (tests).
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

  /**
   * Draw the baked exhaust clusters — ONE rotated blit per cluster, replacing the EXHAUST.PUFFS
   * individual blits it stands for.
   *
   * The atlas cell is authored in local space (+X along the emission perpendicular), so each blit
   * needs its own rotation. Rather than save()/rotate()/restore() per particle, the caller's
   * transform (identity on the main ctx, a half-res scale+translate on the smoke buffer) is read
   * ONCE and composed by hand with each cluster's rotate+translate — measured at ~28% over an
   * unrotated blit, versus the per-call state churn save/restore would add.
   */
  private drawExhaust(g: CanvasRenderingContext2D, cullMin: number, cullMax: number): void {
    // Through the cached getter, not the field: setAssets() invalidates the atlas, and any cluster
    // still in flight at that moment would otherwise draw as nothing until something rebuilt it.
    const atlas = this.exhaustAtlas();
    if (!atlas) return;
    // A context stub without getTransform (headless mocks) can't be composed with — fall back to
    // save/restore, which every 2-D context supports.
    const base = typeof g.getTransform === 'function' ? g.getTransform() : null;
    const ba = base ? base.a : 1,
      bb = base ? base.b : 0,
      bc = base ? base.c : 0,
      bd = base ? base.d : 1,
      be = base ? base.e : 0,
      bf = base ? base.f : 0;
    let drew = false;
    for (const p of this.m_particles) {
      if (p.kind !== 'exhaust') continue;
      if (p.x < cullMin || p.x > cullMax) continue;
      const t = p.age / p.life;
      if (t >= 1) continue;
      const frame = Math.min(EXHAUST_ATLAS.FRAMES - 1, (t * EXHAUST_ATLAS.FRAMES) | 0);
      const dw = EXHAUST_ATLAS.CELL_W * p.exScale, // destination size — see EXHAUST_ATLAS.REF_LIFE
        dh = EXHAUST_ATLAS.CELL_H * p.exScale;
      const hw = dw / 2,
        hh = dh / 2;
      const sx = frame * EXHAUST_ATLAS.CELL_W,
        sy = p.exVariant * EXHAUST_ATLAS.CELL_H;
      const c = p.exCos,
        s = p.exSin;
      if (base) {
        // base × translate(p.x, p.y) × rotate(c, s), expanded (the rotation has no shear).
        g.setTransform(
          ba * c + bc * s,
          bb * c + bd * s,
          ba * -s + bc * c,
          bb * -s + bd * c,
          ba * p.x + bc * p.y + be,
          bb * p.x + bd * p.y + bf,
        );
        g.drawImage(atlas, sx, sy, EXHAUST_ATLAS.CELL_W, EXHAUST_ATLAS.CELL_H, -hw, -hh, dw, dh);
      } else {
        g.save();
        g.translate(p.x, p.y);
        g.rotate(Math.atan2(s, c));
        g.drawImage(atlas, sx, sy, EXHAUST_ATLAS.CELL_W, EXHAUST_ATLAS.CELL_H, -hw, -hh, dw, dh);
        g.restore();
      }
      drew = true;
    }
    // Put the caller's transform back so the crater-fume pass below draws in world space.
    if (drew && base) g.setTransform(ba, bb, bc, bd, be, bf);
  }

  /** Draw the smoke puffs to `g` (the main ctx or the half-res buffer): 'smoke' = the plume-table
   *  puff (tank-death column / pre-atlas exhaust), 'fume' = crater smoke on the soft white sprite,
   *  shaded from soot-black to grey by its generation. */
  private drawSmoke(g: CanvasRenderingContext2D, cullMin: number, cullMax: number): void {
    this.drawExhaust(g, cullMin, cullMax);
    const smokeSpr = this.m_assets?.getSprite('fx:smoke') ?? null;
    for (const p of this.m_particles) {
      if (p.kind !== 'smoke' && p.kind !== 'fume') continue;
      if (p.x < cullMin || p.x > cullMax) continue;
      const t = p.age / p.life;
      if (t >= 1) continue;
      const alpha = Math.sin(Math.min(1, t) * Math.PI) * p.op; // per-particle peak opacity
      if (alpha <= 0.01) continue;
      const d = p.size * (0.9 + t * p.grow) * 2; // small at birth → grows over life
      if (p.kind === 'smoke') {
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
        // CRATER FUMES: the soft white sprite, swelling and fading on ABSOLUTE age so the
        // motion reads the same whether the puff lives 1.5s (small crater) or 9s (a nuke) — see
        // FUME.SWELL_TAU. The normalised `t` is used only for the tail fade, which SHOULD stretch
        // with life: that is what keeps a big crater's plume hanging in the sky.
        const swell = 0.9 + p.grow * (1 - Math.exp(-p.age / FUME.SWELL_TAU));
        const tail = Math.min(1, (1 - t) / (1 - FUME.HOLD)); // 1 → 0 across the tail
        // CONTRACT while fading, the way the exhaust puffs do. A puff that keeps its full size and
        // merely fades stays a big disc all the way out, so the very last thing left on screen is
        // its own outline — that is what makes a dying crater cloud break up into visibly separate
        // circles. Pulling the size in as the alpha goes means each puff dissolves instead.
        const fd = p.size * swell * (1 - FUME.SHRINK * (1 - tail)) * 2;
        const fa =
          Math.min(1, p.age / FUME.FADE_IN) * // bloom in fast off the dirt
          tail * // hold, then fade out over the tail
          p.op;
        if (fa > 0.01) {
          // The soot shade is a MULTIPLY over the white sprite, cached in coarse buckets — the GPU
          // path does the same thing with a per-particle tint and no cache at all.
          const spr = this.fumeShade(p.r) ?? this.whiteSmoke() ?? smokeSpr.bitmap;
          g.globalAlpha = fa;
          g.drawImage(spr, p.x - fd / 2, p.y - fd / 2, fd, fd);
          g.globalAlpha = 1;
        }
      } else {
        this.blitGlow(g, p.x, p.y, d / 2, p.r, p.g, p.b, alpha);
      }
    }
  }

  /** Render all particles. Additive kinds are batched to set the blend once. */
  private drawSmokeLayer(ctx: CanvasRenderingContext2D, cullMin: number, cullMax: number): void {
    // GPU path: hand the puffs to the compositor as quads so one batched draw call stands in for
    // the thousands of drawImage calls this layer would otherwise cost. The 2D path below covers
    // headless tests and any host without a smoke sink.
    if (this.m_smokeSink) {
      this.emitSmokeQuads(this.m_smokeSink, cullMin, cullMax);
      return;
    }
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

  /**
   * Describe every live smoke puff as a textured quad in WORLD space. Mirrors the two 2D draw
   * paths term for term — the baked exhaust atlas frame, and the fume/plume sprite with its swell
   * and fade — but emits instead of blitting, so the caller can batch them.
   */
  private emitSmokeQuads(sink: ISmokeSink, cullMin: number, cullMax: number): void {
    const atlas = this.exhaustAtlas();
    const smokeSpr = this.m_assets?.getSprite('fx:smoke') ?? null;
    const white = this.whiteSmoke();
    for (const p of this.m_particles) {
      if (p.x < cullMin || p.x > cullMax) continue;
      const t = p.age / p.life;
      if (t >= 1) continue;

      if (p.kind === 'exhaust') {
        if (!atlas) continue;
        const frame = Math.min(EXHAUST_ATLAS.FRAMES - 1, (t * EXHAUST_ATLAS.FRAMES) | 0);
        sink.smokeQuad(
          atlas,
          frame * EXHAUST_ATLAS.CELL_W,
          p.exVariant * EXHAUST_ATLAS.CELL_H,
          EXHAUST_ATLAS.CELL_W,
          EXHAUST_ATLAS.CELL_H,
          p.x,
          p.y,
          EXHAUST_ATLAS.CELL_W * p.exScale,
          EXHAUST_ATLAS.CELL_H * p.exScale,
          Math.atan2(p.exSin, p.exCos),
          1, // the fade is baked into the atlas frames
        );
        continue;
      }
      if (p.kind !== 'smoke' && p.kind !== 'fume') continue;

      if (p.kind === 'smoke') {
        // The plume-coloured puff (tank-death column, or exhaust before the atlas is baked).
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
        const gs = t < 0.72 ? 0.5 + 2.9 * (t / 0.72) : 3.4 * (1 - (t - 0.72) / 0.28);
        const de = p.size * gs * 2;
        const ea = Math.min(1, t / 0.1) * (t > 0.72 ? (1 - t) / 0.28 : 1) * p.op;
        // The UNTINTED master plus a tint, not m_puffCache.tint(): that cache holds up to 512
        // distinct canvases, and every distinct canvas is a distinct texture source — i.e. its own
        // batch. One master keeps the whole plume layer in a single draw call.
        const puff = this.m_puffCache.master();
        if (!puff || de <= 0 || ea <= 0.01) continue;
        const tint = ((cr & 0xff) << 16) | ((cg & 0xff) << 8) | (cb & 0xff);
        sink.smokeQuad(puff, 0, 0, puff.width, puff.height, p.x, p.y, de, de, 0, ea, tint);
        continue;
      }

      // CRATER FUMES. Same swell/fade curves as the 2D path (see drawSmoke). The soot shade rides
      // as a per-particle TINT on the one white sprite, rather than a tinted canvas per shade —
      // each distinct canvas would be its own texture source, i.e. its own batch.
      const spr = white ?? (smokeSpr?.bitmap as CanvasImageSource | undefined);
      if (!spr) continue;
      const swell = 0.9 + p.grow * (1 - Math.exp(-p.age / FUME.SWELL_TAU));
      const tail = Math.min(1, (1 - t) / (1 - FUME.HOLD));
      const fd = p.size * swell * (1 - FUME.SHRINK * (1 - tail)) * 2;
      const fa = Math.min(1, p.age / FUME.FADE_IN) * tail * p.op;
      if (fa <= 0.01 || fd <= 0) continue;
      const sw = white ? white.width : (smokeSpr?.width ?? 0);
      const sh = white ? white.height : (smokeSpr?.height ?? 0);
      if (!sw || !sh) continue;
      const shade = ((p.r & 0xff) << 16) | ((p.g & 0xff) << 8) | (p.b & 0xff);
      sink.smokeQuad(spr, 0, 0, sw, sh, p.x, p.y, fd, fd, 0, fa, shade);
    }
  }

  // ========================================================================
  // QUERIES
  // ========================================================================

  /** Live particle count (diagnostics / tests). */
  count(): number {
    return this.m_particles.length;
  }

  /**
   * Whether the EXPLOSION itself is still playing — the fireball/flare burst (`m_explosions`), a
   * beam sweep, or its fire/spark particles. Unlike `hasActiveExplosions`, this deliberately IGNORES
   * the lingering `smoke`/`exhaust`/`plume` puffs: those are a port embellishment (the original blasts
   * emit only flares + fire streamers, no drifting smoke), so their multi-second fade must NOT hold
   * the turn open. Gates turn hand-off; the render gate still uses `hasActiveExplosions` so the smoke
   * keeps drawing (and drifting) into the next player's aim phase.
   */
  hasActiveBlast(): boolean {
    if (this.m_explosions.length > 0 || this.m_beams.length > 0) return true;
    for (const p of this.m_particles)
      if (
        p.kind !== 'smoke' &&
        p.kind !== 'plume' &&
        p.kind !== 'exhaust' &&
        p.kind !== 'heat' &&
        p.kind !== 'fume'
      )
        return true;
    return false;
  }

  hasActiveExplosions(): boolean {
    return (
      this.m_particles.length > 0 ||
      this.m_beams.length > 0 ||
      this.m_explosions.length > 0 ||
      this.m_debris.length > 0
    );
  }

  // ========================================================================
  // MEMBER VARIABLES
  // ========================================================================

  // Pre-baked soft radial glow. Drawing each flare/flash/plume/smoke fallback from a live
  // createRadialGradient (+3 addColorStop) costs one allocation per particle per frame — hundreds
  // per blast frame. Instead one white glow sprite is baked once, tinted per colour into a small
  // cache, and blitted with drawImage, so the hot path allocates nothing.
  private static readonly GLOW_SRC = 32; // master glow radius (px); scaled up per particle
  // The master glow's falloff is the flare/flash gradient — solid core, half-alpha midpoint,
  // transparent rim — so blitting it under 'lighter' gives exactly the gradient's look.
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

  // Real sprites (looked up lazily each frame; falls back to procedural draws
  // until they finish loading). 'fx:smoke' = gui/smoke.bmp, 'fx:flare' = flares/04.bmp.
  private m_assets: ISpriteSource | null = null;
  private m_whiteSmoke: HTMLCanvasElement | null = null; // cool-white smoke (crater fumes)

  private m_debris: Debris[] = [];
  private m_debrisPool: Debris[] = []; // free-list — a warm pool allocates nothing per blast
  private m_debrisColors: string[] = []; // CSS strings cached by brightness
  // One-call blit of the debris cloud (see util/PixelBlitter).
  private readonly m_blit = new PixelBlitter();

  // The baked exhaust-cluster atlas: EXHAUST_ATLAS.VARIANTS rows (seeds) × EXHAUST_ATLAS.FRAMES columns (the cohort's
  // life). Null until gui/rocket plume.bmp is available (and always in headless tests, where there
  // is no canvas) — callers fall back to emitting the individual puffs.
  private m_exAtlas: HTMLCanvasElement | null = null;

  // Downward acceleration (px/s^2). Sparks and debris arc and fall; flares and
  // the flash are short-lived enough that gravity barely moves them.
  private m_gravity = 240;

  // Keyed by the weapon's exact radiation rgb. Capped like every other sprite cache: the hues are
  // jittered per blast, so an uncapped map would mint a fresh sprite-sized canvas for every shade
  // seen in a long session and never release one.
  private m_heatTints = new Map<string, HTMLCanvasElement>();
  private m_heatFallback: HTMLCanvasElement | null = null;

  // Clip bounds — particles outside are reaped. Grown generously past the
  // viewport so nothing pops at the edges.
  private m_minX = -200;
  private m_minY = -400;
  private m_maxX = 4000;
  private m_maxY = 3000;

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
  private m_smokeSink: ISmokeSink | null = null; // set → smoke goes to the GPU instead of the canvas

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
}
