/**
 * CWeather — ambient precipitation and blowing-sand effects tied to the map.
 *
 * Each landscape can declare one or more weather bands (snow, rain, hail, dust)
 * with an intensity 0..100. This system keeps a persistent, screen-filling field
 * of particles per band that wraps toroidally, so the effect is continuous and
 * cheap (no per-frame spawn/expire churn). Motion couples to the same wind vector
 * that pushes smoke and shots, so the whole scene reads as one weather system.
 *
 * Layering: ALL weather is drawn BEHIND the terrain (between the backdrop and the
 * ground), so precipitation only shows against the sky and is naturally occluded
 * by hills. The per-band `hover` flag selects MOTION only: dust hovers and drifts
 * sideways; snow / rain / hail fall.
 */

import type {Vec2} from '../math/Vec2';
import {TWO_PI} from '../math/num';
import {between} from '../math/random';
import {windProfile} from './wind';

export type WeatherType = 'snow' | 'rain' | 'hail' | 'dust';

export interface WeatherSpec {
  type: string;
  intensity: number;
}

// Weather draws as small crisp dots, NOT soft gradient blobs.
// `size` is the dot radius in px — kept tiny so the field reads as flecks, not smudges.
const TUNING = {
  // Small slow flakes that sway side to side and drift on the wind.
  snow: {
    mult: 1.5,
    fall: 45,
    fallVar: 28,
    sway: 16,
    swayFreq: 1.6,
    wind: 15,
    sizeMin: 0.9,
    sizeMax: 2.0,
    alphaMin: 0.6,
    alphaMax: 1.0,
    hover: false,
    cap: 1200,
  },
  // Fast near-vertical streaks that slant hard with the wind.
  rain: {
    mult: 1.0,
    fall: 780,
    fallVar: 240,
    sway: 0,
    swayFreq: 0,
    wind: 34,
    sizeMin: 0.7,
    sizeMax: 1.3,
    alphaMin: 0.2,
    alphaMax: 0.45,
    hover: false,
    cap: 900,
  },
  // Heavy pellets: fast, mostly vertical, only lightly pushed by wind, with a tiny flutter.
  hail: {
    mult: 1.0,
    fall: 560,
    fallVar: 170,
    sway: 6,
    swayFreq: 8,
    wind: 12,
    sizeMin: 0.9,
    sizeMax: 1.7,
    alphaMin: 0.8,
    alphaMax: 1.0,
    hover: false,
    cap: 900,
  },
  // Blowing sand: tiny specks that barely fall, bob gently, and are carried mostly
  // horizontally by the wind across the distance. The thickest field of the four.
  dust: {
    mult: 3.0,
    fall: 0,
    fallVar: 0,
    sway: 10,
    swayFreq: 0.55,
    wind: 36,
    sizeMin: 0.7,
    sizeMax: 1.6,
    alphaMin: 0.22,
    alphaMax: 0.5,
    hover: true,
    cap: 1800,
  },
} as const;

type Tuning = (typeof TUNING)[WeatherType];

// The 5 sand tints cycled for dust specks (alpha-blended tan, not glow).
const DUST_TANS = ['#a37d3b', '#937137', '#896a33', '#7f642f', '#785f2d'];

/** Fixed field size: sqrt(screenArea) · K · 300 · typeMult, where
 * K = 1/900 above 800px wide, else 1/600. Independent of intensity. */
function computeCount(w: number, h: number, mult: number): number {
  if (w <= 0 || h <= 0) return 0;
  const K = w > 800 ? 1 / 900 : 1 / 600;
  return Math.floor(Math.sqrt(w * h) * K * 300 * mult);
}

interface WParticle {
  x: number;
  y: number;
  size: number;
  seed: number; // phase offset for the sway / bob oscillator
  speedMul: number; // per-particle fall-speed variation
  drift: number; // ambient horizontal drift (dust: a leftward "blowing" bias)
  alpha: number; // depth cue — nearer particles brighter
  ci: number; // dust tint index into DUST_TANS (ignored by other types)
}

interface Layer {
  type: WeatherType;
  t: Tuning;
  particles: WParticle[];
}

export class CWeather {
  private m_layers: Layer[] = [];
  private m_w = 0;
  private m_h = 0;
  private m_t = 0; // seconds accumulator for the oscillators
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
   * Set the active weather from a map's declared bands. `intensity` is a one-time
   * probability GATE (not a density scale): each band rolls `rand(0..99) <= intensity`
   * at map load and, if it passes, appears at a FIXED per-type density. Unknown types
   * and intensity ≤ 0 are dropped.
   *
   * Note: a parse-order quirk in the map data suppresses hail whenever snow is
   * declared first — and every hail map declares snow first, so hail would never
   * show. We honour the data's intent and let both appear.
   */
  configure(specs: readonly WeatherSpec[] | undefined): void {
    this.m_layers = [];
    if (!specs) return;
    for (const s of specs) {
      const type = s.type as WeatherType;
      if (!(type in TUNING) || s.intensity <= 0) continue;
      if (Math.floor(Math.random() * 100) > s.intensity) continue; // probability gate
      const layer: Layer = {type, t: TUNING[type], particles: []};
      this.resize(layer);
      this.m_layers.push(layer);
    }
  }

