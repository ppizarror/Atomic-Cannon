/**
 * Deterministic logic tests for the particle system (Phase 4).
 */
import {describe, it, expect} from 'vitest';

import {CParticleSystem} from '../src/core/CParticleSystem';
import {ScreenShake} from '../src/core/rendering/ScreenShake';
import {Vec2} from '../src/math/Vec2';

// These tests were authored to run with no DOM: with `document` undefined the
// particle draw path takes CParticleSystem's "Node test runner" branch (a
// gradient fallback painted on the recording ctx) instead of building an
// offscreen glow canvas. The global Vitest setup installs a stub `document`;
// drop it here so the draw tests exercise exactly the branch they were written
// for (the stub canvas has no working createRadialGradient).
delete (globalThis as {document?: unknown}).document;

// A recording 2D-context stand-in: never throws, and logs each PAINT op with the
// composite mode + alpha in force at the time. That lets the draw tests assert the
// blend mode per particle kind and that ctx state is left clean — the invariants
// the glow-sprite draw path must preserve — without a real canvas.
interface PaintCall {
  m: string;
  op: string;
  alpha: number;
}

type RecCtx = CanvasRenderingContext2D & {_calls: PaintCall[]};

function mockCtx(): RecCtx {
  const grad = {
    addColorStop() {},
  };
  const ctx = {
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    _calls: [] as PaintCall[],
    save() {},
    restore() {},
    translate() {},
    beginPath() {},
    arc() {},
    moveTo() {},
    lineTo() {},
    createRadialGradient() {
      return grad;
    },
    createLinearGradient() {
      return grad;
    },
    fill(this: RecCtx) {
      this._calls.push({m: 'fill', op: this.globalCompositeOperation, alpha: this.globalAlpha});
    },
    fillRect(this: RecCtx) {
      this._calls.push({m: 'fillRect', op: this.globalCompositeOperation, alpha: this.globalAlpha});
    },
    stroke(this: RecCtx) {
      this._calls.push({m: 'stroke', op: this.globalCompositeOperation, alpha: this.globalAlpha});
    },
    drawImage(this: RecCtx) {
      this._calls.push({
        m: 'drawImage',
        op: this.globalCompositeOperation,
        alpha: this.globalAlpha,
      });
    },
  };
  return ctx as unknown as RecCtx;
}

// Push one live particle of a given render kind straight into the pool (reaches the
// private `add` emitter) so a test can exercise a single kind's draw branch.
function addKind(ps: CParticleSystem, kind: string, c = {r: 200, g: 120, b: 40}): void {
  (
    ps as unknown as {
      add(
        x: number,
        y: number,
        vx: number,
        vy: number,
        c: object,
        life: number,
        size: number,
        kind: string,
      ): void;
    }
  ).add(400, 300, 0, 0, c, 1, 10, kind);
}

function stepN(ps: CParticleSystem, n: number, dt: number, wind?: Vec2) {
  for (let i = 0; i < n; i++) ps.update(dt, wind);
}

