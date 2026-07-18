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
  gameController.startGame(2);

  setController(gameController);
  render(<App />, uiRoot);

  // Keyboard shortcuts (the on-screen controls live in the Preact HUD).
  document.addEventListener('keydown', (e) => {
    if (!canFire.value) return;
    switch (e.code) {
      case 'Space': e.preventDefault(); gameController.fire(); break;
      case 'ArrowLeft': gameController.setAngle(Math.max(ANGLE_MIN, gameController.getAngle() - 2)); break;
      case 'ArrowRight': gameController.setAngle(Math.min(ANGLE_MAX, gameController.getAngle() + 2)); break;
      case 'ArrowUp': gameController.setPower(Math.min(POWER_MAX, gameController.getPower() + 5)); break;
      case 'ArrowDown': gameController.setPower(Math.max(POWER_MIN, gameController.getPower() - 5)); break;
    }
  });

  window.addEventListener('resize', () => compositor.resize());

  if (import.meta.env.DEV) {
    (window as unknown as { atomic: unknown }).atomic = { gameController, compositor };
  }

  // Game loop — drive the sim, present, and pump UI signals.
  compositor.app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.1);
    gameController.update(dt);
    gameController.draw();
    compositor.update(dt);
    syncHud();
  });

  console.log('Atomic Cannon ready.');
}

main();
