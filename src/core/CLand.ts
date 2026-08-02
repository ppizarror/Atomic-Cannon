/**
 * CLand - Terrain Management Class.
 */

import {Vec2} from '../math/Vec2';
import {clamp, clamp01, smoothstep, TWO_PI} from '../math/num';
import {blotchNoise, hashLattice} from '../math/noise';
import {between, plusMinus} from '../math/random';
import {GameConfig} from './CGameConfig';
import {isRealisticWind, windProfile} from './wind';

// Sideways acceleration (px/s^2) a unit of wind imparts to flying dirt chunks. Dirt is heavy,
// so this is well below smoke's push — high-arcing ejecta leans on the wind, low chunks barely.
// Only applied in Realistic wind mode; Linear mode leaves ejecta purely ballistic (the classic feel).
const DEBRIS_WIND_ACCEL = 12;
// Wind push on airborne fallout specks (Realistic mode). Ash is far lighter than dirt clods, so it
// streams downwind into a leaning plume as it settles — but the altitude profile eases it near the
// ground, so specks still land on/near their radiation zone (the damage area itself never moves).
const FALLOUT_WIND_ACCEL = 26;

// ==========================================================================
// INTERFACES & TYPES
// ==========================================================================

interface LandParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string; // dirt-chunk colour, sampled from the terrain palette
  size: number; // chunk size in px
  spin: number; // visual tumble
  age: number; // seconds airborne
  deposit: boolean; // on landing: raise the column (true) vs. just vanish (false — cosmetic ejecta)
}

interface RadParticle {
  x: number;
  y: number;
  radius: number;
  damagePerSecond: number;
  timeRemaining: number;
  duration: number; // irTime (for the visual fade)
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
  raining: boolean; // thrown from a mid-air burst: it has no crater to stay inside, so it may spread
  phase: number; // random glow-pulse phase (so specks shimmer INDEPENDENTLY, no coherent wave)
  pw: number; // random glow-pulse angular rate (each speck breathes at its own speed)
  r: number;
  g: number;
  b: number; // tint (from the weapon's irRGB, per zone)
}

// A faint warm plume rising off the radioactive carpet — it lifts, widens, spins
// and fades, so the hot fallout SHIMMERS with heat. Purely visual, transient.
interface HeatWisp {
  x: number;
  y: number;
  age: number;
  life: number;
  size: number;
  vx: number;
  rot: number;
  spin: number;
  r: number;
  g: number;
  b: number;
}

// A falling overburden block (beam/digger slice collapse): a captured column of pixels
// (the cap + earth above a cut) sliding DOWN under gravity to land on the substrate below.
interface Fall {
  col: number;
  y: number;
  thick: number;
  target: number;
  vel: number;
  colors: Uint32Array;
  // Packed material byte per captured pixel: the dirt tag AND how radioactive that earth is, so a
  // sliding cliff carries its fallout down with it instead of leaving it hanging where it used to be.
  mats: Uint8Array;
}

// ==========================================================================
// CLand CLASS
// ==========================================================================

/** Dirt debris count = `earth × radius × this`. Factoring radius in makes the PEAK scale with
 *  `earth` (Mountain, earth 90, piles biggest) while WIDTH tracks radius (Dirty Boy r15 broader than
 *  Dirtox r10). Each landed chunk raises a column +1px; repose + a rounding pass then settle it. */
const DIRT_DEPOSIT_VOLUME = 5.5;
/** Round the raw angle-of-repose cone into a SMOOTH mound. Runs a box-3 averaging pass EVERY frame
 *  from the first chunk (no delay) so the pile looks smooth AS IT BUILDS — never spiky-then-round.
 *  `PASSES` spans the settle (~1 pass/frame) then stops so it rounds without flattening away. */
const DIRT_SMOOTH_DELAY = 0;
const DIRT_SMOOTH_PASSES = 110;
/** Dirt-chunk launch (px/s). Chunks go mostly STRAIGHT UP with a little random horizontal scatter,
 *  then rain back down NEAR where they were born — so the pile takes the shape of the birth DISC
 *  (dome-weighted: a uniform-area disc drops more dirt at the centre). A radial-OUTWARD throw instead
 *  lands chunks in a RING → a double-peaked crater-mound, so the launch is deliberately vertical. */
const DIRT_THROW_SCATTER = 12; // small random horizontal (px/s) — NOT radial-outward
const DIRT_THROW_UP_MIN = 35;
const DIRT_THROW_UP_SPAN = 70; // varied arc heights → staggered landings (no single-frame snap)
/** Chunks are born across a disc of `radius × this`, so the pile is BROAD (a wide dome) rather than a
 *  tall spire — the legacy Mountain is a broad hill. Wider disc → wider base, lower peak (same volume). */
const DIRT_DISC_SPREAD = 2.0;
/** Share of a crater's DEPOSITING ejecta thrown on the wide radial arc instead of nearly straight
 *  up — the clods that sail out and land well away from the blast. They deposit where they fall, so
 *  this is earth genuinely carried off the crater: enough to watch, not enough to empty the hole. */
const EJECTA_FLUNG_FRACTION = 0.15;
/** Max deposit height: dirt cannot pile above this screen-Y (a fraction of world height from the
 *  top). A chunk landing on a capped column is discarded, so tall stacks (Land Fill) FLAT-TOP into a
 *  mesa instead of spiking — matching the original's deposit-height settle gate. */
const DIRT_CAP_FRACTION = 0.16;
/** A settled radiation speck is hidden once the surface has been RAISED (by a dirt fill) more than
 *  this far above where it landed — it reads as buried under the fresh dirt, not glowing on top.
 *  Comfortably above per-frame slump jitter so post-crater repose doesn't flicker the crater-face
 *  coat; well below the tens of px a Dirt weapon piles, so a real fill always buries it. */
/** How hot one landed grain makes its pixel, drawn up to full. Piling means each pixel is marked by
 *  exactly ONE grain, so a weak stamp leaves the entire coat dim rather than shading it — the
 *  variation that used to come from grains overlapping has to come from the draw instead. */
const RAD_STAMP_MIN = 70;
/** How far below a column's surface counts as "standing on radioactive ground" for damage. The
 *  coat is packed against the surface, so this only has to cover the contact layer. */
const RAD_CONTACT_DEPTH = 10;
/** Upward launch (px/s) of ground-burst fallout. Against RAD_GRAV this buys ~2.5-4s of airtime, so
 *  the grains come down AFTER a crater's ejecta has finished refilling the hole (which it does by
 *  ~2.2s). The windows must not overlap: a grain landing while the floor is still rising gets built
 *  over, and its pile ends up measured from a surface that no longer exists — which shows up as a
 *  second, deeper cluster in the coat. Sized off the ejecta's own settle time, not by eye. */
