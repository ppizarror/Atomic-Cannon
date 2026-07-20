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
import particlesRaw from '../data/particles.json';

// Per-weapon explosion presets from weapons.txt's ParticleEffectTable: each
// weapon's `blast`/`trail` names one of these (colour, count, speed, life,
// spread), giving each weapon its own explosion — e.g. a nuke's giant yellow
// `eYellowPC` burst vs a small `eWhite` puff.
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

// 'plume' = the bright starburst flare used along a projectile trail (real
// flares/04.bmp sprite, additive). 'smoke' = grey puff (real gui/smoke.bmp).
type RenderKind = 'disc' | 'flare' | 'flash' | 'smoke' | 'plume';

interface RGB {
    r: number;
    g: number;
    b: number;
}

/** Minimal sprite source (the game's CAssetManager satisfies this). */
interface SpriteSrc {
    getSprite(name: string): { bitmap: CanvasImageSource; width: number; height: number } | null;
}

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
    size: number;      // base radius in px
    kind: RenderKind;
    gravMul: number;   // gravity scale (smoke is buoyant → negative)
    windMul: number;   // how strongly wind pushes this particle sideways
    spr?: string;      // optional sprite key for plume particles (else the default flare)
}

// Per-kind physics response: how gravity and wind act on each render kind.
// Light smoke rises and is shoved hard by wind; heavy sparks fall and ignore it.
const KIND_GRAV: Record<RenderKind, number> = {disc: 1, flare: 0.25, flash: 0, smoke: -0.12, plume: 0.15};
const KIND_WIND: Record<RenderKind, number> = {disc: 0.15, flare: 0.5, flash: 0, smoke: 1.6, plume: 0.4};

const DEG = Math.PI / 180;
const rnd = () => Math.random();
/** Uniform in [a, b]. */
const between = (a: number, b: number) => a + (b - a) * rnd();

/** Parse `#rrggbb` (falls back to a warm orange). */
function parseColor(s: string): RGB {
    if (s.startsWith('#') && s.length === 7) {
        const n = parseInt(s.slice(1), 16);
        return {r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff};
    }
    return {r: 255, g: 136, b: 0};
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
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    r: number;
    g: number;
    b: number;
    age: number;
    life: number;
}

// The main explosion fireball — the real `effects/explosion1.bmp` chromatic
// starburst, blitted additively and scaled up (an "animation" via growth) as it
// fades, matching the original's expanding explosion-sprite object.
interface Explosion {
    x: number;
    y: number;
    age: number;
    life: number;
    size: number;
    sprite: string;
}

export class CParticleSystem {
    private m_particles: Particle[] = [];
    private m_beams: Beam[] = [];
    private m_explosions: Explosion[] = [];

    // Real sprites (looked up lazily each frame; falls back to procedural draws
    // until they finish loading). 'fx:smoke' = gui/smoke.bmp, 'fx:flare' = flares/04.bmp.
    private m_assets: SpriteSrc | null = null;
    private m_warmSmoke: HTMLCanvasElement | null = null;   // fire-tinted smoke (young trail puffs)

    setAssets(a: SpriteSrc): void {
        this.m_assets = a;
        this.m_warmSmoke = null;
    }

    /** Lazily build a warm-tinted copy of the smoke sprite (keeps its texture+alpha).
     *  Blitted additively over young trail smoke so fresh puffs near the exhaust glow
     *  like fire, cooling to plain grey as they age. Null until the sprite exists. */
    private warmSmoke(): HTMLCanvasElement | null {
        if (this.m_warmSmoke) return this.m_warmSmoke;
        const spr = this.m_assets?.getSprite('fx:smoke');
        if (!spr) return null;
        const w = spr.width, h = spr.height;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d')!;
        g.drawImage(spr.bitmap, 0, 0, w, h);
        g.globalCompositeOperation = 'multiply';        // fire-orange tint, keep the puff texture
        g.fillStyle = 'rgb(255,140,55)';
        g.fillRect(0, 0, w, h);
        g.globalCompositeOperation = 'destination-in';  // re-mask to the smoke's own alpha
        g.drawImage(spr.bitmap, 0, 0, w, h);
        g.globalCompositeOperation = 'source-over';
        this.m_warmSmoke = c;
        return this.m_warmSmoke;
    }

