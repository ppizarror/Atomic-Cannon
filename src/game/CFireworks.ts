/**
 * CFireworks — the victory sky display, split out of CGameController.
 *
 * The legacy fires fireworks over the final standings when the human's team wins the war. This
 * owns the whole effect: the burst-shape bitmaps, the rising launch rockets, the sparks, their
 * physics and their draw. It is purely cosmetic — nothing here touches the simulation — which is
 * why it can live behind a small surface: the controller decides WHETHER the human won, and this
 * decides everything about what that looks like.
 *
 * The world it needs (camera, view width, ground height, wind, the boom sound) arrives per-frame
 * through {@link FireworksEnv} rather than a controller reference.
 */
import {plusMinus} from '../math/random';
import {windProfile} from '../core/wind';
import {tryCanvas2d} from '../util/canvas';

const FW = {
  /** Downward accel (px/s²) — the burst rains down (semi-implicit Euler, no drag). */
  GRAVITY: 95,
  /** Fraction of life at full alpha before the linear fade begins. */
  HOLD: 0.6,
  /** Gap between bursts ≈ uniform(min, max) seconds. */
  INTERVAL: [0.12, 2.4],
  /** Particle lifetime (s). */
  LIFE: 2.8,
  /** The 8 shape templates (`bursts/<name>.bmp`), loaded + sampled once into `burstPixels`. */
  NAMES: ['circle', 'ring', 'star1', 'star2', 'delta', 'pentagon', 'hexagon', 'octagon'],
  /** Launch trail (a deliberate embellishment over the legacy, which just pops the burst in): a
   *  rocket rises from the ground trailing sparks, then detonates into the burst. This is its rise
   *  speed (px/s). */
  ROCKET_SPEED: 320,
  /** Native bmp scale (no position multiplier). */
  SCALE: 1,
  /** Radial launch speed scale (px/s); per-spark speed = rand01 × this. */
  SPEED: 52,
  /** Launch-trail spark lifetime (s). */
  TRAIL_LIFE: 0.4,
} as const;

/** One burst/trail spark. */
interface Firework {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  age: number;
  life: number;
}

/** A rising launch rocket: climbs from `y` (the ground) to `targetY`, trailing sparks,
 *  then detonates into a burst. */
interface FwRocket {
  x: number;
  y: number;
  vy: number;
  targetY: number;
}

/** One sampled burst-shape pixel: its offset from the shape centre and its own colour. */
type BurstPoint = {dx: number; dy: number; color: string};

/** The slice of the world the display reads each frame. */
export interface FireworksEnv {
  /** World-X of the view's left edge, and the view width — bursts stay on screen. */
  camX: number;
  viewW: number;
  /** Terrain surface Y at a world X: the launch pad, and the floor sparks are culled against. */
  groundAt(x: number): number;
  /** Effective wind; the display uses 70% of it. */
  wind: {x: number; y: number};
  /** The burst boom (panned across the WORLD, so it takes a world X). */
  onBoom(worldX: number): void;
}

// Sampled lit pixels per burst shape, indexed like FW.NAMES; null until that bmp loads. Module
// scope (not per-instance): the bitmaps are immutable art shared by every match.
const burstPixels: (BurstPoint[] | null)[] = FW.NAMES.map(() => null);
let burstLoadStarted = false;

/** Load the 8 burst bmps once and sample their lit pixels (magenta keyed out) into `burstPixels`.
 *  Browser-only — headless callers simply never get any shapes, and the display no-ops. */
export function loadBurstPixels(): void {
  if (burstLoadStarted || typeof document === 'undefined') return;
  burstLoadStarted = true;
  FW.NAMES.forEach((name, idx) => {
    const img = new Image();
    img.onload = () => {
      const made = tryCanvas2d(img.width, img.height, {willReadFrequently: true});
      if (!made) return;
      made.ctx.drawImage(img, 0, 0);
      const {data} = made.ctx.getImageData(0, 0, img.width, img.height);
      const hw = img.width / 2,
        hh = img.height / 2;
      const pts: BurstPoint[] = [];
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const i = (y * img.width + x) * 4; // sample every lit pixel — many fine sparks
          const r = data[i],
            gg = data[i + 1],
            b = data[i + 2];
          if (r > 200 && gg < 80 && b > 200) continue; // magenta colour-key
          if (r + gg + b < 30) continue; // (near-)black background
          pts.push({dx: x - hw, dy: y - hh, color: `rgb(${r},${gg},${b})`});
        }
      }
      burstPixels[idx] = pts;
    };
    img.src = `/assets/bursts/${name}.bmp`;
  });
}

export class CFireworks {
  private m_sparks: Firework[] = [];
  private m_rockets: FwRocket[] = [];
  private m_timer = 0;
  private m_active = false;

  /** Arm (or disarm) the display. Arming warms the burst bitmaps and schedules the first launch
   *  shortly after the standings screen appears. */
  setActive(on: boolean): void {
    this.m_active = on;
    this.m_sparks = [];
    this.m_rockets = [];
    this.m_timer = 0.35;
    if (on) loadBurstPixels();
  }

  isActive(): boolean {
    return this.m_active;
  }

  /** Drop everything (a fresh battle / match reset). */
  clear(): void {
    this.m_sparks = [];
    this.m_rockets = [];
    this.m_active = false;
  }

  /** True while anything is still on screen — the render gate keeps repainting for this. */
  hasVisible(): boolean {
    return this.m_sparks.length > 0 || this.m_rockets.length > 0;
  }

