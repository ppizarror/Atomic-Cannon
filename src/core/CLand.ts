/**
 * CLand - Terrain Management Class.
 */

import {Vec2} from '../math/Vec2';
import {clamp, clamp01, lerp, smoothstep, TWO_PI} from '../math/num';
import {blotchNoise, hashLattice} from '../math/noise';
import {between, plusMinus} from '../math/random';
import {GameConfig} from './CGameConfig';
import {isRealisticWind, windProfile} from './wind';
import {PixelBlitter} from '../util/PixelBlitter';
import {makeCanvas2d, tryCanvas2d} from '../util/canvas';

// ==========================================================================
// INTERFACES & TYPES
// ==========================================================================

/** A chunk of excavated earth IN TRANSIT. Not a cosmetic particle: it raises the column it lands
 *  on, carries its own contamination, and is thrown from the match-seeded LCG so every client
 *  produces the same terrain. Cosmetic dirt spray — the stuff that flies and vanishes — lives in
 *  CParticleSystem instead (see IFxSink). */
interface SpoilChunk {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string; // dirt-chunk colour, sampled from the terrain palette
  rgba: number; // …the same colour packed, for the pixel-buffer draw path (see `draw`)
  size: number; // chunk size in px
  spin: number; // visual tumble
  age: number; // seconds airborne
  fill: number; // px of column this chunk raises when it settles (see `EJECTA_MAX_CHUNKS`)
  radSlot: number; // colour slot this chunk's earth is contaminated with; −1 = clean soil
}

interface RadParticle {
  x: number;
  y: number;
  radius: number;
  damagePerSecond: number;
  timeRemaining: number;
  duration: number; // irTime (for the visual fade)
  slot: number; // the terrain slot this blast's earth is tagged with — this zone's clock drives it
  r: number;
  g: number;
  b: number;
}

// Visual radiation speck: thrown from the crater, falls under gravity, settles on
// the terrain surface, and glows (additive, tinted by irRGB) fading over its life.
// The gameplay damage lives in RadParticle; these are purely the ground glow.
interface RadSpeck {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  settled: boolean;
  size: number;
  rise: number; // height ABOVE the surface once settled (position within the fallout pile)
  zx: number; // x of the blast that threw this grain — how far out it LANDS sets its coat depth
  zr: number; // that blast's zone radius (the depth taper is measured against it)
  hold: number; // seconds it hangs in the fireball before gravity takes it
  raining: boolean; // thrown from a mid-air burst: it has no crater to stay inside, so it may spread
  slot: number; // which radiation COLOUR this grain deposits (index into the terrain's slot palette)
  phase: number; // random glow-pulse phase (so specks shimmer INDEPENDENTLY, no coherent wave)
  pw: number; // random glow-pulse angular rate (each speck breathes at its own speed)
  r: number;
  g: number;
  b: number; // tint (from the weapon's irRGB, per zone)
}

/**
 * Where the radioactive heat haze goes. CLand owns the fallout map and the terrain surface, so it
 * decides WHERE a wisp rises and in what colour — but a wisp is a particle, and particles are
 * CParticleSystem's job. CLand talks to it through this one-method-per-need interface rather than
 * holding a particle system of its own.
 */
export interface IFxSink {
  /** Cosmetic dirt spray — flies and vanishes, raising nothing (a beam cut's dust). */
  debrisSpray(x: number, y: number, count: number, radius: number, gentle?: boolean): void;
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
  ): void;
  heatCount(): number;
  clearHeat(x: number, y: number, r: number): void;
  clearAllHeat(): void;
}

/** A compression wave travelling out from a detonation, compacting the soil as it passes. */
interface Shock {
  cx: number; // ground zero
  radius: number; // how far the wave reaches
  maxSink: number; // px the surface drops directly under the blast
  front: number; // how far the wave has travelled so far
}

/** A falling overburden block (beam/digger slice collapse): a captured column of pixels — the cap
 *  and earth above a cut — sliding DOWN under gravity to land on the substrate below. */
interface Fall {
  col: number;
  y: number;
  thick: number;
  target: number;
  vel: number;
  colors: Uint32Array;
  // Packed material byte per captured pixel: the dirt tag AND how radioactive that earth is, so a
  // sliding cliff carries its fallout down with it instead of leaving it hanging at the height the
  // surface had before the slide.
  mats: Uint8Array;
}

// ==========================================================================
// TUNING
// ==========================================================================

/**
 * The layer of soil a blast turns over across its fresh crater face, and the bed the fallout
 * settles into. How THICK it is comes from `CLand.coatDepth`; these two are what make its edge
 * read as mixed ground rather than as a pasted shape.
 */
const COAT = {
  /** Blotch scale (px) that warps the mixing zone. This octave does NOT cut the boundary (the
   *  per-pixel dither does that) — it only makes the mix reach deeper in some places than others,
   *  so the transition wanders instead of fading out at one even rate. */
  CELL: 38,
  /** Fraction of the band that is turned over SOLIDLY before the fringe starts to break up. Without
   *  it the crater's own face gets holes in it, which reads as a chewed rim, not a soft one. */
  SKIN: 0.5,
} as const;

/**
 * Thrown earth: how much of it a blast turns over, how it flies, and how the pile settles.
 */
const DIRT = {
  /** Past this many pixels of bounding box, plotting the dirt cloud into a buffer costs more to
   *  clear than the canvas calls it saves, so the per-chunk path is used instead. */
  BLIT_MAX_AREA: 1_600_000,
  /** Max deposit height: dirt cannot pile above this screen-Y (a fraction of world height from the
   *  top). A chunk landing on a capped column is discarded, so tall stacks (Land Fill) FLAT-TOP
   *  into a mesa instead of spiking — matching the original's deposit-height settle gate. */
  CAP_FRACTION: 0.16,
  /** Debris count = `earth × radius × this`. Factoring radius in makes the PEAK scale with `earth`
   *  (Mountain, earth 90, piles biggest) while WIDTH tracks radius (Dirty Boy r15 broader than
   *  Dirtox r10). Each landed chunk raises a column +1px; repose + a rounding pass then settle it. */
  DEPOSIT_VOLUME: 5.5,
  /** Chunks are born across a disc of `radius × this`, so the pile is BROAD (a wide dome) rather
   *  than a tall spire — the legacy Mountain is a broad hill. Wider disc → wider base, lower peak
   *  (same volume). */
  DISC_SPREAD: 2.0,
  /** Share of a crater's DEPOSITING ejecta thrown on the wide radial arc instead of nearly straight
   *  up — the clods that sail out and land well away from the blast. They deposit where they fall,
   *  so this is earth genuinely carried off the crater: enough to watch, not enough to empty the
   *  hole. */
  FLUNG_FRACTION: 0.15,
  /** Fall acceleration (px/s²) for the dirt this land throws. There is no single global gravity in
   *  the codebase: 500 is what shots and debris use and is the de facto world value, while tanks
   *  (400), smoke (240) and crates (95) take lower ones as a cheap stand-in for air resistance
   *  rather than as different physics. */
  GRAVITY: 500,
  /** Frames the rounding pass waits before it starts. ZERO — it runs from the very first chunk, so
   *  the pile looks smooth AS IT BUILDS rather than spiky-then-round. */
  SMOOTH_DELAY: 0,
  /** Box-3 averaging passes that round the raw angle-of-repose cone into a SMOOTH mound. Spans the
   *  settle (~1 pass/frame) then stops, so it rounds without flattening the pile away. */
  SMOOTH_PASSES: 110,
  /** Horizontal scatter (px/s), SIGNED and random rather than outward, so it widens the cloud
   *  without biasing where the earth lands. Down at 12 the throw is so nearly vertical that a big
   *  blast's spoil rises as a straight-sided column of dirt the exact width of its own crater. */
  THROW_SCATTER: 42,
  /** Launch speed (px/s). Chunks go mostly STRAIGHT UP, then rain back down NEAR where they were
   *  born — so the pile takes the shape of the birth DISC (dome-weighted: a uniform-area disc drops
   *  more dirt at the centre). A radial-OUTWARD throw instead lands chunks in a RING → a
   *  double-peaked crater-mound, so the launch is deliberately vertical. The SPREAD of arc heights
   *  is what staggers the landings; one flat speed snaps the whole cloud down in a single frame. */
  THROW_UP: [35, 105],
} as const;

/**
 * How the settled coat is DRAWN. Purely visual: the radiation channel stays solid underneath, so
 * `radiationAt` and burial are unaffected by every figure in here.
 */
const GLOW = {
  /** How strongly the bloom halo is added under the sharp specks. */
  BLOOM_ALPHA: 0.85,
  /** How hard the glow layer is shrunk before being blown back up — bigger = softer, wider halo. */
  BLOOM_SHRINK: 10,
  /** Dot radii (px) the settled grains are drawn at. */
  DOT: [1.5, 5.5],
  /** Share of hot pixels actually lit. Has to be LOW because the coat is a solid BODY, not a
   *  surface: a nuke's spoil is contaminated 40-70px deep, so the dots stack in depth as well as
   *  across. A dot of radius r covers ~πr², so the lit area runs at density × πr² ≈ density × 20 —
   *  at 0.4 that is 16× coverage, every dot fuses into its neighbours and the size variety vanishes
   *  inside one blob. It trades against dot SIZE, since coverage is the product: shrinking the dots
   *  buys back room for more of them at the same fused-ness. Sparse-and-large (0.06 at 3.6px) reads
   *  as individual specks but too few of them; the same coverage carried by ~3× as many smaller
   *  dots is what reads as scattered fallout rather than a handful of blobs. */
  DOT_DENSITY: 0.22,
  /** How many steps across the `DOT` range a grain can pick from (see `GLOW_KERNELS`). */
  DOT_SIZES: 4,
  /** Brightness of one fully-hot pixel of ground. Well above 1 because a pixel lights only ITSELF:
   *  the bleed reaches clean ground only, so an interior pixel collects ONE contribution (its own)
   *  rather than the five it would get with its four neighbours bleeding in, and at a gain near 1 a
   *  solid body of hot fill comes out three times darker than a sparse coat. Above
   *  1 the red channel of a fully-hot pixel clips, which is wanted — that is the coat reading as
   *  saturated rather than washed — while green and blue stay low, so it saturates toward its own
   *  hue instead of blowing out to white-gold. */
  GAIN: 3,
  /** Clean pixels tolerated inside a run of hot earth before it counts as ENDED. Radioactivity is
   *  lit from the surface DOWNWARD through the contiguous hot body (see `drawRadGlow`), rather than
   *  to a fixed depth: a nuke's spoil is hot all the way through, so a fixed film would light a
   *  token skin of a 60px-deep bowl of contaminated fill and leave the mass under it dead.
   *  Contiguity still hides a coat genuinely BURIED under later clean fill: that fill cuts it off
   *  from the surface, so the walk stops before reaching it and it never shows through. The
   *  tolerance only spans the odd clean pixel that repose and the coat's dither leave. */
  GAP: 3,
  /** Swing either side of `PULSE_BASE`. */
  PULSE_AMP: 0.28,
  /** The twinkle itself — a bucket's brightness rides `PULSE_BASE ± PULSE_AMP` at `PULSE_RATE`. */
  PULSE_BASE: 0.72,
  /** How many phase groups the settled coat is scattered over. More = finer twinkle, at one extra
   *  blit each; three already breaks up the "whole map breathing as one" read. */
  PULSE_BUCKETS: 3,
  /** Angular rate (rad/s) of that ride. */
  PULSE_RATE: 2.6,
  /** How strongly a grain bleeds through its kernel onto the ground around it — the softness of the
   *  join between contaminated earth and clean (see `GLOW_KERNELS`). */
  SPREAD: 0.95,
} as const;

/** The soft kernels a hot grain bleeds through, one per SIZE. A grain marks a single pixel, so a
 *  fixed kernel draws every grain the same and the coat comes out an even stipple — the original's
 *  fallout was a scatter of chunky dots of visibly different sizes, and that variety is most of what
 *  made it read as thrown material rather than as texture. Each grain picks a kernel by a
 *  world-keyed hash, so its size is stable across rebuilds and identical on every client. Built once
 *  — the inner loop just walks the one it is handed. */
const GLOW_KERNELS = ((): {dx: number; dy: number; w: number}[][] => {
  const kernels: {dx: number; dy: number; w: number}[][] = [];
  const [rMin, rMax] = GLOW.DOT;
  for (let i = 0; i < GLOW.DOT_SIZES; i++) {
    // Radii spread across the range; the widest dots are also the softest, so a big grain reads as
    // a bloom rather than a hard disc.
    const R = rMin + (i * (rMax - rMin)) / Math.max(1, GLOW.DOT_SIZES - 1);
    const span = Math.ceil(R);
    const k: {dx: number; dy: number; w: number}[] = [];
    for (let dy = -span; dy <= span; dy++)
      for (let dx = -span; dx <= span; dx++) {
        const d = Math.hypot(dx, dy);
        if (d === 0 || d > R) continue;
        // Solid core, thin soft rim — NOT a gaussian. A gaussian dot is mostly falloff, so as soon
        // as the coat gets dense the tails overlap and the specks melt into one smooth mass; the
        // original's fallout stayed legible as individual grains even packed tight because each
        // grain was a hard little mark. A flat core lets density go up without fusing.
        const rim = Math.max(0.6, R - 1);
        const w = d <= rim ? 1 : Math.max(0, 1 - (d - rim) / (R - rim + 0.001));
        k.push({dx, dy, w: GLOW.SPREAD * w});
      }
    kernels.push(k);
  }
  return kernels;
})();

/** Margin (px) the baked glow layer carries beyond the hot earth's bounding box. It has to hold
 *  BOTH of the things that paint past the last hot pixel, or they are sliced off square against the
 *  canvas edge and the coat ends in a visible RECTANGLE — worst exactly where the coat is
 *  brightest, along a crater's rim, since that is where the hot earth runs closest to the box:
 *  - the widest grain KERNEL (`GLOW.DOT[1]`), which bleeds a dot that far onto neighbouring ground;
 *  - the BLOOM, which is the layer shrunk `BLOOM_SHRINK`:1 and blown back up, so a lit pixel smears
 *    roughly that many px in every direction — and being the soft part, its clipping is what reads
 *    as a straight cut rather than as a hard-edged dot.
 *  Cost is one bake of a slightly larger buffer per terrain edit, which is why the pad is derived
 *  from those two rather than set generously. */
const GLOW_PAD = Math.ceil(GLOW.DOT[1]) + GLOW.BLOOM_SHRINK;

/**
 * Heat haze over contaminated ground. The wisps read as a fine SHIMMER, so they want to be
 * many-and-small rather than few-and-large: a handful of big stamps reads as pasted blobs, whereas
 * a dense field of small soft puffs reads as haze. Cost is linear in the cap and these are tiny, so
 * a high cap is cheap.
 */
const HEAT = {
  /** Live wisps allowed at once. High enough that they overlap into haze instead of reading as
   *  separate stamps. */
  MAX: 260,
  /** Spawn attempts per zone per frame. Several, so a zone fills to that population quickly rather
   *  than trickling up to it over seconds. */
  PER_ZONE: 3,
  /** Base radius (px). Deliberately small — at a radius in the 5..12 range each wisp is a legible
   *  blob rather than a wisp, and the field reads as scattered smoke. */
  SIZE: [2.5, 5.5],
} as const;

/**
 * The material byte packs TWO properties of a pixel of earth. Bit 0 is the dirt tag (deposited fill
 * vs native land, what the scorch reads so it burns both alike); bits 1-4 are how radioactive that
 * earth is; bits 5-7 are which blast contaminated it. Radioactivity wanted a per-pixel home and this
 * byte had seven bits spare — a second full-world buffer would have cost another W×H for nothing,
 * and those are already the largest steady-state allocation here. Packing them also makes the
 * coupling FREE: every terrain edit already rewrites this byte, so earth arriving is clean and earth
 * leaving takes its radioactivity with it without a single line spent saying so.
 */
const MAT = {
  /** Fully hot — 4 bits. */
  RAD_MAX: 15,
  /** How many BLASTS can have independent contamination on the map at once — 3 bits' worth. A slot
   *  is one detonation: its colour AND its clock, so each patch of poisoned earth fades on the timer
   *  of the blast that made it. Not one slot per colour — two Uranium craters an hour apart are not
   *  the same contamination, and sharing a slot flares the older one back to full brightness the
   *  moment the newer one lands. Which of the two properties has to live in the PIXEL is the same
   *  argument either way: asked per frame off the live zones, a coat takes the identity of whichever
   *  zone happens to be nearest and alive, so a blue crater turns red when a uranium blast lands
   *  beside it. The earth has to remember what contaminated it. */
  RAD_SLOTS: 8,
} as const;

/**
 * Fallout: the grains a contaminating blast throws, and the radioactivity they leave in the earth.
 * Where that is STORED is `MAT`; how it is DRAWN is `GLOW`.
 */
const RAD = {
  /** How far below a column's surface counts as "standing on radioactive ground" for damage. The
   *  coat is packed against the surface, so this only has to cover the contact layer. */
  CONTACT_DEPTH: 10,
  /** How hot one pixel of a radioactive blast's own SPOIL is. Below a settled grain's stamp: the
   *  dirt is contaminated throughout, while the fine ash that rains down afterwards concentrates at
   *  the surface — so a bowl of hot fill reads as a deep body of glowing earth with a hotter skin
   *  on it, rather than as one flat slab of red. */
  EJECTA_AMOUNT: 8,
  /** Pixels of pile one landed grain lays down. ONE: the airborne cloud draws as a single blit
   *  whatever its size, so a fatter slug buys no cheap depth — it only quantises the coat, stepping
   *  a column that lands five grains more than its neighbour by 10px instead of 5. Fine grains,
   *  more of them, smoother surface, same cost. */
  GRAIN_DEPTH: 1,
  /** Fall acceleration (px/s²). The grains are the same thrown earth as `DIRT.GRAVITY`, so they
   *  fall at nearly the same rate. Not identical: they have to finish landing while the crater's
   *  spoil is still piling in, or the fill ends up on top of the coat rather than mixed through it
   *  and the contaminated body reads as a thin skin over clean fill. Measured on a Uranium Nuke,
   *  hot depth through the bowl holds up to 430 and collapses (8+ → 6.3) at 500, so this sits at
   *  the fast end of what stays mixed. */
  GRAVITY: 430,
  /** Seconds a ground-burst grain hangs before it starts to fall. ZERO. A hang would only be there
   *  to land the fallout after the crater's ejecta stops raising the floor, so the fill cannot bury
   *  the coat — but the spoil a contaminating blast throws lands hot itself (`EJECTA_AMOUNT`), so a
   *  grain the fill covers is covered by MORE hot earth, not by sterile soil. With nothing to
   *  sequence the grains simply fall: no hang, no drifting descent, and gravity is free to be what
   *  it should be. Kept named so the constraint stays on record. */
  HOLD: [0, 0],
  /** How far either side a landing grain looks for a lower spot. Wider averages more of the landing
   *  randomness out of the coat's surface. Measured: widening it to 7 changed nothing, so the
   *  remaining raggedness is NOT landing randomness — see the note on `radPileTop`. */
  LEVEL_SPAN: 3,
  /** How much longer the fallout GLOWS than the weapon's raw irTime. The damage window is the same
   *  number, so this is the ground staying visibly hot after it stops being dangerous. */
  LINGER: 2.8,
  /** Deepest a column's fallout pile may grow. A cap, not a shape — the shape comes from how many
   *  grains actually landed. */
  PILE_MAX: 40,
  /** How hot one landed grain makes its pixel, drawn up to `MAT.RAD_MAX`. Piling means each pixel
   *  is marked by exactly ONE grain, so a weak stamp leaves the entire coat dim rather than shading
   *  it — no variation can come from grains overlapping, so it all has to come from the draw. */
  STAMP_MIN: 9,
  /** Upward launch (px/s) of ground-burst fallout. ZERO — the original gives its specks no upward
   *  kick at all: the angle is `rand%360` and the speed a flat [2,10], an isotropic spill that goes
   *  down as often as up, so the cloud never rises above the disc it was born in and the plume's
   *  height IS the blast radius. A kick here buys airtime — the grains do have to land after a
   *  crater's ejecta finishes refilling the hole — but it buys it the expensive way, throwing the
   *  fallout into a mushroom twice the height of the blast.
   *
   *  The airtime is there for free: grains spawn across the whole disc, so one born at the top has
   *  the full radius to fall. Slowing `GRAVITY` buys the same seconds aloft while the cloud stays
   *  inside its own radius, which is what the original looks like. Kept as a named range rather
   *  than deleted because the ORDERING it protects is real — see `radPileTop`. */
  UP: [0, 0],
} as const;

