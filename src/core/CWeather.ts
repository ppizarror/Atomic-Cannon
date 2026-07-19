/**
 * CWeather — ambient precipitation and blowing-sand effects tied to the map.
 *
 * Each landscape can declare one or more weather bands (snow, rain, hail, dust)
 * with an intensity 0..100. This system keeps a persistent, screen-filling field
 * of particles per band that wraps toroidally, so the effect is continuous and
 * cheap (no per-frame spawn/expire churn). Motion couples to the same wind vector
 * that pushes smoke and shots, so the whole scene reads as one weather system.
 *
 * Layering: snow / rain / hail are FOREGROUND (drawn over terrain and tanks);
 * dust is BACKGROUND haze (drawn between the backdrop and the terrain) so it
 * reads as sand blowing across the distance and is naturally occluded by hills.
 */

import type { Vec2 } from '../math/Vec2';

export type WeatherType = 'snow' | 'rain' | 'hail' | 'dust';
export interface WeatherSpec { type: string; intensity: number }

/** Per-band tuning. Densities are particle counts at intensity 100 over the
 * reference area below; the actual count scales with intensity and canvas area. */
const REF_AREA = 1280 * 720;

// Weather draws as small crisp dots (like the original), NOT soft gradient blobs.
// `size` is the dot radius in px — kept tiny so the field reads as flecks, not smudges.
const TUNING = {
  // Small slow flakes that sway side to side and drift on the wind.
  snow: { density: 240, fall: 45, fallVar: 28, sway: 16, swayFreq: 1.6, wind: 15, sizeMin: 0.9, sizeMax: 2.0, alphaMin: 0.6, alphaMax: 1.0, background: false, cap: 900 },
  // Fast near-vertical streaks that slant hard with the wind.
  rain: { density: 300, fall: 780, fallVar: 240, sway: 0, swayFreq: 0, wind: 34, sizeMin: 0.7, sizeMax: 1.3, alphaMin: 0.2, alphaMax: 0.45, background: false, cap: 1100 },
  // Heavy pellets: fast, mostly vertical, only lightly pushed by wind, with a tiny flutter.
  hail: { density: 150, fall: 560, fallVar: 170, sway: 6, swayFreq: 8, wind: 12, sizeMin: 0.9, sizeMax: 1.7, alphaMin: 0.8, alphaMax: 1.0, background: false, cap: 700 },
  // Blowing sand: tiny specks that barely fall, bob gently, and are carried mostly
  // horizontally by the wind across the distance.
  dust: { density: 260, fall: 0, fallVar: 0, sway: 10, swayFreq: 0.55, wind: 36, sizeMin: 0.7, sizeMax: 1.6, alphaMin: 0.22, alphaMax: 0.5, background: true, cap: 900 },
} as const;

type Tuning = typeof TUNING[WeatherType];

interface WParticle {
  x: number; y: number;
  size: number;
  seed: number;     // phase offset for the sway / bob oscillator
  speedMul: number; // per-particle fall-speed variation
  drift: number;    // ambient horizontal drift (keeps dust alive at zero wind)
  alpha: number;    // depth cue — nearer particles brighter
}

interface Layer {
  type: WeatherType;
  t: Tuning;
  particles: WParticle[];
}

const TWO_PI = Math.PI * 2;
const rnd = () => Math.random();
const between = (a: number, b: number) => a + (b - a) * rnd();

export class CWeather {
  private m_layers: Layer[] = [];
  private m_w = 0;
  private m_h = 0;
  private m_t = 0;                 // seconds accumulator for the oscillators
  private m_margin = 24;

  constructor(width = 0, height = 0) {
    this.m_w = width;
    this.m_h = height;
  }

  /** Keep the field sized to the render surface. Re-seeds counts if it changed. */
  setBounds(width: number, height: number): void {
    if (width === this.m_w && height === this.m_h) return;
    this.m_w = width;
    this.m_h = height;
    for (const layer of this.m_layers) this.resize(layer);
  }

  /** Whether any weather band is currently active. */
  isActive(): boolean {
    return this.m_layers.length > 0;
  }

  /**
   * Set the active weather from a map's declared bands. Rebuilds the particle
   * fields; unknown types are ignored, intensity 0 is dropped.
   */
  configure(specs: readonly WeatherSpec[] | undefined): void {
    this.m_layers = [];
    if (!specs) return;
    for (const s of specs) {
      const type = s.type as WeatherType;
      if (!(type in TUNING) || s.intensity <= 0) continue;
      const layer: Layer = { type, t: TUNING[type], particles: [] };
      this.resize(layer, s.intensity);
      this.m_layers.push(layer);
    }
  }

  /** (Re)allocate a layer's particle field for the current bounds + intensity. */
  private resize(layer: Layer, intensity?: number): void {
    // Remember the intensity across pure-bounds resizes.
    if (intensity !== undefined) (layer as { intensity?: number }).intensity = intensity;
    const it = (layer as { intensity?: number }).intensity ?? 0;
    if (this.m_w <= 0 || this.m_h <= 0) { layer.particles.length = 0; return; }

    const area = this.m_w * this.m_h;
    const want = Math.min(
      layer.t.cap,
      Math.round(layer.t.density * (it / 100) * (area / REF_AREA)),
    );
    const ps = layer.particles;
    while (ps.length < want) ps.push(this.spawn(layer.t, true));
    if (ps.length > want) ps.length = want;
  }