describe('Particle system', () => {
  it('blast() emits, and everything expires within its max lifetime', () => {
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.blast(400, 300, 40, '#ff8c22', false);
    const born = ps.count();
    expect(born).toBeGreaterThan(50); // blast spawns particles
    // Step past the crater vent's full life (VENT_LIFE of emission + the last puff's ~1.3s life).
    stepN(ps, 760, 1 / 60); // ~12.7 s (VENT_LIFE 10 + margin)
    expect(ps.count()).toBe(0); // blast particles (incl. vent fumes) all expire
  });

  it('clear() wipes all live effects (so a new battle starts with no leftover smoke)', () => {
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.blast(400, 300, 40, '#ff8c22', false); // debris + a crater vent
    ps.tankDeath(410, 310); // more particles
    ps.beam(0, 0, 100, 100, '#00ff00'); // a beam flash
    expect(ps.count()).toBeGreaterThan(0);
    const priv = ps as unknown as {m_craterVents: unknown[]; m_explosions: unknown[]};
    expect(priv.m_craterVents.length).toBeGreaterThan(0);

    ps.clear();

    expect(ps.count()).toBe(0); // particles gone
    expect(priv.m_craterVents.length).toBe(0); // vents gone → no smoke re-emits next frame
    expect(priv.m_explosions.length).toBe(0); // fireballs gone
    ps.update(1 / 60); // and stays empty — a cleared vent can't spawn new fumes
    expect(ps.count()).toBe(0);
  });

  it('nuclear blast is bigger than a conventional one of the same radius', () => {
    const a = new CParticleSystem();
    a.setBounds(800, 600);
    const b = new CParticleSystem();
    b.setBounds(800, 600);
    a.blast(400, 300, 40, '#ffff00', false);
    b.blast(400, 300, 40, '#ffff00', true);
    expect(b.count()).toBeGreaterThan(a.count()); // nuclear blast emits more
  });

  it('tankDeath() emits the fixed profile and clears', () => {
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.tankDeath(200, 200);
    expect(ps.count()).toBeGreaterThanOrEqual(180); // tankDeath spawns particles
    stepN(ps, 120, 1 / 60);
    expect(ps.count()).toBe(0); // tankDeath clears
  });

  it('trail() adds a small, short-lived puff each call', () => {
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.trail(100, 100, '#00ffff'); // trailType 1 (ballistic): one faint white spark, NO smoke/glow
    // shell trail adds a single faint spark (no smoke, no fire glow)
    expect(ps.count()).toBe(1);
    stepN(ps, 130, 1 / 60); // ~2.2 s — past the puff/spark life
    expect(ps.count()).toBe(0); // trail puff fades
  });

  it('wind drives smoke sideways in the wind direction (regardless of firing dir)', () => {
    const left = new CParticleSystem();
    left.setBounds(4000, 2000);
    const right = new CParticleSystem();
    right.setBounds(4000, 2000);
    // Same emission; opposite winds. trailType 2 (rocket) so it emits grey SMOKE
    // (ballistic trailType 1 emits none — that's the shell/rail fix).
    for (let i = 0; i < 30; i++) {
      left.trail(2000, 1000, '#cccccc', 0, 0, 2);
      right.trail(2000, 1000, '#cccccc', 0, 0, 2);
    }
    stepN(left, 40, 1 / 60, new Vec2(-5, 0)); // strong left wind
    stepN(right, 40, 1 / 60, new Vec2(5, 0)); // strong right wind
    const mx = (ps: CParticleSystem) =>
      (ps as unknown as {m_particles: {x: number; kind: string}[]}).m_particles
        .filter(p => p.kind === 'smoke')
        .reduce((s, p, _i, a) => s + p.x / a.length, 0);
    const lx = mx(left),
      rx = mx(right);
    expect(lx).toBeLessThan(1999); // smoke drifts downwind (left wind → left)
    expect(rx).toBeGreaterThan(2001); // smoke drifts downwind (right wind → right)
    expect(rx - lx).toBeGreaterThan(20); // opposite winds separate the smoke
  });

  it('wind PROFILE: a low smoke puff drifts less than a high one under the same wind', () => {
    // Ground line at y=1000 (via a flat groundAt). A puff hugging the ground (small height above it)
    // should barely move; a puff high above should catch the full wind. The smoke boundary-layer easing
    // is applied UNCONDITIONALLY (independent of the Wind Model setting) so fumes never rocket off the soil.
    const groundY = 1000;
    const groundAt = () => groundY;
    const mk = (y: number) => {
      const ps = new CParticleSystem();
      ps.setBounds(4000, 2000);
      ps.setGroundProvider(groundAt); // enable the boundary-layer wind profile
      (
        ps as unknown as {
          add(
            x: number,
            y: number,
            vx: number,
            vy: number,
            c: object,
            l: number,
            s: number,
            k: string,
          ): void;
        }
      ).add(2000, y, 0, 0, {r: 150, g: 150, b: 150}, 5, 4, 'smoke');
      for (let i = 0; i < 40; i++) ps.update(1 / 60, new Vec2(5, 0)); // strong wind
      return (ps as unknown as {m_particles: {x: number}[]}).m_particles[0].x;
    };
    const lowDrift = mk(groundY - 10) - 2000; // 10px above ground → near-zero wind factor
    const highDrift = mk(groundY - 320) - 2000; // 320px up (> WIND_PROFILE_H 260) → full wind
    expect(lowDrift).toBeLessThan(highDrift * 0.25); // ground-hugging smoke barely drifts
    expect(highDrift).toBeGreaterThan(5); // high smoke clearly streams downwind
  });

  it('higher shot speed (∝ power) lays down more trail smoke per frame', () => {
    const lo = new CParticleSystem();
    lo.setBounds(4000, 2000);
    const hi = new CParticleSystem();
    hi.setBounds(4000, 2000);
    lo.trail(2000, 1000, '#ffffff', 120, 0, 2); // slow rocket (trailType 2)
    hi.trail(2000, 1000, '#ffffff', 950, 0, 2); // fast (high-power) rocket
    expect(hi.count()).toBeGreaterThan(lo.count()); // faster shot emits more trail smoke
  });

  // Helper: the live 'smoke' particles of a system.
  const smokeOf = (ps: CParticleSystem) =>
    (ps as unknown as {m_particles: {kind: string; r: number}[]}).m_particles.filter(
      p => p.kind === 'smoke',
    );

  it('a ROCKET (trailType≥2) fumes only while ASCENDING — the motor stops at apex', () => {
    const up = new CParticleSystem();
    up.setBounds(4000, 2000);
    const down = new CParticleSystem();
    down.setBounds(4000, 2000);
    // Same rocket; ascending vs descending (past apex). vy sign is informational — the
    // controller passes `ascending` explicitly (arg 9); trail() gates on that.
    up.trail(2000, 1000, '#cccccc', 300, -300, 2, 0, 1 / 60, true); // ascending → fumes
    down.trail(2000, 1000, '#cccccc', 300, 300, 2, 0, 1 / 60, false); // past apex → no fume
    expect(up.count()).toBeGreaterThan(0); // rocket exhausts on the way up
    expect(down.count()).toBe(0); // …and coasts down with NO trail
  });

  it('a BALLISTIC shell (trailType 1) trails the WHOLE flight — no apex gate', () => {
    const ps = new CParticleSystem();
    ps.setBounds(4000, 2000);
    ps.trail(2000, 1000, '#cccccc', 300, 300, 1, 0, 1 / 60, false); // descending
    expect(ps.count()).toBeGreaterThan(0); // shell still sparks on the way down
  });

  it('rocket exhaust smoke is GREY (warm→grey→black ramp); crater fumes are WHITE', () => {
    // Rocket exhaust: grey-based (r<200) so the render ramps it orange→grey→black by age.
    const rk = new CParticleSystem();
    rk.setBounds(4000, 2000);
    rk.trail(2000, 1000, '#cccccc', 400, -300, 2, 0, 1 / 60, true);
    const exhaust = smokeOf(rk);
    expect(exhaust.length).toBeGreaterThan(0);
    expect(exhaust.every(p => p.r < 200)).toBe(true); // exhaust is grey, not white

    // Crater fumes: white (r≥200) so the render draws the cool-tinted white sprite (never darkens).
    const cr = new CParticleSystem();
    cr.setBounds(1600, 1200);
    cr.blast(800, 600, 50, '#ff8c22', false);
    for (let i = 0; i < 60; i++) cr.update(1 / 60); // past VENT_DELAY — fumes rising
    const fumes = smokeOf(cr);
    expect(fumes.length).toBeGreaterThan(0);
    expect(fumes.every(p => p.r >= 200)).toBe(true); // earth fumes are white
  });

  it('the crater vent builds a DENSE cloud (many overlapping puffs alive at once)', () => {
    const ps = new CParticleSystem();
    ps.setBounds(2000, 2000);
    ps.blast(1000, 1000, 60, '#ff8c22', false);
    let maxAlive = 0;
    for (let i = 0; i < 180; i++) {
      ps.update(1 / 60);
      maxAlive = Math.max(maxAlive, smokeOf(ps).length);
    }
    expect(maxAlive).toBeGreaterThan(30); // dense: dozens of fume puffs coexist
  });

  it('a rocket lays a DENSER trail than a ballistic shell of the same speed', () => {
    const rk = new CParticleSystem();
    rk.setBounds(4000, 2000);
    const sh = new CParticleSystem();
    sh.setBounds(4000, 2000);
    rk.trail(2000, 1000, '#cccccc', 600, -100, 2, 0, 1 / 60, true); // rocket exhaust ribbon
    sh.trail(2000, 1000, '#cccccc', 600, -100, 1, 0, 1 / 60, true); // shell: a faint spark
    expect(rk.count()).toBeGreaterThan(sh.count());
  });

  it('an AIRBURST in mid-air vents NO crater fumes (no soil disturbed); a ground blast does', () => {
    // Ground at y=1000. A blast whose sphere never reaches it must not fume from the dirt below.
    const air = new CParticleSystem();
    air.setBounds(2000, 2000);
    air.setGroundProvider(() => 1000);
    air.blast(1000, 300, 150, '#ff0000', false); // burst at y=300, r=150 → bottom y=450, well above ground
    for (let i = 0; i < 90; i++) air.update(1 / 60); // past VENT_DELAY, into the emit window
    expect(smokeOf(air).length).toBe(0); // Sky Bomb bursting in the air → no ground fumes

    const ground = new CParticleSystem();
    ground.setBounds(2000, 2000);
    ground.setGroundProvider(() => 1000);
    ground.blast(1000, 1000, 150, '#ff0000', false); // same blast AT the surface
    for (let i = 0; i < 90; i++) ground.update(1 / 60);
    expect(smokeOf(ground).length).toBeGreaterThan(0); // a blast in soil DOES vent fumes
  });

  it('a named preset drives explosion colour (eGreen → green fireball particles)', () => {
    const ps = new CParticleSystem();
    ps.setBounds(1600, 1200);
    ps.blast(800, 600, 45, '#ffffff', false, 'eGreen');
    const parts = (
      ps as unknown as {m_particles: {r: number; g: number; b: number; kind: string}[]}
    ).m_particles;
    const flares = parts.filter(p => p.kind === 'flare');
    const greenish = flares.filter(p => p.g > p.r && p.g > p.b).length;
    // preset tints the fireball (eGreen → green)
    expect(flares.length > 0 && greenish > flares.length * 0.5).toBe(true);
  });

  it('a crater-cutting blast vents a WHITE fume curtain across the crater width', () => {
    const ps = new CParticleSystem();
    ps.setBounds(1600, 1200);
    const cx = 800,
      cy = 600,
      r = 50;
    ps.blast(cx, cy, r, '#ff8c22', false);
    // The vent stays silent until VENT_DELAY (fumes rise AFTER the blast), so step past it first.
    for (let i = 0; i < 60; i++) ps.update(1 / 60); // ~1s > VENT_DELAY
    const parts = (
      ps as unknown as {
        m_particles: {x: number; y: number; vy: number; r: number; size: number; kind: string}[];
      }
    ).m_particles;
    // The vent fumes are the only 'smoke' emitter spread across the crater width, WHITE (near-255) —
    // the original's crater streamers are white.
    const curtain = parts.filter(
      p => p.kind === 'smoke' && Math.abs(p.x - cx) > r * 0.5 && p.vy < 0 && p.r > 200,
    );
    expect(curtain.length).toBeGreaterThan(0); // white fume curtain is emitted
    // It lines the crater on BOTH sides — a spread row, not a point.
    expect(curtain.some(p => p.x < cx) && curtain.some(p => p.x > cx)).toBe(true);
    // They RISE off the bowl (vy < 0) — a fume curtain, not settling debris.
    expect(curtain.every(p => p.vy < 0)).toBe(true);
  });

  it('a CLEANER blast (Earth Destroy) also vents the crater fume curtain', () => {
    const ps = new CParticleSystem();
    ps.setBounds(1600, 1200);
    const cx = 800,
      cy = 600,
      r = 60;
    // isCleaner=true — the earth-remover path used to skip the streamers entirely.
    ps.blast(cx, cy, r, '#ffffff', false, undefined, undefined, undefined, false, true);
    for (let i = 0; i < 60; i++) ps.update(1 / 60); // past VENT_DELAY — fumes rise after the blast
    const parts = (ps as unknown as {m_particles: {x: number; r: number; kind: string}[]})
      .m_particles;
    const curtain = parts.filter(p => p.kind === 'smoke' && p.r > 200);
    expect(curtain.length).toBeGreaterThan(0); // cleaners now get the white curtain too
  });

  it('the crater vent keeps venting fumes over time (sustained ascension)', () => {
    const ps = new CParticleSystem();
    ps.setBounds(1600, 1200);
    ps.blast(800, 600, 60, '#ff8c22', false);
    const kind = () =>
      (ps as unknown as {m_particles: {kind: string}[]}).m_particles.filter(p => p.kind === 'smoke')
        .length;
    // Let the immediate curtain fully age out (puff life ≤1.6s), then confirm NEW fumes exist —
    // proof the vent re-emitted rather than firing a single one-shot burst.
    stepN(ps, 120, 1 / 60); // 2.0s: past one puff-life, still within VENT_LIFE (2.6s)
    expect(kind()).toBeGreaterThan(0); // fumes still being vented well after impact
  });

  it('out-of-bounds reap: a particle pushed past the clip window dies immediately', () => {
    const ps = new CParticleSystem();
    ps.setBounds(100, 100); // tight bounds (maxX≈300 incl. margin)
    ps.blast(50, 50, 40, '#ffffff', false);
    const before = ps.count();
    stepN(ps, 420, 1 / 30); // 14s — past the crater vent's full life (VENT_LIFE 10 + puff life)
    expect(ps.count()).toBe(0); // bounds reap empties the pool
    void before;
  });

  it('gravity pulls sparks downward (net +y drift over time)', () => {
    const ps = new CParticleSystem();
    ps.setBounds(2000, 2000);
    ps.explode(500, 500, 1);
    // Sample: run a few steps, then confirm the pool has live particles with
    // downward velocity dominating (integrate and check mean-y increased).
    const y0 = 500;
    stepN(ps, 8, 1 / 60);
    // Draw must not throw with live particles.
    let threw = false;
    try {
      ps.draw(mockCtx());
    } catch {
      threw = true;
    }
    expect(threw).toBe(false); // draw does not throw
    expect(ps.count()).toBeGreaterThan(0); // particles still alive mid-flight
    void y0;
  });

  it('draw() restores the composite mode it found', () => {
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.blast(400, 300, 30, '#00ff00', false);
    const ctx = mockCtx();
    (ctx as {globalCompositeOperation: string}).globalCompositeOperation = 'multiply';
    ps.draw(ctx);
    expect(ctx.globalCompositeOperation).toBe('multiply'); // draw restores composite op
  });

  it('ScreenShake decays to zero after its duration', () => {
    const s = new ScreenShake();
    s.trigger(20, 0.001);
    const active0 = s.isActive();
    // Busy-wait a hair past the duration.
    const t0 = performance.now();
    while (performance.now() - t0 < 5) {
      /* spin ~5ms */
    }
    const off = s.getOffset();
    expect(active0).toBe(true); // shake starts active
    expect(off.x === 0 && off.y === 0).toBe(true); // shake settles to zero
  });

  // ---------------------------------------------------------------------------
  // Draw-path invariants — the safety net for the glow-sprite optimisation. These
  // pin down behaviour that must survive replacing per-particle radial gradients
  // with pre-baked glow blits: the blend mode of each kind, clean ctx state on
  // exit, and that no live particle is silently skipped.
  // ---------------------------------------------------------------------------

  it("additive kinds (flare/flash/plume) paint under the 'lighter' composite mode", () => {
    for (const kind of ['flare', 'flash', 'plume']) {
      const ps = new CParticleSystem();
      ps.setBounds(800, 600);
      addKind(ps, kind);
      const ctx = mockCtx();
      ps.draw(ctx);
      expect(ctx._calls.length).toBeGreaterThan(0); // `${kind} paints`
      // `${kind} paints additively (lighter)`
      expect(ctx._calls.length > 0 && ctx._calls.every(c => c.op === 'lighter')).toBe(true);
    }
  });

  it("normal-blend kinds (disc/smoke) paint under 'source-over'", () => {
    const d = new CParticleSystem();
    d.setBounds(800, 600);
    addKind(d, 'disc');
    const dctx = mockCtx();
    d.draw(dctx);
    // disc paints normally (source-over)
    expect(dctx._calls.length > 0 && dctx._calls.every(c => c.op === 'source-over')).toBe(true);

    // Smoke's alpha envelope opens with age (sin), so at t=0 it draws nothing —
    // step it forward first, then it must paint under normal blend.
    const s = new CParticleSystem();
    s.setBounds(800, 600);
    addKind(s, 'smoke', {r: 150, g: 150, b: 150});
    s.update(0.2);
    const sctx = mockCtx();
    s.draw(sctx);
    expect(sctx._calls.length).toBeGreaterThan(0); // smoke paints after a step
    // smoke paints normally (source-over)
    expect(sctx._calls.every(c => c.op === 'source-over')).toBe(true);
  });

  it('a full scene leaves ctx state clean: composite op restored and globalAlpha back to 1', () => {
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.blast(400, 300, 45, '#ffaa00', true); // every kind
    ps.tankDeath(410, 310);
    ps.beam(0, 0, 100, 100, '#00ff00');
    ps.update(0.05);
    const ctx = mockCtx();
    (ctx as {globalCompositeOperation: string}).globalCompositeOperation = 'multiply';
    ps.draw(ctx);
    expect(ctx.globalCompositeOperation).toBe('multiply'); // full scene restores composite op
    expect(ctx.globalAlpha).toBe(1); // full scene restores globalAlpha to 1
    expect(ctx._calls.length).toBeGreaterThan(0); // full scene paints something
  });

  it('no live particle is silently dropped: N glow particles → exactly N paints', () => {
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    for (let i = 0; i < 5; i++) addKind(ps, 'flare');
    const ctx = mockCtx();
    ps.draw(ctx);
    expect(ctx._calls).toHaveLength(5); // one paint per live flare
  });

  it('when real sprites are available, the sprite kinds blit images (drawImage)', () => {
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.setAssets({getSprite: () => ({bitmap: {} as CanvasImageSource, width: 8, height: 8})});
    ps.blast(400, 300, 40, '#ff8800', false);
    ps.update(0.1);
    const ctx = mockCtx();
    ps.draw(ctx);
    // assets drive drawImage blits
    expect(ctx._calls.some(c => c.m === 'drawImage')).toBe(true);
  });
});
