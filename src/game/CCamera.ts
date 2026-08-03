/**
 * CCamera — the horizontal scroll position, split out of CGameController.
 *
 * The world is wider than the view on anything but a 1-screen map, so the scene scrolls in X only
 * (world height == view height). This owns where the view sits, how it eases toward a target, and
 * the minimap strip that lets the player drag it about.
 *
 * It deliberately does NOT decide WHAT to look at: the controller computes the follow target (a
 * shot in flight, the impact, the acting tank, the victor) and passes it in. Camera = how we get
 * there; controller = where we're going.
 *
 * It also owns the detonation SHAKE. Scroll and shake are both "where the view is this frame" —
 * one eased and persistent, one transient and decaying — so a caller asks one object rather than
 * combining two. Shake belongs here, with the scroll it composes with, not in the particle system.
 */
import {clamp, lerp} from '../math/num';
import {plusMinus} from '../math/random';

export const CAMERA = {
  /** Where the followed object sits in the view: 0.5 = dead centre. */
  CENTER: 0.5,
  /** Cinematic: how long the camera lingers on the impact before it pans away. */
  DWELL_SEC: 0.8,
  /** Pan speed (world px/sec) — the constant-speed ease toward the follow target (the original
   *  scrolls at dt·gameSpeed·scrollSpeed; this is that budget in px/sec). Fast enough to keep a
   *  shot roughly framed without whipping. */
  SCROLL_SPEED: 1100,
  /** Graphics → Camera: how the view moves to the next player when the turn hands off. Matches the
   *  gfx.camera enum order (0 Smooth — the implicit default, just ease across / 1 Instant /
   *  2 Cinematic). */
  MODE_CINEMATIC: 2,
  MODE_INSTANT: 1,
} as const;

/** The world/view dimensions the camera measures itself against. */
export interface CameraBounds {
  worldWidth: number;
  viewW: number;
  viewH: number;
}

/** Minimap strip geometry (scene px). */
export interface MinimapRect {
  m: number;
  width: number;
  height: number;
}

export class CCamera {
  private m_x = 0;
  /** Scroll position at the START of the current fixed sim step — the other end of the render
   *  interpolation (see {@link xAt}). Kept in sync by every write to m_x that is a TELEPORT
   *  (reset / centerOn / a minimap drag) so those snap instead of sliding across the map. */
  private m_prevX = 0;
  private m_targetX = 0;
  /** Cinematic dwell: seconds still to linger on the impact before the pan is released. */
  private m_dwell = 0;
  /** The player grabbed the minimap — auto-follow yields until the next fire/turn. */
  private m_manual = false;
  // Detonation shake: peak offset, how long it decays over, and when it started. Timed on the WALL
  // clock (performance.now), NOT the sim clock — it is a presentation effect, and a headless run
  // that sims faster than real time must stub performance.now or every shake reads as permanently
  // active (which wedges the Explosion → endTurn hand-off).
  private m_shakeIntensity = 0;
  private m_shakeDuration = 0;
  private m_shakeStart = 0;

  /** World X of the view's left edge — the SIM value, for input→world mapping and follow logic. */
  x(): number {
    return this.m_x;
  }

  /**
   * World X of the view's left edge for DRAWING, interpolated across the fixed sim step by `alpha`
   * (see CGameController.renderAlpha). The pan runs at up to SCROLL_SPEED px/s, so a 60 Hz sim
   * moves the whole scene in ~18px jumps; on a 120 Hz display that judders the entire world, not
   * just whatever the camera is chasing. Interpolating here is what makes an interpolated
   * projectile actually look smooth — it is the shot's frame of reference, and only their RELATIVE
   * motion is visible. Pass the same alpha to both, and to any overlay drawn over the world, or
   * they drift apart by up to a step's worth of pan.
   */
  xAt(alpha: number): number {
    return lerp(this.m_prevX, this.m_x, alpha);
  }

  /** True while the view is still easing toward its target (keeps the render gate awake). */
  isPanning(): boolean {
    return this.m_x !== this.m_targetX;
  }

  /**
   * True while the DRAWN scroll position has not yet caught up with the sim's (see {@link xAt}).
   * Also keeps the render gate awake: the render trails the sim by up to one step, so a pan that
   * has just reached its target still has that last fraction of easing left to show. Without this
   * the gate shuts the moment isPanning() goes false and the world is stranded up to one step's
   * worth of pan short of the camera — visible as a small jerk, and worse, clicks map through the
   * SIM position and would land offset from what is on screen. Clears on the first step after the
   * pan settles, when update() copies m_x into m_prevX and finds nothing left to move.
   */
  isInterpolating(): boolean {
    return this.m_prevX !== this.m_x;
  }

  isManualScroll(): boolean {
    return this.m_manual;
  }

  /** Hand control back to auto-follow (a new turn / a shot fired). */
  releaseManualScroll(): void {
    this.m_manual = false;
  }

  /** Start the Cinematic lingering-on-the-impact beat. */
  startDwell(sec: number = CAMERA.DWELL_SEC): void {
    this.m_dwell = sec;
  }

  /** True while the Cinematic dwell is still holding the view on the impact. */
  isDwelling(): boolean {
    return this.m_dwell > 0;
  }

  /** Reset for a fresh match. */
  reset(): void {
    this.m_x = this.m_prevX = this.m_targetX = 0;
    this.m_dwell = 0;
    this.m_manual = false;
  }

  // ---- DETONATION SHAKE --------------------------------------------------

  /** Kick the view: `intensity` px of peak offset, decaying linearly over `durationSec`. */
  shake(intensity: number, durationSec: number): void {
    this.m_shakeIntensity = intensity;
    this.m_shakeDuration = durationSec;
    this.m_shakeStart = performance.now() / 1000;
  }

