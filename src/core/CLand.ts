/**
 * CLand - Terrain Management Class
 */

import {Vec2} from '../math/Vec2';

// ============================================================================
// INTERFACES & TYPES
// ============================================================================

interface LandParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string; // dirt-chunk colour, sampled from the terrain palette
  size: number; // chunk size in px
  spin: number; // visual tumble
  age: number; // seconds airborne — force-settled past a cap so ejecta never lingers as "dots"
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

// ============================================================================
// CLand CLASS
// ============================================================================

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
    this.m_deposit = new Float32Array(width);
  }

  initFromArray(heights: Int16Array, _scaleX: number = 1, scaleY: number = 1): void {
    if (!this.m_arrHeights) return;
    const len = Math.min(heights.length, this.m_nWidth);

    for (let x = 0; x < len; x++) {
      const scaledHeight = heights[x] * scaleY;
      this.m_arrHeights[x] = Math.max(0, Math.min(this.m_nHeight, Math.floor(scaledHeight)));
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
    this.m_deposit?.fill(0);
    this.m_dirtBlobs.length = 0;
    this.m_radSpecks.length = 0;
    this.m_radParticles.length = 0;
    this.m_heat.length = 0;
    const y = Math.floor(this.m_nHeight * 0.62);
    for (let x = 0; x < this.m_nWidth; x++) this.m_arrHeights[x] = y;
    if (this.m_baseHeights) this.m_baseHeights.fill(y);
    this.m_needsBake = true;
    this.computeDirtyRegion();
  }

  // The 6 shape modes. Screen-Y: smaller = higher on screen, so
  // Ymin is the highest peaks can reach, Ymax the lowest valleys.
  private generateProfile(mode: number): void {
    if (!this.m_arrHeights) return;
    this.m_needsBake = true; // fresh heights → repaint the pixel buffer
    const W = this.m_nWidth;
    this.m_deposit?.fill(0); // clear any old fallout pile
    this.m_dirtBlobs.length = 0; // drop any in-flight dirt deposits
    this.m_falls.length = 0; // and any falling overburden blocks
    this.m_radSpecks.length = 0;
    this.m_radParticles.length = 0;
    this.m_heat.length = 0;
    const A = 15; // walk amplitude
    const Ymin = Math.floor(this.m_nHeight * 0.3); // top clamp
    const Ymax = Math.floor(this.m_nHeight * 0.82); // bottom clamp
    const clamp = (v: number) => Math.min(Math.max(v, Ymin), Ymax);

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
      this.smoothProfile(Math.max(6, Math.round(W / 180)), 2);
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
    this.m_arrHeights[0] = Math.round(clamp(start));
    for (let x = 1; x < W; x++) {
      const q = x < q1 ? 0 : x < q2 ? 1 : x < q3 ? 2 : 3;
      const [lo, hi] = win[q];
      prev = clamp(prev + this.rand01() * (hi - lo) + lo);
      this.m_arrHeights[x] = Math.round(prev);
    }

    // Box-blur the profile into soft rolling curves.
    this.smoothProfile(Math.max(6, Math.round(W / 180)), 2);
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
  // =====================================================================

  blastCircle(x: number, y: number, nRadius: number): void {
    if (!this.m_arrHeights) return;

    const startX = Math.max(0, x - nRadius);
    const endX = Math.min(this.m_nWidth - 1, x + nRadius);

    // Heightmap approximation of a destructible-bitmap crater:
    // at each column the surface drops to the bottom edge of the blast circle
    // when that is lower than the current ground (screen-Y larger = lower down).
    for (let dx = startX; dx <= endX; dx++) {
      const distFromCenter = Math.abs(dx - x);

      if (distFromCenter > nRadius) continue;

      const arcHeight = Math.sqrt(nRadius * nRadius - distFromCenter * distFromCenter);
      const craterBottom = y + arcHeight;

      // Lower the surface to the crater floor — `setColumnTop` CLEARS the removed pixels
      // (grass/dirt/rock/deposited dirt alike, material-blind) down to the new floor.
      if (craterBottom > this.m_arrHeights[dx]) this.setColumnTop(dx, craterBottom);
      // A blast destroys any irradiated-earth fallout glow here.
      if (this.m_deposit) this.m_deposit[dx] = 0;
    }

    // Wipe the radiation specks + settle-glow the blast overran — the fallout that
    // sat here is gone (the damage query is gated on the deposit, cleared above).
    if (this.m_radSpecks.length) {
      const lo = x - nRadius,
        hi = x + nRadius;
      this.m_radSpecks = this.m_radSpecks.filter(s => s.x < lo || s.x > hi);
    }

    this.preBlast(x - nRadius, x + nRadius);
  }

  /**
   * Slice-carve at a column: remove only the part of the [y-half, y+half] band that
   * is BELOW the current surface, then let all the earth above it FALL DOWN to fill
   * the gap — so the surface drops by the removed slice, NOT down to the cut. This is
   * how a ray/digger cuts *through* a mass on our heightmap (which can't hold a
   * floating tunnel): it takes a slice and the overburden collapses onto it. Returns
   * the thickness removed (0 if the band was entirely in open air here).
   */
  private sliceColumn(col: number, y: number, half: number): number {
    const h = this.m_arrHeights;
    const px = this.m_pixels;
    if (!h) return 0;
    const surf = h[col];
    const b0 = Math.max(surf, Math.floor(y - half)); // band top, clamped to the surface
    const b1 = Math.min(this.m_nHeight, Math.ceil(y + half)); // band bottom
    const removed = b1 - b0;
    if (removed <= 0) return 0; // band is above the surface here → nothing to cut

    if (px) {
      const W = this.m_nWidth;
      const overThick = b0 - surf; // the intact overburden ABOVE the band (cap + earth)
      if (overThick > 0) {
        // Capture the overburden's pixels (grass cap + earth) so they slide DOWN INTACT,
        // then clear both it and the band. A falling block drops it under gravity to land
        // on the substrate below, filling the cut — the "upper section falls down".
        const colors = new Uint32Array(overThick);
        for (let i = 0; i < overThick; i++) colors[i] = px[(surf + i) * W + col];
        for (let yy = surf; yy < b1; yy++) px[yy * W + col] = 0;
        this.m_falls.push({col, y: surf, thick: overThick, target: surf + removed, vel: 0, colors});
        h[col] = surf; // surface = the falling block's (current) top
      } else {
        // The cut starts at the surface — just remove the band from the top.
        for (let yy = surf; yy < b1; yy++) px[yy * W + col] = 0;
        h[col] = b1;
      }
    } else {
      h[col] = b1; // headless/no-pixel fallback: just drop the surface
    }
    this.m_pixelsDirty = true;
    return removed;
  }

  /** Advance falling overburden blocks (beam/digger collapse): each slid-down cap accelerates
   *  under gravity, redrawn at its new Y each frame, until it lands contiguously on the
   *  substrate — no lingering gap. */
  private stepFalls(dt: number): void {
    if (!this.m_falls.length || !this.m_pixels || !this.m_arrHeights) return;
    const G = 1400,
      W = this.m_nWidth,
      px = this.m_pixels,
      h = this.m_arrHeights;
    let w = 0;
    for (let i = 0; i < this.m_falls.length; i++) {
      const f = this.m_falls[i];
      for (let k = 0; k < f.thick; k++) px[(Math.round(f.y) + k) * W + f.col] = 0; // erase old pos
      f.vel += G * dt;
      f.y += f.vel * dt;
      let landed = false;
      if (f.y >= f.target) {
        f.y = f.target;
        landed = true;
      }
      const top = Math.round(f.y);
      for (let k = 0; k < f.thick; k++) px[(top + k) * W + f.col] = f.colors[k]; // draw at new pos
      h[f.col] = top;
      if (!landed) this.m_falls[w++] = f;
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
    const lo = Math.max(0, Math.floor(Math.min(x0, x1)));
    const hi = Math.min(this.m_nWidth - 1, Math.ceil(Math.max(x0, x1)));
    const dx = x1 - x0;
    for (let c = lo; c <= hi; c++) {
      const t = Math.abs(dx) < 1e-3 ? 0 : (c - x0) / dx;
      if (t < 0 || t > 1) continue;
      const beamY = y0 + (y1 - y0) * t;
      // Cut a SMOOTH band (no per-column random depth — that leaves thin standing "nail"
      // columns). The capped overburden falls in under gravity (a block, in sliceColumn);
      // the post-cut slump below adds a little natural raggedness while settling any spikes.
      this.sliceColumn(c, beamY, halfWidth);
    }
    this.startSlump(lo, hi); // settle the cut so it never leaves standing nails
    // Only the fallout specks the ray actually PASSES THROUGH are vaporised — the
    // rest ride the collapse down (their radiation is preserved). Keep a speck unless
    // it lies within the beam's half-width of the ray line.
    if (this.m_radSpecks.length) {
      const len2 = dx * dx + (y1 - y0) * (y1 - y0);
      this.m_radSpecks = this.m_radSpecks.filter(s => {
        if (s.x < lo || s.x > hi) return true;
        const tt =
          len2 > 0
            ? Math.max(0, Math.min(1, ((s.x - x0) * dx + (s.y - y0) * (y1 - y0)) / len2))
            : 0;
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
   * Per-column jitter (±28%) keeps the crater ragged, not a flat/perfect circle.
   */
  carveDiscCollapse(x: number, y: number, r: number): void {
    if (!this.m_arrHeights) return;
    const lo = Math.max(0, Math.floor(x - r));
    const hi = Math.min(this.m_nWidth - 1, Math.ceil(x + r));
    for (let c = lo; c <= hi; c++) {
      const dx = c - x;
      const base = Math.sqrt(Math.max(0, r * r - dx * dx)); // disc half-height at this column
      if (base <= 0.5) continue;
      // Cut the SMOOTH disc profile (no per-column random — that leaves thin standing "nails").
      // The capped soil ABOVE the band falls in under gravity (falling block); the slump below
      // settles the crater into a natural, slightly ragged bowl.
      this.sliceColumn(c, y, base);
    }
    this.startSlump(lo, hi);
    if (this.m_radSpecks.length)
      this.m_radSpecks = this.m_radSpecks.filter(s => s.x < lo || s.x > hi);
    this.preBlast(lo, hi);
  }

  /**
   * Register a column to sink by `drop` px under gravity (a beam-slice collapse): the
   * surface stays put, then `update()` accelerates it downward until it has fallen
   * `drop` px, so the capped overburden visibly FALLS into the void instead of snapping.
   * Accumulates if the column is already collapsing.
   */

  private preBlast(nX1: number, nX2: number): void {
    this.m_dirtyMin = Math.max(0, nX1);
    this.m_dirtyMax = Math.min(this.m_nWidth - 1, nX2);
    this.m_terrainDirty = true;
  }

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

  blastEllipse(x: number, y: number, nRadiusX: number, nRadiusY: number): void {
    if (!this.m_arrHeights) return;
    const startX = Math.max(0, x - nRadiusX);
    const endX = Math.min(this.m_nWidth - 1, x + nRadiusX);

    for (let dx = startX; dx <= endX; dx++) {
      const normalizedDist = (dx - x) / nRadiusX;
      if (Math.abs(normalizedDist) > 1) continue;

      const arcHeight = Math.sqrt(1 - normalizedDist * normalizedDist);
      const verticalExtent = Math.floor(nRadiusY * arcHeight);

      const newHeight = Math.max(0, this.m_arrHeights[dx] - (y + verticalExtent));
      if (newHeight < this.m_arrHeights[dx]) this.setColumnTop(dx, newHeight);
    }

    this.preBlast(x - nRadiusX, x + nRadiusX);
  }

  /**
   * Deposit earth — Dirt weapons (Dirty Boy, Mountain, Land Fill…) REMOVE NOTHING. At the
   * impact a small ball of DIRT appears (a little dome the width of the blast, replacing grass
   * with bare earth — the contact mark), then it GROWS OUTWARD and UP into the full rounded
   * mound over ~½ s: earth piling ON TOP of the surface, not the ground swelling from below.
   * Applied as pure ADD (every column only ever rises), so it can never lower or flatten the
   * surrounding terrain. `amount` (the weapon's `earth` field) scales the mound's height & width.
   */
  depositDirt(x: number, y: number, nRadius: number, amount: number): void {
    if (!this.m_arrHeights) return;
    // Mound WIDTH is driven by the weapon's blast RADIUS (how far it flings earth) and its
    // VOLUME by `earth`; height = volume/width. So two same-`earth` weapons read differently:
    // a wide-radius one (Dirty Boy r15) spreads into a low broad hill, a tight one (Dirtox r10)
    // piles a narrower, TALLER mound — instead of both looking the same.
    const R = Math.min(220, Math.round(Math.max(6, nRadius) * 3 + amount * 0.6)); // half-base
    const H = Math.min(120, Math.round((amount * amount * 1.2) / Math.max(20, R))); // peak
    if (R <= 0 || H <= 0) return;
    const r0 = Math.max(5, Math.min(R, Math.round(nRadius))); // impact-ball radius
    const cx = Math.round(x);
    // Fill the BLAST RADIUS at the contact point with a round DISC of dirt pixels — a solid
    // dirt ball right where the bomb lands (fills the little crater a contact leaves), stamped
    // straight into the terrain buffer so it IS ground. Lower half sinks below the surface.
    // Snapshot the ORIGINAL surface across the mound span BEFORE the disc raises it — the
    // dome targets an absolute level above THIS, so the disc and dome never double-count.
    const base = new Int16Array(2 * R + 1);
    for (let i = 0; i < base.length; i++) {
      const col = cx - R + i;
      base[i] = col >= 0 && col < this.m_nWidth ? this.m_arrHeights[col] : this.m_nHeight;
    }
    this.stampDirtDisc(cx, Math.round(y), r0);
    // The dome grows from the small ball (r0) out to the full mound (R,H) over ~0.5 s.
    this.m_dirtBlobs.push({x: cx, R, H, r0, t: 0, dur: 0.5, base});
    this.stepDirtBlobs(0); // stamp the initial contact ball this frame
  }

  /**
   * Advance the growing dirt blobs (Dirt-weapon deposits). Each frame the mound's radius and
   * height ease outward from the small contact ball to the full dome — raising each column,
   * baking it as bare earth (`m_deposit` + de-grass), and NEVER lowering anything, so earth
   * piles on top and the surrounding terrain is untouched.
   */
  private stepDirtBlobs(dt: number): void {
    if (!this.m_dirtBlobs.length || !this.m_arrHeights) return;
    const heights = this.m_arrHeights;
    for (let bi = this.m_dirtBlobs.length - 1; bi >= 0; bi--) {
      const blob = this.m_dirtBlobs[bi];
      blob.t += dt;
      const frac = Math.min(1, blob.t / blob.dur);
      const ease = frac * (2 - frac); // ease-out so it eases to rest
      // The mound spreads out and rises from the contact ball to the full dome.
      const curR = blob.r0 + (blob.R - blob.r0) * ease;
      const curH = blob.H * (0.35 + 0.65 * ease); // starts as a small ball, grows up
      const x0 = Math.max(0, Math.round(blob.x - curR)),
        x1 = Math.min(this.m_nWidth - 1, Math.round(blob.x + curR));
      for (let col = x0; col <= x1; col++) {
        const dx = (col - blob.x) / curR; // -1..1 across the current mound
        if (dx <= -1 || dx >= 1) continue;
        // Cosine dome: 1 at centre, 0 at the rim, smooth (zero slope) at both — a rounded hill.
        const dome = 0.5 * (1 + Math.cos(Math.PI * dx));
        const want = Math.round(curH * dome); // mound height at this column
        const idx = col - (blob.x - blob.R);
        if (idx < 0 || idx >= blob.base.length) continue;
        // Target an ABSOLUTE top of `base - want` above the ORIGINAL surface. `setColumnTop`
        // raises to it by STAMPING dirt pixels (grass stays underneath); never goes below the
        // original surface, so the surrounding terrain and substrate never move. This is real,
        // native terrain — it burns and craters exactly like the ground.
        const target = blob.base[idx] - want;
        if (target < heights[col]) {
          this.setColumnTop(col, target);
          if (this.m_baseHeights) this.m_baseHeights[col] = Math.min(this.m_baseHeights[col], heights[col]); // prettier-ignore
        }
      }
      this.preBlast(x0, x1);
      if (frac >= 1) this.m_dirtBlobs.splice(bi, 1);
    }
  }

  blastIradiate(
    x: number,
    y: number,
    nRadius: number,
    fDamagePerSecond: number,
    fDurationSeconds: number,
    rgb?: [number, number, number],
  ): void {
    // Nukes/DOT ship no explicit irRGB → glow a hot radioactive red-orange.
    const [r, g, b] = rgb && (rgb[0] || rgb[1] || rgb[2]) ? rgb : [255, 46, 20];

    // The fallout lingers longer than the raw irTime and dims GRADUALLY.
    // Stretch the visible life ~1.6× so the radioactive ground glows for a
    // good while and decays slowly.
    const dur = fDurationSeconds * 1.6;

    // Gameplay damage zone (queried against tanks each frame) — also drives the
    // solid glowing band painted along the surface.
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

    // Fallout is irradiated EARTH: it REFILLS most of the crater, raising the
    // heightmap back up — so the deposit is real, collidable, destructible TERRAIN
    // (not an overlay over the sky). It fills a fixed fraction of the crater at each
    // column, so it follows the bowl: thick over the deep centre, thin up the walls.
    // The earth glows red densest at the centre, fading to brown up the walls and
    // over irTime; when the glow dies the raised earth stays (never turns to air).
    if (this.m_deposit && this.m_arrHeights && this.m_baseHeights) {
      const FILL = 0.2; // fraction of the crater refilled by fallout
      const px0 = Math.max(0, Math.floor(x - nRadius)),
        px1 = Math.min(this.m_nWidth - 1, Math.floor(x + nRadius));
      for (let col = px0; col <= px1; col++) {
        const craterDepth = this.m_arrHeights[col] - this.m_baseHeights[col]; // >0 inside the crater
        if (craterDepth <= 2) continue; // only where the ground was actually cratered
        const target = craterDepth * FILL;
        const add = target - this.m_deposit[col]; // only the new contribution
        if (add > 0) {
          this.m_deposit[col] = target; // radiation glow-zone height (transient overlay reads it)
          // Refill the crater with real earth pixels; the glow reddens them while live, then
          // the bare irradiated earth stays. Clamp the raise to the pristine ceiling.
          const raised = Math.max(this.m_baseHeights[col], this.m_arrHeights[col] - add);
          this.setColumnTop(col, raised);
        }
      }
      this.preBlast(px0, px1);
    }

    // Irradiated ground turns to bare DIRT: recolour the grass cap to dirt pixels across the
    // whole fallout span (the original bares the grass so the zone reads as radiated earth, not
    // green under a red tint). Real pixels → the bare earth stays after the glow fades.
    if (this.m_pixels && this.m_arrHeights) {
      const gd = Math.max(4, (this.m_layers[0]?.depth ?? 10) + 2); // grass-cap thickness
      const zx0 = Math.max(0, Math.floor(x - nRadius)),
        zx1 = Math.min(this.m_nWidth - 1, Math.floor(x + nRadius));
      for (let col = zx0; col <= zx1; col++) {
        const top = this.m_arrHeights[col];
        const bot = Math.min(this.m_nHeight - 1, top + gd);
        for (let yy = top; yy <= bot; yy++)
          this.m_pixels[yy * this.m_nWidth + col] = this.dirtColorAt(col, yy);
      }
      this.m_pixelsDirty = true;
    }

    // Visual: a cloud of glowing specks thrown out of the crater. They fall, settle,
    // and scatter THROUGH the pile (granular texture) tinted by irRGB fading over
    // irTime — so the zone conforms to the ground, not floating.
    const n = Math.max(200, Math.min(12000, Math.round(nRadius * 60)));
    const pool = this.m_speckPool;
    for (let i = 0; i < n; i++) {
      const ang = this.rand01() * Math.PI * 2;
      const dist = this.rand01() * nRadius; // stays within the crater zone
      // Thrown mostly UP and a little out, so specks rain back down INSIDE the
      // crater rather than flying onto the surrounding ridges.
      const speed = 30 + this.rand01() * 110;
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
        r: 0,
        g: 0,
        b: 0,
      };
      s.x = x + Math.cos(ang) * dist;
      s.y = y + Math.sin(ang) * dist * 0.5; // start near the surface line
      s.vx = Math.cos(ang) * speed * 0.6;
      s.vy = Math.sin(ang) * speed * 0.5 - (70 + this.rand01() * 150); // up-biased
      s.age = 0;
      s.life = dur * (0.85 + this.rand01() * 0.2); // lingers ~the stretched irTime
      s.settled = false;
      s.size = 1.6 + this.rand01() * 2;
      s.rise = 0;
      s.r = r;
      s.g = g;
      s.b = b;
      this.m_radSpecks.push(s);
    }
    if (this.m_radSpecks.length > 13000)
      this.m_radSpecks.splice(0, this.m_radSpecks.length - 13000);
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
   * lower one. Repeated,
   * this melts the thin spikes debris stacks up into smooth mounds.
   */
  private slump(x0: number, x1: number): void {
    const h = this.m_arrHeights;
    if (!h) return;
    const THRESH = 7; // adjacent columns may differ by up to this before dirt slides (repose angle)
    const a = Math.max(1, Math.floor(x0)),
      b = Math.min(this.m_nWidth - 2, Math.floor(x1));
    for (let x = a; x <= b; x++) {
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

  smoothy(): void {
    if (!this.m_arrHeights) return;

    const smoothed = new Int16Array(this.m_nWidth);
    const kernelSize = 5;
    const halfKernel = Math.floor(kernelSize / 2);

    for (let x = halfKernel; x < this.m_nWidth - halfKernel; x++) {
      let sum = 0;

      for (let dx = -halfKernel; dx <= halfKernel; dx++) {
        sum += this.m_arrHeights[x + dx];
      }

      smoothed[x] = Math.floor(sum / kernelSize);
    }

    const endIdx = this.m_nWidth - halfKernel;
    for (let i = halfKernel; i < endIdx; i++) {
      this.m_arrHeights[i] = smoothed[i];
    }
  }

  /**
   * Throw dirt chunks from a blast — launched radially, they arc up, fall, and
   * settle back into the terrain (raising the column where they land, so mounds
   * are emergent). Chunk colour is procedurally-generated brown (R=v, G≈v/2, B=0,
   * v∈[30,129]), not sampled from the ground.
   */
  /** Dirt-chunk colour string cached by brightness v (0..139) so a 6500-chunk nuke
   *  doesn't allocate 6500 `rgb()` strings per blast (GC churn → fire-time hitch). */
  private dirtColor(v: number): string {
    return this.m_dirtColors[v] ?? (this.m_dirtColors[v] = `rgb(${v},${v >> 1},${v >> 3})`);
  }

  addShowerParticles(x: number, y: number, count: number, radius = 24): void {
    const pool = this.m_particlePool;
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      // Dirt brown (R=v, G≈v/2, B≈0), occasionally a darker clod for texture.
      let v = 24 + Math.floor(Math.random() * 116); // [24,139]
      if (Math.random() < 0.25) v = Math.floor(v * 0.55); // some dark chunks
      // Launch speed scales with the blast radius so a small weapon's debris stays
      // near the crater instead of raining across the whole map.
      const speed = 30 + Math.random() * (radius * 2.4);
      const up = radius * (0.3 + Math.random() * 1.3);
      // Reuse a settled chunk from the free pool — after the first big blast the
      // pool is warm, so a nuke allocates zero LandParticle objects (no GC spike).
      const p: LandParticle = pool.pop() ?? {x: 0, y: 0, vx: 0, vy: 0, color: '', size: 0, spin: 0, age: 0};
      p.x = x + (Math.random() * 2 - 1) * radius;
      p.y = y + (Math.random() * 2 - 1) * radius * 0.4;
      p.vx = Math.cos(ang) * speed;
      p.vy = Math.sin(ang) * speed * 0.7 - up; // varied up-and-out, scaled to the blast
      p.color = this.dirtColor(v);
      p.size = Math.random() < 0.82 ? 1 : 2; // mostly 1px → many fine chunks
      p.spin = 0;
      p.age = 0;
      this.m_particles.push(p);
    }
  }

  /**
   * Spawn dirt chunks that FALL from a cut rather than being flung out — near-zero
   * launch (they just drop under gravity) and settle into ±2px-scattered piles via
   * the same deposit path as blast ejecta. This is the "the earth falls in after the
   * beam" collapse: the sliced overburden drops and re-piles noisily, so the cut never
   * reads as a clean geometric slot. (The original ejects the carved earth as
   * zero-velocity debris that settles over the next ~1 s — see the RE notes.)
   */
  addFallingDebris(x: number, y: number, count: number, spread: number, color?: string): void {
    const pool = this.m_particlePool;
    for (let i = 0; i < count; i++) {
      let v = 24 + Math.floor(Math.random() * 116); // dirt brown [24,139]
      if (Math.random() < 0.25) v = Math.floor(v * 0.55); // some dark clods
      const p: LandParticle = pool.pop() ?? {x: 0, y: 0, vx: 0, vy: 0, color: '', size: 0, spin: 0, age: 0};
      p.x = x + (Math.random() * 2 - 1) * spread;
      p.y = y + (Math.random() * 2 - 1) * spread * 0.5;
      p.vx = (Math.random() * 2 - 1) * 22; // slight sideways drift
      p.vy = Math.random() * 34; // starts falling — no upward launch
      p.color = color ?? this.dirtColor(v); // caller can match the surface cap
      p.size = Math.random() < 0.82 ? 1 : 2;
      p.spin = 0;
      p.age = 0;
      this.m_particles.push(p);
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
    // ground around and down the walls of the blast, the way the original chars the land.
    this.scorchPixels(x, y, Math.max(20, radius * 1.8));
  }

  update(dt: number): void {
    const GRAVITY = 500;

    this.stepFalls(dt); // advance any beam/digger overburden falling under gravity
    this.stepDirtBlobs(dt); // grow any Dirt-weapon deposit domes into place

    // Compact-forward removal (a write index), NOT splice(i,1): a nuke flings
    // ~6500 chunks, and hundreds settle per frame — each splice shifts the whole
    // tail (O(n)), so settling was O(n²) per frame. That is the hitch on impact and
    // the sluggish earth settle. Copying survivors forward and truncating once is O(n).
    let dw = 0;
    for (let i = 0; i < this.m_particles.length; i++) {
      const p = this.m_particles[i];

      p.vy += GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.age += dt;

      const col = Math.floor(p.x);
      if (col < 0 || col >= this.m_nWidth) {
        this.m_particlePool.push(p);
        continue;
      } // left the field → recycle

      // A chunk settles when it reaches the surface (only on the way down) and deposits —
      // raising a column by 1px. Past a lifetime cap, a straggler force-settles at its column
      // even if still airborne, so the ejecta NEVER lingers as a cloud of "dots" over the crater.
      if (
        (p.vy > 0 && p.y >= this.getHeightAt(col) && this.m_arrHeights) ||
        (p.age > 1.1 && this.m_arrHeights)
      ) {
        const dcol = Math.min(this.m_nWidth - 1, Math.max(0, col + ((Math.random() * 5) | 0) - 2));
        // A landed chunk raises its column 1px → STAMP one dirt pixel on top (the shared
        // deposit primitive). Real, native terrain; no separate de-grass bookkeeping.
        this.setColumnTop(dcol, this.m_arrHeights[dcol] - 1);
        if (this.m_baseHeights)
          this.m_baseHeights[dcol] = Math.min(this.m_baseHeights[dcol], this.m_arrHeights[dcol]);
        this.preBlast(dcol - 1, dcol + 1);
        // Let the slump smooth this area over the next few seconds.
        this.m_slumpTimer = 3;
        this.m_slumpX0 = Math.min(this.m_slumpX0, dcol - 3);
        this.m_slumpX1 = Math.max(this.m_slumpX1, dcol + 3);
        this.m_particlePool.push(p);
        continue; // settled → deposited → recycle
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

    let rw = 0;
    for (let i = 0; i < this.m_radParticles.length; i++) {
      const r = this.m_radParticles[i];
      r.timeRemaining -= dt;
      if (r.timeRemaining <= 0) continue; // zone expired → drop
      this.m_radParticles[rw++] = r;
    }
    this.m_radParticles.length = rw;

    // Radiation specks: fall until they hit the surface, then settle and glow.
    // Compact-forward too — up to ~12000 specks meant splice(i,1) was O(n²).
    const RAD_GRAV = 320;
    let sw = 0;
    for (let i = 0; i < this.m_radSpecks.length; i++) {
      const s = this.m_radSpecks[i];
      s.age += dt;
      if (s.age >= s.life) {
        this.m_speckPool.push(s);
        continue;
      } // faded out → recycle

      if (!s.settled) {
        s.vy += RAD_GRAV * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        const col = Math.floor(s.x);
        if (col < 0 || col >= this.m_nWidth) {
          this.m_speckPool.push(s);
          continue;
        } // left the field → recycle
        if (s.vy > 0 && s.y >= this.getHeightAt(col)) {
          s.settled = true;
          s.vx = s.vy = 0;
          // Scatter the grain THROUGH the fallout pile at this column: from a few px
          // in the soil (grounded base) up to the pile top, biased low so the crown
          // thins out. rise = height ABOVE the surface (the grain's pile position).
          // Settle as a granular CARPET hugging the surface across the WHOLE bowl
          // (walls + floor + rim) — a small spread
          // mostly on/just below the ground, a thin fringe above. NOT pooled in the
          // deposit, so it coats the deep walls, not just the bottom.
          s.rise = this.rand01() * 4 - this.rand01() * this.rand01() * 30; // +4 above .. -30 below (thick, grounded)
          s.y = this.getHeightAt(col) - s.rise;
        }
      } else {
        // Keep clinging to the surface as craters below it change the height.
        const col = Math.floor(s.x);
        if (col >= 0 && col < this.m_nWidth) s.y = this.getHeightAt(col) - s.rise;
      }
      this.m_radSpecks[sw++] = s; // still live → keep
    }
    this.m_radSpecks.length = sw;

    // Heat haze: faint warm plumes rise off the live fallout — spawned across the
    // active deposit (fewer as the zone cools), they lift, widen and fade so the
    // radioactive ground reads as HOT. Gated on the deposit, so a bomb that clears
    // the fallout stops new heat there too.
    if (this.m_radParticles.length && this.m_deposit && this.m_heat.length < 90) {
      for (const z of this.m_radParticles) {
        const cool = z.timeRemaining / Math.max(0.5, z.duration); // 1 hot → 0 cold
        const rr = z.radius;
        const spawn = this.rand01() < cool * 0.7 ? 1 : 0; // sparse — a wisp here and there
        // Tint the wisp with the weapon's radiation colour (irRGB), brightened
        // so hydrogen puffs BLUE / plutonium GREEN / uranium RED — matching the
        // carpet, not a fixed red.
        const mx = Math.max(z.r, z.g, z.b, 1),
          k2 = 230 / mx;
        const tr = Math.round(z.r * k2),
          tg = Math.round(z.g * k2),
          tb = Math.round(z.b * k2);
        for (let k = 0; k < spawn; k++) {
          const col = Math.floor(z.x - rr + this.rand01() * rr * 2);
          if (col < 0 || col >= this.m_nWidth || this.m_deposit[col] <= 0) continue;
          this.m_heat.push({
            x: col + this.rand01() * 2 - 1,
            y: this.getHeightAt(col) - this.rand01() * 4,
            age: 0,
            life: 0.7 + this.rand01() * 0.8,
            size: 5 + this.rand01() * 7,
            vx: (this.rand01() - 0.5) * 12,
            rot: this.rand01() * Math.PI * 2,
            spin: (this.rand01() - 0.5) * 1.6,
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

  /** Fallout deposit height (px) at a column — 0 where there is no live irradiation
   *  (cleared when a blast overruns it). Gates radiation damage to the visible zone. */
  radDepositAt(x: number): number {
    if (!this.m_deposit) return 0;
    const ix = Math.floor(x);
    if (ix < 0 || ix >= this.m_nWidth) return 0;
    return this.m_deposit[ix];
  }

  // ========================================================================
  // COLLISION & QUERIES
  // =====================================================================

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

  isUnderground(x: number, y: number): boolean {
    return y >= this.getHeightAt(x);
  }

  getNormal(x: number): Vec2 {
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
  // =====================================================================

  /**
   * Set the depth-sorted texture layers (from land.txt): the smallest depth is
   * the surface cap, larger depths are deeper strata. Rebuilds the cached bitmap.
   */
  setLayers(
    layers: {image: CanvasImageSource; depth: number}[],
    bareImage?: CanvasImageSource,
  ): void {
    // land.txt depths are authored for a ~480px play area; scale them
    // to our (taller) terrain so the strata bands stay proportional.
    const scale = this.m_nHeight / 480;
    this.m_layers = layers
      .map(l => ({image: l.image, depth: Math.round(l.depth * scale)}))
      .sort((a, b) => a.depth - b.depth);
    // Guaranteed-bare (non-grass) earth texture used to repaint de-grassed crater
    // columns. Fall back to the deepest stratum (always sub-surface, never the cap).
    this.m_bareImage = bareImage ?? this.m_layers[this.m_layers.length - 1]?.image ?? null;
    this.m_patterns = [];
    this.m_terrainDirty = true;
    this.m_needsBake = true; // new textures → repaint the pixel buffer
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
    const nt = Math.max(0, Math.min(this.m_nHeight, Math.floor(newTop)));
    const old = h[col];
    const px = this.m_pixels;
    if (px) {
      const W = this.m_nWidth;
      if (nt < old) {
        for (let y = nt; y < old; y++) px[y * W + col] = colorFn ? colorFn(col, y) : this.dirtColorAt(col, y); // prettier-ignore
      } else if (nt > old) {
        for (let y = old; y < nt; y++) px[y * W + col] = 0;
      }
    }
    h[col] = nt;
    this.m_pixelsDirty = true;
  }

  /** Darken the terrain pixels inside a disc — permanent scorch, baked into the buffer (the
   *  original tints the same pixels, so burnt DEPOSITED dirt darkens exactly like native ground). */
  private scorchPixels(cx: number, cy: number, radius: number): void {
    const px = this.m_pixels;
    if (!px) return;
    const W = this.m_nWidth,
      H = this.m_nHeight;
    const r = Math.max(1, radius);
    const x0 = Math.max(0, Math.floor(cx - r)),
      x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)),
      y1 = Math.min(H - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > r) continue;
        const i = y * W + x;
        const c = px[i];
        if ((c & 0xff000000) === 0) continue; // empty → skip
        // Charred: near-black at the blast, easing back to the untouched colour at the rim.
        const k = 0.18 + 0.72 * (d / r);
        const rr = (c & 0xff) * k,
          gg = ((c >> 8) & 0xff) * k,
          bb = ((c >> 16) & 0xff) * k;
        px[i] = ((0xff << 24) | (bb << 16) | (gg << 8) | rr) >>> 0;
      }
    }
    this.m_pixelsDirty = true;
  }

  /** Stamp the round contact ball a Dirt weapon leaves at the impact: a filled DISC of dirt.
   *  Above the surface → raise the crown CONTIGUOUSLY (via `setColumnTop`, so no floating gap
   *  above sloped/stacked ground). Below the surface → RECOLOUR the already-solid pixels to
   *  dirt (never clears → can't create a void). So the whole circle reads as a dirt ball. */
  private stampDirtDisc(cx: number, cy: number, r: number): void {
    const h = this.m_arrHeights,
      px = this.m_pixels;
    if (!h) return;
    const W = this.m_nWidth,
      H = this.m_nHeight;
    const x0 = Math.max(0, cx - r),
      x1 = Math.min(W - 1, cx + r);
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const hh = Math.sqrt(Math.max(0, r * r - dx * dx));
      const crown = cy - hh;
      if (crown < h[x]) this.setColumnTop(x, crown); // above surface → raise (stamp dirt)
      // below surface → recolour the solid pixels the ball covers, down to its bottom edge
      if (px) {
        const bot = Math.min(H - 1, Math.floor(cy + hh));
        for (let y = h[x]; y <= bot; y++) px[y * W + x] = this.dirtColorAt(x, y);
        if (bot >= h[x]) this.m_pixelsDirty = true;
      }
    }
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
    const g = this.ensureTerrainCtx();
    const W = this.m_nWidth,
      H = this.m_nHeight;
    const heights = this.m_arrHeights!;
    g.clearRect(0, 0, W, H);
    if (this.m_patterns.length !== this.m_layers.length) {
      this.m_patterns = this.m_layers.map(l => g.createPattern(l.image, 'repeat'));
    }
    const EXT = 2;
    const deepest = this.m_patterns[this.m_layers.length - 1];
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
      const pat = this.m_patterns[i];
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
    this.m_pixels = new Uint32Array(this.m_terrainImage.data.buffer);
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
    this.m_needsBake = false;
    this.m_pixelsDirty = true;
  }

  private ensureTerrainCtx(): CanvasRenderingContext2D {
    if (!this.m_terrainCanvas) this.m_terrainCanvas = document.createElement('canvas');
    if (
      this.m_terrainCanvas.width !== this.m_nWidth ||
      this.m_terrainCanvas.height !== this.m_nHeight
    ) {
      this.m_terrainCanvas.width = this.m_nWidth;
      this.m_terrainCanvas.height = this.m_nHeight;
      this.m_patterns = [];
      this.m_terrainDirty = true;
    }
    return this.m_terrainCanvas.getContext('2d')!;
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
    return (
      this.m_falls.length > 0 || this.m_particles.length > 0 || this.m_dirtBlobs.length > 0
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
      if (this.m_pixelsDirty && this.m_terrainImage) {
        this.ensureTerrainCtx().putImageData(this.m_terrainImage, 0, 0);
        this.m_pixelsDirty = false;
      }
      if (this.m_terrainCanvas) ctx.drawImage(this.m_terrainCanvas, 0, 0);
    } else {
      // Gradient fallback until the land tiles finish loading.
      for (let x = 0; x < W - 1; x++) {
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

    // Radiation glow — a TEMPORARY emissive tint over the raised fallout deposit.
    // The deposit is real, collidable, destructible EARTH (the heightmap was raised
    // and the bitmap baked earthy-brown above); this glow only reddens that earth
    // while the zone is live and fades over irTime, leaving the bare earth behind —
    // it never paints the sky above the surface, so nothing turns to air.
    if (this.m_radParticles.length && this.m_arrHeights && this.m_deposit) {
      const dep = this.m_deposit;
      // Pass A — red emissive body (normal blend) painted DOWN INTO the raised earth.
      // Per zone the tint is constant, so set fillStyle ONCE and vary only
      // globalAlpha per column — no per-column rgba() string (that churn drove GC).
      for (const z of this.m_radParticles) {
        const fade = Math.min(1, (2 * z.timeRemaining) / Math.max(0.5, z.duration)); // full for the first half, then dim gradually
        if (fade <= 0) continue;
        const rr = z.radius;
        const x0 = Math.max(0, Math.floor(z.x - rr)),
          x1 = Math.min(this.m_nWidth - 1, Math.floor(z.x + rr));
        ctx.fillStyle = `rgb(${z.r},${Math.round(z.g * 0.5)},${Math.round(z.b * 0.4)})`;
        for (let col = x0; col <= x1; col++) {
          const d = Math.round(dep[col]);
          if (d <= 0) continue; // only where earth was deposited
          const edge = 1 - Math.abs(col - z.x) / rr;
          if (edge <= 0) continue;
          const sy = this.getHeightAt(col);
          ctx.globalAlpha = fade * (0.14 + edge * 0.2);
          ctx.fillRect(col, sy - 3, 1, 15); // a soft red BASE hugging the surface — the dots dominate
        }
      }
      // Pass B — additive GLOW, strongest over the dense centre.
      const prevOp = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter';
      for (const z of this.m_radParticles) {
        const life = z.timeRemaining / Math.max(0.5, z.duration);
        const fade = Math.min(1, (2 * z.timeRemaining) / Math.max(0.5, z.duration)); // full for the first half, then dim gradually
        if (fade <= 0) continue;
        const rr = z.radius;
        const x0 = Math.max(0, Math.floor(z.x - rr)),
          x1 = Math.min(this.m_nWidth - 1, Math.floor(z.x + rr));
        ctx.fillStyle = `rgb(${z.r},${z.g},${z.b})`;
        for (let col = x0; col <= x1; col++) {
          const d = Math.round(dep[col]);
          if (d <= 0) continue;
          const edge = 1 - Math.abs(col - z.x) / rr;
          if (edge <= 0) continue;
          const sy = this.getHeightAt(col);
          ctx.globalAlpha = fade * (0.1 + edge * 0.22) * (0.5 + 0.5 * life);
          ctx.fillRect(col, sy - 3, 1, 16);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = prevOp;
    }

    // Radiation specks = grains of the irradiated EARTH, each an earthy body with a
    // soft red EMISSIVE glow. They sit within the raised deposit and fade over life.
    // Up to ~7200 of these, so the hot path avoids per-speck string/path work.
    if (this.m_radSpecks.length) {
      const prevOp = ctx.globalCompositeOperation;
      // Pass 1 — earthy grain bodies (normal blend). Constant colour → set the
      // fillStyle once and vary only globalAlpha (no per-speck rgba() string).
      ctx.fillStyle = 'rgb(42,24,13)';
      for (const s of this.m_radSpecks) {
        const fade = Math.min(1, 2.2 * (1 - s.age / s.life)); // full for the first ~55%, then dim gradually to 0
        if (fade <= 0) continue;
        ctx.globalAlpha = fade * 0.4;
        ctx.fillRect(Math.round(s.x) - 1, Math.round(s.y) - 1, 2, 2);
      }
      // Pass 2 — the soft red emissive glow (additive). A fast fillRect instead of
      // a per-speck arc()+fill() circle (the rasterised path ×7200 was the draw
      // spike); the tint is constant per blast, so build the rgb() string only when
      // the colour actually changes, and vary only globalAlpha per speck.
      ctx.globalCompositeOperation = 'lighter';
      let lastKey = -1;
      for (const s of this.m_radSpecks) {
        const fade = Math.min(1, 2.2 * (1 - s.age / s.life)); // full for the first ~55%, then dim gradually to 0
        if (fade <= 0) continue;
        const key = (s.r << 16) | (s.g << 8) | s.b;
        if (key !== lastKey) {
          ctx.fillStyle = `rgb(${s.r},${s.g},${s.b})`;
          lastKey = key;
        }
        ctx.globalAlpha = fade * 0.5;
        const w = 2 + s.size; // ≈ old arc diameter
        ctx.fillRect(s.x - w / 2, s.y - w / 2, w, w);
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

    // Dirt debris chunks in flight.
    for (const p of this.m_particles) {
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }

  // ========================================================================
  // MEMBER VARIABLES
  // =====================================================================

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
  private m_deposit: Float32Array | null = null; // per-column: deposited earth PILE height above surface (px) — fallout OR Dirt-weapon mound; bakes the pile as bare earth
  // Active Dirt-weapon deposits: smooth cosine domes that grow from a small contact ball (r0)
  // out to the full mound (R,H) over `dur` s, ADD-only. `applied` = px raised per column.
  private m_dirtBlobs: {
    x: number;
    R: number;
    H: number;
    r0: number;
    t: number;
    dur: number;
    base: Int16Array; // original surface Y per column (dome targets an absolute level above this)
  }[] = [];
  // Impact discs: a round dirt ball baked at each Dirt-weapon contact point (x, surfY, radius).
  // Falling overburden blocks (beam/digger slice collapse): a captured column of pixels (the
  // cap + earth above the cut) sliding DOWN under gravity to land on the substrate below.
  private m_falls: {col: number; y: number; thick: number; target: number; vel: number; colors: Uint32Array}[] = [];
  // Terrain-slump erosion, scoped to the recently-disturbed span for a short window.
  private m_slumpTimer: number = 0;
  private m_slumpX0: number = 1e9;
  private m_slumpX1: number = 0;

  // Layered textures + cached destructible-terrain bitmap.
  private m_layers: {image: CanvasImageSource; depth: number}[] = [];
  private m_patterns: (CanvasPattern | null)[] = [];
  private m_bareImage: CanvasImageSource | null = null; // non-grass earth for de-grassed craters
  private m_terrainCanvas: HTMLCanvasElement | null = null;
  private m_terrainDirty: boolean = true;

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

  get width(): number {
    return this.m_nWidth;
  }

  get height(): number {
    return this.m_nHeight;
  }
}
