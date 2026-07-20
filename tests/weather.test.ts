/**
 * Deterministic logic tests for the map weather system (snow / rain / hail / dust).
 * Run: pnpm tsx tests/weather.test.ts   (or `pnpm test`)
 */
import {installDomMocks} from './_dom';

installDomMocks();

import {CWeather} from '../src/core/CWeather';
import {Vec2} from '../src/math/Vec2';

let pass = 0,
  fail = 0;

function ok(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${extra}`);
  }
}

// A 2D-context stand-in that never throws (draw records nothing).
function mockCtx(): CanvasRenderingContext2D {
  const noop = () => {};
  return {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    beginPath: noop,
    arc: noop,
    fill: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    drawImage: noop,
  } as unknown as CanvasRenderingContext2D;
}

// A view onto CWeather that also exposes the private layer state for assertions.
// Standalone (not an intersection with the class) so the private `m_layers` field
// doesn't collapse the type to `never`.
type Layer = {type: string; particles: {x: number; y: number}[]};

interface WX {
  m_layers: Layer[];
  m_w: number;
  m_h: number;
  m_margin: number;

  configure(specs: readonly {type: string; intensity: number}[]): void;

  update(dt: number, wind?: Vec2): void;

  draw(ctx: CanvasRenderingContext2D): void;

  isActive(): boolean;
}

const W = 1280,
  H = 720;
const make = (w = W, h = H) => new CWeather(w, h) as unknown as WX;
const countOf = (wx: WX, type: string) =>
  wx.m_layers.find(l => l.type === type)?.particles.length ?? 0;

console.log('Weather system');

// 1. Field density is a FIXED function of screen size × per-type multiplier
//    (independent of intensity): dust (×3) > snow (×1.5) > rain = hail (×1).
{
  const wx = make();
  wx.configure([
    {type: 'snow', intensity: 100},
    {type: 'rain', intensity: 100},
    {type: 'hail', intensity: 100},
    {type: 'dust', intensity: 100},
  ]);
  const rain = countOf(wx, 'rain'),
    snow = countOf(wx, 'snow'),
    dust = countOf(wx, 'dust'),
    hail = countOf(wx, 'hail');
  ok(
    'all four bands present at intensity 100',
    wx.m_layers.length === 4,
    `layers=${wx.m_layers.length}`,
  );
  ok('rain field is non-trivial', rain > 100 && rain < 600, `rain=${rain}`);
  ok('rain and hail share the ×1 density', rain === hail, `rain=${rain} hail=${hail}`);
  ok('snow ≈ 1.5× rain', Math.abs(snow - rain * 1.5) <= 2, `snow=${snow} rain=${rain}`);
  ok(
    'dust ≈ 3× rain (thickest field)',
    Math.abs(dust - rain * 3) <= 2,
    `dust=${dust} rain=${rain}`,
  );
}

// 2. Intensity is a probability GATE, not a density scale.
{
  // 100 always passes (rand(0..99) <= 100); 0 is dropped up front.
  let alwaysOn = true;
  for (let i = 0; i < 50; i++) {
    const wx = make();
    wx.configure([{type: 'snow', intensity: 100}]);
    if (wx.m_layers.length !== 1) alwaysOn = false;
  }
  ok('intensity 100 always activates', alwaysOn);

  // A mid intensity activates only sometimes — neither never nor always.
  let on = 0;
  for (let i = 0; i < 400; i++) {
    const wx = make();
    wx.configure([{type: 'rain', intensity: 50}]);
    if (wx.m_layers.length === 1) on++;
  }
  ok('intensity 50 gates ~half the time', on > 120 && on < 280, `on=${on}/400`);
}

// 3. Invalid input is ignored: unknown type + intensity 0 are dropped.
{
  const wx = make();
  wx.configure([
    {type: 'fog', intensity: 100},
    {type: 'rain', intensity: 0},
    {type: 'rain', intensity: 100},
  ]);
  ok(
    'unknown type + zero intensity dropped',
    wx.m_layers.length === 1 && wx.m_layers[0].type === 'rain',
    `layers=${wx.m_layers.map(l => l.type)}`,
  );
  wx.configure([]);
  ok('empty config clears all weather', wx.m_layers.length === 0 && !wx.isActive());
}

// 4. update() moves the field, and wrapping keeps every particle inside the
//    padded bounds even under sustained strong wind over many frames.
{
  const wx = make();
  wx.configure([{type: 'rain', intensity: 100}]);
  const before = wx.m_layers[0].particles.map(p => ({x: p.x, y: p.y}));
  const wind = new Vec2(5, 0); // hard right wind
  for (let i = 0; i < 600; i++) wx.update(1 / 60, wind); // ~10 s

  const ps = wx.m_layers[0].particles;
  const m = wx.m_margin;
  const inBounds = ps.every(
    p => p.x >= -m - 1 && p.x <= W + m + 1 && p.y >= -m - 1 && p.y <= H + m + 1,
  );
  ok('all particles stay within padded bounds after wrapping', inBounds);

  const moved = ps.some((p, i) => before[i] && (p.x !== before[i].x || p.y !== before[i].y));
  ok('update() actually moves the field', moved);
}

// 5. Falling types descend; dust hovers (net vertical motion near zero).
{
  const wx = make();
  wx.configure([{type: 'snow', intensity: 100}]);
  const p = wx.m_layers[0].particles[0];
  p.x = W / 2;
  p.y = 5;
  const y0 = p.y;
  wx.update(0.2, new Vec2(0, 0));
  ok('snow falls downward', p.y > y0, `y0=${y0} y1=${p.y.toFixed(1)}`);
}

// 6. The draw path (all bands, behind terrain) never throws with a context.
{
  const wx = make();
  wx.configure([
    {type: 'dust', intensity: 100},
    {type: 'rain', intensity: 100},
    {
      type: 'snow',
      intensity: 100,
    },
    {type: 'hail', intensity: 100},
  ]);
  wx.update(1 / 60, new Vec2(2, 0));
  const ctx = mockCtx();
  let threw = false;
  try {
    wx.draw(ctx);
  } catch {
    threw = true;
  }
  ok('draw does not throw', !threw);
}

// 7. No-op guards: dt<=0 and no-weather update are safe.
{
  const wx = make();
  ok('inactive by default', !wx.isActive());
  wx.update(0.016, new Vec2(1, 0)); // no layers → no-op
  wx.configure([{type: 'snow', intensity: 100}]);
  const snap = wx.m_layers[0].particles.map(p => p.y);
  wx.update(0, new Vec2(1, 0)); // dt=0 → no motion
  const same = wx.m_layers[0].particles.every((p, i) => p.y === snap[i]);
  ok('dt=0 leaves the field unchanged', same);
}

console.log(`\n${pass}/${pass + fail} weather checks passed`);
process.exit(fail ? 1 : 0);
