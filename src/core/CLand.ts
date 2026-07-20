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

// A permanent blackened blast mark baked into the terrain bitmap.
interface Scorch {
  x: number;
  y: number;
  r: number;
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
    this.m_degrass = new Uint8Array(width);
    this.m_radDeposit = new Float32Array(width);
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

  // The 6 shape modes. Screen-Y: smaller = higher on screen, so
  // Ymin is the highest peaks can reach, Ymax the lowest valleys.
  private generateProfile(mode: number): void {
    if (!this.m_arrHeights) return;
    const W = this.m_nWidth;
    this.m_degrass?.fill(0); // fresh terrain: grass everywhere again
    this.m_radDeposit?.fill(0); // clear any old fallout pile
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

      if (craterBottom > this.m_arrHeights[dx]) {
        this.m_arrHeights[dx] = Math.min(this.m_nHeight, Math.floor(craterBottom));
      }
      // Strip the grass cap here — the blast tears through it, exposing bare
      // dirt (the destructible bitmap loses the green pixels).
      if (this.m_degrass) this.m_degrass[dx] = 1;
      // A blast destroys any irradiated-earth deposit here (a normal bomb or a
      // terrain-clear removes the fallout + its red glow).
      if (this.m_radDeposit) this.m_radDeposit[dx] = 0;
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
  private sliceColumn(
    col: number,
    y: number,
    half: number,
    keepCap = false,
    animate = false,
  ): number {
    const surf = this.m_arrHeights![col];
    // Earth exists for screen-Y in [surf, height]. Intersect the band with it.
    const removed = Math.min(y + half, this.m_nHeight) - Math.max(surf, y - half);
    if (removed <= 0) return 0; // band is above the surface here
    // animate: leave the surface where it is and let `beginCollapse` sink it under
    // gravity over the next moments (the earth FALLS in) instead of snapping down.
    if (!animate) this.m_arrHeights![col] = Math.min(this.m_nHeight, surf + removed);
    // keepCap: the overburden slides DOWN INTACT — it keeps its top surface (grass/
    // snow cap) AND its radiation (a beam takes a void and the capped, possibly
    // irradiated earth falls in; it does not destroy either). Only a true excavation
    // (digger underground, blast) strips the cap and wipes the fallout.
    if (!keepCap) {
      if (this.m_degrass) this.m_degrass[col] = 1; // tore through the grass cap
      if (this.m_radDeposit) this.m_radDeposit[col] = 0; // blast wipes the fallout
    } else if (this.m_radDeposit && this.m_radDeposit[col] > 0) {
      // Irradiated earth survives the collapse EXCEPT the part the ray band cuts
      // directly through: the fallout sits in [surf, surf+dep], so remove only its
      // overlap with the removed band and let the rest fall back with its radiation.
      const dep = this.m_radDeposit[col];
      const hit = Math.min(surf + dep, y + half) - Math.max(surf, y - half);
      if (hit > 0) this.m_radDeposit[col] = Math.max(0, dep - hit);
    }
    return removed;
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
      // Ragged cut: jitter the removed depth per column (±30%) so the slot edge is
      // noisy, not a clean geometric line. keepCap → the grass/snow surface slides
      // down with the collapse instead of exposing bare dirt.
      const half = Math.max(1, halfWidth * (0.7 + Math.random() * 0.6));
      const removed = this.sliceColumn(c, beamY, half, true, true); // keepCap + animate
      // Don't snap the surface down — register a gravity COLLAPSE so the capped
      // overburden visibly FALLS into the void over the next moments. Per-column
      // depth jitter (above) makes each column fall to a slightly different level,
      // so the settled line is ragged/noisy, not a clean slot.
      if (removed > 0.5) this.beginCollapse(c, removed);
    }
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
      // Noise so the crater isn't a clean circle: scale the disc height ±40% and add a
      // small absolute wobble per column → a ragged, uneven rim/floor.
      const h = Math.max(1, base * (0.6 + Math.random() * 0.8) + (Math.random() * 2 - 1) * r * 0.12);
      const removed = this.sliceColumn(c, y, h, true, true); // keepCap (grass rides down) + animate
      if (removed > 0.5) this.beginCollapse(c, removed); // the overburden falls in (gravity)
    }
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
  private beginCollapse(col: number, drop: number): void {
    const W = this.m_nWidth;
    if (!this.m_collapseTarget) {
      this.m_collapseTarget = new Float32Array(W).fill(-1); // -1 = not collapsing
      this.m_collapseVel = new Float32Array(W);
    }
    if (!this.m_collapseActive) {
      this.m_collapseMinX = W;
      this.m_collapseMaxX = 0;
    }
    const cur = this.m_arrHeights![col];
    const base = this.m_collapseTarget[col] >= 0 ? this.m_collapseTarget[col] : cur;
    this.m_collapseTarget[col] = Math.min(this.m_nHeight, base + drop);
    this.m_collapseActive = true;
    if (col < this.m_collapseMinX) this.m_collapseMinX = col;
    if (col > this.m_collapseMaxX) this.m_collapseMaxX = col;
  }