/**
 * Soil compaction: the compression wave a nuke-class blast sends out through the ground. It removes
 * nothing — the surface drops because the soil under it is packed tighter — which is what lets it
 * reach well past the crater without erasing the map.
 */
const SHOCK = {
  /** Blotch scale of the wave's falloff — broad undulation in the compacted ground rather than
   *  column-to-column jitter, which just reads as noise on the surface line. */
  CELL: 48,
  /** How fast a column pays off its queued subsidence (px/s). Low enough that the ground eases down
   *  behind the wavefront instead of stepping, high enough to be finished within the blast. */
  SINK_RATE: 55,
  /** How fast the wave travels outward (px/s). Matched to the screen ripple the same blast fires
   *  (`ShockwaveFilter` speed 900), so the ground gives way exactly under the visible wavefront
   *  instead of lagging behind it as a second, slower event. */
  SPEED: 900,
  /** Minimum depth of soil the wave squeezes — how far down the compression is visible before the
   *  strata return to their normal spacing. */
  SQUASH: 70,
  /** Band depth as a multiple of the sink, when that is the larger of the two. 4 means the squeezed
   *  soil ends up at 3/4 of its original spacing however deep the ground drops. */
  SQUASH_RATIO: 4,
} as const;

/**
 * Sideways acceleration (px/s²) a unit of wind imparts to airborne material. Only applied in
 * Realistic wind mode; Linear mode leaves flight purely ballistic (the classic feel).
 */
const WIND_ACCEL = {
  /** Flying dirt chunks. Dirt is heavy, so this is well below smoke's push — high-arcing ejecta
   *  leans on the wind, low chunks barely. */
  DEBRIS: 12,
  /** Airborne fallout specks. Ash is far lighter than dirt clods, so it streams downwind into a
   *  leaning plume as it settles — but the altitude profile eases it near the ground, so specks
   *  still land on/near their radiation zone (the damage area itself never moves). */
  FALLOUT: 26,
} as const;

// ==========================================================================
// CLand CLASS
// ==========================================================================

export class CLand {
  // ========================================================================
  // STATIC HELPERS
  // ========================================================================

  /**
   * The shared profile for anything a blast COATS onto the crater face — how thick the layer is at
   * horizontal offset `dx` from a blast of radius `r`, given its thickness `full` at ground zero.
   *
   * `full` under the detonation easing to a few px at the rim, so a coat piles up where the blast
   * was and runs out as it climbs the bowl. Both the soil the carve lays down and the fallout that
   * settles on it run through here: they cover the same hole, so a coat with its own private
   * thickness curve reads as a second, unrelated shape drawn over the first.
   */
  private static coatDepth(dx: number, r: number, full: number): number {
    const t = r > 0 ? Math.min(1, Math.abs(dx) / r) : 1;
    return 4 + (full - 4) * (1 - t * t);
  }

  /** How radioactive a pixel's material byte says its earth is — bits 1-4 (see `MAT`). */
  private static matRad(b: number): number {
    return (b >>> 1) & MAT.RAD_MAX;
  }

  /** Both halves written back at once, preserving the dirt tag in bit 0. */
  private static matSetRad(b: number, rad: number, slot: number): number {
    return (b & 1) | (Math.min(MAT.RAD_MAX, rad) << 1) | ((slot & 7) << 5);
  }

  /** Which detonation contaminated that earth — bits 5-7, an index into `m_radSlotRGB`. */
  private static matSlot(b: number): number {
    return (b >>> 5) & 7;
  }

  /** A weapon's fallout colour, defaulting to a hot radioactive red-orange: nukes/DOT ship no
   *  explicit irRGB. Shared so the SPOIL and the FALLOUT of one blast resolve to the same terrain
   *  slot — they are the same contamination and must not end up drawn as two colours. */
  private static radRGB(rgb?: [number, number, number]): [number, number, number] {
    return rgb && (rgb[0] || rgb[1] || rgb[2]) ? rgb : [255, 46, 20];
  }

  // ========================================================================
  // CONSTRUCTION & INITIALIZATION
  // ========================================================================

  constructor(width: number = 800, height: number = 480) {
    this.m_nWidth = width;
    this.m_nHeight = height;

    this.m_arrHeights = new Int16Array(width);

    const baseHeight = Math.floor(height * 0.75);
    for (let x = 0; x < width; x++) {
      this.m_arrHeights[x] = baseHeight;
    }

    this.m_spoil = [];
    this.m_radParticles = [];
  }

  /**
   * Drop everything IN FLIGHT or deposited ON this land — falling overburden, airborne spoil,
   * fallout specks, live radiation zones and the haze over them — because the world underneath is
   * being rebuilt or thrown away. The heightmap and the pixel buffers are NOT touched here; each
   * caller owns what it does with those.
   */
  private clearTransient(): void {
    this.m_falls.length = 0;
    this.m_spoil.length = 0;
    this.m_radSpecks.length = 0;
    this.m_radParticles.length = 0;
    this.m_fxSink?.clearAllHeat(); // the land is being rebuilt — its haze goes with it
    this.m_radEventSlot.clear(); // …and no contamination event survives a new world
  }

  /** The per-column surface heightmap (live reference — copy before mutating). */
  getHeights(): Int16Array {
    return this.m_arrHeights ?? new Int16Array(0);
  }

  /**
   * Reconcile the whole terrain to an authoritative heightmap (network sync). Unlike
   * `initFromArray` (heights only), this repaints every changed column via
   * `setColumnTop`, so both the COLLISION heights and the RENDERED bitmap match —
   * a remote player's craters/deposits actually appear on a spectator's screen.
   */
  setHeightmap(heights: readonly number[] | Int16Array): void {
    const h = this.m_arrHeights;
    if (!h) return;
    const n = Math.min(heights.length, this.m_nWidth);
    for (let x = 0; x < n; x++) {
      if (h[x] !== heights[x]) this.setColumnTop(x, heights[x]);
    }
    this.computeDirtyRegion();
  }

  initFromArray(heights: Int16Array, _scaleX: number = 1, scaleY: number = 1): void {
    if (!this.m_arrHeights) return;
    const len = Math.min(heights.length, this.m_nWidth);

    for (let x = 0; x < len; x++) {
      const scaledHeight = heights[x] * scaleY;
      this.m_arrHeights[x] = clamp(Math.floor(scaledHeight), 0, this.m_nHeight);
    }

    this.computeDirtyRegion();
  }

  // ---- RNG ---------------------------------------------------------------
  // A linear congruential generator, so a level is reproducible from its seed.
  private m_rngState: number = 1;

  private srand(seed: number): void {
    this.m_rngState = seed >>> 0;
  }

  /** rand() in 0..32767 (LCG: state = state*0x343FD + 0x269EC3; (state>>16)&0x7FFF). */
  private rand(): number {
    this.m_rngState = (Math.imul(this.m_rngState, 0x343fd) + 0x269ec3) >>> 0;
    return (this.m_rngState >>> 16) & 0x7fff;
  }

  /** Uniform [0,1). */
  private rand01(): number {
    return this.rand() / 32767;
  }

  /**
   * Generate terrain: pick a shape mode (0..5) then fill a seeded biased
   * random walk. Mode 5 config = "random": 50% mode 5,
   * else one of 0..4. All modes share one RNG stream seeded here.
   */
  generateRandomTerrain(seed: number = Date.now()): void {
    this.srand(seed >>> 0);
    let mode: number;
    if ((this.rand() & 1) === 0) {
      mode = 5; // 50%: fully-random / mountainous
    } else {
      mode = this.rand() % 5; // 50%: one of 0..4
    }
    this.generateProfile(mode);
  }

  /** Force a specific shape mode (0..5) with a given seed. */
  generateTerrainMode(mode: number, seed: number = Date.now()): void {
    this.srand(seed >>> 0);
    this.generateProfile(mode);
  }

  /**
   * DEV/test terrain: a perfectly flat surface at ~⅔ down the map — useful for eyeballing
   * weapon effects (deposits, craters, strata) without natural slopes confounding the read.
   */
  generateFlat(): void {
    if (!this.m_arrHeights) return;
    this.clearTransient();
    const y = Math.floor(this.m_nHeight * 0.62);
    for (let x = 0; x < this.m_nWidth; x++) this.m_arrHeights[x] = y;
    if (this.m_baseHeights) this.m_baseHeights.fill(y);
    this.m_needsBake = true;
    this.computeDirtyRegion();
  }

  /**
   * Release the world-sized buffers. A Land-Size change spawns a fresh `new CLand`; without this
   * the OLD land's several full-world RGBA copies (terrain buffer + terrain/backdrop/debug canvas
   * backing stores) linger until the next GC WHILE the new land bakes its own — a transient that
   * roughly DOUBLES the terrain footprint (hundreds of MB at Massive size on a big display).
   * Zeroing a canvas's width/height frees its backing store immediately, and nulling the typed-array
   * views lets the old ImageData buffers be reclaimed before the replacement allocates.
   */
  dispose(): void {
    this.clearTransient();
    this.m_spoilPool.length = 0;
    this.m_speckPool.length = 0;
    for (const c of [this.m_terrainCanvas, this.m_backdropCanvas, this.m_debugCanvas]) {
      if (c) c.width = c.height = 0; // free the backing store now, not at the next GC
    }
    this.m_terrainCanvas = this.m_backdropCanvas = this.m_debugCanvas = null;
    this.m_terrainImage = this.m_debugImage = null;
    this.m_pixels = null;
    this.m_material = null;
    this.m_radBoxX1 = this.m_radBoxY1 = -1; // hot-earth extent goes with it
    this.m_dirtTile = null;
  }

  // The 6 shape modes. Screen-Y: smaller = higher on screen, so
  // Ymin is the highest peaks can reach, Ymax the lowest valleys.
  private generateProfile(mode: number): void {
    if (!this.m_arrHeights) return;
    this.m_needsBake = true; // fresh heights → repaint the pixel buffer
    const W = this.m_nWidth;
    this.clearTransient();
    this.m_shocks.length = 0;
    this.m_sinkX1 = -1;
    this.m_sinkX0 = 0;
    const A = 15; // walk amplitude
    const Ymin = Math.floor(this.m_nHeight * 0.3); // top clamp
    const Ymax = Math.floor(this.m_nHeight * 0.82); // bottom clamp

    // Horizontal smoothing scale. The walk's step size is fixed in pixels, so on a SHORT
    // view (mobile / small window) it crosses the smaller height band in few columns and
    // clamps hard against it — steep, aggressive cliffs. Widening the smoothing window on
    // short views spreads those transitions over more columns (gentle rolling slopes)
    // WITHOUT lowering the terrain (the peaks still reach the band). `hs` < 1 on short
    // views → a larger blur radius below. Net play uses a fixed 720px view, so all peers
    // share the same radius and stay deterministic.
    const hs = clamp(this.m_nHeight / 780, 0.5, 1.25);
    const smoothRadius = Math.max(6, Math.round(W / (180 * hs)));

    if (mode === 0) {
      // Flat + uncorrelated ±15 noise (jagged plateau).
      this.rand(); // one throwaway draw
      const base = Math.floor((Ymin + Ymax) / 2);
      for (let x = 0; x < W; x++) {
        let y = base + (this.rand() % 30) - 15;
        if (y < Ymin) y = Ymin;
        else if (y >= Ymax) y = Ymax - 1;
        this.m_arrHeights[x] = y;
      }
      // Box-blur the profile into soft rolling curves.
      this.smoothProfile(smoothRadius, 2);
      this.computeDirtyRegion();
      return;
    }

    // Modes 1..5: biased random walk, four quarters each with a (lo,hi) drift.
    let start: number;
    const win: [number, number][] = [
      [-A, A],
      [-A, A],
      [-A, A],
      [-A, A],
    ];

    switch (mode) {
      case 1: // hill / mound
        start = Ymax;
        win[0] = [-7, 7];
        win[1] = [-3, 1];
        win[2] = [0, 4];
        win[3] = [-7, 7];
        break;
      case 2: // valley / basin
        start = Ymin;
        win[0] = [-7, 7];
        win[1] = [-1, 6];
        win[2] = [-5, 2];
        win[3] = [-7, 7];
        break;
      case 3: {
        // ramp / cliff
        const coin = this.rand() & 1;
        start = coin ? Ymax : Ymin;
        const q3: [number, number] = start === Ymin ? [0, 10] : [-10, 0];
        win[0] = [-7, 7];
        win[1] = [-7, 7];
        win[2] = q3;
        win[3] = [-7, 7];
        break;
      }
      case 4: {
        // planar linear slope + jitter
        const coin = this.rand() & 1;
        start = coin ? Ymax : Ymin;
        const s = ((coin ? -1 : 1) * (Ymax - Ymin)) / W;
        const j = 2;
        for (let q = 0; q < 4; q++) win[q] = [s - j, s + j];
        break;
      }
      case 5: // rough / mountainous
      default:
        start = Ymin + (Ymax - Ymin) * this.rand01();
        break; // windows already ±A
    }

    const q1 = W >> 2,
      q2 = W >> 1,
      q3 = (3 * W) >> 2;
    let prev = start;
    this.m_arrHeights[0] = Math.round(clamp(start, Ymin, Ymax));
    for (let x = 1; x < W; x++) {
      const q = x < q1 ? 0 : x < q2 ? 1 : x < q3 ? 2 : 3;
      const [lo, hi] = win[q];
      prev = clamp(prev + this.rand01() * (hi - lo) + lo, Ymin, Ymax);
      this.m_arrHeights[x] = Math.round(prev);
    }

    // Box-blur the profile into soft rolling curves (wider window on short views).
    this.smoothProfile(smoothRadius, 2);
    this.computeDirtyRegion();
  }

  /** Windowed box blur of the height profile — turns the jagged walk into soft curves. */
  private smoothProfile(radius: number, passes: number): void {
    if (!this.m_arrHeights) return;
    const W = this.m_nWidth;
    for (let p = 0; p < passes; p++) {
      const src = Int16Array.from(this.m_arrHeights);
      for (let x = 0; x < W; x++) {
        const lo = Math.max(0, x - radius);
        const hi = Math.min(W - 1, x + radius);
        let sum = 0;
        for (let xi = lo; xi <= hi; xi++) sum += src[xi];
        this.m_arrHeights[x] = Math.round(sum / (hi - lo + 1));
      }
    }
  }

  // ========================================================================
  // TERRAIN DEFORMATION
  // ========================================================================

  /**
   * Slice-carve at a column: remove only the part of the [y-half, y+half] band that
   * is BELOW the current surface, then let all the earth above it FALL DOWN to fill
   * the gap — so the surface drops by the removed slice, NOT down to the cut. This is
   * how a ray/digger cuts *through* a mass on our heightmap (which can't hold a
   * floating tunnel): it takes a slice and the overburden collapses onto it. Returns
   * the thickness removed (0 if the band was entirely in open air here).
   */
  private sliceColumn(col: number, y: number, halfTop: number, halfBottom = halfTop): number {
    const h = this.m_arrHeights;
    const px = this.m_pixels;
    if (!h) return 0;
    const surf = h[col];
    const b0 = Math.max(surf, Math.floor(y - halfTop)); // band top, clamped to the surface
    const b1 = Math.min(this.m_nHeight, Math.ceil(y + halfBottom)); // band bottom
    const removed = b1 - b0;
    if (removed <= 0) return 0; // band is above the surface here → nothing to cut

    if (px) {
      const W = this.m_nWidth;
      const mat = this.m_material;
      const overThick = b0 - surf; // the intact overburden ABOVE the band (cap + earth)
      if (overThick > 0) {
        // Capture the overburden's pixels (grass cap + earth) so they slide DOWN INTACT,
        // then clear both it and the band. A falling block drops it under gravity to land
        // on the substrate below, filling the cut — the "upper section falls down".
        const colors = new Uint32Array(overThick);
        const mats = new Uint8Array(overThick);
        // The block's radioactivity travels WITH it. Captured here and cleared below like the
        // pixels, so a cliff sliding down does not leave its fallout hanging in the air at the
        // height it fell from — the block is the same earth, just lower.
        for (let i = 0; i < overThick; i++) {
          colors[i] = px[(surf + i) * W + col];
          if (mat) mats[i] = mat[(surf + i) * W + col];
        }
        for (let yy = surf; yy < b1; yy++) {
          px[yy * W + col] = 0;
          if (mat) mat[yy * W + col] = 0;
        }
        this.m_radGlowDirty = true;
        this.m_falls.push({col, y: surf, thick: overThick, target: surf + removed, vel: 0, colors, mats}); // prettier-ignore
        h[col] = surf; // surface = the falling block's (current) top
      } else {
        // The cut starts at the surface — just remove the band from the top.
        for (let yy = surf; yy < b1; yy++) {
          px[yy * W + col] = 0;
          if (mat) mat[yy * W + col] = 0;
        }
        h[col] = b1;
      }
    } else {
      h[col] = b1; // headless/no-pixel fallback: just drop the surface
    }
    this.m_pixelsDirty = true;
    return removed;
  }

  /** Clamp a raw column span to the terrain's valid range [0, width-1]. */
  private clampCols(lo: number, hi: number): [number, number] {
    return [Math.max(0, lo), Math.min(this.m_nWidth - 1, hi)];
  }

  /** Blit a falling block's captured column at row `top`: `draw` writes its pixels+material,
   *  else clears them (erase). Shared by stepFalls (per frame) + settleFallsIn (on re-carve). */
  private blitFall(px: Uint32Array, mat: Uint8Array | null, f: Fall, top: number, draw: boolean): void {
    const W = this.m_nWidth;
    for (let k = 0; k < f.thick; k++) {
      const idx = (top + k) * W + f.col;
      px[idx] = draw ? f.colors[k] : 0;
      if (mat) {
        mat[idx] = draw ? f.mats[k] : 0;
        if (draw && CLand.matRad(f.mats[k])) this.growRadBox(f.col, top + k); // it moved, so did its glow
      }
    }
    this.m_radGlowDirty = true;
  }

  /** Advance falling overburden blocks (beam/digger collapse): each slid-down cap accelerates
   *  under gravity, redrawn at its new Y each frame, until it lands contiguously on the
   *  substrate — no lingering gap. */
  private stepFalls(dt: number): void {
    if (!this.m_falls.length || !this.m_pixels || !this.m_arrHeights) return;
    const G = 1400,
      px = this.m_pixels,
      mat = this.m_material,
      h = this.m_arrHeights;
    let w = 0;
    for (let i = 0; i < this.m_falls.length; i++) {
      const f = this.m_falls[i];
      const oldTop = Math.round(f.y);
      this.blitFall(px, mat, f, oldTop, false); // erase old pos
      f.vel += G * dt;
      f.y += f.vel * dt;
      let landed = false;
      if (f.y >= f.target) {
        f.y = f.target;
        landed = true;
      }
      const top = Math.round(f.y);
      this.blitFall(px, mat, f, top, true); // draw at new pos
      h[f.col] = top;
      if (!landed) this.m_falls[w++] = f;
    }
    this.m_falls.length = w;
    this.m_pixelsDirty = true;
  }

  /** Finalize (snap to target) every active falling block in the column range [lo,hi] and clear it
   *  from the list — so a follow-up carve on those columns acts on SETTLED terrain. Without this a
   *  second cut reads the mid-air block top as the surface and spawns a CONCURRENT fall; the two then
   *  land at independent absolute targets and whichever sets `h[col]` lower strands the other block's
   *  pixels ABOVE the surface → the "floating dirt" in the sky. Called before every re-carve. */
  private settleFallsIn(lo: number, hi: number): void {
    if (!this.m_falls.length || !this.m_pixels || !this.m_arrHeights) return;
    const px = this.m_pixels,
      mat = this.m_material,
      h = this.m_arrHeights;
    let w = 0;
    for (let i = 0; i < this.m_falls.length; i++) {
      const f = this.m_falls[i];
      if (f.col < lo || f.col > hi) {
        this.m_falls[w++] = f; // outside the range → still falling
        continue;
      }
      const oldTop = Math.round(f.y);
      this.blitFall(px, mat, f, oldTop, false); // erase from wherever it is now
      const top = Math.min(this.m_nHeight - f.thick, f.target);
      this.blitFall(px, mat, f, top, true); // deposit at its target
      h[f.col] = top; // surface = the settled block top
    }
    this.m_falls.length = w;
    this.m_pixelsDirty = true;
  }

