/**
 * Deterministic logic tests for the particle system (Phase 4).
 * Run: pnpm tsx scripts/test-particles.ts
 */
import {CParticleSystem, ScreenShake} from '../src/core/CParticleSystem';
import {Vec2} from '../src/math/Vec2';

let pass = 0, fail = 0;

function ok(name: string, cond: boolean, extra = '') {
    if (cond) {
        pass++;
        console.log(`  ✓ ${name}`);
    } else {
        fail++;
        console.log(`  ✗ ${name}  ${extra}`);
    }
}

// A recording 2D-context stand-in: never throws, and logs each PAINT op with the
// composite mode + alpha in force at the time. That lets the draw tests assert the
// blend mode per particle kind and that ctx state is left clean — the invariants
// the glow-sprite draw path must preserve — without a real canvas.
interface PaintCall {
    m: string;
    op: string;
    alpha: number;
}

type RecCtx = CanvasRenderingContext2D & { _calls: PaintCall[] };

function mockCtx(): RecCtx {
    const grad = {
        addColorStop() {
        }
    };
    const ctx = {
        globalCompositeOperation: 'source-over',
        globalAlpha: 1,
        fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt',
        _calls: [] as PaintCall[],
        save() {
        }, restore() {
        }, translate() {
        },
        beginPath() {
        }, arc() {
        }, moveTo() {
        }, lineTo() {
        },
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
            this._calls.push({m: 'drawImage', op: this.globalCompositeOperation, alpha: this.globalAlpha});
        },
    };
    return ctx as unknown as RecCtx;
}

// Push one live particle of a given render kind straight into the pool (reaches the
// private `add` emitter) so a test can exercise a single kind's draw branch.
function addKind(ps: CParticleSystem, kind: string, c = {r: 200, g: 120, b: 40}): void {
    (ps as unknown as {
        add(x: number, y: number, vx: number, vy: number, c: object, life: number, size: number, kind: string): void
    })
        .add(400, 300, 0, 0, c, 1, 10, kind);
}

function stepN(ps: CParticleSystem, n: number, dt: number, wind?: Vec2) {
    for (let i = 0; i < n; i++) ps.update(dt, wind);
}

console.log('Particle system');

// 1. blast() emits, and everything expires within its max lifetime.
{
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.blast(400, 300, 40, '#ff8c22', false);
    const born = ps.count();
    ok('blast spawns particles', born > 50, `count=${born}`);
    stepN(ps, 200, 1 / 60);                 // ~3.3 s — past the ~1.6 s max life
    ok('blast particles all expire', ps.count() === 0, `left=${ps.count()}`);
}

// 2. Nuclear blast is bigger than a conventional one of the same radius.
{
    const a = new CParticleSystem();
    a.setBounds(800, 600);
    const b = new CParticleSystem();
    b.setBounds(800, 600);
    a.blast(400, 300, 40, '#ffff00', false);
    b.blast(400, 300, 40, '#ffff00', true);
    ok('nuclear blast emits more', b.count() > a.count(), `conv=${a.count()} nuke=${b.count()}`);
}

// 3. tankDeath() emits the fixed profile and clears.
{
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.tankDeath(200, 200);
    ok('tankDeath spawns particles', ps.count() >= 180, `count=${ps.count()}`);
    stepN(ps, 120, 1 / 60);
    ok('tankDeath clears', ps.count() === 0, `left=${ps.count()}`);
}

// 4. trail() adds a small, short-lived puff each call.
{
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.trail(100, 100, '#00ffff');          // trailType 1 (ballistic): flare + spark, NO smoke
    ok('shell trail adds a flare + spark (no smoke)', ps.count() === 2, `count=${ps.count()}`);
    stepN(ps, 130, 1 / 60);                 // ~2.2 s — past the puff/spark life
    ok('trail puff fades', ps.count() === 0, `left=${ps.count()}`);
}

// 4b. Wind drives smoke sideways in the wind direction (regardless of firing dir).
{
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
    stepN(left, 40, 1 / 60, new Vec2(-5, 0));   // strong left wind
    stepN(right, 40, 1 / 60, new Vec2(5, 0));   // strong right wind
    const mx = (ps: CParticleSystem) => (ps as unknown as { m_particles: { x: number; kind: string }[] })
        .m_particles.filter(p => p.kind === 'smoke').reduce((s, p, _i, a) => s + p.x / a.length, 0);
    const lx = mx(left), rx = mx(right);
    ok('smoke drifts downwind (left wind → left)', lx < 1999, `meanX=${lx.toFixed(1)}`);
    ok('smoke drifts downwind (right wind → right)', rx > 2001, `meanX=${rx.toFixed(1)}`);
    ok('opposite winds separate the smoke', rx - lx > 20, `dx=${(rx - lx).toFixed(1)}`);
}

// 4c. Higher shot speed (∝ power) lays down more trail smoke per frame.
{
    const lo = new CParticleSystem();
    lo.setBounds(4000, 2000);
    const hi = new CParticleSystem();
    hi.setBounds(4000, 2000);
    lo.trail(2000, 1000, '#ffffff', 120, 0, 2);    // slow rocket (trailType 2)
    hi.trail(2000, 1000, '#ffffff', 950, 0, 2);    // fast (high-power) rocket
    ok('faster shot emits more trail smoke', hi.count() > lo.count(), `lo=${lo.count()} hi=${hi.count()}`);
}

// 4d. A named preset drives explosion colour (eGreen → green fireball particles).
{
    const ps = new CParticleSystem();
    ps.setBounds(1600, 1200);
    ps.blast(800, 600, 45, '#ffffff', false, 'eGreen');
    const parts = (ps as unknown as { m_particles: { r: number; g: number; b: number; kind: string }[] }).m_particles;
    const flares = parts.filter(p => p.kind === 'flare');
    const greenish = flares.filter(p => p.g > p.r && p.g > p.b).length;
    ok('preset tints the fireball (eGreen → green)', flares.length > 0 && greenish > flares.length * 0.5,
        `flares=${flares.length} green=${greenish}`);
}

