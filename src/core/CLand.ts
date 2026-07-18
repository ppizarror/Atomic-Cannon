/**
 * CLand - Terrain Management Class
 */

import { Vec2 } from '../math/Vec2';

// ============================================================================
// INTERFACES & TYPES
// ============================================================================

interface LandParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface RadParticle {
  x: number;
  y: number;
  radius: number;
  damagePerSecond: number;
  timeRemaining: number;
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
  }
  
  initFromArray(heights: Int16Array, scaleX: number = 1, scaleY: number = 1): void {
    const len = Math.min(heights.length, this.m_nWidth);
    
    for (let x = 0; x < len; x++) {
      const scaledHeight = heights[x] * scaleY;
      this.m_arrHeights[x] = Math.max(0, Math.min(this.m_nHeight, Math.floor(scaledHeight)));
    }
    
    this.computeDirtyRegion();
  }

  // --- RNG: classic MSVC LCG, so a level is reproducible from its seed --------
  private m_rngState: number = 1;

  private srand(seed: number): void {
    this.m_rngState = seed >>> 0;
  }

  /** rand() in 0..32767 (MSVC: state = state*0x343FD + 0x269EC3; (state>>16)&0x7FFF). */
  private rand(): number {
    this.m_rngState = (Math.imul(this.m_rngState, 0x343FD) + 0x269EC3) >>> 0;
    return (this.m_rngState >>> 16) & 0x7FFF;
  }

  /** Uniform [0,1). */
  private rand01(): number {
    return this.rand() / 32767;
  }

  /**
   * Generate terrain the way the original does: pick a shape mode (0..5) then
   * fill a seeded biased random walk. Mode 5 config = "random": 50% mode 5,
   * else one of 0..4. All modes share one RNG stream seeded here.
   */
  generateRandomTerrain(seed: number = Date.now()): void {
    this.srand(seed >>> 0);
    let mode: number;
    if ((this.rand() & 1) === 0) {
      mode = 5;                       // 50%: fully-random / mountainous
    } else {
      mode = this.rand() % 5;         // 50%: one of 0..4
    }
    this.generateProfile(mode);
  }

  /** Force a specific shape mode (0..5) with a given seed. */
  generateTerrainMode(mode: number, seed: number = Date.now()): void {
    this.srand(seed >>> 0);
    this.generateProfile(mode);
  }

  // The 6 shape modes (FUN_004a4970). Screen-Y: smaller = higher on screen, so
  // Ymin is the highest peaks can reach, Ymax the lowest valleys.
  private generateProfile(mode: number): void {
    const W = this.m_nWidth;
    const A = 15;                                   // walk amplitude (obj +0x4c)
    const Ymin = Math.floor(this.m_nHeight * 0.30); // top clamp
    const Ymax = Math.floor(this.m_nHeight * 0.82); // bottom clamp
    const clamp = (v: number) => Math.min(Math.max(v, Ymin), Ymax);

    if (mode === 0) {
      // Flat + uncorrelated ±15 noise (jagged plateau).
      this.rand();                                  // one throwaway draw
      const base = Math.floor((Ymin + Ymax) / 2);
      for (let x = 0; x < W; x++) {
        let y = base + (this.rand() % 30) - 15;
        if (y < Ymin) y = Ymin;
        else if (y >= Ymax) y = Ymax - 1;
        this.m_arrHeights[x] = y;
      }
      this.computeDirtyRegion();
      return;
    }

    // Modes 1..5: biased random walk, four quarters each with a (lo,hi) drift.
    let start: number;
    const win: [number, number][] = [[-A, A], [-A, A], [-A, A], [-A, A]];

    switch (mode) {
      case 1:                                       // hill / mound
        start = Ymax;
        win[0] = [-7, 7]; win[1] = [-3, 1]; win[2] = [0, 4]; win[3] = [-7, 7];
        break;
      case 2:                                       // valley / basin
        start = Ymin;
        win[0] = [-7, 7]; win[1] = [-1, 6]; win[2] = [-5, 2]; win[3] = [-7, 7];
        break;
      case 3: {                                     // ramp / cliff
        const coin = this.rand() & 1;
        start = coin ? Ymax : Ymin;
        const q3: [number, number] = start === Ymin ? [0, 10] : [-10, 0];
        win[0] = [-7, 7]; win[1] = [-7, 7]; win[2] = q3; win[3] = [-7, 7];
        break;
      }
      case 4: {                                     // planar linear slope + jitter
        const coin = this.rand() & 1;
        start = coin ? Ymax : Ymin;
        const s = (coin ? -1 : 1) * (Ymax - Ymin) / W;
        const j = 2;
        for (let q = 0; q < 4; q++) win[q] = [s - j, s + j];
        break;
      }
      case 5:                                       // rough / mountainous
      default:
        start = Ymin + (Ymax - Ymin) * this.rand01();
        break;                                      // windows already ±A
    }

    const q1 = W >> 2, q2 = W >> 1, q3 = (3 * W) >> 2;
    let prev = start;
    this.m_arrHeights[0] = Math.round(clamp(start));
    for (let x = 1; x < W; x++) {
      const q = x < q1 ? 0 : x < q2 ? 1 : x < q3 ? 2 : 3;
      const [lo, hi] = win[q];
      prev = clamp(prev + this.rand01() * (hi - lo) + lo);
      this.m_arrHeights[x] = Math.round(prev);
    }

    this.computeDirtyRegion();
  }

  // ========================================================================
  // TERRAIN DEFORMATION
  // =====================================================================
  
  blastCircle(x: number, y: number, nRadius: number): void {
    if (!this.m_arrHeights) return;
    
    const startX = Math.max(0, x - nRadius);
    const endX = Math.min(this.m_nWidth - 1, x + nRadius);
    
    // Heightmap approximation of the original's destructible-bitmap crater:
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
    }

    this.preBlast(x - nRadius, x + nRadius);
  }

  private preBlast(nX1: number, nX2: number): void {
    this.m_dirtyMin = Math.max(0, nX1);
    this.m_dirtyMax = Math.min(this.m_nWidth - 1, nX2);
  }
  
  getDirtyRegion(): { min: number; max: number } {
    return { min: this.m_dirtyMin, max: this.m_dirtyMax };
  }

  private computeDirtyRegion(): void {
    this.m_dirtyMin = 0;
    this.m_dirtyMax = this.m_nWidth - 1;
  }

  blastEllipse(x: number, y: number, nRadiusX: number, nRadiusY: number): void {
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

  blastIradiate(
    x: number,
    y: number,
    nRadius: number,
    fDamagePerSecond: number,
    fDurationSeconds: number
  ): void {
    const radParticle: RadParticle = {
      x, y,
      radius: nRadius,
      damagePerSecond: fDamagePerSecond,
      timeRemaining: fDurationSeconds,
      r: 255,
      g: 128,
      b: 0
    };
    
    this.m_radParticles.push(radParticle);
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

  addShowerParticles(x: number, y: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const p: LandParticle = {
        x,
        y,
        vx: (Math.random() - 0.5) * 100,
        vy: -(Math.random() * 150 + 50)
      };
      this.m_particles.push(p);
    }
  }

  update(dt: number): void {
    const GRAVITY = 500;
    
    for (let i = this.m_particles.length - 1; i >= 0; i--) {
      const p = this.m_particles[i];
      
      p.vy += GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      
      const terrainY = this.getHeightAt(Math.floor(p.x));
      
      if (p.y >= terrainY) {
        this.m_particles.splice(i, 1);
        this.blastCircle(Math.floor(p.x), Math.floor(terrainY), 3);
      }
    }
    
    for (let i = this.m_radParticles.length - 1; i >= 0; i--) {
      const r = this.m_radParticles[i];
      r.timeRemaining -= dt;
      
      if (r.timeRemaining <= 0) {
        this.m_radParticles.splice(i, 1);
      }
    }
  }

  getRadiationZones(): RadParticle[] {
    return this.m_radParticles.filter(r => r.timeRemaining > 0);
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
    const dy = this.m_arrHeights[Math.min(x + 1, this.m_nWidth - 1)] - 
               this.m_arrHeights[Math.max(x - 1, 0)];
    
    const len = Math.sqrt(dx * dx + dy * dy);
    
    return new Vec2(-dy / len, -dx / len).normalize();
  }

  // ========================================================================
  // RENDERING
  // =====================================================================
  
  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.m_arrHeights) return;
    
    const WIDTH = this.m_nWidth;
    const HEIGHT = this.m_nHeight;
    
    for (let x = 0; x < WIDTH - 1; x++) {
      const yTop = this.m_arrHeights[x];
      
      if (yTop >= HEIGHT) continue;
      
      const gradient = ctx.createLinearGradient(0, yTop, 0, HEIGHT);
      gradient.addColorStop(0, '#4a7c23');
      gradient.addColorStop(0.1, '#3d6b1e');
      gradient.addColorStop(0.15, '#8B4513');
      gradient.addColorStop(1, '#654321');
      
      ctx.fillStyle = gradient;
      ctx.fillRect(x, yTop, 1, HEIGHT - yTop);
    }
    
    ctx.strokeStyle = '#2d5016';
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    let started = false;
    for (let x = 0; x < WIDTH; x++) {
      const y = this.m_arrHeights[x];
      
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    
    ctx.stroke();
    
    for (const r of this.m_radParticles) {
      const alpha = Math.min(0.4, r.timeRemaining / 5);
      
      ctx.fillStyle = `rgba(${r.r}, ${r.g}, ${r.b}, ${alpha})`;
      ctx.beginPath();
      ctx.arc(r.x, r.y - r.radius/2, r.radius, Math.PI, 0);
      ctx.fill();
    }
    
    for (const p of this.m_particles) {
      const terrainY = this.getHeightAt(Math.floor(p.x));
      
      if (p.y < terrainY) {
        ctx.fillStyle = '#8B4513';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ========================================================================
  // MEMBER VARIABLES
  // =====================================================================
  
  private m_nWidth: number = 800;
  private m_nHeight: number = 600;
  private m_arrHeights: Int16Array | null = null;
  
  private m_dirtyMin: number = -1;
  private m_dirtyMax: number = -1;
  
  private m_particles: LandParticle[] = [];
  private m_radParticles: RadParticle[] = [];

  get width(): number { return this.m_nWidth; }
  get height(): number { return this.m_nHeight; }
}