  /** Advance any in-progress beam-slice collapse: each registered column falls under
   *  gravity until it reaches its target depth. Called from `update()`. */
  private stepCollapse(dt: number): void {
    if (!this.m_collapseActive || !this.m_arrHeights || !this.m_collapseTarget) return;
    const G = 1400; // px/s^2 — the earth accelerates as it caves
    const tgt = this.m_collapseTarget,
      vel = this.m_collapseVel!,
      h = this.m_arrHeights;
    let anyActive = false;
    for (let c = this.m_collapseMinX; c <= this.m_collapseMaxX; c++) {
      if (tgt[c] < 0) continue;
      vel[c] += G * dt;
      let s = h[c] + vel[c] * dt; // screen-Y down → sinking = increasing Y
      if (s >= tgt[c]) {
        s = tgt[c];
        tgt[c] = -1;
        vel[c] = 0;
      } // landed → stop
      else anyActive = true;
      h[c] = s;
    }
    this.preBlast(this.m_collapseMinX, this.m_collapseMaxX);
    if (!anyActive) {
      this.m_collapseActive = false;
      this.m_collapseMinX = this.m_nWidth;
      this.m_collapseMaxX = 0;
    }
  }


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
      if (newHeight < this.m_arrHeights[dx]) {
        this.m_arrHeights[dx] = newHeight;
      }
    }

    this.preBlast(x - nRadiusX, x + nRadiusX);
  }

  /**
   * Raise terrain — Dirt weapons deposit a mound, approximated directly as a
   * circular mound of height `amount` (the weapon's `earth` field) over
   * `nRadius`.
   */
  raiseTerrain(x: number, y: number, nRadius: number, amount: number): void {
    if (!this.m_arrHeights || nRadius <= 0) return;

    const startX = Math.max(0, x - nRadius);
    const endX = Math.min(this.m_nWidth - 1, x + nRadius);

    for (let dx = startX; dx <= endX; dx++) {
      const d = Math.abs(dx - x);
      if (d > nRadius) continue;
      const arc = Math.sqrt(1 - (d / nRadius) * (d / nRadius)); // 1 at centre → 0 at rim
      const lift = amount * arc;
      // Screen-Y down: raising = smaller Y. Mound sits on top of whatever is lower.
      const top = Math.min(this.m_arrHeights[dx], y) - lift;
      this.m_arrHeights[dx] = Math.max(0, Math.floor(top));
      // A raised mound is solid new terrain — lift the cavity ceiling with it.
      if (this.m_baseHeights)
        this.m_baseHeights[dx] = Math.min(this.m_baseHeights[dx], this.m_arrHeights[dx]);
      // Deposited dirt is bare EARTH — de-grass so the mound never re-grows grass.
      if (this.m_degrass) this.m_degrass[dx] = 1;
    }

    this.preBlast(x - nRadius, x + nRadius);
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

    // The irradiated ground turns to bare DIRT (grass stripped) so the fallout
    // reads as radiated earth, not green grass with a red tint over it.
    if (this.m_degrass) {
      const gx0 = Math.max(0, Math.floor(x - nRadius)),
        gx1 = Math.min(this.m_nWidth - 1, Math.floor(x + nRadius));
      for (let col = gx0; col <= gx1; col++) this.m_degrass[col] = 1;
      this.m_terrainDirty = true;
    }

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
    if (this.m_radDeposit && this.m_arrHeights && this.m_baseHeights) {
      const FILL = 0.2; // fraction of the crater refilled by fallout
      const px0 = Math.max(0, Math.floor(x - nRadius)),
        px1 = Math.min(this.m_nWidth - 1, Math.floor(x + nRadius));
      for (let col = px0; col <= px1; col++) {
        const craterDepth = this.m_arrHeights[col] - this.m_baseHeights[col]; // >0 inside the crater
        if (craterDepth <= 2) continue; // only where the ground was actually cratered
        const target = craterDepth * FILL;
        const add = target - this.m_radDeposit[col]; // only the new contribution
        if (add > 0) {
          this.m_radDeposit[col] = target;
          this.m_arrHeights[col] = Math.max(this.m_baseHeights[col], this.m_arrHeights[col] - add); // raise
        }
      }
      this.preBlast(px0, px1);
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

  /**
   * One erosion pass over [x0,x1]: where two adjacent columns differ by more
   * than the angle of repose, move 1px of dirt from the taller column to the
   * lower one. Repeated,
   * this melts the thin spikes debris stacks up into smooth mounds.
   */
  private slump(x0: number, x1: number): void {
    const h = this.m_arrHeights;
    if (!h) return;
    const THRESH = 6; // adjacent columns may differ by up to this before dirt slides
    const a = Math.max(1, Math.floor(x0)),
      b = Math.min(this.m_nWidth - 2, Math.floor(x1));
    for (let x = a; x <= b; x++) {
      const diff = h[x + 1] - h[x]; // >0: column x is TALLER (smaller screen-Y)
      if (diff >= THRESH) {
        h[x]++;
        h[x + 1]--;
      } else if (diff <= -THRESH) {
        h[x]--;
        h[x + 1]++;
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
      const p: LandParticle = pool.pop() ?? {x: 0, y: 0, vx: 0, vy: 0, color: '', size: 0, spin: 0};
      p.x = x + (Math.random() * 2 - 1) * radius;
      p.y = y + (Math.random() * 2 - 1) * radius * 0.4;
      p.vx = Math.cos(ang) * speed;
      p.vy = Math.sin(ang) * speed * 0.7 - up; // varied up-and-out, scaled to the blast
      p.color = this.dirtColor(v);
      p.size = Math.random() < 0.82 ? 1 : 2; // mostly 1px → many fine chunks
      p.spin = 0;
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
      const p: LandParticle = pool.pop() ?? {x: 0, y: 0, vx: 0, vy: 0, color: '', size: 0, spin: 0};
      p.x = x + (Math.random() * 2 - 1) * spread;
      p.y = y + (Math.random() * 2 - 1) * spread * 0.5;
      p.vx = (Math.random() * 2 - 1) * 22; // slight sideways drift
      p.vy = Math.random() * 34; // starts falling — no upward launch
      p.color = color ?? this.dirtColor(v); // caller can match the surface cap
      p.size = Math.random() < 0.82 ? 1 : 2;
      p.spin = 0;
      this.m_particles.push(p);
    }
  }

  /**
   * Blacken the terrain around a blast — a permanent scorch mark baked into the
   * cached bitmap (a rim-darken + black crater interior). Stored so it
   * survives terrain re-renders; painted `source-atop` so only ground is darkened.
   */
  scorch(x: number, y: number, radius: number): void {
    this.m_scorches.push({x, y, r: Math.max(8, radius * 1.05)});
    if (this.m_scorches.length > 80) this.m_scorches.shift(); // cap for perf
    this.m_terrainDirty = true;
  }

  update(dt: number): void {
    const GRAVITY = 500;

    this.stepCollapse(dt); // advance any gravity beam-slice collapse

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

      const col = Math.floor(p.x);
      if (col < 0 || col >= this.m_nWidth) {
        this.m_particlePool.push(p);
        continue;
      } // left the field → recycle

      // A chunk settles when it reaches the surface (only on the way down) and
      // deposits — raising a column by 1px. The landing column is jittered ±2
      // so chunks spread instead of stacking into a thin spike.
      if (p.vy > 0 && p.y >= this.getHeightAt(col) && this.m_arrHeights) {
        const dcol = Math.min(this.m_nWidth - 1, Math.max(0, col + ((Math.random() * 5) | 0) - 2));
        this.m_arrHeights[dcol] = Math.max(0, this.m_arrHeights[dcol] - 1);
        if (this.m_baseHeights)
          this.m_baseHeights[dcol] = Math.min(this.m_baseHeights[dcol], this.m_arrHeights[dcol]);
        // Deposited dirt is bare EARTH — de-grass the column so a settled ejecta mound
        // never re-grows the grass cap. But ONLY where it CONNECTS to already-bared
        // ground (the crater and its growing rim mound): a lone chunk flung far out and
        // settling on virgin grass must not bare a single isolated column, since
        // renderTerrainBitmap bakes a 1px dirt bar per de-grassed column — scattered
        // singletons read as ugly vertical stripes speckled across the whole map.
        // Requiring a de-grassed neighbour keeps the bare zone one contiguous run that
        // grows outward from the blast. (m_degrass is a Uint8Array → OOB reads are
        // undefined/falsy, so the edge columns need no bounds guard.)
        if (this.m_degrass && (this.m_degrass[dcol - 1] || this.m_degrass[dcol + 1])) {
          this.m_degrass[dcol] = 1;
        }
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
    if (this.m_radParticles.length && this.m_radDeposit && this.m_heat.length < 90) {
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
          if (col < 0 || col >= this.m_nWidth || this.m_radDeposit[col] <= 0) continue;
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
    if (!this.m_radDeposit) return 0;
    const ix = Math.floor(x);
    if (ix < 0 || ix >= this.m_nWidth) return 0;
    return this.m_radDeposit[ix];
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
    this.m_barePattern = null;
    this.m_patterns = [];
    this.m_terrainDirty = true;
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

  /** Trace the top-surface polyline (left → right), shifted down by `offset`. */
  private traceSurface(g: CanvasRenderingContext2D, offset = 0): void {
    g.moveTo(0, this.m_arrHeights![0] + offset);
    for (let x = 1; x < this.m_nWidth; x++) g.lineTo(x, this.m_arrHeights![x] + offset);
  }

  /** Re-render the destructible terrain into the cached bitmap (on change only). */
  private renderTerrainBitmap(): void {
    const g = this.ensureTerrainCtx();
    const W = this.m_nWidth,
      H = this.m_nHeight;
    const heights = this.m_arrHeights!;
    g.clearRect(0, 0, W, H);

    if (this.m_patterns.length !== this.m_layers.length) {
      this.m_patterns = this.m_layers.map(l => g.createPattern(l.image, 'repeat'));
    }

    // Fill each layer's region directly (no clip → no anti-aliased white halo).
    // Paths run from x=-2..W+2 so the left/right edges sit off-canvas, no seam.
    // Deepest first = whole silhouette; shallower layers overwrite the top band.
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

    // (The excavated hollow ABOVE the surface is background sky and is left
    // untouched — the fallout instead RAISES the ground as real terrain, below.)

    // Thin dark edge along the surface — hides any seam.
    g.beginPath();
    this.traceSurface(g, 0);
    g.strokeStyle = 'rgba(22, 38, 12, 0.5)';
    g.lineWidth = 1.5;
    g.lineJoin = 'round';
    g.stroke();

    // De-grassed columns: the blast tore off the green cap → paint bare EARTH over
    // it so craters read as exposed dirt, not grass.
    // Uses a guaranteed non-grass texture (m_barePattern), so it never repaints
    // grass on landscapes whose second layer is itself a grass tile.
    if (this.m_degrass && this.m_layers.length > 1) {
      const grassDepth = (this.m_layers[0]?.depth ?? 10) + 10;
      if (!this.m_barePattern && this.m_bareImage) {
        this.m_barePattern = g.createPattern(this.m_bareImage, 'repeat');
      }
      const dirtPat = this.m_barePattern ?? this.m_patterns[this.m_patterns.length - 1];
      const dep = this.m_radDeposit;
      // The de-grass band extends down through the raised fallout deposit (dep[x])
      // so the whole irradiated mound is baked EARTH — this is the terrain that
      // remains once the red emissive glow fades. dep[x]=0 off the crater.
      const bandDepth = (x: number) => grassDepth + (dep ? Math.round(dep[x]) : 0);
      if (dirtPat) {
        g.fillStyle = dirtPat;
        for (let x = 0; x < W; x++) {
          if (this.m_degrass[x]) g.fillRect(x, heights[x] - 2, 1, bandDepth(x));
        }
        // No darkening — the crater exposes the BRIGHT ldirt1 wall texture
        // (not the black path). A subtle warm ADDITIVE lift nudges it toward
        // a rust-brown instead of a muddy dark.
        const prevLift = g.globalCompositeOperation;
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = 'rgba(48,26,9,0.18)';
        for (let x = 0; x < W; x++) {
          if (this.m_degrass[x]) g.fillRect(x, heights[x] - 2, 1, bandDepth(x));
        }
        g.globalCompositeOperation = prevLift;
      }
    }

    // Permanent scorch — `source-atop` darkens only existing terrain pixels so it
    // hugs the surface. Kept SUBTLE + warm (a hint of burn at the very centre) so the
    // crater stays the bright rust dirt, not a dark muddy hole.
    if (this.m_scorches.length) {
      g.save();
      g.globalCompositeOperation = 'source-atop';
      for (const s of this.m_scorches) {
        const grad = g.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
        grad.addColorStop(0, 'rgba(26,13,5,0.4)');
        grad.addColorStop(0.5, 'rgba(34,18,8,0.18)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }

    this.m_terrainDirty = false;
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
      this.m_slumpTimer > 0 ||
      this.m_collapseActive ||
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
    return this.m_collapseActive || this.m_particles.length > 0;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.m_arrHeights) return;
    const W = this.m_nWidth,
      H = this.m_nHeight;

    if (this.m_layers.length > 0) {
      if (this.m_terrainDirty) this.renderTerrainBitmap();
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
    if (this.m_radParticles.length && this.m_arrHeights && this.m_radDeposit) {
      const dep = this.m_radDeposit;
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
  private m_scorches: Scorch[] = [];
  private m_degrass: Uint8Array | null = null; // per-column: 1 = grass torn off by a blast
  private m_radDeposit: Float32Array | null = null; // per-column: accumulated fallout PILE height (px above surface)
  // Terrain-slump erosion, scoped to the recently-disturbed span for a short window.
  private m_slumpTimer: number = 0;
  private m_slumpX0: number = 1e9;
  private m_slumpX1: number = 0;

  // Layered textures + cached destructible-terrain bitmap.
  private m_layers: {image: CanvasImageSource; depth: number}[] = [];
  private m_patterns: (CanvasPattern | null)[] = [];
  private m_bareImage: CanvasImageSource | null = null; // non-grass earth for de-grassed craters
  private m_barePattern: CanvasPattern | null = null;

  // Beam-slice gravity collapse: per-column fall target (screen-Y; -1 = idle) + velocity.
  private m_collapseTarget: Float32Array | null = null;
  private m_collapseVel: Float32Array | null = null;
  private m_collapseActive = false;
  private m_collapseMinX = 0;
  private m_collapseMaxX = 0;
  private m_terrainCanvas: HTMLCanvasElement | null = null;
  private m_terrainDirty: boolean = true;

  get width(): number {
    return this.m_nWidth;
  }

  get height(): number {
    return this.m_nHeight;
  }
}