  /**
   * Carve the slice a beam cuts along its whole line: for each column the ray crosses
   * at/below the surface, remove a band of ~`halfWidth` above+below the ray. The cut is
   * NOT a razor-clean slot — the per-column depth is jittered (ragged edge) and the
   * removed earth is ejected as FALLING debris that drops and re-piles noisily (the
   * overburden collapses in). So after the beam the surface sags along the line with
   * random patterns, matching the original (per-fire size jitter + ±2px debris settle),
   * rather than planing off everything from the ray up to the surface.
   */
  carveBeamSlice(x0: number, y0: number, x1: number, y1: number, halfWidth: number): void {
    if (!this.m_arrHeights) return;
    const [lo, hi] = this.clampCols(Math.floor(Math.min(x0, x1)), Math.ceil(Math.max(x0, x1)));
    this.settleFallsIn(lo, hi); // finalize any overburden still falling here → no concurrent falls
    const dx = x1 - x0;
    // The original carves with an irregular MASK stencil (jagged silhouette), not a clean band,
    // and trims the channel a few px per fire. Reproduce that with COHERENT edge noise: two low
    // sines (random phase per fire) + a tiny per-column wobble on the top AND bottom edges
    // independently → a jagged, natural channel. Coherent = adjacent columns barely differ, so it
    // never leaves thin standing "nails" (unlike independent per-column random depth).
    const rnd = () => this.rand01();
    const pT1 = rnd() * TWO_PI,
      pT2 = rnd() * TWO_PI,
      pB1 = rnd() * TWO_PI,
      pB2 = rnd() * TWO_PI;
    const fireHalf = Math.max(2, halfWidth - rnd() * 3); // per-fire width reduction (mask − rand)
    for (let c = lo; c <= hi; c++) {
      const t = Math.abs(dx) < 1e-3 ? 0 : (c - x0) / dx;
      if (t < 0 || t > 1) continue;
      const beamY = y0 + (y1 - y0) * t;
      const jTop = 3.4 * Math.sin(c * 0.17 + pT1) + 2.0 * Math.sin(c * 0.44 + pT2) + (rnd() - 0.5) * 1.8;
      const jBot = 3.4 * Math.sin(c * 0.2 + pB1) + 2.0 * Math.sin(c * 0.51 + pB2) + (rnd() - 0.5) * 1.8;
      const surfBefore = this.getHeightAt(c); // spawn ejecta at the ground, BEFORE the slice lowers it
      const removed = this.sliceColumn(c, beamY, Math.max(1, fireHalf + jTop), Math.max(1, fireHalf + jBot)); // prettier-ignore
      // The original EJECTS the removed earth as falling debris — the ray visibly emits dirt, not a
      // silent slice. We spray a couple of cosmetic grains per cut column UP from the surface so they
      // arc and rain back visibly (the source's grains are zero-velocity because its cut leaves open
      // space below; ours fills the trench, so a small pop is the visible equivalent). NON-depositing:
      // they vanish on landing — the sliding overburden block already fills the trench.
      if (removed > 0) {
        this.m_fxSink?.debrisSpray(c, surfBefore, 2, 14);
      }
    }
    this.startSlump(lo, hi); // settle the cut so it never leaves standing nails
    // Only the fallout specks the ray actually PASSES THROUGH are vaporised — the
    // rest ride the collapse down (their radiation is preserved). Keep a speck unless
    // it lies within the beam's half-width of the ray line.
    if (this.m_radSpecks.length) {
      const len2 = dx * dx + (y1 - y0) * (y1 - y0);
      this.m_radSpecks = this.m_radSpecks.filter(s => {
        if (s.x < lo || s.x > hi) return true;
        const tt = len2 > 0 ? clamp01(((s.x - x0) * dx + (s.y - y0) * (y1 - y0)) / len2) : 0;
        const cx = x0 + tt * dx,
          cy = y0 + tt * (y1 - y0);
        return Math.hypot(s.x - cx, s.y - cy) > halfWidth + 4; // outside the ray → survives
      });
    }
    this.preBlast(lo, hi);
  }

  /**
   * Underground blast (digger detonation): remove ONLY the DISC of radius `r` at (x,y) and
   * let the soil ABOVE it cave IN under gravity to fill the void — so the surface drops by
   * ~the disc thickness (≤ 2r), NOT all the way down from the surface to the buried blast.
   * The overburden slides down as a falling block per column.
   *
   * `slump` (default true) then runs the angle-of-repose avalanche so a detonation crater
   * settles into a natural ragged bowl. Pass FALSE for the digger's continuous BORE: the
   * channel must stay narrow — each cut just drops the overburden straight down by the removed
   * thickness (grass ends up that much lower), with NO lateral slumping. Otherwise the steep
   * bore walls avalanche sideways every frame and stack into a wide funnel/V (the wrong look).
   */
  carveDiscCollapse(x: number, y: number, r: number, slump = true, ragged = false, coatDirt = false): void {
    if (!this.m_arrHeights) return;
    const [lo, hi] = this.clampCols(Math.floor(x - r), Math.ceil(x + r));
    this.settleFallsIn(lo, hi); // settle any active overburden first → no concurrent falls
    const px = this.m_pixels;
    const W = this.m_nWidth;
    const heights = this.m_arrHeights;
    // Thickness of the soil coat AT THE CENTRE of the bowl; it thins toward the rim on the shared
    // `coatDepth` curve, the same one the fallout settles on. A flat band all the way round makes
    // the two layers disagree about the shape of the hole they both line.
    const dirtFull = clamp(Math.round(r * 0.22), 12, 40);
    // `ragged`: a gentle wobble on the disc radius so an EXPLOSION crater reads as a rough hole (the
    // way the original cuts one). Two out-of-phase sines (random per-crater phases) → an irregular but
    // SMOOTH profile; every column is still CUT (varying depth → wavy floor), so it does NOT strand
    // the "nails" a per-column jitter/skip would. Cleaner/digger pass false (a clean, controlled cut).
    const wobPh1 = ragged ? this.rand01() * TWO_PI : 0;
    const wobPh2 = ragged ? this.rand01() * TWO_PI : 0;
    for (let c = lo; c <= hi; c++) {
      const dx = c - x;
      let base = Math.sqrt(Math.max(0, r * r - dx * dx)); // disc half-height at this column
      if (ragged) base *= 0.9 + 0.07 * Math.sin(c * 0.6 + wobPh1) + 0.05 * Math.sin(c * 1.4 + wobPh2); // prettier-ignore
      if (base <= 0.5) continue;
      // Cut the disc profile; the capped soil ABOVE the band falls in under gravity (falling block).
      const before = heights[c];
      this.sliceColumn(c, y, base);
      // `coatDirt` (bombs/dirt): coat the fresh crater face with soil — a thin band below the new
      // surface — so it reads as a filled dirt bowl (the blastCircle look), not raw rock strata. Only
      // for columns that lowered DIRECTLY (heights[c] rose): a column with a falling block keeps its
      // surface until the block lands, and coating the void there would strand floating dirt.
      if (coatDirt && px && base > 2 && heights[c] > before) {
        const mat = this.m_material;
        const top = heights[c];
        const band = CLand.coatDepth(dx, r, dirtFull); // thins toward the rim (shared with the fallout)
        const bandBot = Math.min(this.m_nHeight, top + Math.ceil(band));
        for (let yy = top; yy < bandBot; yy++) {
          const i = yy * W + c;
          if ((px[i] & 0xff000000) === 0) continue;
          const v = (yy - top) / band; // 0 at the face → 1 at the band floor
          // The face itself is turned over SOLIDLY — the blast scoured it. Only below COAT.SKIN
          // does coverage fall away, so the coat dissolves into the native strata with depth instead
          // of stopping on a ruled line. The radial thinning lives entirely in `band` above: taking
          // it out of coverage as well would eat holes in the crater's own edge, which reads as the
          // rim breaking into blobs rather than as a soft boundary.
          let cover = 1;
          if (v > COAT.SKIN) {
            const u = (1 - v) / (1 - COAT.SKIN);
            cover = smoothstep(u); // eased to zero at the band floor
            // Decide each pixel INDEPENDENTLY, on a per-pixel dither. Thresholding a smooth noise
            // field instead makes the two materials meet along a contour — the soil ends on a wavy
            // line and the fringe combs into vertical spikes — whereas dithering interleaves them
            // grain by grain, so the turned earth and the ground it came from genuinely mix.
            // The coherent octave only WARPS the threshold, so the mixing zone wanders and wells
            // deeper in places; dither alone dissolves in a perfectly even haze that reads as
            // machine-made. World-keyed, so overlapping craters agree where they meet.
            // The octave SCALES the dither threshold, so wherever it runs high the coat reaches its
            // full depth and wherever it runs low it dissolves early — meaning this cell size is
            // literally the width of the resulting fringe. A 9px cell gives a comb of 9-column
            // teeth hanging off the coat's underside (measured: mean depth 21px swinging 3-33px,
            // average run 9.4 columns), so the cell is kept wide and shallow: the boundary still
            // wanders, but over a distance you read as an uneven edge rather than as stripes.
            const w = cover * (0.72 + 0.56 * blotchNoise(c, yy, COAT.CELL));
            if (hashLattice(c, yy) > w) continue;
          }
          px[i] = this.dirtColorAt(c, yy);
          // Tag it churned soil while KEEPING its radioactivity: this is earth the carve left in
          // place, only re-textured, so wiping the bits here would decontaminate ground the blast
          // never removed.
          if (mat) mat[i] = (mat[i] & ~1) | CLand.MAT_DIRT;
        }
      }
    }
    if (slump) this.startSlump(lo, hi); // detonation bowl only; the bore stays a straight-down cut
    this.m_pixelsDirty = true;
    // A detonation crater blows the ground (and any fallout on it) away — drop the radiation the
    // blast actually REACHED (inside the disc), not the whole column band.
    this.clearRadiationDisc(x, y, r);
    this.preBlast(lo, hi);
  }

  /**
   * A blast sweeps the LOOSE fallout out of the disc it reached — the grains still in the air and
   * the wisps rising off the ground, within radius `r` of `(x, y)`. Keyed on 2-D distance, not the
   * column span: a circular crater must not blow away fallout that sits in the same x-range but
   * outside the sphere (deep in the soil below the blast, or past the arc near the span edges).
   *
   * It does NOT touch the radiation CHANNEL — the carve already took the radioactivity of every
   * pixel it actually removed, via `setColumnTop`, and scrubbing the rest of the disc would
   * decontaminate earth that survived the blast. Irradiated soil under a fresh crater stays
   * irradiated; only what was excavated is gone.
   *
   * And it does NOT touch the damage ZONES. A zone is a blast's CLOCK, not its extent — the extent
   * lives in the earth, which is what `radiationAt` reads for damage and what `drawRadGlow` reads
   * for the glow. Deleting the zone whose centre a later shell happens to land on cleans nothing
   * up: it stops the clock on contamination still lying all around the new crater, so an entire
   * nuke coat goes dark the instant a missile hits the middle of it, leaving only the fringe the
   * new blast never reached. Zones expire on their own time instead. (The heat wisps a cleaned
   * crater would otherwise keep venting are gated on hot earth at the spawn column — see `update`.)
   */
  private clearRadiationDisc(x: number, y: number, r: number): void {
    const r2 = r * r;
    const outside = (px: number, py: number): boolean => {
      const dx = px - x,
        dy = py - y;
      return dx * dx + dy * dy > r2;
    };
    this.m_fxSink?.clearHeat(x, y, r); // …and the haze that was rising off it
    // Grains still IN THE AIR over the disc go too, not only the ones already within it: the blast
    // erupts up through that column. Left alone they carry on down and re-coat the floor of the
    // crater that was supposed to have swept them away, so a cleaner fired into a settling cloud
    // comes out glowing and fuming a second later.
    if (this.m_radSpecks.length)
      this.m_radSpecks = this.m_radSpecks.filter(s => outside(s.x, s.y) && !(s.y < y && Math.abs(s.x - x) <= r));
  }

  /**
   * Digger BORE: cut a narrow disc at (x,y) but bore each column only ONCE (tracked in `done`).
   * Removing a `2r`-thick band and letting the overburden slide straight down by that thickness
   * drops the surface by ~`2r` (the tunnel height) — the tunnel BACKFILLS as the digger passes,
   * so the ground only dents by the bore's cross-section, it does NOT cave down to the shell.
   * Boring each column once is what stops the dent re-deepening every frame the disc re-sweeps or
   * the shot descends through it (which would erode a deep wide funnel). No slump → the walls stay
   * put (a thin channel, not an angle-of-repose V). Matches the original's per-frame disc cut.
   */
  carveBore(x: number, y: number, r: number, done: Set<number>): void {
    if (!this.m_arrHeights) return;
    const [lo, hi] = this.clampCols(Math.floor(x - r), Math.ceil(x + r));
    this.settleFallsIn(lo, hi); // land any overburden still in flight before the next cut
    const yy = Math.floor(y);
    let cut = false;
    for (let c = lo; c <= hi; c++) {
      if (done.has(c)) continue; // already bored → leave it (the tunnel stays backfilled here)
      done.add(c);
      // Fixed half-thickness = r (not the chord), so every fresh column drops by the SAME ~2r
      // tunnel height regardless of where in the disc it sits — a uniform-depth channel.
      if (this.sliceColumn(c, yy, Math.round(r)) > 0) cut = true;
    }
    if (cut) {
      if (this.m_radSpecks.length) this.m_radSpecks = this.m_radSpecks.filter(s => s.x < lo || s.x > hi);
      this.preBlast(lo, hi);
    }
  }

  private preBlast(nX1: number, nX2: number): void {
    this.m_dirtyMin = Math.max(0, nX1);
    this.m_dirtyMax = Math.min(this.m_nWidth - 1, nX2);
    this.m_terrainDirty = true;
  }

  /** Column span touched since the last render. NOTE: the min/max region is currently only read
   *  here — the renderer redraws on the `m_terrainDirty` boolean — so the span tracking (this +
   *  `preBlast`'s args) is a dormant partial-redraw hook. Kept wired for that future optimisation. */
  getDirtyRegion(): {min: number; max: number} {
    return {min: this.m_dirtyMin, max: this.m_dirtyMax};
  }

  private computeDirtyRegion(): void {
    this.m_dirtyMin = 0;
    this.m_dirtyMax = this.m_nWidth - 1;
    this.m_terrainDirty = true;
    // Snapshot the fresh, undisturbed surface as the crater-cavity ceiling. Only
    // called on terrain (re)generation, so this captures the pristine profile.
    if (this.m_arrHeights) {
      if (!this.m_baseHeights || this.m_baseHeights.length !== this.m_nWidth)
        this.m_baseHeights = new Int16Array(this.m_nWidth);
      this.m_baseHeights.set(this.m_arrHeights);
    }
  }

  /**
   * Build a flat-topped dirt PLATFORM (the Bunker/Wall terrain tool): level a span of columns
   * `[cx±halfWidth]` to a common top `height` px above the centre's current surface, filling
   * with dirt pixels. Only ever RAISES (never lowers ground that's already higher), so a wall
   * rises out of the terrain without carving it — a solid structure you can hide behind.
   * Fallback for when the structure bitmap isn't available; `buildStructure` is preferred.
   */
  buildPlatform(cx: number, halfWidth: number, height: number): void {
    if (!this.m_arrHeights) return;
    const c = clamp(Math.round(cx), 0, this.m_nWidth - 1);
    const top = Math.max(0, this.m_arrHeights[c] - Math.round(height)); // flat top, `height` above centre
    const [x0, x1] = this.clampCols(c - halfWidth, c + halfWidth);
    for (let col = x0; col <= x1; col++) {
      if (top < this.m_arrHeights[col]) this.setColumnTop(col, top); // raise → stamp dirt (never lower)
    }
    this.preBlast(x0, x1);
  }

  /**
   * Build the Bunker/Wall STRUCTURE at `cx`, TEXTURED with its own bitmap (bunker.bmp /
   * wall.bmp). The bitmap's own width/height size the platform: level a dirt base the width
   * of the bitmap, raise the surface by the bitmap's height, then stamp the bitmap's opaque
   * pixels as the visible face — so it reads as the real emplacement art, not a bare dirt
   * block. Magenta-keyed (transparent) pixels fall back to the dirt fill, keeping the platform
   * solid with no sky gaps. Raise-only, like `buildPlatform` (never carves higher ground).
   * `img.data` is a 32-bit `0xAABBGGRR` view of the keyed sprite (alpha 0 = transparent).
   */
  buildStructure(cx: number, img: {width: number; height: number; data: Uint32Array}): void {
    if (!this.m_arrHeights || !this.m_pixels) return;
    const W = this.m_nWidth,
      H = this.m_nHeight;
    const bw = img.width,
      bh = img.height;
    const c = clamp(Math.round(cx), 0, W - 1);
    const left = c - (bw >> 1); // centre the bitmap on the aim column
    const baseTop = this.m_arrHeights[c]; // flat ground level = centre's current surface
    const structTop = Math.max(0, baseTop - bh); // structure top = raise by the bitmap height
    // 1) Level + fill a solid dirt base under the whole footprint, raised to the structure top.
    for (let bx = 0; bx < bw; bx++) {
      const col = left + bx;
      if (col < 0 || col >= W) continue;
      if (structTop < this.m_arrHeights[col]) this.setColumnTop(col, structTop);
    }
    // 2) Stamp the bitmap's opaque pixels over the structure zone as the textured face.
    const px = this.m_pixels;
    for (let by = 0; by < bh; by++) {
      const y = structTop + by;
      if (y < 0 || y >= H) continue;
      for (let bx = 0; bx < bw; bx++) {
        const col = left + bx;
        if (col < 0 || col >= W) continue;
        const rgba = img.data[by * bw + bx];
        if (rgba >>> 24 === 0) continue; // transparent (magenta-keyed) → keep the dirt fill
        px[y * W + col] = (rgba | 0xff000000) >>> 0; // opaque structure pixel
      }
    }
    this.m_pixelsDirty = true;
    this.preBlast(Math.max(0, left), Math.min(W - 1, left + bw));
  }

  /**
   * Deposit earth — Dirt weapons (Dirty Boy, Mountain, Dirtox…) throw a burst of dirt DEBRIS that
   * arcs up, falls under gravity, and PILES where it lands (each landed chunk raises its column
   * +1px); the angle-of-repose slump then settles the stack into a natural mound that flows down
   * slopes. The shape is EMERGENT — no dome (faithful to the original crater-throw → settle →
   * repose pipeline). `amount` (the weapon's `earth`) is the
   * chunk COUNT = deposit volume; `nRadius` (blast radius) is the throw WIDTH — so same-`earth`
   * weapons differ by radius (Dirty Boy r15 spreads broad; Dirtox r10 piles tall), and multiple
   * `spawn` deposits merge naturally through the shared debris pool + one repose pass.
   */
  depositDirt(x: number, y: number, nRadius: number, amount: number): void {
    if (!this.m_arrHeights || amount <= 0) return;
    const R = Math.max(4, nRadius);
    const discR = R * DIRT.DISC_SPREAD; // chunks are BORN across this disc → the pile's WIDTH
    // Count = earth × radius → the PEAK scales with earth (Mountain biggest), width tracks radius.
    // Each landed chunk raises a column +1px; repose + the rounding pass then settle the pile.
    const chunks = Math.min(16000, Math.round(amount * R * DIRT.DEPOSIT_VOLUME));
    const pool = this.m_spoilPool;
    for (let i = 0; i < chunks; i++) {
      // Deposited dirt writes the heightmap → seeded LCG (deterministic in a net match).
      const ang = this.rand01() * TWO_PI;
      const dist = Math.sqrt(this.rand01()) * discR; // uniform over the DISC AREA (no central 1/r spike)
      let v = 24 + Math.floor(Math.random() * 116); // dirt brown, occasional dark clod (cosmetic)
      if (Math.random() < 0.25) v = Math.floor(v * 0.55);
      const p: SpoilChunk = pool.pop() ?? {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        color: '',
        rgba: 0,
        size: 0,
        spin: 0,
        age: 0,
        fill: 1,
        radSlot: -1,
      };
      p.fill = 1; // a Dirt weapon's pile is built one chunk = one pixel, straight from `chunks`
      p.radSlot = -1; // a Dirt weapon ships clean fill — it is not a contaminating blast
      p.x = x + Math.cos(ang) * dist;
      p.y = y + Math.sin(ang) * dist * 0.4; // disc flattened vertically (chunks born near the surface)
      p.vx = (this.rand01() * 2 - 1) * DIRT.THROW_SCATTER; // small random horizontal (NOT outward)
      p.vy = -lerp(...DIRT.THROW_UP, this.rand01()); // up → rains back near birth
      p.color = this.dirtColor(v);
      p.rgba = this.packSolid(v, v >> 1, 0);
      p.size = 1;
      p.spin = 0;
      p.age = 0;
      this.m_spoil.push(p);
    }
    // Arm the rounding pass over this deposit's span (accumulates across near-simultaneous spawns).
    this.armDirtSmoothing(x, discR);
  }