  /** Make one particle. `anywhere` spreads it across the whole field (initial
   * seeding); otherwise it enters just above the top edge (recycled flake). */
  private spawn(t: Tuning, anywhere: boolean): WParticle {
    return {
      x: between(-this.m_margin, this.m_w + this.m_margin),
      y: anywhere ? between(-this.m_margin, this.m_h + this.m_margin) : -this.m_margin,
      size: between(t.sizeMin, t.sizeMax),
      seed: rnd() * TWO_PI,
      speedMul: between(0.75, 1.25),
      drift: between(-18, 18),
      alpha: between(t.alphaMin, t.alphaMax),
    };
  }

  /**
   * Advance the field. `wind` is the game's ±5 drift vector; its X component
   * slants rain, carries snow, and blows the dust haze along.
   */
  update(dt: number, wind?: Vec2): void {
    if (dt <= 0 || this.m_layers.length === 0) return;
    this.m_t += dt;
    const windX = wind ? wind.x : 0;
    this.m_windX = windX;   // remembered so rain streaks can slant to match
    const t = this.m_t;
    const W = this.m_w, H = this.m_h, m = this.m_margin;

    for (const layer of this.m_layers) {
      const tune = layer.t;
      const windDx = windX * tune.wind;
      for (const p of layer.particles) {
        // Horizontal: wind + type-specific sway/flutter (+ ambient drift for dust).
        const sway = tune.sway ? Math.sin(t * tune.swayFreq + p.seed) * tune.sway : 0;
        const vx = windDx + sway + (tune.background ? p.drift : 0);
        // Vertical: fall speed (dust barely falls — it bobs on the oscillator instead).
        const vy = tune.background
          ? Math.sin(t * tune.swayFreq + p.seed * 1.7) * tune.fallVar + Math.cos(t * 0.3 + p.seed) * tune.sway
          : (tune.fall + p.size * 6) * p.speedMul + Math.sin(t * 2 + p.seed) * tune.fallVar * 0.15;

        p.x += vx * dt;
        p.y += vy * dt;

        // Toroidal wrap on X (all types drift sideways).
        if (p.x < -m) p.x += W + 2 * m;
        else if (p.x > W + m) p.x -= W + 2 * m;

        if (tune.background) {
          // Dust hovers: wrap Y toroidally too so the haze band stays filled.
          if (p.y < -m) p.y += H + 2 * m;
          else if (p.y > H + m) p.y -= H + 2 * m;
        } else if (p.y > H + m) {
          // Falling types recycle to the top with a fresh column so the pattern
          // never visibly repeats.
          p.y = -m;
          p.x = between(-m, W + m);
        }
      }
    }
  }

  /** Background weather (blowing sand). Draw AFTER the backdrop, BEFORE terrain. */
  drawBackground(ctx: CanvasRenderingContext2D): void {
    for (const layer of this.m_layers) if (layer.t.background) this.drawLayer(ctx, layer);
  }

  /** Foreground weather (snow / rain / hail). Draw over terrain, tanks and FX. */
  drawForeground(ctx: CanvasRenderingContext2D): void {
    for (const layer of this.m_layers) if (!layer.t.background) this.drawLayer(ctx, layer);
  }

  private drawLayer(ctx: CanvasRenderingContext2D, layer: Layer): void {
    switch (layer.type) {
      case 'snow': this.drawSnow(ctx, layer); break;
      case 'rain': this.drawRain(ctx, layer); break;
      case 'hail': this.drawHail(ctx, layer); break;
      case 'dust': this.drawDust(ctx, layer); break;
    }
  }

  // All precipitation renders as small crisp dots — flecks, not soft blobs.
  private drawDots(ctx: CanvasRenderingContext2D, layer: Layer, color: string): void {
    ctx.fillStyle = color;
    for (const p of layer.particles) {
      ctx.globalAlpha = p.alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.6, p.size), 0, TWO_PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawSnow(ctx: CanvasRenderingContext2D, layer: Layer): void {
    this.drawDots(ctx, layer, '#ffffff');
  }

  private drawHail(ctx: CanvasRenderingContext2D, layer: Layer): void {
    this.drawDots(ctx, layer, '#eef4ff');
  }

  private drawDust(ctx: CanvasRenderingContext2D, layer: Layer): void {
    this.drawDots(ctx, layer, '#c8ad82');
  }

  private drawRain(ctx: CanvasRenderingContext2D, layer: Layer): void {
    // Draw each drop as a short streak along its motion so it slants with the wind.
    const windX = this.m_lastWindX(layer);
    const vy = layer.t.fall;
    ctx.strokeStyle = 'rgba(178,202,228,1)';
    ctx.lineCap = 'round';
    for (const p of layer.particles) {
      const len = 0.02 + p.size * 0.006;   // faster/bigger drops streak longer
      ctx.globalAlpha = p.alpha;
      ctx.lineWidth = p.size;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - windX * len, p.y - vy * len);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // The last frame's wind X (remembered by update()); rain streaks slant to match.
  private m_windX = 0;
  private m_lastWindX(layer: Layer): number { return this.m_windX * layer.t.wind; }
}