/** Deepest a column's fallout pile may grow. A cap, not a shape — the shape comes from how many
 *  grains actually landed. */
const RAD_PILE_MAX = 40;
const RAD_UP_MIN = 200;
const RAD_UP_MAX = 340;
/** How far below its column's surface radioactive earth still lights up. Past this it is buried:
 *  the ground above it is opaque, so lighting it would show the glow through solid terrain — which
 *  is how an OLD coat, covered by a later blast's fill, used to draw a second arc hanging over the
 *  hole. Set just past the pile's own reach so a fresh coat is shown whole and only genuinely
 *  buried radiation is hidden. */
const RAD_GLOW_DEPTH = 28;
/** Brightness of one fully-hot pixel of ground, and how much of it bleeds onto each orthogonal
 *  neighbour. Together they stand in for the 5-pixel additive cross the loose specks used to draw:
 *  the coat's glow came from those crosses overlapping, so a flat one-pixel-per-grain field reads
 *  far duller than the carpet it replaced. The gain is BELOW 1 now only because piling made every
 *  marked pixel near-full strength — at the old weak stamp it had to be 1.35 just to be seen, and
 *  leaving it there washed the coat out to pale instead of a saturated hue. */
/** The material byte packs TWO properties of a pixel of earth. Bit 0 is the dirt tag (deposited
 *  fill vs native land, what the scorch reads so it burns both alike); bits 1-7 are how radioactive
 *  that earth is, 0-127. Radioactivity wanted a per-pixel home and this byte had seven bits spare —
 *  a second full-world buffer would have cost another W×H for nothing, and those are already the
 *  largest steady-state allocation here. Packing them also makes the coupling FREE: every terrain
 *  edit already rewrites this byte, so earth arriving is clean and earth leaving takes its
 *  radioactivity with it without a single line spent saying so. */
const MAT_RAD_MAX = 127;
const matRad = (b: number): number => b >>> 1;
const matSetRad = (b: number, rad: number): number => (b & 1) | (Math.min(MAT_RAD_MAX, rad) << 1);

const RAD_GLOW_GAIN = 0.8;
const RAD_GLOW_SPREAD = 0.55;

/** Blotch scale (px) that warps the soil coat's mixing zone. This octave does NOT cut the boundary
 *  (the per-pixel dither does that) — it only makes the mix well deeper in some places than others,
 *  so the transition wanders instead of fading out at one even rate. */
const DIRT_COAT_CELL = 9;
/** Fraction of the soil band that is turned over SOLIDLY before the fringe starts to break up.
 *  Without it the crater's own face gets holes in it, which reads as a chewed rim, not a soft one. */
const DIRT_COAT_SKIN = 0.5;

/**
 * How much earth a blast of radius `r` turns over under the detonation — the thickness at ground
 * zero of the layer it disturbs. The layer thins from here toward the rim (`coatDepth`).
 *
 * ONE figure for the whole blast, shared by everything that lines the new crater face. The soil
 * coat and the fallout that settles into it are two views of the same disturbed ground, so they
 * have to agree on how deep it goes: when the fallout ran on its own, larger figure it reached
 * about twice as far down as the earth it was supposedly lying in, and the glow read as a
 * separate, deeper shape hanging below the crater rather than a coating of it.
 */
function coatFullDepth(r: number): number {
  return clamp(Math.round(r * 0.22), 12, 40);
}

/**
 * The shared profile for anything a blast COATS onto the crater face — how thick the layer is at
 * horizontal offset `dx` from a blast of radius `r`, given its thickness `full` at ground zero.
 *
 * `full` under the detonation easing to a few px at the rim, so a coat piles up where the blast
 * was and runs out as it climbs the bowl. Both the soil the carve lays down and the fallout that
 * settles on it run through here: they cover the same hole, so a coat with its own private
 * thickness curve reads as a second, unrelated shape drawn over the first.
 */
function coatDepth(dx: number, r: number, full: number): number {
  const t = r > 0 ? Math.min(1, Math.abs(dx) / r) : 1;
  return 4 + (full - 4) * (1 - t * t);
}

export class CLand {
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

    this.m_particles = [];
    this.m_radParticles = [];
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

