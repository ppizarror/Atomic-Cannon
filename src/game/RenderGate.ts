/**
 * RenderGate — invalidation-based present-on-demand for the game loop.
 *
 * The loop keeps ticking every frame (so the simulation, and any future
 * remote/networked or scheduled state, always advances), but the EXPENSIVE work —
 * the full 2D scene redraw and the GPU texture upload — is skipped on frames where
 * nothing visible changed. This is the standard "dirty flag" / render-on-demand
 * technique: cut idle CPU/GPU/battery without ever freezing live motion.
 *
 * Three inputs decide a frame:
 *   - markDirty()           — an explicit invalidation (input, resize, a state
 *                             change, a network update applied to the sim…).
 *   - `animating` argument  — true while real gameplay motion is on screen this
 *                             frame (shots, explosions, weather, moving tanks…).
 *                             This is what keeps multiplayer correct: a REMOTE
 *                             player's action mutates the sim → animating/dirty →
 *                             we redraw, even though the local player is idle.
 *   - a grace window        — purely-cosmetic idle loops (the bobbing turn arrow,
 *                             twinkling stars) keep redrawing for a short time after
 *                             the last interaction, then the idle scene is allowed
 *                             to go static. Any markDirty() resumes it instantly.
 *
 * Keeping this logic in a canvas-free class makes the decision unit-testable
 * (the controller that owns it needs a DOM canvas and cannot run under the test
 * runner).
 */
export class RenderGate {
  private m_dirty = true;              // explicit invalidation; true at start so the first frame draws
  private m_wasAnimating = true;       // draw ONE trailing frame after motion stops (the resting frame)
  private m_lastInteractMs = -Infinity;

  /** @param m_graceMs how long cosmetic idle animation keeps redrawing after the last interaction. */
  constructor(private readonly m_graceMs = 1500) {}

  /**
   * Invalidate: the next frame must be redrawn. `nowMs` (performance.now()) stamps
   * the interaction so cosmetic loops keep animating through the grace window.
   */
  markDirty(nowMs: number): void {
    this.m_dirty = true;
    this.m_lastInteractMs = nowMs;
  }

  /**
   * Decide whether to redraw + re-upload this frame, and consume the one-shot dirty
   * flag. Call exactly once per frame.
   *
   * @param paused    frozen sim — draw ONLY on an explicit invalidation (cosmetic
   *                  loops and gameplay motion are frozen, so ignore them).
   * @param animating true if gameplay motion is on screen this frame.
   * @param nowMs     performance.now().
   */
  shouldRedraw(paused: boolean, animating: boolean, nowMs: number): boolean {
    if (paused) {
      const d = this.m_dirty;
      this.m_dirty = false;
      return d;
    }
    const withinGrace = nowMs - this.m_lastInteractMs < this.m_graceMs;
    const need = this.m_dirty || animating || this.m_wasAnimating || withinGrace;
    this.m_wasAnimating = animating;
    this.m_dirty = false;
    return need;
  }
}