  /** This frame's shake offset — a fresh random jitter scaled by the remaining decay, {0,0} once
   *  it has run out. Called at draw time, so it is deliberately NOT memoised per frame. */
  shakeOffset(): {x: number; y: number} {
    const elapsed = performance.now() / 1000 - this.m_shakeStart;
    if (elapsed > this.m_shakeDuration) return {x: 0, y: 0};
    const maxOffset = this.m_shakeIntensity * (1 - elapsed / this.m_shakeDuration);
    return {x: plusMinus(maxOffset), y: plusMinus(maxOffset)};
  }

  /** Still shaking — holds the render gate open and defers the turn hand-off. */
  isShaking(): boolean {
    return performance.now() / 1000 - this.m_shakeStart < this.m_shakeDuration;
  }

  /** Widest the view can scroll; 0 when the world fits (no scroll, hence no minimap). */
  maxX(b: CameraBounds): number {
    return Math.max(0, b.worldWidth - b.viewW);
  }

  private clampX(x: number, b: CameraBounds): number {
    return clamp(x, 0, this.maxX(b));
  }

  /**
   * Ease toward `followX` — constant speed, snapping when within one step (matching the original,
   * which is NOT a proportional lerp). Skipped while the player manually scrolls via the minimap
   * or Auto Scroll is off; the result is always clamped to the world.
   */
  update(dt: number, followX: number, autoScroll: boolean, b: CameraBounds): void {
    this.m_prevX = this.m_x; // anchor this step's render interpolation before anything moves
    if (this.m_dwell > 0) this.m_dwell -= dt; // linger on the impact, then release the pan
    if (this.maxX(b) === 0) {
      this.m_x = this.m_targetX = 0;
      return;
    }
    if (autoScroll && !this.m_manual) {
      this.m_targetX = this.clampX(followX - b.viewW * CAMERA.CENTER, b);
      const step = CAMERA.SCROLL_SPEED * dt;
      const d = this.m_targetX - this.m_x;
      this.m_x = Math.abs(d) <= step ? this.m_targetX : this.m_x + Math.sign(d) * step;
    }
    this.m_x = this.clampX(this.m_x, b);
  }

  /** Snap to centre `worldX` immediately (battle start / recenter). */
  centerOn(worldX: number, b: CameraBounds): void {
    this.m_targetX = this.clampX(worldX - b.viewW * CAMERA.CENTER, b);
    this.m_x = this.m_prevX = this.m_targetX; // a snap, not a pan — leave nothing to interpolate from
  }

  // ---- MINIMAP STRIP -----------------------------------------------------
  // The camera's own control widget.

  /** Is there a minimap at all? Only when the world is wider than the view. */
  hasMinimap(b: CameraBounds): boolean {
    return b.worldWidth > b.viewW;
  }

  /**
   * Minimap strip rect (px) — top-left, ~half the view wide (`width = viewWidth/2 − 19`).
   * For a wide (>320) view the strip is 48px tall, or 64px at large-display scale. Our canvas is
   * always a large display, so we take the 64px height — 48 leaves the strip over-elongated.
   */
  rect(b: CameraBounds): MinimapRect {
    const Vw = b.viewW;
    const m = Vw < 240 ? 2 : Vw > 320 ? 4 : 3;
    const height = Vw < 240 ? 24 : Vw > 320 ? 64 : 29;
    const width = Math.floor(Vw / 2 - (Vw < 240 ? 8 : 19));
    return {m, width, height};
  }

  /** Fraction of the view width the battle-status text must clear — 0 when there's no minimap.
   *  In the original the per-tank life lines sit to the RIGHT of the overview strip. */
  rightFrac(b: CameraBounds): number {
    if (!this.hasMinimap(b)) return 0;
    const r = this.rect(b);
    return (r.m + r.width + 6) / b.viewW;
  }

  /** True when scene-pixel (px, py) is inside the minimap strip (false if no minimap). */
  hitStrip(px: number, py: number, b: CameraBounds): boolean {
    if (!this.hasMinimap(b)) return false;
    const r = this.rect(b);
    return px >= r.m && px <= r.m + r.width && py >= r.m && py <= r.m + r.height;
  }

  /** True when (px, py) is inside the minimap's extents box — the draggable viewport handle
   *  (the translucent rectangle). This is what shows the grab cursor and starts a pan; the rest
   *  of the strip is inert. */
  hitBox(px: number, py: number, b: CameraBounds): boolean {
    if (!this.hasMinimap(b)) return false;
    const r = this.rect(b);
    const sx = r.width / b.worldWidth;
    const boxX = r.m + this.m_x * sx;
    const boxW = b.viewW * sx;
    return px >= boxX && px <= boxX + boxW && py >= r.m && py <= r.m + r.height;
  }

  /**
   * Drag/click the minimap to pan: a scene-pixel X on the strip snaps the camera so the picked
   * world column is centred (`camX = ((mouseX − m)/width)·W − viewWidth/2`, clamped). Instant (no
   * easing) and sets the manual-scroll override so auto-follow yields until the next fire/turn.
   * Returns whether it actually panned (so the caller can mark the scene dirty).
   */
  panFrom(px: number, b: CameraBounds): boolean {
    if (!this.hasMinimap(b)) return false;
    const r = this.rect(b);
    const cam = ((px - r.m) / r.width) * b.worldWidth - b.viewW * CAMERA.CENTER;
    this.m_x = this.m_prevX = this.m_targetX = this.clampX(cam, b); // instant drag — no interpolation
    this.m_manual = true;
    return true;
  }
}