  // --- RNG: a linear congruential generator, so a level is reproducible from its seed ---
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
    this.m_falls.length = 0;
    this.m_particles.length = 0;
    this.m_radSpecks.length = 0;
    this.m_radParticles.length = 0;
    this.m_heat.length = 0;
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
    this.m_falls.length = 0;
    this.m_particles.length = 0;
    this.m_particlePool.length = 0;
    this.m_radSpecks.length = 0;
    this.m_speckPool.length = 0;
    this.m_radParticles.length = 0;
    this.m_heat.length = 0;
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
    this.m_falls.length = 0; // drop any falling overburden blocks
    this.m_particles.length = 0; // + any dirt debris still in flight
    this.m_radSpecks.length = 0;
    this.m_radParticles.length = 0;
    this.m_heat.length = 0;
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
        // pixels, so a cliff sliding down does not leave its fallout hanging in the air where the
        // cliff used to be — the block is the same earth, just lower.
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
  private blitFall(
    px: Uint32Array,
    mat: Uint8Array | null,
    f: Fall,
    top: number,
    draw: boolean,
  ): void {
    const W = this.m_nWidth;
    for (let k = 0; k < f.thick; k++) {
      const idx = (top + k) * W + f.col;
      px[idx] = draw ? f.colors[k] : 0;
      if (mat) {
        mat[idx] = draw ? f.mats[k] : 0;
        if (draw && matRad(f.mats[k])) this.growRadBox(f.col, top + k); // it moved, so did its glow
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
      const jTop =
        3.4 * Math.sin(c * 0.17 + pT1) + 2.0 * Math.sin(c * 0.44 + pT2) + (rnd() - 0.5) * 1.8;
      const jBot =
        3.4 * Math.sin(c * 0.2 + pB1) + 2.0 * Math.sin(c * 0.51 + pB2) + (rnd() - 0.5) * 1.8;
      const surfBefore = this.getHeightAt(c); // spawn ejecta at the ground, BEFORE the slice lowers it
      const removed = this.sliceColumn(c, beamY, Math.max(1, fireHalf + jTop), Math.max(1, fireHalf + jBot)); // prettier-ignore
      // The original EJECTS the removed earth as falling debris — the ray visibly emits dirt, not a
      // silent slice. We spray a couple of cosmetic grains per cut column UP from the surface so they
      // arc and rain back visibly (the source's grains are zero-velocity because its cut leaves open
      // space below; ours fills the trench, so a small pop is the visible equivalent). NON-depositing:
      // they vanish on landing — the sliding overburden block already fills the trench.
      if (removed > 0) {
        this.addShowerParticles(c, surfBefore, 2, 14, false);
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
  carveDiscCollapse(
    x: number,
    y: number,
    r: number,
    slump = true,
    ragged = false,
    coatDirt = false,
  ): void {
    if (!this.m_arrHeights) return;
    const [lo, hi] = this.clampCols(Math.floor(x - r), Math.ceil(x + r));
    this.settleFallsIn(lo, hi); // settle any active overburden first → no concurrent falls
    const px = this.m_pixels;
    const W = this.m_nWidth;
    const heights = this.m_arrHeights;
    // Thickness of the soil coat AT THE CENTRE of the bowl; it thins toward the rim on the shared
    // `coatDepth` curve, the same one the fallout settles on. A flat band all the way round made
    // the two layers disagree about the shape of the hole they both line.
    const dirtFull = coatFullDepth(r);
    // `ragged`: a gentle wobble on the disc radius so an EXPLOSION crater reads as a rough hole (what
    // the old blastCircle gave). Two out-of-phase sines (random per-crater phases) → an irregular but
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
        const band = coatDepth(dx, r, dirtFull); // thins toward the rim (shared with the fallout)
        const bandBot = Math.min(this.m_nHeight, top + Math.ceil(band));
        for (let yy = top; yy < bandBot; yy++) {
          const i = yy * W + c;
          if ((px[i] & 0xff000000) === 0) continue;
          const v = (yy - top) / band; // 0 at the face → 1 at the band floor
          // The face itself is turned over SOLIDLY — the blast scoured it. Only below DIRT_COAT_SKIN
          // does coverage fall away, so the coat dissolves into the native strata with depth instead
          // of stopping on a ruled line. The radial thinning lives entirely in `band` above: taking
          // it out of coverage as well would eat holes in the crater's own edge, which reads as the
          // rim breaking into blobs rather than as a soft boundary.
          let cover = 1;
          if (v > DIRT_COAT_SKIN) {
            const u = (1 - v) / (1 - DIRT_COAT_SKIN);
            cover = smoothstep(u); // eased to zero at the band floor
            // Decide each pixel INDEPENDENTLY, on a per-pixel dither. Thresholding a smooth noise
            // field instead makes the two materials meet along a contour — the soil ends on a wavy
            // line and the fringe combs into vertical spikes — whereas dithering interleaves them
            // grain by grain, so the turned earth and the ground it came from genuinely mix.
            // The coherent octave only WARPS the threshold, so the mixing zone wanders and wells
            // deeper in places; dither alone dissolves in a perfectly even haze that reads as
            // machine-made. World-keyed, so overlapping craters agree where they meet.
            const w = cover * (0.5 + blotchNoise(c, yy, DIRT_COAT_CELL));
            if (hashLattice(c, yy) > w) continue;
          }
          px[i] = this.dirtColorAt(c, yy);
          // Tag it churned soil while KEEPING its radioactivity: this is earth the carve left in
          // place, only re-textured, so wiping the bits here would decontaminate ground the blast
          // never removed — the same mistake the old disc-wide clear made.
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
   * Radiation the blast physically reached — within the DISC of radius `r` at `(x, y)` — is gone.
   * Keyed on 2-D distance, NOT the column span: a circular crater must NOT wipe fallout that sits in
   * the same x-range but OUTSIDE the sphere (deep in the soil below the blast, or beyond the arc near
   * the span edges) — that soil was never touched. Drops, together, whatever falls inside the disc:
   * the damage ZONES (they stop hurting tanks AND stop venting heat smoke — the smoke is spawned
   * per-frame off a live zone, so leaving one alive keeps it fuming forever), the rising heat wisps,
   * and the ground specks/glow. Beam/bore cuts keep their own surgical speck-only clearing.
   */
  private clearRadiationDisc(x: number, y: number, r: number): void {
    const r2 = r * r;
    const outside = (px: number, py: number): boolean => {
      const dx = px - x,
        dy = py - y;
      return dx * dx + dy * dy > r2;
    };
    if (this.m_radParticles.length)
      this.m_radParticles = this.m_radParticles.filter(z => outside(z.x, z.y));
    if (this.m_heat.length) this.m_heat = this.m_heat.filter(h => outside(h.x, h.y));
    if (this.m_radSpecks.length) this.m_radSpecks = this.m_radSpecks.filter(s => outside(s.x, s.y));
    // NOT the radiation channel. The carve already cleared every pixel it actually removed, via
    // `setColumnTop`; wiping the disc on top of that scrubs radioactivity off earth that SURVIVED
    // the blast — which is the old guess-what-happened behaviour this channel replaced, and reads
    // as a new explosion mysteriously decontaminating the ground around it.
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
      if (this.m_radSpecks.length)
        this.m_radSpecks = this.m_radSpecks.filter(s => s.x < lo || s.x > hi);
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
    const discR = R * DIRT_DISC_SPREAD; // chunks are BORN across this disc → the pile's WIDTH
    // Count = earth × radius → the PEAK scales with earth (Mountain biggest), width tracks radius.
    // Each landed chunk raises a column +1px; repose + the rounding pass then settle the pile.
    const chunks = Math.min(16000, Math.round(amount * R * DIRT_DEPOSIT_VOLUME));
    const pool = this.m_particlePool;
    for (let i = 0; i < chunks; i++) {
      // Deposited dirt writes the heightmap → seeded LCG (deterministic in a net match).
      const ang = this.rand01() * TWO_PI;
      const dist = Math.sqrt(this.rand01()) * discR; // uniform over the DISC AREA (no central 1/r spike)
      let v = 24 + Math.floor(Math.random() * 116); // dirt brown, occasional dark clod (cosmetic)
      if (Math.random() < 0.25) v = Math.floor(v * 0.55);
      const p: LandParticle = pool.pop() ?? {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        color: '',
        size: 0,
        spin: 0,
        age: 0,
        deposit: true,
      };
      p.x = x + Math.cos(ang) * dist;
      p.y = y + Math.sin(ang) * dist * 0.4; // disc flattened vertically (chunks born near the surface)
      p.vx = (this.rand01() * 2 - 1) * DIRT_THROW_SCATTER; // small random horizontal (NOT outward)
      p.vy = -(DIRT_THROW_UP_MIN + this.rand01() * DIRT_THROW_UP_SPAN); // up → rains back near birth
      p.color = this.dirtColor(v);
      p.size = 1;
      p.spin = 0;
      p.age = 0;
      p.deposit = true;
      this.m_particles.push(p);
    }
    // Arm the rounding pass over this deposit's span (accumulates across near-simultaneous spawns).
    if (this.m_dirtSmoothPasses <= 0 && this.m_dirtSmoothDelay <= 0) {
      this.m_dirtSmoothX0 = this.m_nWidth;
      this.m_dirtSmoothX1 = 0;
    }
    this.m_dirtSmoothDelay = DIRT_SMOOTH_DELAY;
    this.m_dirtSmoothPasses = DIRT_SMOOTH_PASSES;
    this.m_dirtSmoothX0 = Math.min(this.m_dirtSmoothX0, Math.round(x - discR - 10));
    this.m_dirtSmoothX1 = Math.max(this.m_dirtSmoothX1, Math.round(x + discR + 10));
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
    // Nukes/DOT ship no explicit irRGB → glow a hot radioactive red-orange.
    const [r, g, b] = rgb && (rgb[0] || rgb[1] || rgb[2]) ? rgb : [255, 46, 20];

    // The fallout lingers longer than the raw irTime and dims GRADUALLY.
    // Stretch the visible life ~1.6× so the radioactive ground glows for a
    // good while and decays slowly.
    const dur = fDurationSeconds * 1.6;

    // Gameplay damage zone (queried against tanks each frame) — invisible; the visible glow
    // is the specks. Damage-over-time for irTime, matching the original's fallout DOT.
    this.m_radParticles.push({
      x,
      y,
      radius: nRadius,
      damagePerSecond: fDamagePerSecond,
      timeRemaining: dur,
      duration: dur,
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
    // This count IS the coat's thickness now. A grain settles onto the pile already in its column,
    // one pixel at a time, so however many land on a spot is how deep the fallout goes there —
    // there is no separate depth to tune, and raising or lowering this moves the whole profile
    // together instead of leaving a count and a curve to disagree.
    const n = clamp(Math.round(nRadius * 82), 900, 20000);
    const pool = this.m_speckPool;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TWO_PI;
      // Radial placement: UNIFORM OVER THE DISC's area, `sqrt(u)·radius`, so the grains cover the
      // blast footprint at one even density — the same way the carve coats every column of the
      // bowl face it cuts. The original's flat `rand·radius` looks like it spreads evenly but does
      // not: a ring at distance d holds grains ∝ d·dd of area yet receives a constant share of the
      // draw, so density runs as 1/d and heaps into a bell at ground zero. That hump is what read
      // as a mound of fallout sitting inside the crater instead of a lining of it.
      //
      // Note this is NOT the radial falloff tried earlier and reverted: it does not thin the edge.
      // Grains still reach the full radius, so the glow ends where the crater does. The only taper
      // the fallout carries is into the soil (see `radBandDepth`), matching the coat.
      const dist = Math.sqrt(Math.random()) * nRadius;
      // Velocity stays as the original had it: only a SMALL radial nudge (`rand·8+2` in the
      // source's units). The visible fall comes from the SPREAD — grains that land high in the
      // upper half of the disc drop back down under gravity — NOT from a big launch.
      const speed = between(20, 85); // small radial launch (the spread does the spreading)
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
        raining: false,
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
      // here depends on. Launched flat, the fallout was fully settled at ~1.5s while dirt kept
      // landing until ~2.25s, so the refill buried the coat it had just laid and the crater came out
      // with a sterile layer through it. Making the thrown earth radioactive to compensate only
      // moved the problem: every fresh layer re-lit, so the glow climbed with the rising floor
      // instead of settling. Landing LAST needs no compensation — the fallout simply coats whatever
      // the ground finally is. An AIRBURST is unchanged: it rains from a mid-air burst point and was
      // never thrown up in the first place.
      s.vy = raining
        ? Math.abs(Math.sin(ang)) * speed + between(25, 80)
        : Math.sin(ang) * speed - between(RAD_UP_MIN, RAD_UP_MAX);
      s.age = 0;
      s.life = dur * between(0.85, 1.05); // lingers ~the stretched irTime
      s.settled = false;
      s.size = between(0.85, 2.25); // small grains (1.8–3.2px dots) — the old size read as big boxes
      s.phase = Math.random() * TWO_PI; // independent glow phase (no coherent wave/banding)
      s.pw = between(3, 7.5); // independent glow rate (each speck breathes at its own speed)
      s.rise = 0;
      // Remember which blast threw this grain, so the coat depth it digs on landing can be measured
      // against THAT zone. Carried per grain rather than read off the land at settle time: a grain
      // still in the air when the next blast goes off would otherwise take the new zone's depth.
      s.zx = x;
      s.zr = nRadius;
      s.raining = raining;
      const f = between(0.3, 1); // 0.3..1.0 — dark grains stay on-hue, never black
      s.r = (r * f) | 0;
      s.g = (g * f) | 0;
      s.b = (b * f) | 0;
      this.m_radSpecks.push(s);
    }
    // Global ceiling. Deliberately NOT raised alongside the per-blast count above: this bounds the
    // per-frame draw (two fillRects per grain), which measures ~0.8µs a grain, so the ceiling —
    // not the per-blast count — is what sets the worst-case frame cost. A single zone gets its
    // denser coat; a screen already saturated with fallout stays as cheap as it was.
    if (this.m_radSpecks.length > 17000)
      this.m_radSpecks.splice(0, this.m_radSpecks.length - 17000);
  }

  /**
   * Mark one pixel of earth radioactive — where a fallout grain came to rest. Additive and
   * saturating, so overlapping blasts and the grains of a single one BUILD UP a hotter patch
   * rather than each overwriting the last.
   */
  private stampRadiation(
    col: number,
    y: number,
    amount = between(RAD_STAMP_MIN, MAT_RAD_MAX),
  ): void {
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
    // would leave that glow hanging exactly where the old speck model used to strand fallout.
    const top = this.m_arrHeights ? this.m_arrHeights[col] : 0;
    const yy = Math.max(top, Math.floor(y));
    if (yy < 0 || yy >= this.m_nHeight) return;
    const i = yy * this.m_nWidth + col;
    mat[i] = matSetRad(mat[i], matRad(mat[i]) + amount);
    this.growRadBox(col, yy);
    this.m_radGlowDirty = true;
  }

  /**
   * Draw the radioactive GROUND — the settled coat — from the terrain's radiation channel.
   *
   * The channel says which earth is hot; the live zones (`m_radParticles`) say what colour and how
   * brightly, each on its own clock. Keeping those apart is what lets two blasts of different ages
   * overlap and still fade independently, and it means the glow is rebuilt only when the EARTH
   * changes — a fade is just the alpha on the blit, so it stays perfectly smooth between rebuilds
   * rather than stepping the way a periodically re-baked layer does.
   */
  private drawRadGlow(ctx: CanvasRenderingContext2D): void {
    const mat = this.m_material;
    if (!mat || !this.m_radParticles.length || typeof document === 'undefined') return;
    const W = this.m_nWidth;
    if (this.m_radGlowDirty || !this.m_radGlowCanvas) {
      this.m_radGlowDirty = false;
      // Bounds of the HOT EARTH itself (+1 for the neighbour spread below), never the zones'.
      if (this.m_radBoxX1 < this.m_radBoxX0) return; // nothing has been irradiated yet
      let x0 = this.m_radBoxX0 - 1,
        x1 = this.m_radBoxX1 + 1,
        y0 = this.m_radBoxY0 - 1,
        y1 = this.m_radBoxY1 + 1;
      x0 = clamp(x0, 0, W - 1);
      x1 = clamp(x1, 0, W - 1);
      y0 = clamp(y0, 0, this.m_nHeight - 1);
      y1 = clamp(y1, 0, this.m_nHeight - 1);
      const w = x1 - x0 + 1,
        h = y1 - y0 + 1;
      if (w <= 0 || h <= 0) return;
      let cv = this.m_radGlowCanvas;
      if (!cv) cv = this.m_radGlowCanvas = document.createElement('canvas');
      if (cv.width !== w || cv.height !== h) {
        cv.width = w;
        cv.height = h;
      }
      const g = cv.getContext('2d');
      if (!g) return;
      const heights = this.m_arrHeights;
      const img = g.createImageData(w, h);
      const out = img.data;
      // Each hot pixel takes the colour of the nearest zone covering it, scaled by how hot it is,
      // and SPREADS onto its four orthogonal neighbours at a lower weight. The spread is what the
      // brightness used to come from: the old carpet drew every grain as a 5-pixel additive cross,
      // so overlapping grains stacked into a saturated glow. One pixel per grain lit a fraction of
      // that and the coat came out dull. Contributions accumulate and clip, matching how the
      // crosses piled up. The zone's own fade is NOT applied here — that rides on the blit alpha
      // below, so decay stays continuous even though this buffer only rebuilds when earth changes.
      const add = (x: number, y: number, zr: number, zg: number, zb: number, k: number): void => {
        if (x < x0 || x > x1 || y < y0 || y > y1) return;
        const o = ((y - y0) * w + (x - x0)) * 4;
        out[o] = Math.min(255, out[o] + zr * k);
        out[o + 1] = Math.min(255, out[o + 1] + zg * k);
        out[o + 2] = Math.min(255, out[o + 2] + zb * k);
        out[o + 3] = 255;
      };
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const v = matRad(mat[y * W + x]);
          if (!v) continue;
          // Only the coat AT THE SURFACE is drawn. Radioactivity deeper than this is buried under
          // earth, and the glow composites OVER the terrain — so drawing it lit the old coat
          // straight through the fill piled on top of it, as a second arc following the bowl the
          // crater used to have. Detached from the ground and floating over the hole where the fill
          // was thin. It stays in the channel (dig back down and it is still hot, still damaging),
          // it simply is not lit through solid ground.
          if (y - (heights ? heights[x] : 0) > RAD_GLOW_DEPTH) continue;
          let zr = 0,
            zg = 0,
            zb = 0,
            best = Infinity;
          for (const z of this.m_radParticles) {
            const dx = x - z.x,
              dy = y - z.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < best) {
              best = d2;
              zr = z.r;
              zg = z.g;
              zb = z.b;
            }
          }
          const k = (v / MAT_RAD_MAX) * RAD_GLOW_GAIN;
          add(x, y, zr, zg, zb, k);
          add(x - 1, y, zr, zg, zb, k * RAD_GLOW_SPREAD);
          add(x + 1, y, zr, zg, zb, k * RAD_GLOW_SPREAD);
          add(x, y - 1, zr, zg, zb, k * RAD_GLOW_SPREAD);
          add(x, y + 1, zr, zg, zb, k * RAD_GLOW_SPREAD);
        }
      }
      g.putImageData(img, 0, 0);
      this.m_radGlowX = x0;
      this.m_radGlowY = y0;
    }
    const cv = this.m_radGlowCanvas;
    if (!cv) return;
    // The longest-lived zone drives the blit, with a shimmer so the ground keeps breathing the way
    // the loose specks used to. Additive, so the coat stacks over the terrain as the cloud did.
    let fade = 0;
    for (const z of this.m_radParticles)
      fade = Math.max(fade, z.timeRemaining / Math.max(0.5, z.duration));
    if (fade <= 0) return;
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp01(fade) * (0.86 + 0.14 * Math.sin(this.m_radPulseT * 2.1));
    ctx.drawImage(cv, this.m_radGlowX, this.m_radGlowY);
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
    const limit = Math.min(this.m_nHeight - 1, top + RAD_PILE_MAX);
    while (y < limit && matRad(mat[y * W + col])) y++;
    return y;
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
        if (matRad(mat[i])) {
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
    // The old `v>>3` blue muddied it toward a darker "burned" tone.
    return this.m_dirtColors[v] ?? (this.m_dirtColors[v] = `rgb(${v},${v >> 1},0)`);
  }

  /** Throw dirt chunks. `deposit`: raise the column where each lands (true, blast ejecta) vs. just
   *  vanish (false, cosmetic). `gentle`: near-zero launch velocity so grains DROP rather than
   *  fountain — used for a beam cut, whose original ejects the removed band at ZERO velocity. */
  addShowerParticles(
    x: number,
    y: number,
    count: number,
    radius = 24,
    deposit = true,
    gentle = false,
  ): void {
    const pool = this.m_particlePool;
    // Depositing ejecta WRITES the heightmap, so its motion must be deterministic in a
    // network match → draw from the seeded LCG. Non-deposit spray is cosmetic → Math.random.
    const r = deposit ? () => this.rand01() : Math.random;
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
      // pool is warm, so a nuke allocates zero LandParticle objects (no GC spike).
      const p: LandParticle = pool.pop() ?? {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        color: '',
        size: 0,
        spin: 0,
        age: 0,
        deposit: true,
      };
      // Born across the blast DISC (uniform over its area, no central spike), not a box.
      const bd = Math.sqrt(r()) * radius;
      p.x = x + Math.cos(ang) * bd;
      p.y = y + Math.sin(ang) * bd * 0.4;
      // The throw splits in two. MOST of the earth goes nearly straight up and rains back into the
      // hole it came out of — the launch `depositDirt` uses, and what the original does far more
      // literally (its debris leaves the rim at [2,10] px/s, barely more than a spill). Throwing all
      // of it outward at `radius·2.4` sprayed the earth clear of the crater, so a nuke left a bare
      // pit: only ~0.09 R of the depth it dug ever came back.
      //
      // A minority is still FLUNG on the wide radial arc, because that is the part you watch: clods
      // sailing out and thudding down across the map, well away from the blast. They deposit where
      // they land, so this is real earth carried off, not decoration — which is why it is a minority
      // and not the default. Cosmetic spray (`deposit` false — beam/digger dust) is always flung:
      // nothing lands, so where it flies is purely a matter of looks.
      //
      // NOTE every draw here is `r()`, not the module random helpers: depositing ejecta writes the
      // heightmap, so each client must generate the same throw or the match desyncs.
      const flung = !deposit || r() < EJECTA_FLUNG_FRACTION;
      p.vx = flung ? Math.cos(ang) * speed : (r() * 2 - 1) * DIRT_THROW_SCATTER;
      p.vy = gentle
        ? r() * 12
        : flung
          ? Math.sin(ang) * speed * 0.7 - up
          : -(DIRT_THROW_UP_MIN + r() * DIRT_THROW_UP_SPAN) - up * 0.35;
      p.color = this.dirtColor(v);
      p.size = 1; // the original plots each chunk as a single 1px pixel — no 2px squares
      p.spin = 0;
      p.age = 0;
      p.deposit = deposit;
      this.m_particles.push(p);
    }
    // Arm the rounding pass over the landing zone, exactly as `depositDirt` does. Ejecta lands one
    // 1px column at a time, so a big throw leaves the fill as a comb of spikes; the crater's own
    // slump is armed at CARVE time and has largely run out by the time the last chunks come down.
    // Without this the refilled bowl reads as bristles rather than as settled earth.
    if (deposit && count > 0) {
      if (this.m_dirtSmoothPasses <= 0 && this.m_dirtSmoothDelay <= 0) {
        this.m_dirtSmoothX0 = this.m_nWidth;
        this.m_dirtSmoothX1 = 0;
      }
      this.m_dirtSmoothDelay = DIRT_SMOOTH_DELAY;
      this.m_dirtSmoothPasses = DIRT_SMOOTH_PASSES;
      this.m_dirtSmoothX0 = Math.min(this.m_dirtSmoothX0, Math.round(x - radius - 10));
      this.m_dirtSmoothX1 = Math.max(this.m_dirtSmoothX1, Math.round(x + radius + 10));
    }
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
    // nominal radius runs a little past the old 1.8 because scorchPixels now feathers its edge
    // inward (a ragged, fading rim rather than a hard disc), which eats into the visible reach.
    this.scorchPixels(x, y, Math.max(22, radius * 2.0));
  }

  update(dt: number, wind?: Vec2): void {
    const GRAVITY = 500;
    // Realistic wind pushes flying dirt AND airborne fallout sideways (Linear mode leaves both purely
    // ballistic — the classic feel). Terrain is broadcast authoritatively (getNetSnapshot), so
    // wind-nudged deposits stay in sync across clients without re-simulation. Precomputed once per frame.
    const realistic = !!wind && isRealisticWind();
    const windX = realistic ? wind!.x * DEBRIS_WIND_ACCEL : 0;
    const windY = realistic ? wind!.y * DEBRIS_WIND_ACCEL : 0;
    const foutX = realistic ? wind!.x * FALLOUT_WIND_ACCEL : 0;
    const foutY = realistic ? wind!.y * FALLOUT_WIND_ACCEL : 0;

    this.m_radPulseT += dt; // drives the sinusoidal glow shimmer on the radiation specks
    this.stepFalls(dt); // advance any beam/digger overburden falling under gravity

    // Compact-forward removal (a write index), NOT splice(i,1): a nuke flings
    // ~6500 chunks, and hundreds settle per frame — each splice shifts the whole
    // tail (O(n)), so settling was O(n²) per frame. That is the hitch on impact and
    // the sluggish earth settle. Copying survivors forward and truncating once is O(n).
    // Columns with an overburden block still FALLING: a depositing chunk must NOT settle/stamp on the
    // block's transient (high) top — when the block lands lower the stamped dirt would be left floating
    // above the surface. Keep such chunks airborne until the column stabilises.
    const falling = this.m_falls.length ? new Set(this.m_falls.map(f => f.col)) : null;
    let dw = 0;
    for (let i = 0; i < this.m_particles.length; i++) {
      const p = this.m_particles[i];

      // Wind (Realistic mode only): the shared profile eases the push near the ground so settling
      // chunks barely drift while high-arcing ejecta leans on the wind. windX/Y are 0 in Linear mode.
      if (windX !== 0 || windY !== 0) {
        const wf = windProfile(
          this.getHeightAt(clamp(Math.floor(p.x), 0, this.m_nWidth - 1)) - p.y,
        );
        p.vx += windX * wf * dt;
        p.vy += windY * wf * dt;
      }
      p.vy += GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.age += dt;

      const col = Math.floor(p.x);
      if (col < 0 || col >= this.m_nWidth) {
        this.m_particlePool.push(p);
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
        this.m_particles[dw++] = p;
        continue;
      }
      if (p.vy > 0 && p.y >= this.getHeightAt(col) && this.m_arrHeights) {
        if (!p.deposit) {
          this.m_particlePool.push(p);
          continue; // cosmetic ejecta (beam) — reached ground, just vanish (no column raise)
        }
        // Which column the chunk raises → writes the heightmap → seeded LCG.
        let dcol = clamp(col + ((this.rand01() * 4) | 0) - 2, 0, this.m_nWidth - 1); // −2..+1 (orig)
        if (falling && falling.has(dcol)) dcol = col; // never deposit onto a falling column
        // Height cap: dirt can't pile above `capY`. A chunk on a capped column is discarded, so tall
        // stacks (Land Fill) FLAT-TOP into a mesa instead of spiking (orig settle gate `0x60 <= y`).
        if (this.m_arrHeights[dcol] > this.m_nHeight * DIRT_CAP_FRACTION) {
          // Raise the column 1px. The stamp is `setColumnTop`'s own dirt sampler — the SAME source
          // the crater's soil coat draws from — so thrown earth and the earth lining the bowl are
          // one material. Overwriting it with a flat (v, v/2, 0) ramp instead made a blast leave two
          // visibly different soils in the same hole: a textured coat around the rim and a bright
          // orange granular fill in the bottom. The original's debris carries the colour of the
          // pixel it was excavated from, which is exactly why its deposits are indistinguishable
          // from the ground around them.
          this.setColumnTop(dcol, this.m_arrHeights[dcol] - 1);
          if (this.m_baseHeights)
            this.m_baseHeights[dcol] = Math.min(this.m_baseHeights[dcol], this.m_arrHeights[dcol]);
          this.preBlast(dcol - 1, dcol + 1);
          // Let the slump smooth this area over the next few seconds.
          this.m_slumpTimer = 3;
          this.m_slumpX0 = Math.min(this.m_slumpX0, dcol - 3);
          this.m_slumpX1 = Math.max(this.m_slumpX1, dcol + 3);
        }
        this.m_particlePool.push(p);
        continue; // settled (or capped) → recycle
      }

      this.m_particles[dw++] = p; // still airborne → keep
    }
    this.m_particles.length = dw;

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
    const RAD_GRAV = 320;
    // A settled speck is culled once a crater drops the ground more than this far below it (it would
    // otherwise hang in the air). Wider than the +3px top of the settle scatter so the coat's surface
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
        s.vy += RAD_GRAV * dt;
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
          // more or fewer grains came down — the same distribution that put them there. Depth used
          // to be dictated by a radial curve with the position inside it drawn from another curve,
          // which had to be re-tuned every time the spray changed; a pile needs no tuning and cannot
          // disagree with the spray, because it IS the spray. It also self-maintains: carve the coat
          // away and the pile is gone with it, so the next grain starts from the surface again.
          this.stampRadiation(c2, this.radPileTop(c2));
          this.m_speckPool.push(s);
          continue;
        }
      }
      this.m_radSpecks[sw++] = s; // still falling → keep
    }
    this.m_radSpecks.length = sw;

    // Heat haze: faint warm plumes ("fumes") rise off the live radioactive ground — spawned
    // across the active zone (fewer as it cools), lifting, widening and fading so the ground
    // reads as HOT. Gated on the radiation ZONE (not the removed deposit), so it stops when the
    // zone expires or a bomb clears it.
    if (this.m_radParticles.length && this.m_heat.length < 90) {
      for (const z of this.m_radParticles) {
        const cool = z.timeRemaining / Math.max(0.5, z.duration); // 1 hot → 0 cold
        const rr = z.radius;
        const spawn = Math.random() < cool * 0.7 ? 1 : 0; // sparse — a wisp here and there
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
          this.m_heat.push({
            x: col + plusMinus(1),
            y: this.getHeightAt(col) - Math.random() * 4,
            age: 0,
            life: between(0.7, 1.5),
            size: between(5, 12),
            vx: (Math.random() - 0.5) * 12,
            rot: Math.random() * TWO_PI,
            spin: (Math.random() - 0.5) * 1.6,
            r: tr,
            g: tg,
            b: tb,
          });
        }
      }
    }
    let hw = 0;
    for (let i = 0; i < this.m_heat.length; i++) {
      const h = this.m_heat[i];
      h.age += dt;
      if (h.age >= h.life) continue; // faded → drop
      h.y -= (26 + h.size) * dt; // rise, bigger plumes lift faster
      h.x += h.vx * dt;
      h.rot += h.spin * dt; // slow tumble
      this.m_heat[hw++] = h;
    }
    this.m_heat.length = hw;
  }

