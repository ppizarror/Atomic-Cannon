/**
 * Atomic Cannon - entry point.
 *
 * The game renders to an offscreen 2D canvas; PixiJS presents it full-screen with
 * post-FX. Preact owns the DOM UI (HUD + screens) and reads live game state from
 * signals pumped once per frame. The two never touch each other's DOM.
 */
import './hud.css';
import { render } from 'preact';
import { CGameController } from './game/CGameController';
import { CPixiCompositor } from './core/rendering/CPixiCompositor';
import { CAudio } from './audio/CAudio';
import { App } from './ui/App';
import {
  setController, syncHud, canFire,
  POWER_MIN, POWER_MAX, ANGLE_MIN, ANGLE_MAX,
} from './ui/store';

async function main(): Promise<void> {
  const container = document.getElementById('game-container');
  const uiRoot = document.getElementById('ui-root');
  if (!container || !uiRoot) { console.error('Missing mount points'); return; }

  // Offscreen buffer sized to the WORLD area (above the HUD), not the viewport,
  // so the game renders above the HUD rather than behind it.
  const scene = document.createElement('canvas');
  scene.width = container.clientWidth || window.innerWidth;
  scene.height = container.clientHeight || window.innerHeight;

  const compositor = new CPixiCompositor();
  await compositor.init(scene, container);
  container.appendChild(compositor.app.canvas);

  const gameController = new CGameController(scene);
  gameController.setImpactListener((x, y, s) => compositor.shockwave(x, y, s));

  // Audio: one shared AudioContext (SFX + libopenmpt .it music), unlocked on the
  // first user gesture per the browser autoplay policy. Wired before startGame so
  // the combat preload + battle track kick off with the round.
  const audio = new CAudio();
  audio.attachUnlock(window);
  gameController.setAudio(audio);

  gameController.startGame(2);

  setController(gameController);
  render(<App />, uiRoot);

  // Pause: 'P' freezes the sim so a clean screenshot can be taken; 'P' resumes.
  // The frame keeps rendering while paused (only the simulation clock stops).
  let paused = false;

  // Keyboard shortcuts (the on-screen controls live in the Preact HUD).
  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyP') { e.preventDefault(); paused = !paused; return; }
    if (!canFire.value) return;
    switch (e.code) {
      case 'Space': e.preventDefault(); gameController.fire(); break;
      case 'ArrowLeft': gameController.setAngle(Math.max(ANGLE_MIN, gameController.getAngle() - 2)); break;
      case 'ArrowRight': gameController.setAngle(Math.min(ANGLE_MAX, gameController.getAngle() + 2)); break;
      case 'ArrowUp': gameController.setPower(Math.min(POWER_MAX, gameController.getPower() + 50)); break;
      case 'ArrowDown': gameController.setPower(Math.max(POWER_MIN, gameController.getPower() - 50)); break;
    }
  });

  // Drag-to-aim: click in the world and drag to set angle + power; release fires.
  // Map client coords to the scene's pixel space (it may be CSS-stretched).
  const toWorld = (e: PointerEvent): [number, number] => {
    const r = container.getBoundingClientRect();
    return [
      (e.clientX - r.left) * (scene.width / r.width),
      (e.clientY - r.top) * (scene.height / r.height),
    ];
  };
  let aiming = false;
  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const [wx, wy] = toWorld(e);
    if (gameController.beginAim(wx, wy)) aiming = true;
  });
  // Move/up on the window in the CAPTURE phase so they fire even though the Pixi
  // canvas captures the pointer (its handlers run after ours).
  window.addEventListener('pointermove', (e) => {
    const [wx, wy] = toWorld(e);
    gameController.setMouse(wx, wy);              // hover-detail on tank badges
    if (aiming) gameController.dragAim(wx, wy);
  }, true);
  // Release only commits the aim (angle/power) — it does NOT fire. Fire is the
  // FIRE button / Space.
  window.addEventListener('pointerup', () => {
    if (aiming) { aiming = false; gameController.endAim(false); }
  }, true);
  window.addEventListener('pointercancel', () => {
    if (aiming) { aiming = false; gameController.endAim(false); }
  }, true);

  // Keep the canvas fitted to the container. A ResizeObserver fires after layout
  // for ANY size change (window resize, devtools open/close, HUD height change) —
  // more reliable than the throttled window `resize` event. We coalesce bursts
  // into a single rAF so a fast drag doesn't thrash the renderer.
  let resizePending = false;
  const refit = () => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => { resizePending = false; compositor.resize(); });
  };
  new ResizeObserver(refit).observe(container);
  window.addEventListener('resize', refit);

  if (import.meta.env.DEV) {
    (window as unknown as { atomic: unknown }).atomic = { gameController, compositor, audio };
  }

  // Game loop — drive the sim, present, and pump UI signals. While paused we
  // skip the simulation step entirely (so nothing advances or emits) but keep
  // drawing/presenting so the frozen frame stays live for a screenshot.
  compositor.app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.1);
    if (!paused) gameController.update(dt);
    gameController.draw();
    compositor.update(paused ? 0 : dt);
    syncHud();
  });

  console.log('Atomic Cannon ready.');
}

main();
