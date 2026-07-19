/**
 * Deterministic logic tests for the map weather system (snow / rain / hail / dust).
 * Run: pnpm tsx tests/weather.test.ts   (or `pnpm test`)
 */
import { installDomMocks } from './_dom';
installDomMocks();

import { CWeather } from '../src/core/CWeather';
import { Vec2 } from '../src/math/Vec2';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
}

// A 2D-context stand-in that never throws (draw records nothing).
function mockCtx(): CanvasRenderingContext2D {
  const noop = () => {};
  return {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt',
    beginPath: noop, arc: noop, fill: noop, moveTo: noop, lineTo: noop, stroke: noop,
    drawImage: noop,
  } as unknown as CanvasRenderingContext2D;
}

// Reach into the private layer state for assertions.
type Layer = { type: string; particles: { x: number; y: number }[] };
type WX = CWeather & { m_layers: Layer[]; m_w: number; m_h: number; m_margin: number };

const W = 1280, H = 720;

console.log('Weather system');

// 1. configure() builds one layer per valid band; count scales with intensity.
{
  const wx = new CWeather(W, H) as WX;
  wx.configure([{ type: 'snow', intensity: 100 }]);
  const full = wx.m_layers[0].particles.length;
  ok('snow layer created', wx.m_layers.length === 1 && wx.m_layers[0].type === 'snow', `layers=${wx.m_layers.length}`);
  ok('full-intensity snow has a dense field', full > 150 && full < 400, `count=${full}`);

  wx.configure([{ type: 'snow', intensity: 50 }]);
  const half = wx.m_layers[0].particles.length;
  ok('intensity halves the count (±10%)', Math.abs(half - full / 2) < full * 0.1, `half=${half} full=${full}`);
}

// 2. Multiple bands coexist (a map can declare snow + hail).
{
  const wx = new CWeather(W, H) as WX;
  wx.configure([{ type: 'snow', intensity: 60 }, { type: 'hail', intensity: 70 }]);
  ok('two bands coexist', wx.m_layers.length === 2, `layers=${wx.m_layers.length}`);
  ok('bands are snow + hail', wx.m_layers.map(l => l.type).sort().join(',') === 'hail,snow');
}

// 3. Invalid input is ignored: unknown type + intensity 0 are dropped.
{
  const wx = new CWeather(W, H) as WX;
  wx.configure([{ type: 'fog', intensity: 100 }, { type: 'rain', intensity: 0 }, { type: 'rain', intensity: 40 }]);
  ok('unknown type + zero intensity dropped', wx.m_layers.length === 1 && wx.m_layers[0].type === 'rain', `layers=${wx.m_layers.map(l => l.type)}`);
  wx.configure([]);
  ok('empty config clears all weather', wx.m_layers.length === 0 && !wx.isActive());
}

// 4. update() moves the field, and wrapping keeps every particle inside the
//    padded bounds even under sustained strong wind over many frames.
{
  const wx = new CWeather(W, H) as WX;
  wx.configure([{ type: 'rain', intensity: 80 }]);
  const before = wx.m_layers[0].particles.map(p => ({ x: p.x, y: p.y }));
  const wind = new Vec2(5, 0);   // hard right wind
  for (let i = 0; i < 600; i++) wx.update(1 / 60, wind);   // ~10 s

  const ps = wx.m_layers[0].particles;
  const m = wx.m_margin;
  const inBounds = ps.every(p => p.x >= -m - 1 && p.x <= W + m + 1 && p.y >= -m - 1 && p.y <= H + m + 1);
  ok('all particles stay within padded bounds after wrapping', inBounds);

  const moved = ps.some((p, i) => before[i] && (p.x !== before[i].x || p.y !== before[i].y));
  ok('update() actually moves the field', moved);
}

// 5. Falling types descend; dust hovers (net vertical motion near zero).
{
  const wx = new CWeather(W, H) as WX;
  wx.configure([{ type: 'snow', intensity: 100 }]);
  // Freeze one particle at a known spot and step without wrapping interference.
  const p = wx.m_layers[0].particles[0];
  p.x = W / 2; p.y = 5;
  const y0 = p.y;
  wx.update(0.2, new Vec2(0, 0));
  ok('snow falls downward', p.y > y0, `y0=${y0} y1=${p.y.toFixed(1)}`);
}

// 6. Draw paths (background dust + foreground precip) never throw with a context.
{
  const wx = new CWeather(W, H) as WX;
  wx.configure([{ type: 'dust', intensity: 100 }, { type: 'rain', intensity: 50 }, { type: 'snow', intensity: 50 }, { type: 'hail', intensity: 50 }]);
  wx.update(1 / 60, new Vec2(2, 0));
  const ctx = mockCtx();
  let threw = false;
  try { wx.drawBackground(ctx); wx.drawForeground(ctx); } catch { threw = true; }
  ok('draw does not throw', !threw);
}

// 7. No-op guards: dt<=0 and no-weather update are safe.
{
  const wx = new CWeather(W, H) as WX;
  ok('inactive by default', !wx.isActive());
  wx.update(0.016, new Vec2(1, 0));   // no layers → no-op
  wx.configure([{ type: 'snow', intensity: 30 }]);
  const snap = wx.m_layers[0].particles.map(p => p.y);
  wx.update(0, new Vec2(1, 0));       // dt=0 → no motion
  const same = wx.m_layers[0].particles.every((p, i) => p.y === snap[i]);
  ok('dt=0 leaves the field unchanged', same);
}

console.log(`\n${pass}/${pass + fail} weather checks passed`);
process.exit(fail ? 1 : 0);