  /** Lazily build the soft warm radial glow blitted per heat wisp (additive). */
  private heatSprite(): HTMLCanvasElement {
    if (this.m_heatSprite) return this.m_heatSprite;
    const S = 32,
      c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(255,150,70,0.9)');
    grad.addColorStop(0.4, 'rgba(255,90,40,0.4)');
    grad.addColorStop(1, 'rgba(255,60,30,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    this.m_heatSprite = c;
    return this.m_heatSprite;
  }

  /** Give CLand the game's smoke sprite so heat plumes use the real pixel-art
   *  smoke (tinted warm/red) instead of a procedural blob — matching the art. */
  setSmokeSprite(img: CanvasImageSource, w: number, h: number): void {
    this.m_smokeSrc = img;
    this.m_smokeW = w;
    this.m_smokeH = h;
    this.m_smokeTints.clear();
  }

  /** Lazily build (and cache per colour) a copy of the smoke sprite tinted to the
   *  weapon's radiation hue — keeping the smoke's texture + alpha. So hydrogen puffs
   *  blue, plutonium green, uranium red. Null until the sprite is provided. */
  private smokeTint(r: number, g: number, b: number): HTMLCanvasElement | null {
    if (!this.m_smokeSrc || !this.m_smokeW || !this.m_smokeH) return null;
    const key = `${r},${g},${b}`;
    const cached = this.m_smokeTints.get(key);
    if (cached) return cached;
    const w = this.m_smokeW,
      h = this.m_smokeH;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const gx = c.getContext('2d')!;
    gx.drawImage(this.m_smokeSrc, 0, 0, w, h);
    gx.globalCompositeOperation = 'multiply'; // colour the grey smoke, keep its texture
    gx.fillStyle = `rgb(${r},${g},${b})`;
    gx.fillRect(0, 0, w, h);
    gx.globalCompositeOperation = 'destination-in'; // re-mask to the smoke's own alpha
    gx.drawImage(this.m_smokeSrc, 0, 0, w, h);
    gx.globalCompositeOperation = 'source-over';
    this.m_smokeTints.set(key, c);
    return c;
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
      const bot = Math.min(this.m_nHeight - 1, top + RAD_CONTACT_DEPTH);
      for (let y = top; y <= bot; y++) if (matRad(mat[y * W + c])) return true;
    }
    return false;
  }