    // Pre-baked soft radial glow. The old draw path allocated a fresh
    // createRadialGradient (+3 addColorStop) for EVERY flare/flash/plume/smoke
    // fallback, every frame — hundreds of allocations per blast frame. Instead we
    // bake one white glow sprite once, tint it per colour into a small cache, and
    // blit it with drawImage — the hot path then allocates nothing.
    private m_glow: HTMLCanvasElement | null = null;
    private m_glowNA = false;                                       // no DOM (unit tests) → callers fall back to a gradient
    private m_tints = new Map<number, HTMLCanvasElement>();         // quantised colour → tinted glow
    private static readonly GLOW_SRC = 32;                          // master glow radius (px); scaled up per particle

    /**
     * The white master glow (built once). Its falloff mirrors the old flare/flash
     * gradient exactly — solid core, half-alpha midpoint, transparent rim — so
     * blitting it under 'lighter' reproduces the previous look. Returns null where
     * there is no canvas (the Node test runner), signalling a gradient fallback.
     */
    private glowMaster(): HTMLCanvasElement | null {
        if (this.m_glow || this.m_glowNA) return this.m_glow;
        if (typeof document === 'undefined') {
            this.m_glowNA = true;
            return null;
        }
        const R = CParticleSystem.GLOW_SRC;
        const cv = document.createElement('canvas');
        cv.width = cv.height = R * 2;
        const g = cv.getContext('2d');
        if (!g) {
            this.m_glowNA = true;
            return null;
        }
        const grad = g.createRadialGradient(R, R, 0, R, R, R);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.5, 'rgba(255,255,255,0.4)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, R * 2, R * 2);
        this.m_glow = cv;
        return cv;
    }

    /**
     * The master glow tinted to (r,g,b), cached by colour quantised to 5 bits per
     * channel so a blast's jittered tints collapse to a handful of cache entries.
     * `source-in` keeps the glow's alpha shape and swaps in the solid colour.
     */
    private tintedGlow(r: number, g: number, b: number): HTMLCanvasElement | null {
        const master = this.glowMaster();
        if (!master) return null;
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const hit = this.m_tints.get(key);
        if (hit) return hit;
        const R = CParticleSystem.GLOW_SRC;
        const cv = document.createElement('canvas');
        cv.width = cv.height = R * 2;
        const c = cv.getContext('2d')!;
        c.drawImage(master, 0, 0);
        c.globalCompositeOperation = 'source-in';
        c.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
        c.fillRect(0, 0, R * 2, R * 2);
        if (this.m_tints.size > 256) this.m_tints.clear();   // bound memory on pathological colour spread
        this.m_tints.set(key, cv);
        return cv;
    }