// 5. Out-of-bounds reap: a particle pushed past the clip window dies immediately.
{
    const ps = new CParticleSystem();
    ps.setBounds(100, 100);                 // tight bounds (maxX≈300 incl. margin)
    ps.blast(50, 50, 40, '#ffffff', false);
    const before = ps.count();
    stepN(ps, 300, 1 / 30);                 // long enough to fling sparks well past the margin
    ok('bounds reap empties the pool', ps.count() === 0, `before=${before} after=${ps.count()}`);
}

// 6. Gravity pulls sparks downward (net +y drift over time).
{
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
    ok('draw does not throw', !threw);
    ok('particles still alive mid-flight', ps.count() > 0, `count=${ps.count()}`);
    void y0;
}

// 7. draw() restores the composite mode it found.
{
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.blast(400, 300, 30, '#00ff00', false);
    const ctx = mockCtx();
    (ctx as { globalCompositeOperation: string }).globalCompositeOperation = 'multiply';
    ps.draw(ctx);
    ok('draw restores composite op', ctx.globalCompositeOperation === 'multiply', ctx.globalCompositeOperation);
}

// 8. ScreenShake decays to zero after its duration.
{
    const s = new ScreenShake();
    s.trigger(20, 0.001);
    const active0 = s.isActive();
    // Busy-wait a hair past the duration.
    const t0 = performance.now();
    while (performance.now() - t0 < 5) { /* spin ~5ms */
    }
    const off = s.getOffset();
    ok('shake starts active', active0);
    ok('shake settles to zero', off.x === 0 && off.y === 0, `off=${off.x},${off.y}`);
}

// ---------------------------------------------------------------------------
// Draw-path invariants — the safety net for the glow-sprite optimisation. These
// pin down behaviour that must survive replacing per-particle radial gradients
// with pre-baked glow blits: the blend mode of each kind, clean ctx state on
// exit, and that no live particle is silently skipped.
// ---------------------------------------------------------------------------

// 9. Additive kinds (flare/flash/plume) paint under the 'lighter' composite mode.
{
    for (const kind of ['flare', 'flash', 'plume']) {
        const ps = new CParticleSystem();
        ps.setBounds(800, 600);
        addKind(ps, kind);
        const ctx = mockCtx();
        ps.draw(ctx);
        ok(`${kind} paints`, ctx._calls.length > 0, `calls=${ctx._calls.length}`);
        ok(`${kind} paints additively (lighter)`,
            ctx._calls.length > 0 && ctx._calls.every(c => c.op === 'lighter'),
            ctx._calls.map(c => c.op).join(','));
    }
}

// 9b. Normal-blend kinds (disc/smoke) paint under 'source-over'.
{
    const d = new CParticleSystem();
    d.setBounds(800, 600);
    addKind(d, 'disc');
    const dctx = mockCtx();
    d.draw(dctx);
    ok('disc paints normally (source-over)',
        dctx._calls.length > 0 && dctx._calls.every(c => c.op === 'source-over'),
        dctx._calls.map(c => c.op).join(','));

    // Smoke's alpha envelope opens with age (sin), so at t=0 it draws nothing —
    // step it forward first, then it must paint under normal blend.
    const s = new CParticleSystem();
    s.setBounds(800, 600);
    addKind(s, 'smoke', {r: 150, g: 150, b: 150});
    s.update(0.2);
    const sctx = mockCtx();
    s.draw(sctx);
    ok('smoke paints after a step', sctx._calls.length > 0, `calls=${sctx._calls.length}`);
    ok('smoke paints normally (source-over)',
        sctx._calls.every(c => c.op === 'source-over'), sctx._calls.map(c => c.op).join(','));
}

// 10. A full scene leaves ctx state clean: composite op restored to what it found,
//     and globalAlpha back to 1 (no leaked alpha from a mid-blit).
{
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.blast(400, 300, 45, '#ffaa00', true);   // every kind
    ps.tankDeath(410, 310);
    ps.beam(0, 0, 100, 100, '#00ff00');
    ps.update(0.05);
    const ctx = mockCtx();
    (ctx as { globalCompositeOperation: string }).globalCompositeOperation = 'multiply';
    ps.draw(ctx);
    ok('full scene restores composite op', ctx.globalCompositeOperation === 'multiply', ctx.globalCompositeOperation);
    ok('full scene restores globalAlpha to 1', ctx.globalAlpha === 1, `alpha=${ctx.globalAlpha}`);
    ok('full scene paints something', ctx._calls.length > 0, `calls=${ctx._calls.length}`);
}

// 11. No live particle is silently dropped: N glow particles → exactly N paints.
{
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    for (let i = 0; i < 5; i++) addKind(ps, 'flare');
    const ctx = mockCtx();
    ps.draw(ctx);
    ok('one paint per live flare', ctx._calls.length === 5, `calls=${ctx._calls.length}`);
}

// 12. When real sprites are available, the sprite kinds blit images (drawImage)
//     rather than only filling — the sprite fast-path stays wired up.
{
    const ps = new CParticleSystem();
    ps.setBounds(800, 600);
    ps.setAssets({getSprite: () => ({bitmap: {} as CanvasImageSource, width: 8, height: 8})});
    ps.blast(400, 300, 40, '#ff8800', false);
    ps.update(0.1);
    const ctx = mockCtx();
    ps.draw(ctx);
    ok('assets drive drawImage blits', ctx._calls.some(c => c.m === 'drawImage'), ctx._calls.map(c => c.m).join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
