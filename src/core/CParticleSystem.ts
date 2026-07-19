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

import type { Vec2 } from '../math/Vec2';
import particlesRaw from '../data/particles.json';

// Per-weapon explosion presets from weapons.txt's ParticleEffectTable: each
// weapon's `blast`/`trail` names one of these (colour, count, speed, life,
// spread), giving each weapon its own explosion — e.g. a nuke's giant yellow
// `eYellowPC` burst vs a small `eWhite` puff.
interface ParticlePreset {
  posVar: number; density: number; minv: number; maxv: number;
  minlife: number; maxlife: number; minTheta: number; maxTheta: number;
  colorVar: number; colorr: number; colorg: number; colorb: number;
}
const PRESETS = particlesRaw as unknown as Record<string, ParticlePreset>;

// 'plume' = the bright starburst flare used along a projectile trail (real
// flares/04.bmp sprite, additive). 'smoke' = grey puff (real gui/smoke.bmp).
type RenderKind = 'disc' | 'flare' | 'flash' | 'smoke' | 'plume';

interface RGB { r: number; g: number; b: number; }

/** Minimal sprite source (the game's CAssetManager satisfies this). */
interface SpriteSrc { getSprite(name: string): { bitmap: CanvasImageSource; width: number; height: number } | null; }

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  r: number; g: number; b: number;
  age: number;
  life: number;
  size: number;      // base radius in px
  kind: RenderKind;
  gravMul: number;   // gravity scale (smoke is buoyant → negative)
  windMul: number;   // how strongly wind pushes this particle sideways
  spr?: string;      // optional sprite key for plume particles (else the default flare)
}

// Per-kind physics response: how gravity and wind act on each render kind.
// Light smoke rises and is shoved hard by wind; heavy sparks fall and ignore it.
const KIND_GRAV: Record<RenderKind, number> = { disc: 1, flare: 0.25, flash: 0, smoke: -0.12, plume: 0.15 };
const KIND_WIND: Record<RenderKind, number> = { disc: 0.15, flare: 0.5, flash: 0, smoke: 1.6, plume: 0.4 };

const DEG = Math.PI / 180;
const rnd = () => Math.random();
/** Uniform in [a, b]. */
const between = (a: number, b: number) => a + (b - a) * rnd();