  // ========================================================================
  // COLLISION & QUERIES
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
    const dy =
      this.m_arrHeights[Math.min(x + 1, this.m_nWidth - 1)] - this.m_arrHeights[Math.max(x - 1, 0)];

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
  setLayers(
    layers: {image: CanvasImageSource; depth: number}[],
    bareImage?: CanvasImageSource,
  ): void {
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
        for (let y = nt; y < old; y++)
          px[y * W + col] = colorFn ? colorFn(col, y) : this.dirtColorAt(col, y);
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
        if (matRad(matB[i])) this.m_radGlowDirty = true;
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
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    if (!g) return;
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
    const scratch = document.createElement('canvas');
    scratch.width = W;
    scratch.height = H;
    const g = scratch.getContext('2d', {willReadFrequently: true})!;
    const patterns = this.m_layers.map(l => g.createPattern(l.image, 'repeat'));
    const EXT = 2;
    const deepest = patterns[this.m_layers.length - 1];
    if (deepest) {
      g.beginPath();
      g.moveTo(-EXT, heights[0]);
      for (let x = 0; x < W; x++) g.lineTo(x, heights[x]);
      g.lineTo(W + EXT, heights[W - 1]);
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
      g.beginPath();
      g.moveTo(-EXT, heights[0]);
      for (let x = 0; x < W; x++) g.lineTo(x, heights[x]);
      g.lineTo(W + EXT, heights[W - 1]);
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
        out[hy * hw + hx] =
          (0xff000000 | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r)) >>>
          0;
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
      this.m_particles.length > 0 ||
      this.m_radSpecks.length > 0 ||
      this.m_radParticles.length > 0 ||
      this.m_heat.length > 0
    );
  }

  /** Terrain still physically resolving (gravity collapse or falling debris) — the
   *  round should not hand off the turn until this settles. Narrower than
   *  `isAnimating()` (which also covers cosmetic redraw/rebuild flags). */
  isSettling(): boolean {
    return this.m_falls.length > 0 || this.m_particles.length > 0;
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
      const prevOp = ctx.globalCompositeOperation;
      const dbg = CLand.debugMaterials; // ?skiptexture: solid RED specks (no additive wash)
      ctx.globalCompositeOperation = dbg ? 'source-over' : 'lighter'; // saturating additive
      if (dbg) ctx.fillStyle = '#ff0000';
      let lastKey = -1;
      // Sinusoidal GLOW shimmer: each speck breathes on its OWN random phase AND rate, so the
      // fallout twinkles independently rather than pulsing in unison (a shared/spatial phase made
      // coherent brightness WAVES sweep the zone, which read as odd patterns). Cheap: one sin/speck.
      const gt = this.m_radPulseT;
      for (const s of this.m_radSpecks) {
        const fade = 1 - s.age / s.life; // linear: contribution = irRGB · (1 − age/life)
        if (fade <= 0) continue;
        if (!dbg) {
          const key = (s.r << 16) | (s.g << 8) | s.b;
          if (key !== lastKey) {
            ctx.fillStyle = `rgb(${s.r},${s.g},${s.b})`;
            lastKey = key;
          }
          const pulse = 0.72 + 0.28 * Math.sin(gt * s.pw + s.phase); // per-speck rate+phase → twinkle
          ctx.globalAlpha = fade * pulse;
        }
        const x = Math.round(s.x),
          y = Math.round(s.y);
        ctx.fillRect(x, y - 1, 1, 3); // vertical arm
        ctx.fillRect(x - 1, y, 3, 1); // horizontal arm (overlaps centre → brighter)
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = prevOp;
    }

    // Heat haze — faint warm plumes rising off the hot fallout: the game's real
    // smoke sprite tinted radioactive red (falls back to a soft glow blob until
    // the sprite is provided), widening + tumbling + fading as it lifts, so it
    // matches the pixel-art rather than reading as a clean CGI gradient.
    if (this.m_heat.length) {
      const fallback = this.heatSprite();
      const prevOp = ctx.globalCompositeOperation;
      // Additive so the tinted smoke reads as a warm GLOWING radioactive haze
      // and stays visible over any backdrop (dark sky or bright sand).
      ctx.globalCompositeOperation = 'lighter';
      for (const h of this.m_heat) {
        const t = h.age / h.life;
        const a = Math.sin(Math.PI * t) * 0.1; // ease in, ease out — a faint hint, not a cloud
        if (a <= 0.005) continue;
        const d = h.size * (1 + t * 1.8); // widen as it rises
        const spr = this.smokeTint(h.r, h.g, h.b) ?? fallback; // tinted to THIS wisp's weapon hue
        ctx.globalAlpha = a;
        ctx.save();
        ctx.translate(h.x, h.y);
        ctx.rotate(h.rot);
        ctx.drawImage(spr, -d, -d, d * 2, d * 2);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = prevOp;
    }

    // Dirt debris chunks in flight — each is a SINGLE opaque 1px pixel (the original plots one
    // `setPixel(floor(x), floor(y), color)` per chunk: no 2px squares, no blend). Floor the
    // position so it lands on a crisp pixel instead of being anti-aliased across two.
    const dbgDebris = CLand.debugMaterials; // ?skiptexture: flying dirt chunks are green too
    if (dbgDebris) ctx.fillStyle = '#00c800';
    for (const p of this.m_particles) {
      if (!dbgDebris) ctx.fillStyle = p.color;
      ctx.fillRect(Math.floor(p.x), Math.floor(p.y), 1, 1);
    }
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

  private m_particles: LandParticle[] = [];
  private m_radParticles: RadParticle[] = [];
  private m_radSpecks: RadSpeck[] = [];
  private m_radPulseT = 0; // clock for the sinusoidal glow shimmer on the fallout
  // Free lists of dead particle objects, refilled on removal and drained on emit, so a
  // repeat blast reuses objects instead of allocating thousands (kills the GC hitch).
  private m_particlePool: LandParticle[] = [];
  private m_speckPool: RadSpeck[] = [];
  private m_dirtColors: string[] = []; // dirt-chunk colour strings cached by brightness v
  private m_heat: HeatWisp[] = []; // rising heat-haze plumes off the fallout
  private m_heatSprite: HTMLCanvasElement | null = null; // cached soft warm glow sprite (fallback)
  private m_smokeSrc: CanvasImageSource | null = null; // the game's smoke.bmp (for heat wisps)
  private m_smokeW: number = 0;
  private m_smokeH: number = 0;
  private m_smokeTints: Map<string, HTMLCanvasElement> = new Map(); // per-colour tinted smoke cache
  // Falling overburden blocks (beam/digger slice collapse): a captured column of pixels (the
  // cap + earth above the cut) sliding DOWN under gravity to land on the substrate below.
  private m_falls: Fall[] = [];
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

  // ---- Unified terrain PIXEL BUFFER -------------------------------------------
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
  private m_radGlowCanvas: HTMLCanvasElement | null = null;
  private m_radGlowX = 0;
  private m_radGlowY = 0;
  private m_radGlowDirty = false;
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