  /** (Re)allocate a layer's particle field for the current bounds. Count is a
   * fixed function of the screen size and the band's density multiplier. */
  private resize(layer: Layer): void {
    if (this.m_w <= 0 || this.m_h <= 0) {
      layer.particles.length = 0;
      return;
    }
    const want = Math.min(layer.t.cap, computeCount(this.m_w, this.m_h, layer.t.mult));
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
      seed: Math.random() * TWO_PI,
      speedMul: between(0.75, 1.25),
      // Dust seeds a leftward "blowing" bias so it drifts even in calm air;
      // falling types get a small symmetric jitter (unused by them).
      drift: t.hover ? between(-55, -20) : between(-18, 18),
      alpha: between(t.alphaMin, t.alphaMax),
      ci: Math.floor(Math.random() * DUST_TANS.length),
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
    this.m_windX = windX; // remembered so rain streaks can slant to match
    const t = this.m_t;
    const W = this.m_w,
      H = this.m_h,
      m = this.m_margin;

    for (const layer of this.m_layers) {
      const tune = layer.t;
      const windDx = windX * tune.wind;
      for (const p of layer.particles) {
        // Horizontal: wind + type-specific sway/flutter (+ ambient drift for dust).
        // The shared wind profile (core/wind.ts) attenuates the wind term near the ground in
        // Realistic mode (0 at the field bottom → full aloft); in Linear mode it's a constant 1.
        const wf = windProfile(H - p.y);
        const sway = tune.sway ? Math.sin(t * tune.swayFreq + p.seed) * tune.sway : 0;
        const vx = windDx * wf + sway + (tune.hover ? p.drift : 0);
        // Vertical: fall speed (dust barely falls — it bobs on the oscillator instead).
        const vy = tune.hover
          ? Math.sin(t * tune.swayFreq + p.seed * 1.7) * tune.fallVar +
            Math.cos(t * 0.3 + p.seed) * tune.sway
          : (tune.fall + p.size * 6) * p.speedMul + Math.sin(t * 2 + p.seed) * tune.fallVar * 0.15;

        p.x += vx * dt;
        p.y += vy * dt;

        // Toroidal wrap on X (all types drift sideways).
        if (p.x < -m) p.x += W + 2 * m;
        else if (p.x > W + m) p.x -= W + 2 * m;

        if (tune.hover) {
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

  /** Draw all weather. Called BEHIND the terrain (between backdrop and ground) so
   * precipitation only shows against the sky and is occluded by hills. */
  draw(ctx: CanvasRenderingContext2D): void {
    for (const layer of this.m_layers) this.drawLayer(ctx, layer);
  }

  private drawLayer(ctx: CanvasRenderingContext2D, layer: Layer): void {
    // Precipitation (snow / rain / hail) blits ADDITIVELY — the flecks GLOW against a dark storm sky
    // and wash out against a bright one, the way the original reads. Dust alone is alpha-blended:
    // its opaque tan grains are pigment, not light, so 'lighter' would make them vanish over sand.
    const additive = layer.type !== 'dust';
    if (additive) ctx.globalCompositeOperation = 'lighter';
    switch (layer.type) {
      case 'snow':
        this.drawSnow(ctx, layer);
        break;
      case 'rain':
        this.drawRain(ctx, layer);
        break;
      case 'hail':
        this.drawHail(ctx, layer);
        break;
      case 'dust':
        this.drawDust(ctx, layer);
        break;
    }
    if (additive) ctx.globalCompositeOperation = 'source-over'; // restore for the next layer / caller
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
    this.drawDots(ctx, layer, '#d6ffff'); // pale ice cyan
  }

  // Dust tints (alpha-blended tan) rather than glowing — each speck keeps the sand
  // colour it was seeded with, so the field reads as mixed grains of blowing sand.
  private drawDust(ctx: CanvasRenderingContext2D, layer: Layer): void {
    for (const p of layer.particles) {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = DUST_TANS[p.ci];
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.6, p.size), 0, TWO_PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawRain(ctx: CanvasRenderingContext2D, layer: Layer): void {
    // Draw each drop as a short streak along its motion so it slants with the wind.
    const windX = this.m_lastWindX(layer);
    const vy = layer.t.fall;
    ctx.strokeStyle = 'rgba(178,202,228,1)';
    ctx.lineCap = 'round';
    for (const p of layer.particles) {
      const len = 0.02 + p.size * 0.006; // faster/bigger drops streak longer
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

  private m_lastWindX(layer: Layer): number {
    return this.m_windX * layer.t.wind;
  }
}