  /**
   * Arm (or extend) the box-blur that rounds freshly-landed dirt into a smooth mound, over the
   * span `[x−reach, x+reach]` plus a small margin.
   *
   * Both things that RAISE columns — the deposit dome and crater ejecta — need it, and both land
   * one 1px column at a time, so without it the fill reads as a comb of spikes. The span
   * ACCUMULATES across near-simultaneous spawns (a cluster's bomblets), and only resets once the
   * previous pass has run out, so one weapon's spread is smoothed as a single region.
   */
  private armDirtSmoothing(x: number, reach: number): void {
    if (this.m_dirtSmoothPasses <= 0 && this.m_dirtSmoothDelay <= 0) {
      this.m_dirtSmoothX0 = this.m_nWidth;
      this.m_dirtSmoothX1 = 0;
    }
    this.m_dirtSmoothDelay = DIRT.SMOOTH_DELAY;
    this.m_dirtSmoothPasses = DIRT.SMOOTH_PASSES;
    this.m_dirtSmoothX0 = Math.min(this.m_dirtSmoothX0, Math.round(x - reach - 10));
    this.m_dirtSmoothX1 = Math.max(this.m_dirtSmoothX1, Math.round(x + reach + 10));
  }

  /** Round a Dirt pile: box-3 average the surface over [x0,x1] (via `setColumnTop`, so pixels track),
   *  moving dirt from spikes to hollows — melts the angle-of-repose cone into a smooth mound. */
  private smoothDirtSpan(x0: number, x1: number): void {
    const h = this.m_arrHeights;
    if (!h) return;
    const a = Math.max(1, Math.floor(x0));
    const b = Math.min(this.m_nWidth - 2, Math.floor(x1));
    if (b < a) return;
    const src = Int16Array.from(h.subarray(a - 1, b + 2)); // snapshot with a 1-col margin each side
    for (let x = a; x <= b; x++) {
      const i = x - a + 1;
      const avg = Math.round((src[i - 1] + src[i] + src[i + 1]) / 3);
      if (avg !== h[x]) this.setColumnTop(x, avg);
    }
    this.preBlast(a, b);
  }

