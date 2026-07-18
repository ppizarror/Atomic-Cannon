/**
 * Atomic Cannon - entry point.
 *
 * The game renders to an offscreen 2D canvas; PixiJS presents that buffer
 * full-screen and runs post-effects (the impact shockwave). HUD controls are
 * plain HTML layered over the Pixi canvas.
 */

import { CGameController } from './game/CGameController';
import { CPixiCompositor } from './core/rendering/CPixiCompositor';

async function main(): Promise<void> {
  const container = document.getElementById('game-container');
  if (!container) { console.error('Missing #game-container'); return; }

  // Offscreen buffer the game draws into, sized to the viewport.
  const scene = document.createElement('canvas');
  scene.width = window.innerWidth;
  scene.height = window.innerHeight;

  // Presentation layer (Pixi owns the visible canvas).
  const compositor = new CPixiCompositor();
  await compositor.init(scene);
  container.appendChild(compositor.app.canvas);

  const gameController = new CGameController(scene);
  gameController.setImpactListener((x, y, strength) => compositor.shockwave(x, y, strength));
  gameController.startGame(2);

  // --- HUD controls -------------------------------------------------------
  const angleSlider = document.getElementById('angle-slider') as HTMLInputElement;
  const angleValue = document.getElementById('angle-value');
  angleSlider?.addEventListener('input', () => {
    if (angleValue) angleValue.textContent = angleSlider.value;
    gameController.setAngle(parseInt(angleSlider.value));
  });

  const powerSlider = document.getElementById('power-slider') as HTMLInputElement;
  const powerValue = document.getElementById('power-value');
  powerSlider?.addEventListener('input', () => {
    if (powerValue) powerValue.textContent = powerSlider.value;
    gameController.setPower(parseInt(powerSlider.value));
  });

  document.getElementById('fire-btn')?.addEventListener('click', () => {
    if (gameController.isPlayerTurn()) gameController.fire();
  });

  document.addEventListener('keydown', (e) => {
    if (!gameController.isPlayerTurn()) return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        gameController.fire();
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        const step = e.code === 'ArrowLeft' ? -2 : 2;
        angleSlider.value = String(Math.min(180, Math.max(0, parseInt(angleSlider.value) + step)));
        if (angleValue) angleValue.textContent = angleSlider.value;
        gameController.setAngle(parseInt(angleSlider.value));
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const step = e.code === 'ArrowUp' ? 5 : -5;
        powerSlider.value = String(Math.min(100, Math.max(10, parseInt(powerSlider.value) + step)));
        if (powerValue) powerValue.textContent = powerSlider.value;
        gameController.setPower(parseInt(powerSlider.value));
        break;
      }
    }
  });

  window.addEventListener('resize', () => compositor.resize());

  // Dev-only handle for debugging in the console (stripped from production).
  if (import.meta.env.DEV) {
    (window as unknown as { atomic: unknown }).atomic = { gameController, compositor };
  }

  // --- Game loop (driven by Pixi's ticker) --------------------------------
  compositor.app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.1);
    gameController.update(dt);
    gameController.draw();
    compositor.update(dt);
  });

  console.log('Atomic Cannon ready — aim with the sliders/arrows, Space or FIRE to shoot.');
}

main();