  /** Launch a firework: pick a random sky target above the terrain and send a rocket up
   *  from the ground toward it (it detonates into the burst on arrival). */
  private launch(env: FireworksEnv): void {
    if (!burstPixels.some(Boolean)) {
      loadBurstPixels(); // shapes not sampled yet — kick off the load and skip this beat
      return;
    }
    const margin = 32 * FW.SCALE; // keep the whole 64px burst on screen
    const cx = env.camX + margin + Math.random() * Math.max(1, env.viewW - 2 * margin);
    const ground = env.groundAt(cx); // terrain surface — the launch pad
    const ceil = Math.max(24, ground - 24);
    const targetY = 14 + Math.random() * ceil * 0.5; // upper sky
    this.m_rockets.push({x: cx, y: ground, vy: -FW.ROCKET_SPEED, targetY});
  }

  /** Detonate a burst at (cx, cy): one spark per lit pixel of a random burst bmp, coloured
   *  by that pixel, flying radially out at a uniform-random speed (rand01 × scale). */
  private explode(cx: number, cy: number, env: FireworksEnv): void {
    const ready = burstPixels.filter((p): p is BurstPoint[] => !!p);
    if (!ready.length) return;
    const pts = ready[Math.floor(Math.random() * ready.length)];
    for (const p of pts) {
      const dist = Math.hypot(p.dx, p.dy) || 1;
      const sp = Math.random() * FW.SPEED; // uniform radial speed (rand01 × scale)
      this.m_sparks.push({
        x: cx + p.dx * FW.SCALE,
        y: cy + p.dy * FW.SCALE,
        vx: (p.dx / dist) * sp,
        vy: (p.dy / dist) * sp,
        color: p.color, // the bmp pixel's own colour
        age: 0,
        life: FW.LIFE * (0.8 + Math.random() * 0.4),
      });
    }
    env.onBoom(cx); // Slapthunder1/2.wav (the boom); pan spans the WORLD, so pass world-X
  }

  /** Tick the display: launch on the interval, rise the rockets (trailing sparks) until they
   *  detonate, then integrate every spark (gravity + wind drift ×0.7), dropping the expired /
   *  grounded / off-view. */
  update(dt: number, env: FireworksEnv): void {
    if (!this.m_active) return;
    this.m_timer -= dt;
    if (this.m_timer <= 0) {
      this.launch(env);
      this.m_timer = FW.INTERVAL[0] + Math.random() * (FW.INTERVAL[1] - FW.INTERVAL[0]);
    }
    const wx = env.wind.x * 0.7,
      wy = env.wind.y * 0.7;

    // Rockets: rise, trail a spark each frame, detonate on reaching the target.
    if (this.m_rockets.length) {
      const rising: FwRocket[] = [];
      for (const r of this.m_rockets) {
        r.y += r.vy * dt;
        r.x += wx * dt * 0.3; // slight wind lean
        this.m_sparks.push({
          x: r.x + plusMinus(1.5),
          y: r.y + Math.random() * 4, // just below the head
          vx: plusMinus(8),
          vy: plusMinus(8) + 6,
          color: 'rgb(255,226,150)', // warm launch spark
          age: 0,
          life: FW.TRAIL_LIFE * (0.6 + Math.random() * 0.6),
        });
        if (r.y <= r.targetY) this.explode(r.x, r.targetY, env);
        else rising.push(r);
      }
      this.m_rockets = rising;
    }

    // Burst + trail sparks: integrate, then cull. The shared wind profile (core/wind.ts)
    // eases the drift near the ground in Realistic mode (constant 1 in Linear), so low sparks
    // fall straighter while high bursts stream with the wind.
    if (this.m_sparks.length) {
      for (const p of this.m_sparks) {
        const wf = windProfile(env.groundAt(p.x) - p.y);
        p.age += dt;
        p.vx += wx * wf * dt;
        p.vy += (FW.GRAVITY + wy * wf) * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      this.m_sparks = this.m_sparks.filter(p => p.age < p.life && p.y < env.groundAt(p.x));
    }
  }

  /** Draw the sparks coloured by their burst pixel. Additive ('lighter') so they read as bright
   *  fireworks on any sky (the legacy screenshots show bright, glowing sparks — the raw disc
   *  primitive is nominally alpha-blended, but the particles render as flares). Alpha holds full
   *  for the first FW.HOLD of life, then falls linearly to 0. A brighter core over a soft glow
   *  gives each spark some bloom. */
  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.hasVisible()) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Fine sparks: a 1px bright core over a faint 2px bloom.
    for (const p of this.m_sparks) {
      const t = p.age / p.life;
      const alpha = t <= FW.HOLD ? 1 : 1 - (t - FW.HOLD) / (1 - FW.HOLD);
      if (alpha <= 0) continue;
      const x = Math.round(p.x),
        y = Math.round(p.y);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = alpha * 0.4;
      ctx.fillRect(x - 1, y - 1, 2, 2); // faint bloom
      ctx.globalAlpha = alpha;
      ctx.fillRect(x, y, 1, 1); // 1px core
    }
    // Rocket heads: a bright warm streak climbing to the burst.
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgb(255,240,200)';
    for (const r of this.m_rockets) {
      ctx.fillRect(Math.round(r.x) - 1, Math.round(r.y), 2, 3);
    }
    ctx.restore();
  }
}