    /**
     * Blit the tinted glow centred at (x,y) with the given radius and alpha, under
     * whatever composite op the caller has set. Returns false when no canvas is
     * available so the caller can fall back to a gradient (keeps unit tests working).
     */
    private blitGlow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, r: number, g: number, b: number, alpha: number): boolean {
        const t = this.tintedGlow(r, g, b);
        if (!t) return false;
        const d = radius * 2;
        ctx.globalAlpha = alpha;
        ctx.drawImage(t, x - radius, y - radius, d, d);
        ctx.globalAlpha = 1;
        return true;
    }

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
     * Weapon detonation, staged like the original's explosion sequence:
     *   Phase 1 — a brief central fireball (the weapon's own `expBitmap` flare) + a
     *             hot flash; big/nuclear rounds also trigger the full-viewport
     *             white-out (a DOM overlay, driven from the controller — see `explode`).
     *   Phase 2 — the FIREWORK: the weapon's flare sprite scattered many times as
     *             blobs radiating outward (nuke = white puffs, ring-flares = rings),
     *             plus a circular ejecta ring for big blasts.
     *   Phase 3 — sparks, a fire line, and a lingering smoke column (+ the caller's
     *             dirt shower / radiation specks in CLand).
     * `presetName` (particles.json) drives the fireball's colour/density/speed/spread.
     */
    blast(x: number, y: number, radiusPx: number, color: string, nuclear = false, presetName?: string, expType = 0, expBitmap?: string): void {
        // `eLlightBlue` is a typo in the original weapon table for `eLightBlue`.
        const preset = presetName ? (PRESETS[presetName] ?? PRESETS[presetName.replace('Llight', 'Light')]) : undefined;
        const c = preset ? {r: preset.colorr, g: preset.colorg, b: preset.colorb} : parseColor(color);
        const r = Math.max(12, radiusPx);
        const big = expType === 4 || nuclear;   // expType 4 = the nuke white-out

        // Phase 1 — a moderate central fireball + a hot flash. The full-screen
        // white-out is the DOM overlay; the firework blobs (below) carry the bulk of
        // the spread, so this core stays contained.
        // Central bloom = the weapon's OWN catalog flare (`expBitmap`: Tomcat=flares/16
        // white star, nuke=flares/00 white puff, digger=flares/03 green ring, …), NOT
        // the generic chromatic `explosion1.bmp` (which reads as a rainbow iris — wrong
        // per weapon). Big + BRIEF so it's a prominent core that fades as it spreads.
        const flareSpr = expBitmap ? `fx:${expBitmap}` : 'fx:explosion';
        this.spawnExplosion(x, y, r * (big ? 2.2 : 1.6), big ? 0.35 : 0.5, flareSpr);
        this.spawnFlash(x, y, r * (big ? 2.4 : 1.6), big ? {
            r: 255,
            g: 255,
            b: 255
        } : toward255(c, 0.4), big ? 0.3 : 0.22);

        if (preset) {
            this.emitPreset(x, y, r, preset);
        } else {
            const ring = Math.round(r * 1.2) + (nuclear ? 70 : 22);
            this.emitRadial(x, y, ring, 70, 200, 0.35, 0.7, r * 0.14 + 2, toward255(c, 0.3), 'flare');
            this.emitRadial(x, y, ring * 2, 25, 110, 0.5, 1.1, r * 0.11 + 2, c, 'flare');
        }

        // Phase 2 — the firework: the weapon's OWN explosion flare sprite rendered
        // many times as scattered blobs radiating out (nuke=flares/00 white puffs,
        // excavator=flares/03 green rings, …). Plus, for big blasts, a circular ejecta ring.
        // (`flareSpr` computed above — the same catalog flare drives the central bloom.)
        this.emitGasBlobs(x, y, r, Math.round(r * 1.5) + 30, flareSpr);
        if (big) this.emitEjectaRing(x, y, r);

        this.emitBox(x, y, Math.round(r * 1.4) + 26, 190, 0.4, 1.1, 1.6, toward255(c, 0.2), 'disc'); // sparks
        this.emitFireLine(x, y, r * 0.8, c);
    }

    /**
     * Phase-2 firework: scatter many instances of the weapon's explosion flare
     * SPRITE radiating outward — the cloudy blob burst (each blob is one flare, so
     * its shape/colour is the weapon's own: nuke puffs, excavator green rings, …).
     */
    private emitGasBlobs(x: number, y: number, r: number, count: number, spr: string): void {
        const white: RGB = {r: 255, g: 255, b: 248};   // procedural fallback tint only
        const size = between(2, 3) + r * 0.02;           // bigger blobs for bigger blasts
        // Centre the firework a bit DOWN into the crater bowl — the blast point is at
        // the rim while the bowl carves below it, so this fills the whole crater.
        const cy = y + r * 0.35;
        for (let i = 0; i < count; i++) {
            const a = rnd() * Math.PI * 2;
            // Spread to ≈1.5·r (the crater edge), only lightly centre-biased so blobs
            // reach the rim AND the bottom of the bowl — not just a ball in the middle.
            const life = between(0.4, 0.85);
            const sp = (0.25 + rnd() * 0.75) * (1.5 * r / life);
            const d0 = rnd() * r * 0.35;
            this.add(
                x + Math.cos(a) * d0, cy + Math.sin(a) * d0,
                Math.cos(a) * sp, Math.sin(a) * sp,   // symmetric → fills DOWN into the bowl too
                white, life, size + between(-0.5, 1), 'plume', spr,
            );
        }
    }

    /**
     * Phase-2 circular ejecta: a fast, near-uniform ring of dirt launched radially
     * outward so it reads as an expanding shockwave shell around the crater.
     */
    private emitEjectaRing(x: number, y: number, r: number): void {
        const n = Math.round(r * 4.5) + 50;
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + between(-0.06, 0.06);   // evenly around the circle
            const sp = between(320, 520);                              // narrow band → a clean, wide shell
            const g = 100 + Math.floor(rnd() * 110);                  // brighter, warmer dirt
            this.add(
                x, y,
                Math.cos(a) * sp, Math.sin(a) * sp * 0.55 - between(30, 120),   // out and slightly up
                {r: g, g: Math.round(g * 0.55), b: g >> 3}, between(0.45, 0.9), between(1, 1.8), 'disc',
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
                {r: jc(p.colorr), g: jc(p.colorg), b: jc(p.colorb)}, life, size, 'flare',
            );
        }
    }

    /** Tank/vehicle destruction — the fixed white-flare + spark + fire profile. */
    tankDeath(x: number, y: number): void {
        const white: RGB = {r: 255, g: 255, b: 255};
        const fire: RGB = {r: 255, g: 150, b: 40};
        this.spawnFlash(x, y, 90, white, 0.3);
        this.emitRadial(x, y, 40, 90, 240, 0.4, 0.8, 5, white, 'flare');   // ring 1 (speed 80, ~40)
        this.emitRadial(x, y, 80, 40, 140, 0.5, 1.0, 4, white, 'flare');   // ring 2 (speed 40, ~80)
        this.emitBox(x, y, 60, 200, 0.5, 1.2, 1.8, fire, 'disc');          // 60 sparks
        this.emitFireLine(x, y, 12, fire);                                 // ±10px fire line
        this.emitSmokeColumn(x, y, 20, 16);                               // lingering smoke
    }

    /** In-flight trail — call each frame while a shot flies. A hot leading glow
     * plus a grey smoke puff that lingers and drifts downwind. */
    trail(x: number, y: number, color: string, vx = 0, vy = 0, trailType = 1, trailLength = 0, dt = 0.016): void {
        if (trailType <= 0) return;   // no trail (nukes / beams / diggers)
        const speed = Math.hypot(vx, vy);
        const rocket = trailType >= 2;                       // rocket/missile exhaust
        const lenScale = trailLength > 0 ? 0.6 + trailLength / 100 : 1;   // trailLength 80 → 1.4
        // Fill the segment the rocket just travelled this frame so the trail is a
        // CONTINUOUS streak, not blobs spaced one-per-frame. Steps scale with the
        // segment length (≈ speed·dt) → a faster (higher-power) shot lays down a
        // longer, denser streak (RE: faster ⇒ more visible smoke, via SPEED).
        const steps = Math.max(rocket ? 2 : 1, Math.ceil((speed * dt) / 3));
        const spark = toward255(parseColor(color), 0.55);   // weapon-tinted, brightened
        for (let s = 0; s < steps; s++) {
            const f = s / steps;                             // 0 = head, →1 = last-frame position
            const px = x - vx * dt * f, py = y - vy * dt * f;
            if (rocket) {
                // ROCKET/MISSILE exhaust — a small bright orange FIRE glow (the RE trail
                // flare is only ~4px, so small sizes here vs the ×~7.8 draw) trailing
                // into grey SMOKE. The grey smoke is a rocket-only INTERP (the original
                // has no lingering smoke — only flare+sparks), so it stays on rockets.
                this.add(
                    px, py,
                    between(-5, 5), between(-5, 2),
                    {r: 255, g: 200, b: 110}, between(0.14, 0.28) * lenScale, between(0.9, 1.6), 'plume',
                );
                const g = 150 + between(-20, 20);
                this.add(
                    px + between(-2, 2), py + between(-2, 2),
                    between(-4, 4), -between(3, 10),
                    {r: g, g, b: g}, between(1.0, 1.8) * lenScale, between(1.6, 3.2), 'smoke',
                );
            } else {
                // BALLISTIC shell (trailType 1) — RE: only a flare puff + sparks, NO
                // smoke. Tinted toward the weapon's colour so rails read light-blue,
                // shells white, etc. (fixes shells/rails wrongly puffing grey smoke).
                this.add(
                    px, py,
                    between(-3, 3), between(-3, 2),
                    spark, between(0.12, 0.26) * lenScale, between(0.7, 1.3), 'plume',
                );
                this.add(
                    px, py,
                    between(-16, 16), between(-8, 18),
                    spark, between(0.12, 0.3), between(0.6, 1.1), 'disc',
                );
            }
        }
    }

    /** A glowing flare riding on the projectile (rocket `flareType`/`flareBmp`). */
    inflightFlare(x: number, y: number, sprite: string, size: number): void {
        this.add(x, y, 0, 0, {r: 255, g: 255, b: 255}, 0.14, Math.max(4, size), 'plume', sprite);
    }

    /** Muzzle blast on fire: a forward flash (`muzzleFlash`) + smoke (`muzzleSmoke`). */
    muzzle(x: number, y: number, vx: number, vy: number, flash: number, smoke: number, color: string): void {
        const speed = Math.hypot(vx, vy);
        const dir = speed > 1 ? {x: vx / speed, y: vy / speed} : {x: 1, y: 0};
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
                    {r: g, g, b: g}, between(0.5, 1.1), between(3, 5), 'smoke',
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
                {r: g, g, b: g}, between(0.9, 1.9), between(3, 6) * (0.6 + scale / 40), 'smoke',
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
        this.m_beams.push({x0, y0, x1, y1, r: c.r, g: c.g, b: c.b, age: 0, life: 0.35});
    }

    /** Spawn the expanding fireball sprite (the weapon's own `expBitmap` flare). */
    private spawnExplosion(x: number, y: number, size: number, life: number, sprite: string): void {
        this.m_explosions.push({x, y, age: 0, life, size, sprite});
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
                // Grey puff: starts SMALL and SWELLS strongly over its life (the fumes
                // grow as they drift back), alpha peaks early then fades out.
                const alpha = Math.sin(Math.min(1, t) * Math.PI) * 0.5;
                if (alpha <= 0.01) continue;
                const d = p.size * (0.9 + t * 5.5) * 2;      // small at birth → large as it ages
                if (smokeSpr) {
                    // Warm while YOUNG (fresh puffs near the exhaust glow orange),
                    // cooling to plain grey as it ages back down the trail. Warmth is
                    // aimed at the EARLY-VISIBLE phase (the smoke is transparent at
                    // birth), and the grey base is dimmed while warm so the fresh puff
                    // reads orange rather than grey-with-a-hint.
                    const warmth = Math.max(0, 1.15 - t * 2.2);
                    // Grey base — full grey once cooled, dimmed while warm.
                    ctx.globalAlpha = alpha * (0.45 + 0.55 * (1 - warmth));
                    ctx.drawImage(smokeSpr.bitmap, p.x - d / 2, p.y - d / 2, d, d);
                    const warm = warmth > 0.02 ? this.warmSmoke() : null;
                    if (warm) {
                        const op = ctx.globalCompositeOperation;
                        ctx.globalCompositeOperation = 'lighter';
                        ctx.globalAlpha = alpha * warmth * 1.3;
                        ctx.drawImage(warm, p.x - d / 2, p.y - d / 2, d, d);
                        ctx.globalCompositeOperation = op;
                    }
                    ctx.globalAlpha = 1;
                } else if (!this.blitGlow(ctx, p.x, p.y, d / 2, p.r, p.g, p.b, alpha)) {
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
            } else if (!this.blitGlow(ctx, e.x, e.y, d / 2, 255, 220, 150, a)) {
                const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, d / 2);
                g.addColorStop(0, `rgba(255,220,150,${a})`);
                g.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(e.x, e.y, d / 2, 0, Math.PI * 2);
                ctx.fill();
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
            } else if (!this.blitGlow(ctx, p.x, p.y, d / 2, p.r, p.g, p.b, a)) {
                const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, d / 2);
                g.addColorStop(0, `rgba(${p.r | 0},${p.g | 0},${p.b | 0},${a})`);
                g.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(p.x, p.y, d / 2, 0, Math.PI * 2);
                ctx.fill();
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

            // Blit the pre-baked glow (its baked 0.4 midpoint matches the old 3-stop
            // gradient); fall back to the gradient only where no canvas exists (tests).
            if (!this.blitGlow(ctx, p.x, p.y, glow, p.r, p.g, p.b, alpha)) {
                const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glow);
                g.addColorStop(0, `rgba(${p.r | 0},${p.g | 0},${p.b | 0},${alpha})`);
                g.addColorStop(0.5, `rgba(${p.r | 0},${p.g | 0},${p.b | 0},${alpha * 0.4})`);
                g.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(p.x, p.y, glow, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Beam flashes — a soft coloured halo line under a thin white-hot core. The
        // bolt SHOOTS OUT from the muzzle: the tip races to the target over the first
        // ~35% of the life, then the full line holds and fades (a fired beam, not an
        // instant pop). A bright head rides the advancing tip while it's extending.
        for (const b of this.m_beams) {
            const t = b.age / b.life;
            if (t >= 1) continue;
            const a = 1 - t;
            const grow = Math.min(1, t / 0.35);              // 0→1 as the tip advances
            const ex = b.x0 + (b.x1 - b.x0) * grow, ey = b.y0 + (b.y1 - b.y0) * grow;
            ctx.lineCap = 'round';
            ctx.strokeStyle = `rgba(${b.r | 0},${b.g | 0},${b.b | 0},${a * 0.6})`;
            ctx.lineWidth = 8 * a + 2;
            ctx.beginPath();
            ctx.moveTo(b.x0, b.y0);
            ctx.lineTo(ex, ey);
            ctx.stroke();
            ctx.strokeStyle = `rgba(255,255,255,${a})`;
            ctx.lineWidth = 3 * a + 1;
            ctx.beginPath();
            ctx.moveTo(b.x0, b.y0);
            ctx.lineTo(ex, ey);
            ctx.stroke();
            // Bright muzzle-flash head at the advancing tip while extending.
            if (grow < 1) {
                ctx.fillStyle = `rgba(255,255,255,${a})`;
                ctx.beginPath();
                ctx.arc(ex, ey, 4 * a + 2, 0, Math.PI * 2);
                ctx.fill();
            }
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
        if (elapsed > this.m_shakeDuration) return {x: 0, y: 0};
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
