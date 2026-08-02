/**
 * CHitMarkers — the two optional readouts that mark where a shot landed, split out of
 * CGameController: the floating damage numbers ("Show Points") and the blast-radius rings
 * ("Show Blast Circles").
 *
 * Both are pure feedback: spawned on a hit, aged, drawn over the world, gone. Nothing else in the
 * game reads them, which is why this owns its state outright and needs nothing back — the only
 * thing it borrows is a bitmap-text draw, because game text is never CSS/`fillText` (see
 * `BitmapFont`).
 */
import {TWO_PI} from '../math/num';
import {GameConfig} from '../core/CGameConfig';

const MARKER = {
  /** "Show Blast Circles": how long each explosion ring lingers (s). */
  BLAST_CIRCLE_LIFE: 1.4,
  /** "Show Points" floating damage numbers: life (s) and rise distance over that life (px). */
  DMG_NUM_LIFE: 1.1,
  DMG_NUM_RISE: 28,
} as const;

interface DamageNumber {
  x: number;
  y: number;
  text: string;
  age: number;
}

interface BlastCircle {
  x: number;
  y: number;
  r: number;
  age: number;
}

/** Draws one line of centred bitmap text — the controller's shared text blit. */
export type CenteredTextFn = (text: string, cx: number, cy: number, alpha: number) => void;

export class CHitMarkers {
  private m_numbers: DamageNumber[] = [];
  private m_circles: BlastCircle[] = [];

  clear(): void {
    this.m_numbers = [];
    this.m_circles = [];
  }

  /** Anything still rising or fading (keeps the render gate awake). */
  hasAny(): boolean {
    return this.m_numbers.length > 0 || this.m_circles.length > 0;
  }

  /** Float a damage number off a hit tank. No-op when "Show Points" is off or the hit was a graze
   *  (sub-1 damage), matching the original's threshold. The scatter keeps stacked hits legible. */
  spawnDamage(pos: {x: number; y: number}, amount: number): void {
    if (!GameConfig.showPoints || amount < 1) return;
    this.m_numbers.push({
      x: pos.x + (Math.random() * 40 - 20),
      y: pos.y + (Math.random() * 24 - 12),
      text: String(Math.round(amount)),
      age: 0,
    });
  }

  /** Ring an explosion at its damage radius ("Show Blast Circles"). */
  spawnCircle(x: number, y: number, radiusPx: number): void {
    this.m_circles.push({x, y, r: radiusPx, age: 0});
  }

  /** Age both sets, dropping the expired. */
  update(dt: number): void {
    if (this.m_numbers.length) {
      for (const d of this.m_numbers) d.age += dt;
      this.m_numbers = this.m_numbers.filter(d => d.age < MARKER.DMG_NUM_LIFE);
    }
    if (this.m_circles.length) {
      for (const c of this.m_circles) c.age += dt;
      this.m_circles = this.m_circles.filter(c => c.age < MARKER.BLAST_CIRCLE_LIFE);
    }
  }

  /** Damage numbers: rise and fade over their life. */
  drawNumbers(drawText: CenteredTextFn): void {
    for (const d of this.m_numbers) {
      const t = d.age / MARKER.DMG_NUM_LIFE;
      drawText(d.text, d.x, d.y - t * MARKER.DMG_NUM_RISE, 1 - t);
    }
  }

  /** Blast rings: a dark ring under a light one so they read on any terrain, both fading out. */
  drawCircles(ctx: CanvasRenderingContext2D): void {
    for (const c of this.m_circles) {
      const a = Math.max(0, 1 - c.age / MARKER.BLAST_CIRCLE_LIFE);
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = `rgba(0,0,0,${0.5 * a})`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, TWO_PI);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${0.9 * a})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, TWO_PI);
      ctx.stroke();
      ctx.restore();
    }
  }
}