/** Parse `#rrggbb` (falls back to a warm orange). */
function parseColor(s: string): RGB {
  if (s.startsWith('#') && s.length === 7) {
    const n = parseInt(s.slice(1), 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
  }
  return { r: 255, g: 136, b: 0 };
}

/** Nudge a colour toward white (0..1) — hot cores read brighter than the tint. */
function toward255(c: RGB, t: number): RGB {
  return {
    r: c.r + (255 - c.r) * t,
    g: c.g + (255 - c.g) * t,
    b: c.b + (255 - c.b) * t,
  };
}

// An instantaneous beam flash: a bright line from muzzle to impact that fades.
interface Beam {
  x0: number; y0: number; x1: number; y1: number;
  r: number; g: number; b: number;
  age: number; life: number;
}

// The main explosion fireball — the real `effects/explosion1.bmp` chromatic
// starburst, blitted additively and scaled up (an "animation" via growth) as it
// fades, matching the original's expanding explosion-sprite object.
interface Explosion { x: number; y: number; age: number; life: number; size: number; sprite: string; }

export class CParticleSystem {
  private m_particles: Particle[] = [];
  private m_beams: Beam[] = [];
  private m_explosions: Explosion[] = [];

  // Real sprites (looked up lazily each frame; falls back to procedural draws
  // until they finish loading). 'fx:smoke' = gui/smoke.bmp, 'fx:flare' = flares/04.bmp.
  private m_assets: SpriteSrc | null = null;
  setAssets(a: SpriteSrc): void { this.m_assets = a; }

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
    x: number, y: number, vx: number, vy: number,
    c: RGB, life: number, size: number, kind: RenderKind, spr?: string,
  ): void {
    this.m_particles.push({
      x, y, vx, vy, r: c.r, g: c.g, b: c.b, age: 0, life, size, kind,
      gravMul: KIND_GRAV[kind], windMul: KIND_WIND[kind], spr,
    });
  }

  /** Radial burst: `count` particles fanned across all angles, speed ∈ [smin,smax]. */
  private emitRadial(
    x: number, y: number, count: number,
    smin: number, smax: number, lmin: number, lmax: number,
    size: number, c: RGB, kind: RenderKind, upBias = 0,
  ): void {
    for (let i = 0; i < count; i++) {
      const a = rnd() * 360 * DEG;
      const sp = between(smin, smax);
      this.add(x, y, Math.cos(a) * sp, Math.sin(a) * sp - upBias, c, between(lmin, lmax), size, kind);
    }
  }

  /** Box burst: per-axis velocity ∈ [-speed, speed] (the classic spark spray). */
  private emitBox(
    x: number, y: number, count: number, speed: number,
    lmin: number, lmax: number, size: number, c: RGB, kind: RenderKind,
  ): void {
    for (let i = 0; i < count; i++) {
      this.add(
        x, y,
        between(-speed, speed), between(-speed, speed) - speed * 0.4,
        c, between(lmin, lmax), size, kind,
      );
    }
  }

  /** A row of rising fire streamers across ±half px of the impact column. */
  private emitFireLine(x: number, y: number, half: number, c: RGB): void {
    const step = Math.max(3, half / 5);
    const hot = toward255(c, 0.4);
    for (let fx = x - half; fx <= x + half; fx += step) {
      this.add(
        fx, y,
        between(-20, 20), between(-140, -60),
        hot, between(0.5, 1.0), between(2.5, 4), 'flare',
      );
    }
  }

  /** Additive white-out bloom centred on the blast. */
  private spawnFlash(x: number, y: number, size: number, c: RGB, life: number): void {
    this.add(x, y, 0, 0, c, life, size, 'flash');
  }

  // ---------------------------------------------------------------- profiles

  /**
   * Weapon detonation. If `presetName` names a `particles.json` effect, that
   * drives the fireball's colour / density / speed / life / spread so each
   * weapon explodes differently; otherwise a generic tinted burst is used.
   */
  blast(x: number, y: number, radiusPx: number, color: string, nuclear = false, presetName?: string, expType = 0, expBitmap?: string): void {
    // `eLlightBlue` is a typo in the original weapon table for `eLightBlue`.
    const preset = presetName ? (PRESETS[presetName] ?? PRESETS[presetName.replace('Llight', 'Light')]) : undefined;
    const c = preset ? { r: preset.colorr, g: preset.colorg, b: preset.colorb } : parseColor(color);
    const r = Math.max(12, radiusPx);
    const big = expType === 4 || nuclear;   // expType 4 = the nuke white-out

    // Phase 1 — a moderate central fireball (the weapon's own expBitmap flare)
    // and a hot flash. The full-screen white-out is the DOM overlay; the firework
    // blobs (below) carry the bulk of the visual, so this core stays contained.
    // Big + BRIEF core so it's a prominent phase-1 blob but fades before phase 2,
    // letting the (longer-lived) firework blobs read clearly.
    this.spawnExplosion(x, y, r * (big ? 2.2 : 1.6), big ? 0.35 : 0.5, expBitmap ? `fx:${expBitmap}` : 'fx:explosion');
    this.spawnFlash(x, y, r * (big ? 2.4 : 1.6), big ? { r: 255, g: 255, b: 255 } : toward255(c, 0.4), big ? 0.3 : 0.22);

    if (preset) {
      this.emitPreset(x, y, r, preset);
    } else {
      const ring = Math.round(r * 1.2) + (nuclear ? 70 : 22);
      this.emitRadial(x, y, ring,     70, 200, 0.35, 0.7, r * 0.14 + 2, toward255(c, 0.3), 'flare');
      this.emitRadial(x, y, ring * 2, 25, 110, 0.5,  1.1, r * 0.11 + 2, c, 'flare');
    }

    // Phase 2 — the firework: the weapon's OWN explosion flare sprite rendered
    // many times as scattered blobs radiating out (nuke=flares/00 white puffs,
    // excavator=flares/03 green rings, …). Plus, for big blasts, a circular ejecta ring.
    const flareSpr = expBitmap ? `fx:${expBitmap}` : 'fx:explosion';
    this.emitGasBlobs(x, y, r, Math.round(r * 0.7) + 14, flareSpr);
    if (big) this.emitEjectaRing(x, y, r);

    this.emitBox(x, y, Math.round(r * 1.4) + 26, 190, 0.4, 1.1, 1.6, toward255(c, 0.2), 'disc'); // sparks
    this.emitFireLine(x, y, r * 0.8, c);
    this.emitSmokeColumn(x, y, Math.round(r * 0.4) + (nuclear ? 24 : 8), r * 0.5); // lingering smoke
  }

  /**
   * Phase-2 firework: scatter many instances of the weapon's explosion flare
   * SPRITE radiating outward — the cloudy blob burst (each blob is one flare, so
   * its shape/colour is the weapon's own: nuke puffs, excavator green rings, …).
   */
  private emitGasBlobs(x: number, y: number, r: number, count: number, spr: string): void {
    const white: RGB = { r: 255, g: 255, b: 248 };   // procedural fallback tint only
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const sp = between(160, 540);                    // fly out fast, clear of the core
      const d0 = rnd() * rnd() * r * 0.35;            // some near the core, some flung out
      this.add(
        x + Math.cos(a) * d0, y + Math.sin(a) * d0,
        Math.cos(a) * sp, Math.sin(a) * sp - between(20, 90),   // slight upward bias (mushroom)
        white, between(0.6, 1.35), between(2.5, 5.5), 'plume', spr,   // small distinct puffs
      );
    }
  }

  /**
   * Phase-2 circular ejecta: a fast, near-uniform ring of dirt launched radially
   * outward so it reads as an expanding shockwave shell around the crater.
   */
  private emitEjectaRing(x: number, y: number, r: number): void {
    const n = Math.round(r * 2.2) + 30;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + between(-0.05, 0.05);   // evenly around the circle
      const sp = between(280, 380);                              // narrow band → a clean shell
      const g = 60 + Math.floor(rnd() * 80);
      this.add(
        x, y,
        Math.cos(a) * sp, Math.sin(a) * sp * 0.55 - between(30, 120),   // out and slightly up
        { r: g, g: g >> 1, b: g >> 3 }, between(0.45, 0.9), between(1.5, 3), 'disc',
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
    const t0 = Math.min(p.minTheta, p.maxTheta), t1 = Math.max(p.minTheta, p.maxTheta);
    const size = r * 0.12 + 2;
    for (let i = 0; i < count; i++) {
      const theta = (t0 + rnd() * (t1 - t0)) * DEG;
      const speed = (p.minv + rnd() * (p.maxv - p.minv)) * 14 + 20;   // preset units → px/s
      const life = (p.minlife + rnd() * (p.maxlife - p.minlife)) * 0.16 + 0.25;
      const jc = (base: number) => Math.max(0, Math.min(255, base + (rnd() * 2 - 1) * p.colorVar));
      this.add(
        x + (rnd() * 2 - 1) * p.posVar, y + (rnd() * 2 - 1) * p.posVar,
        Math.cos(theta) * speed, -Math.sin(theta) * speed,   // screen-Y down: -sin → 90° is up
        { r: jc(p.colorr), g: jc(p.colorg), b: jc(p.colorb) }, life, size, 'flare',
      );
    }
  }

  /** Tank/vehicle destruction — the fixed white-flare + spark + fire profile. */
  tankDeath(x: number, y: number): void {
    const white: RGB = { r: 255, g: 255, b: 255 };
    const fire: RGB = { r: 255, g: 150, b: 40 };
    this.spawnFlash(x, y, 90, white, 0.3);
    this.emitRadial(x, y, 40, 90, 240, 0.4, 0.8, 5, white, 'flare');   // ring 1 (speed 80, ~40)
    this.emitRadial(x, y, 80, 40, 140, 0.5, 1.0, 4, white, 'flare');   // ring 2 (speed 40, ~80)
    this.emitBox(x, y, 60, 200, 0.5, 1.2, 1.8, fire, 'disc');          // 60 sparks
    this.emitFireLine(x, y, 12, fire);                                 // ±10px fire line
    this.emitSmokeColumn(x, y, 20, 16);                               // lingering smoke
  }

  /** In-flight trail — call each frame while a shot flies. A hot leading glow
   * plus a grey smoke puff that lingers and drifts downwind. */
  trail(x: number, y: number, color: string, vx = 0, vy = 0, trailType = 1, trailLength = 0): void {
    if (trailType <= 0) return;   // no trail (nukes / beams / diggers)
    const hot = toward255(parseColor(color), 0.4);
    const speed = Math.hypot(vx, vy);
    // Exhaust is thrown BACKWARD out of the nose at 0.1·|velocity| (faithful),
    // and a faster (higher-power) shot lays down more puffs → more smoke.
    const back = speed > 1 ? { x: -vx / speed, y: -vy / speed } : { x: 0, y: -1 };
    const pspd = speed * 0.1;
    const rocket = trailType >= 2;                       // rocket/missile exhaust
    const lenScale = trailLength > 0 ? 0.6 + trailLength / 100 : 1;   // trailLength 80 → 1.4
    // Uses the flares/04 starburst asset; rocket types just emit denser + longer.
    const n = (rocket ? 2 : 1) + Math.min(3, Math.floor(speed / 240));
    for (let i = 0; i < n; i++) {
      this.add(
        x, y,
        back.x * pspd * between(0.3, 1) + between(-8, 8),
        back.y * pspd * between(0.3, 1) + between(-8, 2),
        hot, between(0.2, 0.4) * lenScale, between(3, 5) * (rocket ? 1.2 : 1), 'plume',
      );
      const g = 155 + between(-25, 25);
      this.add(
        x + between(-2, 2), y + between(-2, 2),
        back.x * pspd * between(0.2, 0.6) + between(-5, 5),
        back.y * pspd * between(0.2, 0.6) - between(4, 14),
        { r: g, g, b: g }, between(1.1, 2.1) * lenScale, between(3, 6), 'smoke',
      );
    }
  }

  /** A glowing flare riding on the projectile (rocket `flareType`/`flareBmp`). */
  inflightFlare(x: number, y: number, sprite: string, size: number): void {
    this.add(x, y, 0, 0, { r: 255, g: 255, b: 255 }, 0.14, Math.max(4, size), 'plume', sprite);
  }

  /** Muzzle blast on fire: a forward flash (`muzzleFlash`) + smoke (`muzzleSmoke`). */
  muzzle(x: number, y: number, vx: number, vy: number, flash: number, smoke: number, color: string): void {
    const speed = Math.hypot(vx, vy);
    const dir = speed > 1 ? { x: vx / speed, y: vy / speed } : { x: 1, y: 0 };
    if (flash > 0) {
      const c = toward255(parseColor(color), 0.5);
      for (let i = 0; i < 7; i++) {
        this.add(
          x, y,
          dir.x * between(30, 150) + between(-30, 30), dir.y * between(30, 150) + between(-30, 30),
          c, between(0.1, 0.24), between(2.5, 4.5), 'plume',
        );
      }
    }
    if (smoke > 0) {
      for (let i = 0; i < smoke * 4; i++) {
        const g = 150 + between(-25, 25);
        this.add(
          x + between(-4, 4), y + between(-4, 4),
          dir.x * between(0, 60) + between(-20, 20), between(-30, 5),
          { r: g, g, b: g }, between(0.5, 1.1), between(3, 5), 'smoke',
        );
      }
    }
  }

  /** A slow column of grey smoke rising from a blast site (lingers after the flash). */
  private emitSmokeColumn(x: number, y: number, count: number, scale: number): void {
    for (let i = 0; i < count; i++) {
      const g = 90 + between(-25, 45);
      this.add(
        x + between(-scale, scale), y + between(-scale * 0.4, scale * 0.2),
        between(-14, 14), between(-40, -12),
        { r: g, g, b: g }, between(0.9, 1.9), between(3, 6) * (0.6 + scale / 40), 'smoke',
      );
    }
  }

  /** Generic burst (used by mines and any caller without a weapon tint). */
  explode(x: number, y: number, scale = 1): void {
    this.blast(x, y, 26 * scale, '#ff8c22', false);
  }

  /** An instantaneous beam flash from muzzle to impact (fades over ~0.35 s). */
  beam(x0: number, y0: number, x1: number, y1: number, color: string): void {
    const c = parseColor(color);
    this.m_beams.push({ x0, y0, x1, y1, r: c.r, g: c.g, b: c.b, age: 0, life: 0.35 });
  }

  /** Spawn the expanding fireball sprite (the weapon's own `expBitmap` flare). */
  private spawnExplosion(x: number, y: number, size: number, life: number, sprite: string): void {
    this.m_explosions.push({ x, y, age: 0, life, size, sprite });
  }

  // ------------------------------------------------------------------ update

  /**
   * Integrate one step. `wind` (the game's ±5 drift vector) is applied as a
   * horizontal acceleration scaled per particle — smoke gets shoved, sparks
   * barely move — so a trail visibly bends downwind regardless of firing dir.
   */
  update(dt: number, wind?: Vec2): void {
    if (dt <= 0) return;
    const windAx = wind ? wind.x * 26 : 0;   // ±5 wind → up to ±130 px/s^2 on light smoke
    const windAy = wind ? wind.y * 26 : 0;

    let w = 0;
    for (let i = 0; i < this.m_particles.length; i++) {
      const p = this.m_particles[i];

      p.vx += windAx * p.windMul * dt;
      p.vy += (this.m_gravity * p.gravMul + windAy * p.windMul) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.age += dt;

      const dead =
        p.age >= p.life ||
        p.x < this.m_minX || p.y < this.m_minY ||
        p.x >= this.m_maxX || p.y >= this.m_maxY;

      if (!dead) this.m_particles[w++] = p;   // compact live particles forward
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
      if (e.age < e.life) this.m_explosions[ew++] = e;
    }
    this.m_explosions.length = ew;
  }

  // -------------------------------------------------------------------- draw

  /** Render all particles. Additive kinds are batched to set the blend once. */
  draw(ctx: CanvasRenderingContext2D): void {
    const ps = this.m_particles;
    const smokeSpr = this.m_assets?.getSprite('fx:smoke') ?? null;   // gui/smoke.bmp
    const flareSpr = this.m_assets?.getSprite('fx:flare') ?? null;   // flares/04.bmp

    // Pass 1: normal-blend — sparks/debris (crisp dots) and smoke (grey puffs).
    for (const p of ps) {
      const t = p.age / p.life;
      if (t >= 1) continue;

      if (p.kind === 'disc') {
        const a = 1 - t;
        ctx.fillStyle = `rgba(${p.r | 0},${p.g | 0},${p.b | 0},${a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.6, p.size * (0.5 + a * 0.5)), 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'smoke') {
        // Grey puff: swells over its life, alpha peaks early then fades out.
        const alpha = Math.sin(Math.min(1, t) * Math.PI) * 0.5;
        if (alpha <= 0.01) continue;
        const d = p.size * (2.2 + t * 3.4) * 2;      // diameter grows as it drifts
        if (smokeSpr) {
          ctx.globalAlpha = alpha;
          ctx.drawImage(smokeSpr.bitmap, p.x - d / 2, p.y - d / 2, d, d);
          ctx.globalAlpha = 1;
        } else {
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, d / 2);
          g.addColorStop(0, `rgba(${p.r | 0},${p.g | 0},${p.b | 0},${alpha})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.x, p.y, d / 2, 0, Math.PI * 2);
          ctx.fill();
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
      const d = e.size * (0.7 + t * 1.8) * 2;
      const a = (1 - t) * (t < 0.15 ? t / 0.15 : 1);   // quick fade-in, then fade out
      const spr = this.m_assets?.getSprite(e.sprite) ?? this.m_assets?.getSprite('fx:explosion') ?? null;
      if (spr) {
        ctx.globalAlpha = a;
        ctx.drawImage(spr.bitmap, e.x - d / 2, e.y - d / 2, d, d);
        ctx.globalAlpha = 1;
      } else {
        const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, d / 2);
        g.addColorStop(0, `rgba(255,220,150,${a})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(e.x, e.y, d / 2, 0, Math.PI * 2); ctx.fill();
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
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, d / 2);
        g.addColorStop(0, `rgba(${p.r | 0},${p.g | 0},${p.b | 0},${a})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, d / 2, 0, Math.PI * 2); ctx.fill();
      }
    }

    for (const p of ps) {
      if (p.kind !== 'flare' && p.kind !== 'flash') continue;
      const t = p.age / p.life;
      if (t >= 1) continue;

      const glow = p.kind === 'flash'
        ? p.size * (1 + t * 1.2)          // flash expands as it fades
        : p.size * (1.7 - t * 0.9);       // flare shrinks
      const alpha = p.kind === 'flash'
        ? (1 - t) * (1 - t) * 0.9         // quick, punchy falloff
        : (1 - t) * 0.5;                  // softer, so overlapping flares keep their hue
      if (glow <= 0 || alpha <= 0) continue;

      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glow);
      g.addColorStop(0, `rgba(${p.r | 0},${p.g | 0},${p.b | 0},${alpha})`);
      g.addColorStop(0.5, `rgba(${p.r | 0},${p.g | 0},${p.b | 0},${alpha * 0.4})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, glow, 0, Math.PI * 2);
      ctx.fill();
    }

    // Beam flashes — a soft coloured halo line under a thin white-hot core.
    for (const b of this.m_beams) {
      const t = b.age / b.life;
      if (t >= 1) continue;
      const a = 1 - t;
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(${b.r | 0},${b.g | 0},${b.b | 0},${a * 0.6})`;
      ctx.lineWidth = 8 * a + 2;
      ctx.beginPath(); ctx.moveTo(b.x0, b.y0); ctx.lineTo(b.x1, b.y1); ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${a})`;
      ctx.lineWidth = 3 * a + 1;
      ctx.beginPath(); ctx.moveTo(b.x0, b.y0); ctx.lineTo(b.x1, b.y1); ctx.stroke();
    }

    ctx.globalCompositeOperation = prev;
  }

  hasActiveExplosions(): boolean {
    return this.m_particles.length > 0 || this.m_beams.length > 0 || this.m_explosions.length > 0;
  }

  /** Live particle count (diagnostics / tests). */
  count(): number {
    return this.m_particles.length;
  }
}

/**
 * Screen shake controller — a decaying random offset applied to the whole
 * scene on impact.
 */
export class ScreenShake {
  private m_shakeIntensity = 0;
  private m_shakeDuration = 0;
  private m_startTime = 0;

  trigger(intensity: number, durationSec: number): void {
    this.m_shakeIntensity = intensity;
    this.m_shakeDuration = durationSec;
    this.m_startTime = performance.now() / 1000;
  }

  getOffset(): { x: number; y: number } {
    const elapsed = performance.now() / 1000 - this.m_startTime;
    if (elapsed > this.m_shakeDuration) return { x: 0, y: 0 };
    const decay = 1 - elapsed / this.m_shakeDuration;
    const maxOffset = this.m_shakeIntensity * decay;
    return {
      x: (Math.random() - 0.5) * 2 * maxOffset,
      y: (Math.random() - 0.5) * 2 * maxOffset,
    };
  }

  isActive(): boolean {
    return performance.now() / 1000 - this.m_startTime < this.m_shakeDuration;
  }
}