  blastIradiate(
    x: number,
    y: number,
    nRadius: number,
    fDamagePerSecond: number,
    fDurationSeconds: number,
    rgb?: [number, number, number],
    // AIRBURST: the fallout is thrown from the mid-air burst point (`speckOriginY`, well above
    // the surface) and RAINS down onto the ground, instead of erupting up out of a crater. The
    // damage zone + ground recolour still key off `y` (the surface); only the specks originate
    // high and fall. Defaults keep the normal ground-blast behaviour.
    speckOriginY?: number,
    raining = false,
  ): void {
    const [r, g, b] = CLand.radRGB(rgb);
    // Spoil, fallout and zone are ONE patch of poisoned ground and must share a slot, or they fade
    // on separate clocks. Asked for rather than passed in: `radiationSlot` answers per EVENT, so the
    // caller that already claimed one to tag the earth this blast THREW gets that same slot back
    // here. It used to be a parameter defaulting to a fresh claim, and since no caller ever passed
    // it every irradiating blast claimed two slots — the zone's and an orphan holding the spoil,
    // which then had no zone to light it or to cool it: contaminated ejecta that never glowed and
    // never decayed, on top of burning the eight-slot table twice as fast as it should.
    const slot = this.radiationSlot(rgb);

    // The fallout lingers longer than the raw irTime and dims GRADUALLY.
    // Stretch the visible life ~1.6× so the radioactive ground glows for a
    // good while and decays slowly.
    const dur = fDurationSeconds * RAD.LINGER;

    // Gameplay damage zone (queried against tanks each frame) — invisible; the visible glow
    // is the specks. Damage-over-time for irTime, matching the original's fallout DOT.
    this.m_radParticles.push({
      x,
      y,
      radius: nRadius,
      damagePerSecond: fDamagePerSecond,
      timeRemaining: dur,
      duration: dur,
      slot,
      r,
      g,
      b,
    });

    // Visual: a cloud of glowing specks. They fall, settle on the surface as a thin glowing
    // carpet tinted by irRGB, and fade over irTime — no deposit, they just coat the ground.
    // Count scales with the blast RADIUS (the original's fallout count ∝ radius; the exact
    // multiplier isn't known). Tuned high enough that the 5-px crosses fill the thick crater-void
    // POOL densely — the on-surface tint should read as a solid irradiated carpet (the reference
    // shows a deep red band, not a thin surface line), so the density carries the whole effect
    // (radiation writes NO terrain pixels — there is no baked recolour to fall back on).
    // Count × RAD.GRAIN_DEPTH is the coat's thickness: a grain settles onto the pile already in its
    // column and lays down that many pixels, so how much falls on a spot is how deep the fallout
    // goes there. There is no separate depth to tune. Half the grains at twice the slug is the same
    // coat for half the particles — and particles are the cost here, since each one drawn in flight
    // is a canvas call and the coat itself is free once landed.
    const n = clamp(Math.round(nRadius * 78), 900, 20000);
    const pool = this.m_speckPool;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TWO_PI;
      // Radial placement: UNIFORM OVER THE DISC's area, `sqrt(u)·radius`, so the grains cover the
      // blast footprint at one even density — the same way the carve coats every column of the
      // bowl face it cuts. The original's flat `rand·radius` looks like it spreads evenly but does
      // not: a ring at distance d holds grains ∝ d·dd of area yet receives a constant share of the
      // draw, so density runs as 1/d and heaps into a bell at ground zero. That hump reads as a
      // mound of fallout sitting inside the crater instead of as a lining of it.
      //
      // Note this is NOT a radial FALLOFF: it does not thin the edge. Grains still reach the full
      // radius, so the glow ends where the crater does. The only taper
      // the fallout carries is into the soil (see `radBandDepth`), matching the coat.
      const dist = Math.sqrt(Math.random()) * nRadius;
      // Velocity stays as the original had it: only a SMALL radial nudge (`rand·8+2` in the
      // source's units). The visible fall comes from the SPREAD — grains that land high in the
      // upper half of the disc drop back down under gravity — NOT from a big launch.
      //
      // Scaled to the blast, because "small" is only small relative to something. The nudge is
      // radially OUTWARD along the grain's own spawn angle, so it inflates the whole disc for as
      // long as the grain is airborne — and ours stays up ~1.7s (thrown high on purpose, so it
      // lands after the dirt) where the original's barely leaves the ground. A flat 20–85px/s over
      // that flight carries a grain 35–145px outward, which against a 140px crater is not a nudge
      // but a wholesale sweep: it scours the coat off the middle of the bowl and heaps it into a
      // ring at the rim, everything past the rim culled — radiation piling up densest exactly where
      // no dirt landed.
      //
      // A fraction of the radius, then — but not a tenth of it, which is the other failure: with
      // almost no outward speed the cloud is just the spawn disc extruded upward, a rectangular
      // COLUMN of ash with vertical sides rising out of the hole rather than anything that reads as
      // an explosion. Enough spread that the cloud opens out as it climbs (its top ends up ~1.3×
      // the crater wide, so the silhouette domes), while the landing distribution stays weighted to
      // the middle of the bowl where the spoil is.
      const speed = nRadius * between(0.06, 0.28);
      // Reuse a faded speck from the free pool — up to 12000 per nuke, so this is
      // the biggest allocation sink; pooling makes a warm blast allocate zero.
      const s: RadSpeck = pool.pop() ?? {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        age: 0,
        life: 0,
        settled: false,
        size: 0,
        rise: 0,
        zx: 0,
        zr: 0,
        hold: 0,
        raining: false,
        slot: 0,
        phase: 0,
        pw: 0,
        r: 0,
        g: 0,
        b: 0,
      };
      const originY = speckOriginY ?? y;
      // Faithful spawn: scattered across the FULL radius, in a disc around the blast point — the
      // grains in the upper half start high and rain down under gravity (this is where the visible
      // fall comes from). Velocity is RADIAL along the same angle, small (the original's `speed·dir`).
      s.x = x + Math.cos(ang) * dist;
      s.y = originY + Math.sin(ang) * dist;
      s.vx = Math.cos(ang) * speed;
      // Ground blast: radial nudge (half up, half down) — the up ones arc a touch, the down ones
      // and the low-spawned ones settle quickly, matching the original's radial launch. Airburst
      // (raining): biased DOWN so the disc rains from the mid-air burst point onto the ground.
      // A GROUND burst throws its fallout UP with the earth, so it arcs and rains back down AFTER
      // the heavier clods have finished piling into the hole — which is the ordering everything else
      // here depends on. Launched flat the fallout is fully settled at ~1.5s while dirt keeps
      // landing until ~2.25s, so the refill buries the coat it has just laid and the crater comes
      // out with a sterile layer through it. Making the thrown earth radioactive to compensate only
      // moves the problem: every fresh layer re-lights, so the glow climbs with the rising floor
      // instead of settling. Landing LAST needs no compensation — the fallout simply coats whatever
      // the ground finally is. An AIRBURST is exempt: it rains from a mid-air burst point and is
      // never thrown up in the first place.
      s.vy = raining ? Math.abs(Math.sin(ang)) * speed + between(25, 80) : Math.sin(ang) * speed - between(...RAD.UP);
      s.age = 0;
      s.life = dur * between(0.85, 1.05); // lingers ~the stretched irTime
      s.settled = false;
      s.size = between(0.85, 2.25); // small grains (1.8–3.2px dots); much bigger and they read as boxes
      s.phase = Math.random() * TWO_PI; // independent glow phase (no coherent wave/banding)
      s.pw = between(3, 7.5); // independent glow rate (each speck breathes at its own speed)
      s.rise = 0;
      // Remember which blast threw this grain, so the coat depth it digs on landing can be measured
      // against THAT zone. Carried per grain rather than read off the land at settle time: a grain
      // still in the air when the next blast goes off would otherwise take the new zone's depth.
      s.zx = x;
      s.zr = nRadius;
      s.raining = raining;
      s.hold = raining ? 0 : between(...RAD.HOLD);
      s.slot = slot;
      const f = between(0.3, 1); // 0.3..1.0 — dark grains stay on-hue, never black
      s.r = (r * f) | 0;
      s.g = (g * f) | 0;
      s.b = (b * f) | 0;
      this.m_radSpecks.push(s);
    }
    // Global ceiling. Deliberately NOT raised alongside the per-blast count above: this bounds the
    // per-frame draw (two fillRects per grain), which measures ~0.8µs a grain, so the ceiling —
    // not the per-blast count — is what sets the worst-case frame cost. A single zone gets its
    // denser coat; a screen already saturated with fallout stays bounded by the same ceiling.
    if (this.m_radSpecks.length > 9000) this.m_radSpecks.splice(0, this.m_radSpecks.length - 9000);
  }

  /**
   * Mark one pixel of earth radioactive — where a fallout grain came to rest. Additive and
   * saturating, so overlapping blasts and the grains of a single one BUILD UP a hotter patch
   * rather than each overwriting the last.
   */
  private stampRadiation(col: number, y: number, slot: number, amount = between(RAD.STAMP_MIN, MAT.RAD_MAX)): void {
    // Allocated on first use, and deliberately NOT conditioned on the pixel buffer: radioactivity
    // is terrain STATE, not colour. A land that never ran `bakeTerrain` (headless sim, a net client
    // mid-boot, tests) still has a heightmap and still has to answer `radiationAt`, or fallout
    // silently stops dealing damage wherever there is nothing to draw.
    let mat = this.m_material;
    if (!mat) mat = this.m_material = new Uint8Array(this.m_nWidth * this.m_nHeight);
    if (col < 0 || col >= this.m_nWidth) return;
    // Clamped to at-or-below the surface: only EARTH can be radioactive. The settle scatter reaches
    // a few px above the ground line, which is empty space — marking it would put glow in mid-air,
    // and worse, `setColumnTop` never touches those pixels, so a carve that took the ground away
    // would leave that glow hanging in mid-air with the ground gone from under it.
    const top = this.m_arrHeights ? this.m_arrHeights[col] : 0;
    const yy = Math.max(top, Math.floor(y));
    if (yy < 0 || yy >= this.m_nHeight) return;
    const i = yy * this.m_nWidth + col;
    mat[i] = CLand.matSetRad(mat[i], amount, slot);
    this.growRadBox(col, yy);
    this.m_radGlowDirty = true;
  }

  /**
   * Draw the radioactive GROUND — the settled coat — from the terrain's radiation channel.
   *
   * The channel says which earth is hot and WHICH BLAST made it hot; the live zones
   * (`m_radParticles`) say how brightly each of those blasts is still burning. Keeping those apart
   * is what lets craters of different ages overlap and fade independently, and it means the glow is
   * rebuilt only when the EARTH changes — a fade is just the alpha on a blit, so it stays perfectly
   * smooth between rebuilds rather than stepping the way a periodically re-baked layer does.
   *
   * One buffer PER SLOT, blitted at that slot's own zone's fade, rather than one buffer for the
   * whole map at the longest-lived zone's fade. A single shared buffer carries a single alpha, so a
   * dying crater flares back to full brightness the moment a fresh one lands anywhere on the map,
   * and old earth stays alight forever because some zone is always the max. Per slot, a slot with
   * no live zone simply is not blitted.
   */
  private drawRadGlow(ctx: CanvasRenderingContext2D): void {
    const mat = this.m_material;
    if (!mat || !this.m_radParticles.length || typeof document === 'undefined') return;
    const W = this.m_nWidth;
    if (this.m_radGlowDirty || !this.m_radGlowCanvas.length) {
      this.m_radGlowDirty = false;
      // Bounds of the HOT EARTH itself, padded by everything that reaches PAST the last hot pixel
      // so the coat's outer ring is not clipped into a hard edge. Never the zones' bounds — the
      // earth is the extent.
      if (this.m_radBoxX1 < this.m_radBoxX0) return; // nothing has been irradiated yet
      const pad = GLOW_PAD;
      let x0 = this.m_radBoxX0 - pad,
        x1 = this.m_radBoxX1 + pad,
        y0 = this.m_radBoxY0 - pad,
        y1 = this.m_radBoxY1 + pad;
      x0 = clamp(x0, 0, W - 1);
      x1 = clamp(x1, 0, W - 1);
      y0 = clamp(y0, 0, this.m_nHeight - 1);
      y1 = clamp(y1, 0, this.m_nHeight - 1);
      const w = x1 - x0 + 1,
        h = y1 - y0 + 1;
      if (w <= 0 || h <= 0) return;
      const heights = this.m_arrHeights;
      const glowPx = this.m_pixels; // solidity test for the bleed below
      // A slot's buffer is allocated on its first hot pixel, so the common single-crater case pays
      // for exactly one — no more than a single map-wide buffer would cost.
      const bufs: (Uint8ClampedArray | null)[] = [];
      // …and split again by PHASE BUCKET. A baked layer can only pulse as a whole, which flattens
      // the coat into one breathing mass with no per-grain twinkle. Scattering the pixels over a
      // few buckets by a world-keyed hash and blitting each on its own phase keeps the shimmer:
      // neighbouring grains breathe out of step, which is what reads as alive, and it costs a
      // handful of extra blits rather than a canvas call per grain.
      const bufFor = (slot: number, bucket: number): Uint8ClampedArray =>
        (bufs[slot * GLOW.PULSE_BUCKETS + bucket] ??= new Uint8ClampedArray(w * h * 4));
      // Each hot pixel lights itself at its own strength and BLEEDS onto its four orthogonal
      // neighbours at a lower weight. The bleed is where the brightness comes from: a grain drawn
      // as a 5-pixel additive cross lets overlapping grains stack into a saturated glow, whereas
      // one flat pixel per grain reads far duller than that. The zone's own
      // fade is NOT applied here — it rides on the blit alpha below, so decay stays continuous
      // even though this buffer only rebuilds when earth changes.
      const add = (
        out: Uint8ClampedArray,
        x: number,
        y: number,
        zr: number,
        zg: number,
        zb: number,
        k: number,
      ): void => {
        if (x < x0 || x > x1 || y < y0 || y > y1) return;
        const o = ((y - y0) * w + (x - x0)) * 4;
        out[o] = Math.min(255, out[o] + zr * k);
        out[o + 1] = Math.min(255, out[o + 1] + zg * k);
        out[o + 2] = Math.min(255, out[o + 2] + zb * k);
        out[o + 3] = 255;
      };
      // …onto CLEAN ground only. The bleed exists to soften the boundary between hot earth and the
      // ground around it; inside a solid body of contaminated fill every pixel would otherwise take
      // its own light plus four neighbours' and clip every channel, burning a deep bowl of spoil
      // out to white-gold instead of reading as red earth. Hot pixels light themselves.
      const bleed = (
        out: Uint8ClampedArray,
        x: number,
        y: number,
        zr: number,
        zg: number,
        zb: number,
        k: number,
      ): void => {
        if (x < 0 || x >= W || y < 0 || y >= this.m_nHeight) return;
        if (CLand.matRad(mat[y * W + x])) return;
        // …and onto GROUND only. There cannot be radiation floating in air: a grain sitting on the
        // surface would otherwise bleed its dot straight up into the sky, and on a cliff edge or a
        // crater rim — where the ground ends abruptly and every grain along it is a surface grain —
        // that reads as a band of glow hanging off the terrain with nothing under it. The bleed is
        // there to soften the join between hot earth and the earth around it; there is no earth up
        // there to soften into.
        if (glowPx ? (glowPx[y * W + x] & 0xff000000) === 0 : heights && y < heights[x]) return;
        add(out, x, y, zr, zg, zb, k);
      };
      // Walked per COLUMN, downward from the surface, through the CONTIGUOUS run of hot earth —
      // not scanned as a box with a fixed depth cut-off. The two agree while radioactivity is a thin
      // dusting on the ground, and part company the moment the hot material is the ground: a nuke's
      // own spoil is contaminated all the way through, so a bowl of it is a 40–70px body of glowing
      // earth and a fixed film lights a token skin of it. The case a depth cap exists to prevent is
      // an OLDER coat, since covered by a later blast's clean fill, drawing a second arc hanging in
      // the air over the hole — and contiguity prevents that better than a depth can, because that
      // fill is exactly a clean run between the surface and the buried coat, so the walk stops at
      // it. Radiation cut off from the surface stays in the channel (dig down and it is still hot,
      // still damaging), it simply is not lit through solid ground.
      for (let x = x0; x <= x1; x++) {
        const top = heights ? heights[x] : 0;
        let gap = 0;
        for (let y = Math.max(y0, top); y <= y1; y++) {
          const b = mat[y * W + x];
          const v = CLand.matRad(b);
          if (!v) {
            if (++gap > GLOW.GAP) break; // the hot body ended — anything below is buried
            continue;
          }
          gap = 0;
          // Light only a SCATTER of the hot pixels, not all of them. The pile is solid by
          // construction — a grain per pixel, packed contiguously — so lighting every one merges
          // the dots into a continuous mass however large or varied they are, and the size variety
          // above is invisible. The original's fallout read as individual chunky specks with ground
          // showing between them; skipping most pixels restores that at the draw, leaving the
          // channel underneath untouched, so damage and burial still see the solid body.
          if (hashLattice(x - 3121, y + 7919) > GLOW.DOT_DENSITY) continue;
          // The pixel's OWN blast, from the slot stamped into it — not the nearest live zone. Asked
          // per frame, every coat on the map takes the identity of whichever zone happens to be
          // closest and alive, so a blue crater turns red when a uranium blast lands beside it.
          const slot = CLand.matSlot(b);
          const c = this.m_radSlotRGB[slot] ?? [255, 46, 20];
          const out = bufFor(slot, (hashLattice(x, y) * GLOW.PULSE_BUCKETS) | 0);
          const zr = c[0],
            zg = c[1],
            zb = c[2];
          const k = (v / MAT.RAD_MAX) * GLOW.GAIN;
          add(out, x, y, zr, zg, zb, k);
          // Size from a SECOND hash draw, independent of the phase bucket — grains must not end up
          // with their size and their twinkle correlated, or the coat pulses in visible size bands.
          const kern = GLOW_KERNELS[(hashLattice(x + 8191, y - 5077) * GLOW.DOT_SIZES) | 0];
          for (const oK of kern) bleed(out, x + oK.dx, y + oK.dy, zr, zg, zb, k * oK.w);
        }
      }
      this.m_radGlowCanvas.length = 0;
      for (let idx = 0; idx < bufs.length; idx++) {
        const buf = bufs[idx];
        if (!buf) continue;
        const made = tryCanvas2d(w, h);
        if (!made) continue;
        const {cv, ctx: g} = made;
        const img = g.createImageData(w, h);
        img.data.set(buf);
        g.putImageData(img, 0, 0);
        this.m_radGlowCanvas[idx] = cv;
      }
      this.m_radGlowX = x0;
      this.m_radGlowY = y0;
    }
    // Each blast's earth blitted on ITS OWN zone's clock. A slot whose zone has expired has no fade
    // and is skipped, so contamination goes out when the blast that made it does — it is not held
    // alight by whatever else happens to be burning on the map.
    const fades: number[] = [];
    for (const z of this.m_radParticles)
      fades[z.slot] = Math.max(fades[z.slot] ?? 0, z.timeRemaining / Math.max(0.5, z.duration));
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.m_radGlowCanvas.length; i++) {
      const cv = this.m_radGlowCanvas[i];
      if (!cv) continue;
      const slot = (i / GLOW.PULSE_BUCKETS) | 0;
      const fade = fades[slot] ?? 0;
      if (fade <= 0) continue;
      // Each bucket on its own phase — grains next to each other are in different buckets, so the
      // coat shimmers instead of the whole map brightening and dimming as one.
      const phase = (i % GLOW.PULSE_BUCKETS) * ((2 * Math.PI) / GLOW.PULSE_BUCKETS);
      const pulse = GLOW.PULSE_BASE + GLOW.PULSE_AMP * Math.sin(this.m_radPulseT * GLOW.PULSE_RATE + phase); // prettier-ignore
      const a = clamp01(fade) * pulse;
      // BLOOM first, then the sharp specks over it. The layer is drawn once shrunk hard and blown
      // back up — the scaler's own filtering is the blur — so every speck sits in a soft halo of its
      // own colour and the coat glows rather than looking like paint. Cheap: two more blits of an
      // already-baked layer, no per-pixel work, and it reads as light because it IS the same light
      // spread wider and dimmer.
      const bw = Math.max(1, (cv.width / GLOW.BLOOM_SHRINK) | 0),
        bh = Math.max(1, (cv.height / GLOW.BLOOM_SHRINK) | 0);
      const bcv = this.bloomScratch(bw, bh);
      if (bcv) {
        const bg = bcv.getContext('2d');
        if (bg) {
          bg.clearRect(0, 0, bw, bh);
          bg.imageSmoothingEnabled = true;
          bg.drawImage(cv, 0, 0, bw, bh);
          ctx.globalAlpha = a * GLOW.BLOOM_ALPHA;
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(bcv, 0, 0, bw, bh, this.m_radGlowX, this.m_radGlowY, cv.width, cv.height);
        }
      }
      ctx.globalAlpha = a;
      ctx.drawImage(cv, this.m_radGlowX, this.m_radGlowY);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = prevOp;
  }

  /**
   * The first pixel in this column that fallout has NOT reached yet — the top of the pile, counting
   * down from the surface through the grains already settled there. A landing grain goes here, so
   * the coat grows a grain at a time and its thickness is just how much fell on that spot.
   */
  private radPileTop(col: number): number {
    const mat = this.m_material;
    const top = this.m_arrHeights ? this.m_arrHeights[col] : 0;
    if (!mat) return top;
    const W = this.m_nWidth;
    let y = top;
    // Bounded: a column cannot absorb more than the deepest coat we would ever want to see, and
    // without a stop a heavily-shelled spot would drill the pile down through the whole map.
    const limit = Math.min(this.m_nHeight - 1, top + RAD.PILE_MAX);
    while (y < limit && CLand.matRad(mat[y * W + col])) y++;
    return y;
  }

  /**
   * Open a new contamination EVENT: everything poisoned from here until the next call is one patch
   * of ground on one clock, however many detonations produce it.
   *
   * The event, not the detonation, is the unit — see {@link radiationSlot}. Driven off the TURN,
   * because the turn is already exactly one firing event: it does not advance until every shot has
   * landed and every grain of thrown earth has settled, so a cluster's whole family — however deep
   * it recurses, whatever trajectory carried it — falls inside one, and the next turn's blast is a
   * genuinely separate poisoning that deserves its own clock. Deliberately not a wall-clock window
   * or an idle heuristic: those would have to guess, and a net peer guessing differently would
   * colour its terrain differently.
   */
  beginRadiationEvent(): void {
    this.m_radEventSlot.clear();
  }

  /**
   * The terrain slot THIS contamination event deposits into — its colour and its clock together.
   *
   * Idempotent per (event, colour): ask once or ask twenty times, from a blast, from its cluster
   * children, from the ejecta tagger, from a beam, from a mine — the answer is the same slot, and
   * only the first ask consumes one. That is the whole point. There are only eight slots (three
   * bits in the material byte) and claiming one EVICTS whatever earth still holds it, so a call
   * site that claims per detonation is not merely wasteful, it wipes other players' contamination
   * off the map: an Anthrax (a 7-detonation cluster) claiming two slots apiece burned through the
   * table twice over and took every Plasma crater on the map with it. Making the answer a property
   * of the event rather than of the caller is what stops that at the root — a new weapon, or a new
   * trajectory behaviour, cannot get it wrong because there is nothing for it to get right.
   *
   * Across events it is still a fresh slot, never one shared with an earlier blast of the same
   * colour: sharing couples two craters' clocks, so the older one snaps back to full brightness the
   * instant the newer one lands and cannot go out while the newer one lives.
   */
  radiationSlot(rgb?: [number, number, number]): number {
    const [r, g, b] = CLand.radRGB(rgb);
    const key = ((r << 16) | (g << 8) | b) >>> 0;
    const held = this.m_radEventSlot.get(key);
    if (held !== undefined) return held; // this event is already poisoning in this colour
    const slot = this.pickRadSlot();
    // Recycling a slot ERASES the earth still tagged with it, rather than leaving it to be re-lit
    // in the new blast's colour on the new blast's clock — which is a long-dead crater switching
    // hue and glowing again, the same fault as sharing, only deferred by eight blasts. Bounded by
    // the hot bounding box and paid once per event, on a frame already carving terrain.
    this.clearRadSlot(slot);
    this.m_radSlotRGB[slot] = [r, g, b];
    this.m_radSlotAge[slot] = ++this.m_radSlotClock;
    this.m_radEventSlot.set(key, slot);
    return slot;
  }

  /**
   * Which slot the next contamination event takes: an unused one, else a BURNT-OUT one, else the
   * oldest.
   *
   * Preferring burnt-out slots is what makes the ninth blast of a match cost nothing visible. A
   * slot whose zone has expired is already inert — `drawRadGlow` skips it for want of a fade and
   * `update` has cooled its earth back to clean soil — so recycling it destroys nothing, whereas
   * evicting by age alone reaches for the oldest slot precisely because it is the one that has been
   * glowing longest, which is very often still burning.
   */
  private pickRadSlot(): number {
    if (this.m_radSlotRGB.length < MAT.RAD_SLOTS) return this.m_radSlotRGB.length;
    const live = new Set(this.m_radParticles.map(z => z.slot));
    // A slot this same event already claimed is not a candidate at any price — the event is still
    // depositing into it and its zone may not even be pushed yet.
    const held = new Set(this.m_radEventSlot.values());
    let best = -1;
    for (let i = 0; i < MAT.RAD_SLOTS; i++) {
      if (held.has(i)) continue;
      if (best < 0) best = i;
      else if (live.has(best) !== live.has(i))
        best = live.has(i) ? best : i; // dead beats live
      else if (this.m_radSlotAge[i] < this.m_radSlotAge[best]) best = i; // then oldest
    }
    return best < 0 ? 0 : best; // every slot spoken for (8 colours in one event) — reuse the first
  }

  /** Strip one slot's radioactivity out of the terrain — the earth reverts to ordinary soil. */
  private clearRadSlot(slot: number): void {
    const mat = this.m_material;
    if (!mat || this.m_radBoxX1 < this.m_radBoxX0) return;
    const W = this.m_nWidth;
    for (let y = this.m_radBoxY0; y <= this.m_radBoxY1; y++) {
      for (let x = this.m_radBoxX0; x <= this.m_radBoxX1; x++) {
        const i = y * W + x;
        if (CLand.matRad(mat[i]) && CLand.matSlot(mat[i]) === slot) {
          mat[i] &= 1; // keep the dirt tag, drop amount + slot
          this.m_radGlowDirty = true;
        }
      }
    }
  }

  /**
   * Send a compression wave out from a detonation: the ground it passes over COMPACTS, the surface
   * dropping most under the blast and less further out. Nothing is excavated — the earth is squeezed
   * — so the strata visibly bunch together near the surface instead of a band simply vanishing.
   *
   * Travels outward over time rather than landing all at once, so the ground gives way as a wave
   * you can watch reach you, and a tank sitting on the flat nearby loses its footing a moment after
   * the blast rather than in the same frame.
   */
  shockCompact(cx: number, radius: number, maxSink: number): void {
    if (radius <= 0 || maxSink <= 0) return;
    this.m_shocks.push({cx, radius, maxSink, front: 0});
  }

  /** Advance every live compression wave, compacting the ring of ground it has just reached. */
  private stepShocks(dt: number): void {
    if (!this.m_shocks.length || !this.m_arrHeights) return;
    let w = 0;
    for (const sh of this.m_shocks) {
      const prev = sh.front;
      sh.front += SHOCK.SPEED * dt;
      const [lo, hi] = this.clampCols(
        Math.floor(sh.cx - Math.min(sh.front, sh.radius)),
        Math.ceil(sh.cx + Math.min(sh.front, sh.radius)),
      );
      // Land any overburden still falling in this ring FIRST. A falling block tracks its own top and
      // repaints itself there each frame; compacting the column moves those pixels out from under
      // it, so the block erases at a position they have left and redraws lower — smearing a comb of
      // vertical streaks down the crater wall. The shock slamming a loose block down is also the
      // right reading of what just hit it.
      if (this.m_falls.length) this.settleFallsIn(lo, hi);
      for (let c = lo; c <= hi; c++) {
        const d = Math.abs(c - sh.cx);
        // Half-open [prev, front): a column exactly ON the wavefront must belong to ONE frame's ring
        // or it is compacted twice and sinks past `maxSink`. With a fixed timestep the fronts land
        // on exact integers, so a closed interval double-hits every Nth column — visible as a comb
        // of deep notches through the compacted ground.
        if (d < prev || d >= sh.front || d > sh.radius) continue;
        const t = d / sh.radius;
        // Sink falls off with distance and dies at the rim. The world-keyed blotch keeps the ground
        // from failing along a drawn curve, and only ever SUBTRACTS — a factor that can exceed 1
        // makes `maxSink` a suggestion rather than a limit, and lets a patch halfway out sink
        // further than ground zero, which reads as random potholes instead of a blast profile.
        // Deterministic, which matters because this writes the heightmap in a lockstep match.
        const fall = (1 - t * t) * (0.6 + 0.4 * blotchNoise(c, 0, SHOCK.CELL));
        const sink = Math.round(sh.maxSink * fall);
        // QUEUED, not applied. Compacting the column the instant the front reaches it drops the
        // ground its whole depth in a single frame — a hard step travelling across the map. Soil
        // under a shock settles over a moment, so the column owes this much and pays it off at
        // `SHOCK.SINK_RATE` below, which turns the step into a subsidence you watch arrive.
        if (sink > 0) this.queueSink(c, sink);
      }
      if (sh.front < sh.radius) this.m_shocks[w++] = sh;
    }
    this.m_shocks.length = w;
  }

  /**
   * Compact ONE column by `sink` px: the surface drops, and the soil under it is squeezed rather
   * than removed. The top `SHOCK.SQUASH` px of the column are resampled into `SHOCK.SQUASH − sink`,
   * so every band in that depth — strata, the crater's soil coat, deposited fill — thins in
   * proportion and the layering stays readable. Material and radiation ride along in the same
   * resample, so contaminated earth is compacted rather than losing track of itself.
   */
  private compactColumn(col: number, sink: number): void {
    const h = this.m_arrHeights;
    if (!h) return;
    const top = h[col];
    // The squeezed band grows with the sink so the compression RATIO is fixed, not the depth. At a
    // fixed band a big blast asking for a deep sink crushes the strata to a third of their spacing
    // while a small one barely creases them — the same effect reading completely differently by
    // size. Held at SHOCK.SQUASH_RATIO, every blast compresses the soil by the same proportion and
    // only the depth it reaches changes.
    // …but never deeper than the column actually HAS. Bailing out when the preferred band runs past
    // the world floor makes compaction conditional on how much rock happens to sit under a column:
    // high ground compacts, low ground silently does not, so one blast leaves whole sectors
    // untouched beside sunken ones and a comb of skipped columns through the middle (measured on a
    // nuke: 501 of 1280 columns in range get nothing at all). Squeezing a thinner band where there
    // is less room degrades the ratio locally, which is invisible; skipping the column is not.
    const room = this.m_nHeight - top - 1;
    if (room < 4) return; // genuinely no soil beneath — the column is a sliver at the world floor
    const band = Math.min(room, Math.max(SHOCK.SQUASH, Math.ceil(sink * SHOCK.SQUASH_RATIO)));
    // Keep at least a couple of rows to resample INTO, shrinking the drop if the band is that thin.
    sink = Math.min(sink, band - 2);
    const dstLen = band - sink;
    if (sink <= 0 || dstLen <= 1) return;
    const px = this.m_pixels;
    if (px) {
      const W = this.m_nWidth;
      const mat = this.m_material;
      // Snapshot first: source and destination overlap in the same buffer.
      const srcPx = new Uint32Array(band);
      const srcMat = mat ? new Uint8Array(band) : null;
      for (let j = 0; j < band; j++) {
        srcPx[j] = px[(top + j) * W + col];
        if (srcMat && mat) srcMat[j] = mat[(top + j) * W + col];
      }
      // AVERAGE the source rows each destination row stands for, rather than point-sampling one of
      // them. Nearest-neighbour drops rows, and because `dstLen` differs column to column each one
      // drops a DIFFERENT set — so a horizontal detail survives in one column and vanishes in its
      // neighbour, and the strata come out combed into vertical streaks. Averaging is also the
      // honest reading of compaction: soil squeezed into less space mixes, it does not decimate.
      for (let j = 0; j < dstLen; j++) {
        const s0 = Math.floor((j * band) / dstLen);
        const s1 = Math.max(s0 + 1, Math.floor(((j + 1) * band) / dstLen));
        let ar = 0,
          ag = 0,
          ab = 0,
          n = 0;
        for (let k = s0; k < s1 && k < band; k++) {
          const c32 = srcPx[k];
          if ((c32 & 0xff000000) === 0) continue; // empty rows contribute nothing
          ar += c32 & 0xff;
          ag += (c32 >> 8) & 0xff;
          ab += (c32 >> 16) & 0xff;
          n++;
        }
        const sj = Math.min(band - 1, s0);
        const i = (top + sink + j) * W + col;
        px[i] = n ? this.packSolid((ar / n) | 0, (ag / n) | 0, (ab / n) | 0) : srcPx[sj];
        if (mat && srcMat) mat[i] = srcMat[sj];
      }
      for (let y = top; y < top + sink; y++) {
        const i = y * W + col;
        px[i] = 0;
        if (mat) mat[i] = 0;
      }
    }
    h[col] = top + sink;
    if (this.m_baseHeights) this.m_baseHeights[col] = Math.max(this.m_baseHeights[col], h[col]);
    this.m_pixelsDirty = true;
    this.m_radGlowDirty = true;
    this.preBlast(col - 1, col + 1);
  }

  /** Reusable low-res scratch the glow layer is shrunk into to make its bloom. */
  private bloomScratch(w: number, h: number): HTMLCanvasElement | null {
    if (typeof document === 'undefined') return null;
    let cv = this.m_bloomCanvas;
    if (!cv) cv = this.m_bloomCanvas = document.createElement('canvas');
    if (cv.width < w || cv.height < h) {
      cv.width = Math.max(cv.width, w);
      cv.height = Math.max(cv.height, h);
    }
    return cv;
  }

  /** Record that a column owes `px` of subsidence, to be paid off over the next moment. */
  private queueSink(col: number, px: number): void {
    if (!this.m_sinkOwed) this.m_sinkOwed = new Float32Array(this.m_nWidth);
    this.m_sinkOwed[col] += px;
    this.m_sinkX0 = Math.min(this.m_sinkX0, col);
    this.m_sinkX1 = Math.max(this.m_sinkX1, col);
  }

  /**
   * Pay off queued subsidence. Each column drops at a fixed rate rather than all at once, so ground
   * the wave has passed keeps settling for a moment afterwards — and because the terrain is whole
   * pixels, the debt is carried as a float and only spent when it crosses an integer, which is what
   * lets a slow settle be slower than one pixel per frame.
   */
  private drainSink(dt: number): void {
    const owed = this.m_sinkOwed;
    if (!owed || this.m_sinkX1 < this.m_sinkX0) return;
    const step = SHOCK.SINK_RATE * dt;
    let lo = this.m_nWidth,
      hi = -1;
    for (let c = this.m_sinkX0; c <= this.m_sinkX1; c++) {
      const left = owed[c];
      if (left <= 0) continue;
      const pay = Math.min(left, step);
      const px = Math.floor(left) - Math.floor(left - pay);
      owed[c] = left - pay;
      if (px > 0) this.compactColumn(c, px);
      if (owed[c] > 0) {
        if (c < lo) lo = c;
        if (c > hi) hi = c;
      }
    }
    this.m_sinkX0 = lo;
    this.m_sinkX1 = hi;
  }

  /** Grow the hot-earth extent to include this pixel. */
  private growRadBox(x: number, y: number): void {
    if (this.m_radBoxX1 < this.m_radBoxX0) {
      this.m_radBoxX0 = this.m_radBoxX1 = x;
      this.m_radBoxY0 = this.m_radBoxY1 = y;
      return;
    }
    if (x < this.m_radBoxX0) this.m_radBoxX0 = x;
    if (x > this.m_radBoxX1) this.m_radBoxX1 = x;
    if (y < this.m_radBoxY0) this.m_radBoxY0 = y;
    if (y > this.m_radBoxY1) this.m_radBoxY1 = y;
  }

  /** Clear the radiation channel inside a disc — the zone decayed, so this earth is no longer hot.
   *  Without it the marks outlive their zone and a later blast overlapping the spot would relight
   *  ground that stopped glowing turns ago. */
  private coolRadiation(cx: number, cy: number, r: number): void {
    const mat = this.m_material;
    if (!mat) return;
    const W = this.m_nWidth;
    const [x0, x1] = this.clampCols(Math.floor(cx - r), Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)),
      y1 = Math.min(this.m_nHeight - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy > r2) continue;
        const i = y * W + x;
        if (CLand.matRad(mat[i])) {
          mat[i] &= 1; // keep the dirt tag, drop the radioactivity
          this.m_radGlowDirty = true;
        }
      }
    }
  }

  /** Arm the angle-of-repose slump over a span for a few seconds — it runs in `update()`
   *  after the falling blocks land, smoothing any spikes/nails into a natural slope. */
  private startSlump(x0: number, x1: number): void {
    this.m_slumpTimer = Math.max(this.m_slumpTimer, 2.5);
    this.m_slumpX0 = Math.min(this.m_slumpX0, x0 - 2);
    this.m_slumpX1 = Math.max(this.m_slumpX1, x1 + 2);
  }

  /**
   * One erosion pass over [x0,x1]: where two adjacent columns differ by more
   * than the angle of repose, move 1px of dirt from the taller column to the
   * lower one. Repeated, this melts the thin spikes debris stacks up into smooth mounds.
   */
  private slump(x0: number, x1: number): void {
    const h = this.m_arrHeights;
    if (!h) return;
    const THRESH = 8; // columns must differ by ≥8 before dirt slides (original gate is `7 < diff`)
    const a = Math.max(1, Math.floor(x0)),
      b = Math.min(this.m_nWidth - 2, Math.floor(x1));
    // Columns with an overburden block still FALLING have a transient (mid-air) surface height —
    // slumping against it stamps a pixel that the block then leaves stranded above the final ground
    // as it drops ("floating dirt"). Skip those columns until the block lands.
    const falling = this.m_falls.length ? new Set(this.m_falls.map(f => f.col)) : null;
    for (let x = a; x <= b; x++) {
      if (falling && (falling.has(x) || falling.has(x + 1))) continue;
      const diff = h[x + 1] - h[x]; // >0: column x is TALLER (smaller screen-Y)
      // Move 1px of dirt downhill: CLEAR the taller column's top pixel, STAMP one on the
      // lower — via the shared primitive, so the pixels track the avalanche.
      if (diff >= THRESH) {
        this.setColumnTop(x, h[x] + 1);
        this.setColumnTop(x + 1, h[x + 1] - 1);
      } else if (diff <= -THRESH) {
        this.setColumnTop(x + 1, h[x + 1] + 1);
        this.setColumnTop(x, h[x] - 1);
      }
    }
    if (b >= a) this.preBlast(a, b + 1);
  }

  /** Dirt-chunk colour string cached by brightness v (0..139) so a 6500-chunk nuke
   *  doesn't allocate 6500 `rgb()` strings per blast (GC churn → fire-time hitch). */
  private dirtColor(v: number): string {
    // (v, v/2, 0) — pure orange-brown, ZERO blue, exactly matching the original's packed dirt colour.
    // Any blue at all (e.g. `v>>3`) muddies it toward a darker "burned" tone.
    return this.m_dirtColors[v] ?? (this.m_dirtColors[v] = `rgb(${v},${v >> 1},0)`);
  }

  /** Throw dirt chunks. `deposit`: raise the column where each lands (true, blast ejecta) vs. just
   *  vanish (false, cosmetic). `gentle`: near-zero launch velocity so grains DROP rather than
   *  fountain — used for a beam cut, whose original ejects the removed band at ZERO velocity.
   *  `fill`: px of column each landed chunk raises — the earth VOLUME is `count × fill`, so a big
   *  crater can be refilled without paying for a chunk per pixel (see the caller in `WeaponBehavior`).
   *  `radSlot`: the colour slot this earth is CONTAMINATED with (−1 = clean). A nuke's spoil is not
   *  clean soil that fallout later dusts — it is the irradiated material itself, so it lands hot
   *  through its whole thickness and the glow accumulates exactly where the dirt does. */
  addShowerParticles(x: number, y: number, count: number, radius = 24, gentle = false, fill = 1, radSlot = -1): void {
    const pool = this.m_spoilPool;
    // This ejecta WRITES the heightmap, so every draw that shapes its motion must come from the
    // seeded LCG — two clients that throw it differently end up with different terrain.
    const r = () => this.rand01();
    for (let i = 0; i < count; i++) {
      const ang = r() * TWO_PI;
      // Dirt brown (R=v, G≈v/2, B≈0), occasionally a darker clod for texture.
      let v = 24 + Math.floor(Math.random() * 116); // [24,139]
      if (Math.random() < 0.25) v = Math.floor(v * 0.55); // some dark chunks
      // Launch speed scales with the blast radius so a small weapon's debris stays
      // near the crater instead of raining across the whole map.
      const speed = gentle ? r() * 10 : 30 + r() * (radius * 2.4);
      const up = gentle ? 0 : radius * (0.3 + r() * 1.3);
      // Reuse a settled chunk from the free pool — after the first big blast the
      // pool is warm, so a nuke allocates zero SpoilChunk objects (no GC spike).
      const p: SpoilChunk = pool.pop() ?? {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        color: '',
        rgba: 0,
        size: 0,
        spin: 0,
        age: 0,
        fill: 1,
        radSlot: -1,
      };
      p.fill = fill;
      // Born across the blast DISC (uniform over its area, no central spike), not a box.
      const bd = Math.sqrt(r()) * radius;
      p.x = x + Math.cos(ang) * bd;
      p.y = y + Math.sin(ang) * bd * 0.4;
      // The throw splits in two. MOST of the earth goes nearly straight up and rains back into the
      // hole it came out of — the launch `depositDirt` uses, and what the original does far more
      // literally (its debris leaves the rim at [2,10] px/s, barely more than a spill). Throwing all
      // of it outward at `radius·2.4` sprays the earth clear of the crater and leaves a nuke a bare
      // pit: only ~0.09 R of the depth it dug comes back.
      //
      // A minority is still FLUNG on the wide radial arc, because that is the part you watch: clods
      // sailing out and thudding down across the map, well away from the blast. They deposit where
      // they land, so this is real earth carried off, not decoration — which is why it is a minority
      // and not the default. Cosmetic spray (`deposit` false — beam/digger dust) is always flung:
      // nothing lands, so where it flies is purely a matter of looks.
      //
      // NOTE every draw here is `r()`, not the module random helpers: depositing ejecta writes the
      // heightmap, so each client must generate the same throw or the match desyncs.
      const flung = r() < DIRT.FLUNG_FRACTION;
      // Contamination rides the spoil that falls back INTO the hole — the flung clods land as plain
      // dirt. Not because a thrown clod would really be clean, but because the blast's radiation is
      // a bounded zone: earth tagged where it lands, a couple of hundred px clear of the crater,
      // would GLOW on ground that takes no fallout damage, and would ring the hole in exactly the
      // scattered off-crater red this change exists to get rid of. The same boundary the settling
      // fallout grains already keep.
      p.radSlot = flung ? -1 : radSlot;
      p.vx = flung ? Math.cos(ang) * speed : (r() * 2 - 1) * DIRT.THROW_SCATTER;
      p.vy = gentle ? r() * 12 : flung ? Math.sin(ang) * speed * 0.7 - up : -lerp(...DIRT.THROW_UP, r()) - up * 0.35;
      p.color = this.dirtColor(v);
      p.rgba = this.packSolid(v, v >> 1, 0);
      p.size = 1; // the original plots each chunk as a single 1px pixel — no 2px squares
      p.spin = 0;
      p.age = 0;
      this.m_spoil.push(p);
    }
    // Arm the rounding pass over the landing zone, exactly as `depositDirt` does — the crater's own
    // slump is armed at CARVE time and has largely run out by the time the last chunks come down.
    if (count > 0) this.armDirtSmoothing(x, radius);
  }

  /**
   * Blacken the terrain around a blast — a permanent scorch, DARKENED straight into the
   * terrain pixels (the original tints the same buffer). Being material-blind, it burns
   * deposited dirt exactly like native ground — solving "added dirt doesn't burn".
   */
  scorch(x: number, y: number, radius: number): void {
    // Darken a rim WELL beyond the crater — the crater interior is cleared away, so a scorch
    // barely wider than it would have almost no solid pixels left to burn. This blackens the
    // ground around and down the walls of the blast, the way the original chars the land. The
    // nominal radius runs a little past what a hard disc would need because scorchPixels feathers
    // its edge inward (a ragged, fading rim), which eats into the visible reach.
    this.scorchPixels(x, y, Math.max(22, radius * 2.0));
  }

  update(dt: number, wind?: Vec2): void {
    // Realistic wind pushes flying dirt AND airborne fallout sideways (Linear mode leaves both purely
    // ballistic — the classic feel). Terrain is broadcast authoritatively (getNetSnapshot), so
    // wind-nudged deposits stay in sync across clients without re-simulation. Precomputed once per frame.
    const realistic = !!wind && isRealisticWind();
    const windX = realistic ? wind!.x * WIND_ACCEL.DEBRIS : 0;
    const windY = realistic ? wind!.y * WIND_ACCEL.DEBRIS : 0;
    const foutX = realistic ? wind!.x * WIND_ACCEL.FALLOUT : 0;
    const foutY = realistic ? wind!.y * WIND_ACCEL.FALLOUT : 0;

    this.m_radPulseT += dt; // drives the sinusoidal glow shimmer on the radiation specks
    this.stepShocks(dt); // compression waves compacting the soil as they travel out
    this.drainSink(dt); // …and the ground they passed over still settling
    this.stepFalls(dt); // advance any beam/digger overburden falling under gravity

    // Compact-forward removal (a write index), NOT splice(i,1): a nuke flings
    // ~6500 chunks, and hundreds settle per frame — each splice shifts the whole
    // tail (O(n)), making settling O(n²) per frame: a hitch on impact and a sluggish
    // earth settle. Copying survivors forward and truncating once is O(n).
    // Columns with an overburden block still FALLING: a depositing chunk must NOT settle/stamp on the
    // block's transient (high) top — when the block lands lower the stamped dirt would be left floating
    // above the surface. Keep such chunks airborne until the column stabilises.
    const falling = this.m_falls.length ? new Set(this.m_falls.map(f => f.col)) : null;
    let dw = 0;
    for (let i = 0; i < this.m_spoil.length; i++) {
      const p = this.m_spoil[i];

      // Wind (Realistic mode only): the shared profile eases the push near the ground so settling
      // chunks barely drift while high-arcing ejecta leans on the wind. windX/Y are 0 in Linear mode.
      if (windX !== 0 || windY !== 0) {
        const wf = windProfile(this.getHeightAt(clamp(Math.floor(p.x), 0, this.m_nWidth - 1)) - p.y);
        p.vx += windX * wf * dt;
        p.vy += windY * wf * dt;
      }
      p.vy += DIRT.GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.age += dt;

      const col = Math.floor(p.x);
      if (col < 0 || col >= this.m_nWidth) {
        this.m_spoilPool.push(p);
        continue;
      } // left the field → recycle

      // A chunk settles ONLY when it actually reaches the surface on the way down, then deposits —
      // raising a column by 1px (matching the original debris settle). It must NOT force-settle on a
      // fixed age: every chunk is launched on the SAME frame, so a shared age cap fires for all the
      // still-airborne (highest-thrown) chunks in the SAME frame — the whole cloud snaps into the
      // ground at once ("high in the sky, then all fell 14 frames later"). Gravity brings each one
      // down on its own schedule, so the landing stays staggered.
      // Don't settle onto a column whose overburden is still FALLING — its surface is a transient
      // (mid-air) block top; depositing there strands dirt once the block lands lower. Keep flying.
      if (falling && falling.has(col)) {
        this.m_spoil[dw++] = p;
        continue;
      }
      if (p.vy > 0 && p.y >= this.getHeightAt(col) && this.m_arrHeights) {
        // Which column the chunk raises → writes the heightmap → seeded LCG.
        let dcol = clamp(col + ((this.rand01() * 4) | 0) - 2, 0, this.m_nWidth - 1); // −2..+1 (orig)
        if (falling && falling.has(dcol)) dcol = col; // never deposit onto a falling column
        // Height cap: dirt can't pile above `capY`. A chunk on a capped column is discarded, so tall
        // stacks (Land Fill) FLAT-TOP into a mesa instead of spiking (orig settle gate `0x60 <= y`).
        const capY = this.m_nHeight * DIRT.CAP_FRACTION;
        if (this.m_arrHeights[dcol] > capY) {
          // Raise the column by the chunk's `fill` (1px for everything that throws a chunk per pixel;
          // more for a crater too big to refill that way — see `addShowerParticles`), never up past
          // the pile cap. The stamp is `setColumnTop`'s own dirt sampler — the SAME source
          // the crater's soil coat draws from — so thrown earth and the earth lining the bowl are
          // one material. Overwriting it with a flat (v, v/2, 0) ramp instead leaves two visibly
          // different soils in the same hole: a textured coat around the rim and a bright orange
          // granular fill in the bottom. The original's debris carries the colour of the pixel it
          // was excavated from, which is exactly why its deposits are indistinguishable from the
          // ground around them.
          const wasTop = this.m_arrHeights[dcol];
          this.setColumnTop(dcol, Math.max(Math.ceil(capY), wasTop - p.fill));
          // Contaminated spoil: the earth a radioactive blast throws IS the hot material, so it
          // arrives hot rather than arriving clean and being dusted afterwards. This is the whole
          // coupling — radioactivity is carried by the dirt, so it accumulates wherever and however
          // deeply the dirt accumulates, and cannot pile up somewhere no dirt landed. (`setColumnTop`
          // zeroes the radiation bits of every pixel it stamps — earth arriving is clean by default —
          // so the fresh pixels are re-marked here, after it, not before.)
          if (p.radSlot >= 0)
            for (let yy = this.m_arrHeights[dcol]; yy < wasTop; yy++)
              this.stampRadiation(dcol, yy, p.radSlot, RAD.EJECTA_AMOUNT);
          if (this.m_baseHeights)
            this.m_baseHeights[dcol] = Math.min(this.m_baseHeights[dcol], this.m_arrHeights[dcol]);
          this.preBlast(dcol - 1, dcol + 1);
          // Let the slump smooth this area over the next few seconds.
          this.m_slumpTimer = 3;
          this.m_slumpX0 = Math.min(this.m_slumpX0, dcol - 3);
          this.m_slumpX1 = Math.max(this.m_slumpX1, dcol + 3);
        }
        this.m_spoilPool.push(p);
        continue; // settled (or capped) → recycle
      }

      this.m_spoil[dw++] = p; // still airborne → keep
    }
    this.m_spoil.length = dw;

    // Terrain slump (avalanche): where adjacent columns differ by more than the
    // repose threshold, move 1px of dirt from the taller to the lower — this
    // erodes the thin spikes debris would otherwise stack up. Scoped to the
    // recently-disturbed span (+timer) so it never erodes the natural
    // mountains elsewhere.
    if (this.m_slumpTimer > 0 && this.m_arrHeights) {
      for (let pass = 0; pass < 2; pass++) this.slump(this.m_slumpX0, this.m_slumpX1);
      this.m_slumpTimer -= dt;
      if (this.m_slumpTimer <= 0) {
        this.m_slumpX0 = this.m_nWidth;
        this.m_slumpX1 = 0;
      }
    }

    // Round Dirt-weapon piles into smooth mounds once their debris has finished landing. HELD while
    // any overburden block is still falling: those columns report the block's transient mid-air top,
    // so smoothing against it stamps dirt at a height the ground is about to vacate and leaves it
    // floating once the block lands. The pass has passes to spare — waiting out the collapse costs
    // nothing, and the same hazard applies to every caller that arms it.
    if (this.m_dirtSmoothDelay > 0) this.m_dirtSmoothDelay -= dt;
    else if (this.m_dirtSmoothPasses > 0 && !this.m_falls.length && this.m_arrHeights) {
      this.smoothDirtSpan(this.m_dirtSmoothX0, this.m_dirtSmoothX1);
      this.m_dirtSmoothPasses--;
    }

    let rw = 0;
    for (let i = 0; i < this.m_radParticles.length; i++) {
      const r = this.m_radParticles[i];
      r.timeRemaining -= dt;
      if (r.timeRemaining <= 0) {
        this.coolRadiation(r.x, r.y, r.radius); // decayed → the earth here is clean again
        continue; // zone expired → drop
      }
      this.m_radParticles[rw++] = r;
    }
    this.m_radParticles.length = rw;

    // Radiation specks: fall until they hit the surface, then settle and glow.
    let sw = 0;
    for (let i = 0; i < this.m_radSpecks.length; i++) {
      const s = this.m_radSpecks[i];
      s.age += dt;
      if (s.age >= s.life) {
        this.m_speckPool.push(s);
        continue;
      } // faded out → recycle

      {
        // Wind drift on the still-falling ash (Realistic mode) — eased near the ground by the profile
        // so the plume leans downwind aloft but still settles onto its zone. foutX/Y are 0 in Linear.
        if (foutX !== 0 || foutY !== 0) {
          const wc = clamp(Math.floor(s.x), 0, this.m_nWidth - 1);
          const wf = windProfile(this.getHeightAt(wc) - s.y);
          s.vx += foutX * wf * dt;
          s.vy += foutY * wf * dt;
        }
        // HELD first: the grain hangs where the blast put it before gravity takes it. Fall speed and
        // landing ORDER are otherwise the same knob — the fallout has to come down after the
        // crater's ejecta has finished refilling, or the fill buries the coat it just laid, and
        // buying that with gravity alone means making the grains drift down unnaturally
        // slowly. Holding them decouples the two: they hang in the fireball a moment, then fall at a
        // believable rate. An airburst is not held — it is already raining from height.
        if (s.age < s.hold) {
          this.m_radSpecks[sw++] = s;
          continue;
        }
        s.vy += RAD.GRAVITY * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        const col = Math.floor(s.x);
        if (col < 0 || col >= this.m_nWidth) {
          this.m_speckPool.push(s);
          continue;
        } // left the field → recycle
        if (s.vy > 0 && s.y >= this.getHeightAt(col)) {
          // Faithful settle scatter (the original, on settle, offsets x by −2..+1 columns and sets
          // y to `impactRow + (rand%12 − 2)` — i.e. a granular band from 2px ABOVE the surface to
          // 9px BELOW it). That ~11px scatter is what gives the coat its thickness — NOT a deep
          // 42px band (over-invented) and NOT a flat 1px line (over-thinned). `rise` (offset from the
          // surface at settle) is kept only so we can tell burial-by-fill from the crater-face coat;
          // the speck's y is FIXED from here (the original sets it once and never re-reads the ground).
          const jx = Math.floor(Math.random() * 4) - 2; // −2..+1 columns
          const c2 = clamp(col + jx, 0, this.m_nWidth - 1);
          // Grains launch with a small radial nudge and then fall, so a grain thrown from near the
          // rim drifts tens of px further out before it lands — and the ones flung outward over
          // undisturbed ground are exactly the ones that come to rest OUTSIDE the hole. Drop them:
          // the fallout must not reach past the earth the same blast turned over, or it reads as a
          // glow spilling onto ground the explosion never touched. Ground bursts only — an airburst
          // (`raining`) has no crater to stay inside and is meant to spread.
          if (!s.raining && Math.abs(c2 - s.zx) > s.zr) {
            this.m_speckPool.push(s);
            continue;
          }
          // LANDED. The grain stops being a particle here and becomes radioactivity IN THE EARTH:
          // it stamps the terrain's radiation channel and is recycled. That is what couples the two
          // — from this instant the fallout is a property of these pixels, so it is carved out with
          // them, buried by dirt piled over them, and cannot strand on ground that merely survived.
          //
          // WHERE it stamps is not a formula: the grain settles onto the fallout already lying in
          // this column, one grain deep at a time. The coat's whole profile falls out of that. It is
          // thick under the detonation and thins to nothing at the rim because that is simply where
          // more or fewer grains came down — the same distribution that put them there. Dictating
          // depth from a radial curve, with the position inside it drawn from another curve, means
          // re-tuning both every time the spray changes; a pile needs no tuning and cannot disagree
          // with the spray, because it IS the spray. It also self-maintains: carve the coat
          // away and the pile is gone with it, so the next grain starts from the surface again.
          // Settle into the SHALLOWEST of this column and its neighbours — fallout fills the low
          // spots rather than stacking into a tower. How much lands on a column is random, so with
          // each grain committed to exactly where it hit, neighbouring piles differ by several
          // grains and the coat comes out as a comb of vertical teeth: at 2px a grain, a five-grain
          // difference is a 10px step between adjacent columns, and a big blast lands enough grains
          // for 27px ones. Levelling across three columns turns that shot noise into a surface.
          const h = this.m_arrHeights!;
          let best = c2,
            bestDepth = this.radPileTop(c2) - h[c2];
          for (let nc = c2 - RAD.LEVEL_SPAN; nc <= c2 + RAD.LEVEL_SPAN; nc++) {
            if (nc === c2) continue;
            if (nc < 0 || nc >= this.m_nWidth) continue;
            const nDepth = this.radPileTop(nc) - h[nc];
            if (nDepth < bestDepth) {
              best = nc;
              bestDepth = nDepth;
            }
          }
          const pileTop = h[best] + bestDepth;
          for (let k = 0; k < RAD.GRAIN_DEPTH; k++) this.stampRadiation(best, pileTop + k, s.slot);
          this.m_speckPool.push(s);
          continue;
        }
      }
      this.m_radSpecks[sw++] = s; // still falling → keep
    }
    this.m_radSpecks.length = sw;

    // Heat haze: faint warm plumes ("fumes") rise off the live radioactive ground — spawned
    // across the active zone (fewer as it cools), lifting, widening and fading so the ground
    // reads as HOT. The zone sets the clock and the span; whether the EARTH at the chosen column is
    // still hot decides if a wisp actually rises there, so a crater carved through the middle of a
    // zone stops fuming without the zone having to be destroyed (which would take its glow too).
    const sink = this.m_fxSink;
    if (sink && this.m_radParticles.length && sink.heatCount() < HEAT.MAX) {
      for (const z of this.m_radParticles) {
        const cool = z.timeRemaining / Math.max(0.5, z.duration); // 1 hot → 0 cold
        const rr = z.radius;
        // Several small wisps per frame rather than the occasional big one — the haze reads as
        // haze only when the puffs overlap; sparse stamps just look like blobs.
        let spawn = 0;
        for (let k = 0; k < HEAT.PER_ZONE; k++) if (Math.random() < cool * 0.7) spawn++;
        // Tint the wisp with the weapon's radiation colour (irRGB), brightened
        // so hydrogen puffs BLUE / plutonium GREEN / uranium RED — matching the
        // carpet, not a fixed red.
        const mx = Math.max(z.r, z.g, z.b, 1),
          k2 = 230 / mx;
        const tr = Math.round(z.r * k2),
          tg = Math.round(z.g * k2),
          tb = Math.round(z.b * k2);
        for (let k = 0; k < spawn; k++) {
          const col = Math.floor(z.x - rr + Math.random() * rr * 2);
          if (col < 0 || col >= this.m_nWidth) continue; // spawn anywhere in the zone, off the surface
          if (!this.radiationAt(col, 0)) continue; // …but only where the ground is actually still hot
          const size = between(...HEAT.SIZE);
          // Hand the wisp off; CParticleSystem integrates and draws it from here. `26 + size` is
          // its constant lift — bigger plumes rise faster.
          sink.heatWisp(
            col + plusMinus(1),
            this.getHeightAt(col) - Math.random() * 4,
            size,
            between(0.7, 1.5),
            (Math.random() - 0.5) * 12,
            26 + size,
            tr,
            tg,
            tb,
          );
        }
      }
    }
  }

  /** Wire the haze to the particle system. CLand still decides where fallout fumes (it owns the
   *  radiation map); CParticleSystem owns the resulting particles. */
  setFxSink(sink: IFxSink): void {
    this.m_fxSink = sink;
  }

  getRadiationZones(): RadParticle[] {
    return this.m_radParticles.filter(r => r.timeRemaining > 0);
  }

  /**
   * Is column `x` covered by visible fallout — i.e. does a SETTLED radiation speck sit within
   * `margin` px of it? Drives "Radiation Damage: On": a tank on glowing ground takes DOT, so the
   * damage tracks what the player actually sees (the speck carpet spreads well past the blast
   * circle — especially airbursts drifting down a slope), instead of an invisible fixed radius.
   */
  radiationAt(x: number, margin = 12): boolean {
    const mat = this.m_material;
    if (!mat || !this.m_arrHeights) return false;
    const W = this.m_nWidth;
    const [lo, hi] = this.clampCols(Math.floor(x - margin), Math.ceil(x + margin));
    // Only the top of each column can be stood on, and the coat is packed against the surface, so
    // a shallow probe answers this — no need to sweep the whole depth of the band.
    for (let c = lo; c <= hi; c++) {
      const top = this.m_arrHeights[c];
      const bot = Math.min(this.m_nHeight - 1, top + RAD.CONTACT_DEPTH);
      for (let y = top; y <= bot; y++) if (CLand.matRad(mat[y * W + c])) return true;
    }
    return false;
  }

  // ========================================================================
  // ACCESSORS & QUERIES
  // ========================================================================

  getHeightAt(x: number): number {
    if (!this.m_arrHeights) return this.m_nHeight;
    const ix = Math.floor(x);
    if (ix < 0) return this.m_arrHeights[0];
    if (ix >= this.m_nWidth - 1) return this.m_arrHeights[this.m_nWidth - 1];
    const frac = x - ix;
    const h0 = this.m_arrHeights[ix];
    const h1 = this.m_arrHeights[ix + 1];
    return Math.floor(h0 + (h1 - h0) * frac);
  }

  getNormal(x: number): Vec2 {
    x = Math.floor(x); // a fractional x would index the typed height array as `undefined` → NaN normal
    if (!this.m_arrHeights || x < 1 || x >= this.m_nWidth - 1) {
      return new Vec2(0, -1);
    }

    const dx = 2;
    const dy = this.m_arrHeights[Math.min(x + 1, this.m_nWidth - 1)] - this.m_arrHeights[Math.max(x - 1, 0)];

    const len = Math.sqrt(dx * dx + dy * dy);

    // Surface tangent is (dx, dy); the outward (upward) normal is (dy, -dx) —
    // for a slope descending to the right (dy>0) it points up-right, and it is
    // (0,-1) on flat ground.
    return new Vec2(dy / len, -dx / len).normalize();
  }

  // ========================================================================
  // RENDERING
  // ========================================================================

  /**
   * Set the depth-sorted texture layers: the smallest depth is
   * the surface cap, larger depths are deeper strata. Rebuilds the cached bitmap.
   */
  setLayers(layers: {image: CanvasImageSource; depth: number}[], bareImage?: CanvasImageSource): void {
    // Layer depths are authored for a ~480px play area; scale them
    // to our (taller) terrain so the strata bands stay proportional.
    const scale = this.m_nHeight / 480;
    this.m_layers = layers
      .map(l => ({image: l.image, depth: Math.round(l.depth * scale)}))
      .sort((a, b) => a.depth - b.depth);
    // Guaranteed-bare (non-grass) earth texture used to repaint de-grassed crater
    // columns. Fall back to the deepest stratum (always sub-surface, never the cap).
    this.m_bareImage = bareImage ?? this.m_layers[this.m_layers.length - 1]?.image ?? null;
    this.m_terrainDirty = true;
    this.m_needsBake = true; // new textures → repaint the pixel buffer (rebuilds strata patterns)
    this.m_dirtTile = null; // rebuild the dirt sampler from the new bare texture
  }

  /** Pack an opaque colour into the buffer's little-endian RGBA word. */
  private packSolid(r: number, g: number, b: number): number {
    return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }

  /** Bare-earth colour at a pixel (tiled from the land's dirt texture) — used when a column
   *  RISES (deposit/fallout): the stamped dirt reads with the ground's own texture. */
  private dirtColorAt(x: number, y: number): number {
    const s = this.m_dirtTile;
    if (!s) return this.packSolid(120, 74, 34);
    return s.px[(((y % s.h) + s.h) % s.h) * s.w + (((x % s.w) + s.w) % s.w)];
  }

  /**
   * THE unifying terrain edit: move a column's top-solid surface to `newTop`.
   *   • rises (newTop < old) → STAMP pixels [newTop, old) with `colorFn` (default: bare dirt)
   *   • drops  (newTop > old) → CLEAR pixels [old, newTop) to empty
   * Only ever adds on top or removes from the top; the substrate pixels below stay put, so
   * craters never deform the layers and deposited dirt is real, native terrain.
   */
  setColumnTop(col: number, newTop: number, colorFn?: (x: number, y: number) => number): void {
    const h = this.m_arrHeights;
    if (!h || col < 0 || col >= this.m_nWidth) return;
    const nt = clamp(Math.floor(newTop), 0, this.m_nHeight);
    const old = h[col];
    const px = this.m_pixels;
    if (px) {
      const W = this.m_nWidth;
      if (nt < old) {
        for (let y = nt; y < old; y++) px[y * W + col] = colorFn ? colorFn(col, y) : this.dirtColorAt(col, y);
      } else if (nt > old) {
        for (let y = old; y < nt; y++) px[y * W + col] = 0;
      }
    }
    // The material byte is rewritten OUTSIDE the pixel guard: it is terrain state, so it has to stay
    // correct on a land with no colour buffer (headless sim, net client mid-boot) too. Writing the
    // dirt tag also zeroes the radiation bits, which is the whole coupling in one stroke — earth
    // arriving is clean, earth leaving takes its radioactivity with it, and a fill covering fallout
    // and a crater cutting it out are the same statement about the same byte.
    const matB = this.m_material;
    if (matB) {
      const W = this.m_nWidth;
      const tagB = nt < old && colorFn ? 0 : nt < old ? CLand.MAT_DIRT : 0;
      const [ya, yb] = nt < old ? [nt, old] : [old, nt];
      for (let y = ya; y < yb; y++) {
        const i = y * W + col;
        if (CLand.matRad(matB[i])) this.m_radGlowDirty = true;
        matB[i] = tagB;
      }
    }
    h[col] = nt;
    this.m_pixelsDirty = true;
  }

  /** Char the terrain pixels inside a disc — permanent scorch, baked into the buffer (the
   *  original tints the same pixels, so burnt DEPOSITED dirt darkens exactly like native ground).
   *
   *  Rather than MULTIPLYING the pixels down (which drives the core to flat black, leaves a
   *  hard-edged disc at the rim, and compounds to a solid hole where blasts overlap), each pixel
   *  is BLENDED toward its own charred colour by a soft radial weight:
   *   - the weight peaks at the centre and eases to exactly zero at the rim, so the burn washes
   *     out into the untouched ground instead of ending on a visible circle;
   *   - two octaves of world-space blotch noise warp the rim and mottle the interior, so the burn
   *     is a ragged patch, not a stencil — and because the noise is keyed to WORLD coordinates,
   *     overlapping blasts share one continuous burn texture rather than stacking discs;
   *   - the char target keeps a trace of the ground's own colour over a warm ember floor, so burnt
   *     sand still reads different from burnt rock and repeat hits settle at charcoal, never black.
   */
  private scorchPixels(cx: number, cy: number, radius: number): void {
    const px = this.m_pixels;
    if (!px) return;
    const W = this.m_nWidth,
      H = this.m_nHeight;
    const r = Math.max(1, radius);
    const invR = 1 / r;
    // Both noise octaves scale with the blast — a nuke gets big lobes and broad patchiness, a
    // grenade the same shape in miniature, so the burn never looks like a fixed-size grain
    // stamped over different radii.
    const rimCell = Math.max(8, r * 0.5),
      mottleCell = Math.max(5, r * 0.16);
    // Inside this fraction of the radius the burn is at full strength — a solid charred core that
    // then eases out, rather than a peak that starts fading from the very centre.
    const CORE = 0.35;
    const [x0, x1] = this.clampCols(Math.floor(cx - r), Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)),
      y1 = Math.min(H - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= r) continue;
        const i = y * W + x;
        const c = px[i];
        if ((c & 0xff000000) === 0) continue; // empty → skip
        // Warp the normalised radius by the coarse octave: the burn falls short of the nominal rim
        // by a varying amount, so its outline is lobed instead of a perfect circle. The warp only
        // ever pulls the edge INWARD (factor >= 1), which is what keeps the fade honest — the
        // weight is already 0 by the time it meets the `d >= r` cut, so there is no clipped step.
        const t = d * invR * (1 + 0.34 * blotchNoise(x, y, rimCell));
        if (t >= 1) continue; // outside the warped rim
        // Solid to CORE, then smoothstepped to zero at the rim — flat at BOTH ends, so there is
        // neither a hot pinprick at the centre nor an edge to see where the burn runs out.
        const u = t <= CORE ? 1 : (1 - t) / (1 - CORE);
        // The mid-scale octave then eats into it, the way fire leaves patches barely touched.
        const a = Math.min(1, smoothstep(u) * (0.86 + 0.2 * blotchNoise(x, y, mottleCell)));
        const sr = c & 0xff,
          sg = (c >> 8) & 0xff,
          sb = (c >> 16) & 0xff;
        // Charred version of THIS pixel: a dark ember-warm floor plus a fraction of the original,
        // so the burn keeps the ground's hue and its texture still shows through the char. The
        // floor is what stops repeat hits on one spot from grinding down to a black hole — they
        // converge on charcoal instead.
        const kr = 21 + sr * 0.14,
          kg = 16 + sg * 0.11,
          kb = 13 + sb * 0.09;
        const rr = (sr + (kr - sr) * a) | 0,
          gg = (sg + (kg - sg) * a) | 0,
          bb = (sb + (kb - sb) * a) | 0;
        px[i] = ((0xff << 24) | (bb << 16) | (gg << 8) | rr) >>> 0;
      }
    }
    this.m_pixelsDirty = true;
  }

  /** Build the tiled bare-earth colour sampler from the land's dirt texture (once per land). */
  private buildDirtTile(): void {
    if (typeof document === 'undefined') return;
    const img = this.m_bareImage;
    if (!img) return;
    const w = (img as {width: number}).width | 0,
      h = (img as {height: number}).height | 0;
    if (!w || !h) return;
    const made = tryCanvas2d(w, h);
    if (!made) return;
    const g = made.ctx;
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, w, h).data;
    this.m_dirtTile = {w, h, px: new Uint32Array(data.buffer.slice(0))};
  }

  /**
   * BAKE the strata into the persistent pixel buffer (generation / layers changed). Paints the
   * depth-layered terrain textures at the current heights, snapshots the canvas into
   * `m_terrainImage`/`m_pixels`, then all later edits are incremental pixel ops. This is the
   * only place strata are painted — nothing re-derives them from the surface afterwards.
   */
  private bakeTerrain(): void {
    const W = this.m_nWidth,
      H = this.m_nHeight;
    const heights = this.m_arrHeights!;
    // Drop the previous snapshot NOW (nothing below reads it — the strata are repainted from
    // `heights`) so its full-world buffer is reclaimable before `getImageData` allocates the new
    // one, instead of both being live at once. A re-bake keeps the terrain the same size, so this
    // is the routine per-generation path, not just a resize.
    this.m_terrainImage = null;
    this.m_pixels = null;
    this.m_material = null;
    this.m_radBoxX1 = this.m_radBoxY1 = -1; // hot-earth extent goes with it
    // Paint the strata into a TRANSIENT world-sized scratch, snapshot it, then free it. The
    // persistent display canvas is only VIEW-sized (`m_terrainCanvas`, the on-screen tile), so the
    // full-world RGBA never lives on past the bake — the largest steady-state buffer at big Land
    // Sizes. Patterns bind to this scratch ctx, so they're rebuilt here each bake (bake is rare).
    const {cv: scratch, ctx: g} = makeCanvas2d(W, H, {willReadFrequently: true});
    const patterns = this.m_layers.map(l => g.createPattern(l.image, 'repeat'));
    const EXT = 2;
    // The surface polyline, left→right, overhanging the map edges by EXT so a pattern fill reaches
    // the very first/last column. Every layer's region starts with it — the deepest closes down to
    // the world floor, the others `depth` px below the surface — so it is traced once, here.
    const traceSurface = () => {
      g.beginPath();
      g.moveTo(-EXT, heights[0]);
      for (let x = 0; x < W; x++) g.lineTo(x, heights[x]);
      g.lineTo(W + EXT, heights[W - 1]);
    };
    const deepest = patterns[this.m_layers.length - 1];
    if (deepest) {
      traceSurface();
      g.lineTo(W + EXT, H);
      g.lineTo(-EXT, H);
      g.closePath();
      g.fillStyle = deepest;
      g.fill();
    }
    for (let i = this.m_layers.length - 2; i >= 0; i--) {
      const pat = patterns[i];
      if (!pat) continue;
      const d = this.m_layers[i].depth;
      traceSurface();
      g.lineTo(W + EXT, heights[W - 1] + d);
      for (let x = W - 1; x >= 0; x--) g.lineTo(x, heights[x] + d);
      g.lineTo(-EXT, heights[0] + d);
      g.closePath();
      g.fillStyle = pat;
      g.fill();
    }
    // NOTE: no baked surface-edge stroke — in a pixel model there's no seam to hide, and a
    // stroke's top half lands ABOVE the surface as stray dark pixels that, once the terrain is
    // lowered by a crater, are left floating as a thin line tracing the OLD surface.
    // Snapshot → the persistent pixel buffer.
    this.m_terrainImage = g.getImageData(0, 0, W, H);
    scratch.width = scratch.height = 0; // free the world-sized scratch backing store immediately
    this.m_pixels = new Uint32Array(this.m_terrainImage.data.buffer);
    this.m_material = new Uint8Array(W * H); // fresh strata: native land (tag 0), not hot
    // Enforce a CRISP surface: canvas antialiases the SLOPED strata fill edge into faint
    // partial-alpha pixels a row or two ABOVE the true surface. Once a crater lowers the
    // ground those fringe pixels are left floating as "dots" tracing the old shape (only on
    // non-flat land — a flat edge has no diagonal to antialias). Clear everything above each
    // column's surface so nothing solid sits over the sky. (Later edits keep edges crisp.)
    const px = this.m_pixels;
    for (let x = 0; x < W; x++) {
      const top = heights[x];
      for (let y = 0; y < top; y++) px[y * W + x] = 0;
    }
    if (!this.m_dirtTile) this.buildDirtTile();
    this.buildBackdrop(); // snapshot the PRISTINE shape (darkened) for the Filled-Craters back layer
    this.m_needsBake = false;
    this.m_pixelsDirty = true;
  }

  /**
   * "Filled Craters" back layer: an ATMOSPHERIC snapshot of the pristine terrain, drawn BEHIND the
   * live terrain. Where the live terrain is later carved away, this shows through — so a crater reveals
   * the mountain's darkened interior ("the mass is still there behind, we only broke the surface"),
   * not the sky. A plain darken reads as the SAME texture (hard to tell destroyed from solid), so we
   * push it back via atmospheric perspective: DESATURATE (toward luminance) + COOL tint (recede blue) +
   * DARKEN. A blur + rim shadow are added at draw time. Captured once per bake, static as terrain dies.
   *
   * Built at HALF resolution (¼ the memory of a full world copy) and upscaled at draw — the backdrop is
   * blurred and only ever glimpsed through crater holes, so the half-res sampling is invisible.
   */
  private buildBackdrop(): void {
    const px = this.m_pixels;
    if (!px || typeof document === 'undefined') return;
    const W = this.m_nWidth,
      H = this.m_nHeight;
    const hw = Math.max(1, Math.ceil(W / 2)),
      hh = Math.max(1, Math.ceil(H / 2));
    if (!this.m_backdropCanvas) this.m_backdropCanvas = document.createElement('canvas');
    this.m_backdropCanvas.width = hw;
    this.m_backdropCanvas.height = hh;
    const bctx = this.m_backdropCanvas.getContext('2d');
    if (!bctx) return;
    const img = bctx.createImageData(hw, hh);
    const out = new Uint32Array(img.data.buffer);
    const DESAT = 0.6, // 0 = keep colour, 1 = full grayscale
      DARK = 0.5, // overall value drop
      TR = 0.78, // cool tint: cut warm channels, lift blue → the layer reads "distant/in shadow"
      TG = 0.9,
      TB = 1.22;
    for (let hy = 0; hy < hh; hy++) {
      const sy = Math.min(hy * 2, H - 1);
      for (let hx = 0; hx < hw; hx++) {
        const p = px[sy * W + Math.min(hx * 2, W - 1)]; // nearest-neighbour downsample of the live pixels
        if ((p & 0xff000000) === 0) {
          out[hy * hw + hx] = 0; // sky stays transparent
          continue;
        }
        let r = p & 0xff,
          g = (p >> 8) & 0xff,
          b = (p >> 16) & 0xff;
        const lum = 0.3 * r + 0.59 * g + 0.11 * b;
        r = (r + (lum - r) * DESAT) * DARK * TR;
        g = (g + (lum - g) * DESAT) * DARK * TG;
        b = (b + (lum - b) * DESAT) * DARK * TB;
        out[hy * hw + hx] = (0xff000000 | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r)) >>> 0;
      }
    }
    bctx.putImageData(img, 0, 0);
  }

  /** ?skiptexture: paint the terrain by MATERIAL — sky cyan, native land grayscale (luminance of
   *  its real colour, so strata still read), deposited/crater DIRT solid green. Rebuilt each draw
   *  (dev-only). Radiation specks + flying debris are recoloured in their own draw loops below. */
  private drawMaterialDebug(ctx: CanvasRenderingContext2D): void {
    const W = this.m_nWidth,
      H = this.m_nHeight;
    const px = this.m_pixels;
    const h = this.m_arrHeights;
    if (!px || !h) return;
    const mat = this.m_material;
    if (!this.m_debugCanvas) this.m_debugCanvas = document.createElement('canvas');
    if (this.m_debugCanvas.width !== W || this.m_debugCanvas.height !== H) {
      this.m_debugCanvas.width = W;
      this.m_debugCanvas.height = H;
      this.m_debugImage = null;
    }
    if (!this.m_debugImage) this.m_debugImage = new ImageData(W, H);
    const out = new Uint32Array(this.m_debugImage.data.buffer);
    const SKY = 0xffdc5a1e >>> 0; // ABGR uint32 (0xAABBGGRR): sky blue R30 G90 B220
    const DIRT = 0xff00c800 >>> 0; // ABGR: green, opaque
    // Flat grey LEVELS for native land, banded by depth below THIS column's surface — no texture.
    const GRASS = 0xffcccccc >>> 0; // light grey — the thin surface cap
    const EARTH = 0xff808080 >>> 0; // mid grey — the soil beneath
    const ROCK = 0xff383838 >>> 0; // near-black — deep foundation rock
    const GRASS_D = 6; // px of cap before it reads as earth
    const EARTH_D = 40; // px of soil below the cap; deeper = rock
    for (let x = 0; x < W; x++) {
      const surf = h[x];
      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        const c = px[i];
        if ((c & 0xff000000) === 0) {
          out[i] = SKY;
          continue;
        }
        if (mat && (mat[i] & 1) === CLand.MAT_DIRT) {
          out[i] = DIRT;
          continue;
        }
        const depth = y - surf;
        out[i] = depth < GRASS_D ? GRASS : depth < EARTH_D ? EARTH : ROCK;
      }
    }
    const dctx = this.m_debugCanvas.getContext('2d');
    if (dctx) dctx.putImageData(this.m_debugImage, 0, 0);
    ctx.drawImage(this.m_debugCanvas, 0, 0);
  }

  /**
   * The visible world span (left edge + width), set by the controller each frame. The terrain is
   * mirrored to a canvas only this wide (the on-screen tile) instead of a full worldWidth-wide one,
   * so at large Land Sizes only the slice actually on screen is materialised. A 0 width (tests, or
   * before the first set) tiles the whole world — preserving the original behaviour.
   */
  setViewport(camX: number, viewW: number): void {
    this.m_viewCamX = Math.max(0, Math.floor(camX));
    this.m_viewSpanW = Math.max(0, Math.floor(viewW));
  }

  /** Tile width: the view span (clamped to the world) or, when no viewport is set, the whole world. */
  private tileSpanW(): number {
    return this.m_viewSpanW > 0 ? Math.min(this.m_viewSpanW, this.m_nWidth) : this.m_nWidth;
  }

  /** World-X of the tile's left edge, clamped so the tile never runs past the world's right edge. */
  private tileSpanX(): number {
    if (this.m_viewSpanW <= 0) return 0;
    return Math.min(this.m_viewCamX, Math.max(0, this.m_nWidth - this.tileSpanW()));
  }

  /** The persistent on-screen terrain tile (view-sized). Resized in place when the span changes. */
  private ensureTerrainTile(): HTMLCanvasElement {
    const w = this.tileSpanW();
    if (!this.m_terrainCanvas) this.m_terrainCanvas = document.createElement('canvas');
    if (this.m_terrainCanvas.width !== w || this.m_terrainCanvas.height !== this.m_nHeight) {
      this.m_terrainCanvas.width = w;
      this.m_terrainCanvas.height = this.m_nHeight;
      this.m_tileCamX = -1; // size changed → force a re-upload
      this.m_terrainDirty = true;
    }
    return this.m_terrainCanvas;
  }

  /**
   * Copy the currently-visible column span of the world pixel buffer into the view-sized tile.
   * Re-uploaded only when the pixels changed (`m_pixelsDirty`) or the camera moved to a new span —
   * so a still frame uploads nothing. `putImageData(img, -x, 0, x, 0, w, h)` lands world columns
   * [x, x+w) at tile columns [0, w).
   */
  private uploadTile(tile: HTMLCanvasElement, spanX: number): void {
    if (!this.m_terrainImage) return;
    if (!this.m_pixelsDirty && this.m_tileCamX === spanX) return;
    const tctx = tile.getContext('2d');
    if (!tctx) return;
    tctx.putImageData(this.m_terrainImage, -spanX, 0, spanX, 0, tile.width, this.m_nHeight);
    this.m_pixelsDirty = false;
    this.m_tileCamX = spanX;
  }

  /**
   * True while the terrain layer will still change visibly — debris/fallout in
   * motion, an active slump, or a stale cached bitmap awaiting a rebuild. Drives
   * the game's present-on-demand gate: when this (and everything else) is false,
   * the frame is static and the redraw/upload can be skipped.
   */
  isAnimating(): boolean {
    return (
      this.m_terrainDirty ||
      this.m_needsBake ||
      this.m_pixelsDirty ||
      this.m_slumpTimer > 0 ||
      this.m_dirtSmoothPasses > 0 ||
      this.m_dirtSmoothDelay > 0 ||
      this.m_falls.length > 0 ||
      this.m_shocks.length > 0 ||
      this.m_sinkX1 >= this.m_sinkX0 ||
      this.m_spoil.length > 0 ||
      this.m_radSpecks.length > 0 ||
      this.m_radParticles.length > 0 ||
      (this.m_fxSink?.heatCount() ?? 0) > 0
    );
  }

  /** Terrain still physically resolving (gravity collapse or falling debris) — the
   *  round should not hand off the turn until this settles. Narrower than
   *  `isAnimating()` (which also covers cosmetic redraw/rebuild flags). */
  isSettling(): boolean {
    // A compression wave counts: it is still reshaping ground tanks are standing on, so the round
    // must not hand off the turn until it has passed.
    return (
      this.m_falls.length > 0 || this.m_shocks.length > 0 || this.m_sinkX1 >= this.m_sinkX0 || this.m_spoil.length > 0
    );
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.m_arrHeights) return;
    const W = this.m_nWidth,
      H = this.m_nHeight;

    if (this.m_layers.length > 0) {
      // Bake the strata into the persistent pixel buffer once (fresh terrain / layers loaded),
      // then only push incremental pixel edits — the terrain is a real per-pixel bitmap now.
      if (this.m_needsBake) this.bakeTerrain();
      if (CLand.debugMaterials) {
        this.drawMaterialDebug(ctx); // ?skiptexture: land grey / dirt green / sky cyan
      } else {
        // Mirror only the on-screen span into the view-sized tile, then blit it at its world-X
        // (the ctx is already camera-translated, so the tile lands under the viewport).
        const spanX = this.tileSpanX();
        const tile = this.ensureTerrainTile();
        this.uploadTile(tile, spanX);
        // Filled Craters: draw the atmospheric PRISTINE terrain first, so carved-away regions reveal
        // the mountain's darkened interior behind the live terrain (not the sky). Off → craters are voids.
        if (GameConfig.craterFill && this.m_backdropCanvas) {
          // Upscale+blur only the VISIBLE span of the half-res backdrop, not the whole world — on a
          // Land-Size-5 map (~5× the view) a full-world blurred upscale twice per frame is a big cost.
          const spanW = this.tileSpanW();
          const bw = this.m_backdropCanvas.width,
            bh = this.m_backdropCanvas.height;
          const bx = (spanX / W) * bw, // the backdrop is world-sized (at half res), so scale span → backdrop px
            bwSpan = (spanW / W) * bw;
          ctx.save();
          ctx.filter = 'blur(3px)'; // soften → the backdrop recedes (depth of field)
          ctx.drawImage(this.m_backdropCanvas, bx, 0, bwSpan, bh, spanX, 0, spanW, H);
          // rim shadow: a soft black echo of the live terrain, dropped a few px INTO the carved
          // void, so the crater edge casts an ambient-occlusion shadow onto the backdrop below it.
          ctx.filter = 'blur(3px) brightness(0)';
          ctx.globalAlpha = 0.5;
          ctx.drawImage(tile, spanX, 7);
          ctx.restore();
        }
        ctx.drawImage(tile, spanX, 0);
      }
    } else {
      // Gradient fallback until the land tiles finish loading — clip to the VISIBLE span, not the
      // full world, or a big map allocates ~W gradients + fills EVERY frame during the async load
      // (tileSpanX/W fall back to the whole world when no viewport has been set).
      const fx0 = this.tileSpanX();
      const fx1 = Math.min(W - 1, fx0 + this.tileSpanW());
      for (let x = fx0; x < fx1; x++) {
        const yTop = this.m_arrHeights[x];
        if (yTop >= H) continue;
        const grad = ctx.createLinearGradient(0, yTop, 0, H);
        grad.addColorStop(0, '#4a7c23');
        grad.addColorStop(0.15, '#8B4513');
        grad.addColorStop(1, '#654321');
        ctx.fillStyle = grad;
        ctx.fillRect(x, yTop, 1, H - yTop);
      }
    }

    // Radioactive GROUND: the settled coat, read straight out of the terrain's radiation channel.
    this.drawRadGlow(ctx);

    // Radiation specks — fallout still IN THE AIR. The original draws each as a 5-pixel ADDITIVE
    // CROSS (centre + 4 orthogonal neighbours) tinted by irRGB, fading LINEARLY to black over its
    // life. Two fillRects make the plus (the centre is drawn twice → brightest). Once a grain
    // lands it stops being drawn here and becomes part of the ground above.
    if (this.m_radSpecks.length) {
      const dbg = CLand.debugMaterials; // ?skiptexture: solid RED specks (no additive wash)
      // Same treatment the dirt cloud gets, for the same reason: thousands of grains, one canvas
      // call each. Here the grains blend ADDITIVELY rather than overwriting, so they accumulate
      // into the buffer instead of being plotted into it, and the finished buffer is blitted once
      // with 'lighter' — which stacks identically to drawing them one by one. Each grain keeps its
      // own twinkle (own phase AND rate, so the cloud shimmers rather than pulsing in unison) and
      // its own life fade; those are just numbers here, and numbers are free.
      const gt = this.m_radPulseT;
      let bx0 = this.m_nWidth,
        bx1 = -1,
        by0 = this.m_nHeight,
        by1 = -1;
      for (const s of this.m_radSpecks) {
        if (s.age >= s.life) continue;
        const x = Math.round(s.x),
          y = Math.round(s.y);
        if (x < 1 || x >= this.m_nWidth - 1 || y < 1 || y >= this.m_nHeight - 1) continue;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
      if (bx1 >= bx0) {
        const dw = bx1 - bx0 + 2,
          dh = by1 - by0 + 2;
        const out = dw * dh <= DIRT.BLIT_MAX_AREA ? this.m_speckBlit.beginBytes(dw, dh) : null;
        if (out) {
          for (const s of this.m_radSpecks) {
            const fade = 1 - s.age / s.life;
            if (fade <= 0) continue;
            const x = Math.round(s.x),
              y = Math.round(s.y);
            if (x < 1 || x >= this.m_nWidth - 1 || y < 1 || y >= this.m_nHeight - 1) continue;
            const a = dbg ? 1 : fade * (0.72 + 0.28 * Math.sin(gt * s.pw + s.phase));
            const cr = dbg ? 255 : s.r * a,
              cg = dbg ? 0 : s.g * a,
              cb = dbg ? 0 : s.b * a;
            // Buffer coords, NOT world-minus-one: the blit already places buffer (0,0) at
            // (bx0-1, by0-1), so subtracting another 1 here would put the leftmost column's
            // grains at index -1 — which in a row-major buffer is not off the edge but the LAST
            // pixel of the row above, drawing a stray speck to the right of the cloud for every
            // grain on its left. The 2×2 mark runs 0..dw-1, exactly the width the bounds reserve.
            const px0 = x - bx0,
              py0 = y - by0;
            for (let k = 0; k < 4; k++) {
              const o = ((py0 + (k >> 1)) * dw + (px0 + (k & 1))) * 4;
              out[o] = Math.min(255, out[o] + cr);
              out[o + 1] = Math.min(255, out[o + 1] + cg);
              out[o + 2] = Math.min(255, out[o + 2] + cb);
              out[o + 3] = 255;
            }
          }
          const prevOp = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = dbg ? 'source-over' : 'lighter';
          this.m_speckBlit.end(ctx, dw, dh, bx0 - 1, by0 - 1);
          ctx.globalCompositeOperation = prevOp;
        }
      }
    }

    // The radioactive heat haze lives in CParticleSystem (see IFxSink); the controller calls
    // drawHeat() straight after this, so it paints in this slot — under the tanks and the aim
    // overlay.

    // Dirt debris chunks in flight — each is a SINGLE opaque 1px pixel (the original plots one
    // `setPixel(floor(x), floor(y), color)` per chunk: no 2px squares, no blend). Floor the
    // position so it lands on a crisp pixel instead of being anti-aliased across two.
    // Every chunk is a SINGLE opaque pixel of its own colour, and a nuke has ~15k of them in the
    // air. Drawn one `fillRect` at a time that is 15k canvas calls plus 15k `fillStyle` string
    // assignments a frame — measured at 2.6ms, the largest single item in the frame. They are
    // literally pixels, so they are plotted INTO a pixel buffer and blitted once instead: the whole
    // cloud costs one `drawImage` regardless of how many chunks it holds. Floored positions keep
    // each on a crisp pixel rather than anti-aliased across two, as before.
    if (!this.m_spoil.length) return;
    const dbgDebris = CLand.debugMaterials; // ?skiptexture: flying dirt chunks are green too
    let bx0 = this.m_nWidth,
      bx1 = -1,
      by0 = this.m_nHeight,
      by1 = -1;
    for (const p of this.m_spoil) {
      const x = Math.floor(p.x),
        y = Math.floor(p.y);
      if (x < 0 || x >= this.m_nWidth || y < 0 || y >= this.m_nHeight) continue;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
    if (bx1 < bx0) return; // every chunk is off-world this frame
    const dw = bx1 - bx0 + 1,
      dh = by1 - by0 + 1;
    if (typeof document === 'undefined' || dw * dh > DIRT.BLIT_MAX_AREA) {
      // Headless, or the cloud is spread so wide the buffer would cost more than the calls it saves.
      if (dbgDebris) ctx.fillStyle = '#00c800';
      for (const p of this.m_spoil) {
        if (!dbgDebris) ctx.fillStyle = p.color;
        ctx.fillRect(Math.floor(p.x), Math.floor(p.y), 1, 1);
      }
      return;
    }
    const buf = this.m_blit.begin(dw, dh); // transparent — the terrain must show through the gaps
    if (!buf) return;
    const DBG = this.packSolid(0, 200, 0);
    for (const p of this.m_spoil) {
      const x = Math.floor(p.x) - bx0,
        y = Math.floor(p.y) - by0;
      if (x < 0 || x >= dw || y < 0 || y >= dh) continue;
      buf[y * dw + x] = dbgDebris ? DBG : p.rgba;
    }
    this.m_blit.end(ctx, dw, dh, bx0, by0);
  }

  // ========================================================================
  // MEMBER VARIABLES
  // ========================================================================

  private m_nWidth: number = 800;
  private m_nHeight: number = 600;
  private m_arrHeights: Int16Array | null = null;
  // Undisturbed surface (highest ground ever, incl. raised mounds). Craters expose
  // the cavity between this and the current lowered surface — we fill it with dirt.
  private m_baseHeights: Int16Array | null = null;

  private m_dirtyMin: number = -1;
  private m_dirtyMax: number = -1;

  private m_spoil: SpoilChunk[] = []; // excavated earth in flight (deposits on landing)
  private m_radParticles: RadParticle[] = [];
  private m_radSpecks: RadSpeck[] = [];
  private m_radPulseT = 0; // clock for the sinusoidal glow shimmer on the fallout
  // Free lists of dead particle objects, refilled on removal and drained on emit, so a
  // repeat blast reuses objects instead of allocating thousands (kills the GC hitch).
  private m_spoilPool: SpoilChunk[] = [];
  private m_speckPool: RadSpeck[] = [];
  private m_dirtColors: string[] = []; // dirt-chunk colour strings cached by brightness v
  // The heat haze itself lives in CParticleSystem (see IFxSink); CLand only decides where it
  // rises. Null in tests / before wiring, in which case the fallout simply doesn't fume.
  private m_fxSink: IFxSink | null = null;
  // Falling overburden blocks (beam/digger slice collapse): a captured column of pixels (the
  // cap + earth above the cut) sliding DOWN under gravity to land on the substrate below.
  private m_falls: Fall[] = [];
  private m_shocks: Shock[] = [];
  // Subsidence a column still owes, in px, paid off over time by `drainSink`.
  private m_sinkOwed: Float32Array | null = null;
  private m_sinkX0 = 0;
  private m_sinkX1 = -1;
  // Terrain-slump erosion, scoped to the recently-disturbed span for a short window.
  private m_slumpTimer: number = 0;
  private m_slumpX0: number = 1e9;
  private m_slumpX1: number = 0;
  // Dirt-pile rounding: after a deposit's debris lands (delay), run bounded box-3 smoothing over the span.
  private m_dirtSmoothDelay = 0;
  private m_dirtSmoothPasses = 0;
  private m_dirtSmoothX0 = 0;
  private m_dirtSmoothX1 = 0;

  // Layered textures + cached destructible-terrain bitmap.
  private m_layers: {image: CanvasImageSource; depth: number}[] = [];
  private m_bareImage: CanvasImageSource | null = null; // non-grass earth for de-grassed craters
  private m_terrainCanvas: HTMLCanvasElement | null = null; // VIEW-sized on-screen tile (not the whole world)
  private m_backdropCanvas: HTMLCanvasElement | null = null; // darkened pristine terrain (Filled Craters)
  private m_terrainDirty: boolean = true;
  // Visible world span the tile mirrors (set each frame by the controller; 0 span → whole world).
  private m_viewCamX = 0;
  private m_viewSpanW = 0;
  private m_tileCamX = -1; // camX of the tile's last upload (−1 → force the next upload)

  // ---- TERRAIN PIXEL BUFFER ----------------------------------------------
  // The terrain is ONE persistent per-pixel colour bitmap (matching the original engine):
  // grass, rock, deposited dirt and scorch are ALL just pixels here, positionally FIXED.
  // `m_arrHeights` is the per-column top-solid index (collision/queries). Every terrain edit
  // goes through `setColumnTop` (stamp dirt when a column rises, clear when it drops) or the
  // pixel tint helpers — so deposited dirt is indistinguishable from native ground and the
  // substrate never deforms when the surface moves.
  private m_terrainImage: ImageData | null = null; // RGBA buffer blitted to m_terrainCanvas
  private m_pixels: Uint32Array | null = null; // 32-bit view of m_terrainImage.data (0 = empty/sky)
  private m_needsBake = true; // repaint strata → pixels (fresh terrain / layers changed)
  private m_pixelsDirty = false; // pixels edited since last putImageData
  private m_dirtTile: {w: number; h: number; px: Uint32Array} | null = null; // bare-earth colour sampler
  // Per-pixel MATERIAL tag for the ?skiptexture debug view. Only DIRT needs marking (=1); a solid
  // pixel with tag 0 is native land, an empty pixel (m_pixels alpha 0) is sky. Parallel to m_pixels.
  private m_material: Uint8Array | null = null;
  // Cached glow layer built from `m_radField`; rebuilt only when the hot EARTH changes, never for a
  // fade (that is the blit alpha), so the decay cannot step.
  /** One baked glow layer per radiation slot (per blast), so each blits on its own zone's clock. */
  private m_radGlowCanvas: (HTMLCanvasElement | undefined)[] = [];
  private m_radGlowX = 0;
  private m_radGlowY = 0;
  private m_radGlowDirty = false;
  private m_bloomCanvas: HTMLCanvasElement | null = null;
  // The colours those slots stand for, in claim order, and when each was claimed (see `pickRadSlot`
  // for which one the next event takes).
  private m_radSlotRGB: [number, number, number][] = [];
  private m_radSlotAge: number[] = [];
  private m_radSlotClock = 0;
  // Colour → slot for the contamination event IN PROGRESS (see `beginRadiationEvent`). This is what
  // makes `radiationSlot` idempotent, so no caller can claim the same event's slot twice.
  private m_radEventSlot = new Map<number, number>();
  // Extent of the HOT EARTH, grown as the channel is written. The glow layer is sized from this and
  // never from the zones' radii: the coat reaches the crater FLOOR, which lies below `z.y + radius`,
  // so a zone-sized layer sliced the bottom off the coat with a flat horizontal cap — and when a
  // nearby blast dropped a zone, the layer shrank away from earth that was still radioactive and the
  // old glow simply disappeared. Only ever grown (a clear leaves it conservative), which costs a few
  // wasted pixels in the layer and saves rescanning the field.
  private m_radBoxX0 = 0;
  private m_radBoxX1 = -1;
  private m_radBoxY0 = 0;
  private m_radBoxY1 = -1;
  private m_debugImage: ImageData | null = null; // scratch RGBA for the debug render
  private m_debugCanvas: HTMLCanvasElement | null = null;
  // Scratch buffer the in-flight dirt cloud is plotted into, then blitted in one call (see `draw`).
  // One-call blit of the in-flight dirt cloud (see util/PixelBlitter).
  private readonly m_blit = new PixelBlitter(); // flying dirt chunks (opaque, one word per pixel)
  private readonly m_speckBlit = new PixelBlitter(); // fallout specks (additive, per-channel)

  /** Dev (?skiptexture=1): render the terrain as MATERIALS not textures — land grayscale,
   *  dirt green, radiation red, sky cyan — so deposits/craters/fallout are unambiguous. */
  static debugMaterials = false;
  private static readonly MAT_DIRT = 1;

  get width(): number {
    return this.m_nWidth;
  }

  get height(): number {
    return this.m_nHeight;
  }
}
