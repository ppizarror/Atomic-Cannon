/**
 * CVictoryScene — the between-battles celebration painted over the world, split out of
 * CGameController: the twinkling backdrop stars and the flag planted beside the winning tank.
 *
 * Free functions rather than a class: neither holds state. The flag's whole animation is derived
 * from `sinceBattleEnd`, and the stars twinkle off the wall clock, so there is nothing to own.
 * Its sibling {@link CFireworks} DOES hold state (rockets and sparks in flight) and is a class.
 */
import {TWO_PI} from '../math/num';
import {rgbToHex} from '../math/color';

/** A tank, as the flag needs to see one — where to plant, and how big to draw. */
export interface FlagWinner {
  getPosition(): {x: number; y: number};
  getHitRadius(): number;
}

/** What the winner flag reads from the world. */
export interface VictoryEnv {
  /** The tank to plant beside, or null when there is no winner (a draw). */
  winner: FlagWinner | null;
  /** Seconds since the battle ended — drives the pole raise and the cloth wave. */
  sinceBattleEnd: number;
  camX: number;
  viewW: number;
  groundAt(x: number): number;
}

/** Background stars for atmosphere. */
export function drawStars(ctx: CanvasRenderingContext2D, nowMs: number): void {
  ctx.fillStyle = '#ffffff';

  // Static stars (seeded random)
  const starPositions = [
    [50, 30],
    [150, 60],
    [300, 25],
    [450, 80],
    [600, 40],
    [700, 55],
    [100, 100],
    [250, 120],
    [500, 90],
    [650, 110],
  ];

  for (const [x, y] of starPositions) {
    ctx.globalAlpha = 0.3 + Math.sin(nowMs / 1000 + x) * 0.2;
    ctx.beginPath();
    ctx.arc(x, y, 1, 0, TWO_PI);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

/** The winner flag (between battles): a red flag on a wooden pole that RISES up out
 *  of the terrain, then WAVES with a moving sheen — drawn procedurally. */
export function drawWinnerFlag(ctx: CanvasRenderingContext2D, env: VictoryEnv): void {
  const tank = env.winner;
  if (!tank) return;
  const pos = tank.getPosition();
  const r = tank.getHitRadius();
  // Plant on the side with screen room: if the tank sits on the RIGHT half of the view, put the
  // pole to its LEFT (dir=-1) so the flag can't run off the right edge and hide; otherwise to its
  // right. The cloth is mirrored by `dir` below so it always hangs AWAY from the hull.
  const dir = pos.x - env.camX > env.viewW / 2 ? -1 : 1;
  const fx = pos.x + dir * (r + 30); // pole a little clear of the hull, on the roomy side
  // Plant the pole ON the terrain (a hair below the surface so it doesn't float),
  // sampling the ground column right under the pole.
  const base = env.groundAt(fx) + 2;
  const poleH = r * 3.6; // full pole height above ground
  const fw = r * 2.0; // flag size
  const fh = r * 1.25;

  // Rise: the whole pole (with the flag at its top) grows up out of the ground over
  // RAISE seconds (ease-out); after that it just waves. Slower than a flick so the
  // raise reads as a deliberate planting.
  const RAISE = 1.8;
  const raise = Math.min(1, env.sinceBattleEnd / RAISE);
  const ease = 1 - (1 - raise) * (1 - raise);
  const poleTop = base - poleH * ease; // current top of the growing pole
  const flagTop = poleTop + 1; // flag hangs just under the finial
  const phase = env.sinceBattleEnd * 7; // wave speed (unchanged)
  const amp = fh * 0.16 * ease; // no flutter until it's up

  ctx.save();
  // Wooden pole (grows from the ground to poleTop) + a small cap finial.
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#7a4f2a'; // wood brown
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(fx, base);
  ctx.lineTo(fx, poleTop);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,225,190,0.5)'; // left-edge highlight for a rounded pole
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(fx - 0.7, base);
  ctx.lineTo(fx - 0.7, poleTop);
  ctx.stroke();
  ctx.fillStyle = '#5a3a1e';
  ctx.beginPath();
  ctx.arc(fx, poleTop, 2.2, 0, TWO_PI);
  ctx.fill();

  // Waving red flag: each vertical strip is offset by a sine that grows toward the
  // free (right) edge, and SHADED by the wave's local slope so light plays across the
  // cloth as it ripples — crests catch the light, troughs fall into shadow.
  const N = 14;
  const waveAt = (t: number) => Math.sin(t * TWO_PI - phase) * amp * t;
  for (let i = 0; i < N; i++) {
    const t0 = i / N,
      t1 = (i + 1) / N;
    const mid = (t0 + t1) / 2;
    // Sheen from the wave's slope (∝ cos of the sine's argument): +1 face-to-light → lit.
    const shade = Math.cos(mid * TWO_PI - phase) * mid; // stronger toward free edge
    const l = 0.82 + 0.42 * shade; // brightness multiplier (rgbToHex clamps the overshoot)
    ctx.fillStyle = rgbToHex(224 * l, 34 * l, 34 * l);
    ctx.beginPath();
    ctx.moveTo(fx + dir * fw * t0, flagTop + waveAt(t0));
    ctx.lineTo(fx + dir * (fw * t1 + 0.5), flagTop + waveAt(t1)); // +0.5 overlap hides seams
    ctx.lineTo(fx + dir * (fw * t1 + 0.5), flagTop + fh + waveAt(t1));
    ctx.lineTo(fx + dir * fw * t0, flagTop + fh + waveAt(t0));
    ctx.closePath();
    ctx.fill();
  }
  // Thin dark outline along the top + bottom edges for definition.
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(fx, flagTop);
  for (let i = 1; i <= N; i++) ctx.lineTo(fx + dir * fw * (i / N), flagTop + waveAt(i / N));
  ctx.moveTo(fx, flagTop + fh);
  for (let i = 1; i <= N; i++) ctx.lineTo(fx + dir * fw * (i / N), flagTop + fh + waveAt(i / N));
  ctx.stroke();
  ctx.restore();
}
