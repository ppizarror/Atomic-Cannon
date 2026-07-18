/**
 * Atomic Cannon - Web Port Main Entry Point
 * 
 * Initializes canvas, UI controls, and starts game loop.
 */

import { CGameController } from './game/CGameController';

console.log('Atomic Cannon initializing...');

// ============================================================================
// INITIALIZATION
// ============================================================================

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

if (!canvas) {
  console.error('Could not find game canvas');
} else {
  
  // Create main game controller
  const gameController = new CGameController(canvas);
  
  // Start a new game with 2 players (1 human, 1 bot)
  gameController.startGame(2);

  // ============================================================================
  // UI CONTROL HANDLERS
  // ============================================================================

  // Angle slider control
  const angleSlider = document.getElementById('angle-slider') as HTMLInputElement;
  const angleValue = document.getElementById('angle-value');

  if (angleSlider && angleValue) {
    angleSlider.addEventListener('input', () => {
      const angle = parseInt(angleSlider.value);
      
      // Clamp to valid range for left/right aiming
      let displayAngle = angle;
      const tank = gameController.getCurrentTank();
      const pos = tank?.getPosition() ?? { x: 400 };
      
      // If angle > 90, it's pointing right. Adjust visual if needed.
      angleValue.textContent = String(Math.floor(displayAngle));
      
      gameController.setAngle(angle);
    });
  }

  // Power slider control
  const powerSlider = document.getElementById('power-slider') as HTMLInputElement;
  const powerValue = document.getElementById('power-value');

  if (powerSlider && powerValue) {
    powerSlider.addEventListener('input', () => {
      const power = parseInt(powerSlider.value);
      powerValue.textContent = String(power);
      
      gameController.setPower(power);
    });
  }

  // Fire button
  const fireBtn = document.getElementById('fire-btn');

  if (fireBtn) {
    fireBtn.addEventListener('click', () => {
      if (gameController.isPlayerTurn()) {
        gameController.fire();
        
        // Re-enable controls after shot completes via animation loop check
      }
    });
  }

  // Keyboard shortcuts for firing
  document.addEventListener('keydown', (e) => {
    if (!gameController.isPlayerTurn()) return;
    
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (gameController.isPlayerTurn()) {
          gameController.fire();
        }
        break;
        
      case 'ArrowLeft':
        angleSlider.value = String(Math.max(0, parseInt(angleSlider.value) - 2));
        if (angleValue) angleValue.textContent = angleSlider.value;
        gameController.setAngle(parseInt(angleSlider.value));
        break;
        
      case 'ArrowRight':
        angleSlider.value = String(Math.min(180, parseInt(angleSlider.value) + 2));
        if (angleValue) angleValue.textContent = angleSlider.value;
        gameController.setAngle(parseInt(angleSlider.value));
        break;
        
      case 'ArrowUp':
        powerSlider.value = String(Math.min(100, parseInt(powerSlider.value) + 5));
        if (powerValue) powerValue.textContent = powerSlider.value;
        gameController.setPower(parseInt(powerSlider.value));
        break;
        
      case 'ArrowDown':
        powerSlider.value = String(Math.max(10, parseInt(powerSlider.value) - 5));
        if (powerValue) powerValue.textContent = powerSlider.value;
        gameController.setPower(parseInt(powerSlider.value));
        break;
    }
  });

  // ============================================================================
  // GAME LOOP
  // ============================================================================

  let lastTime = performance.now();

  function gameLoop(currentTime: number): void {
    // Calculate delta time in seconds
    const dt = Math.min((currentTime - lastTime) / 1000, 0.1); // Cap at 100ms to prevent spiral of death
    lastTime = currentTime;

    // Update and render
    gameController.update(dt);
    gameController.draw();

    // Continue loop
    requestAnimationFrame(gameLoop);
  }

  // Start the game loop
  console.log('Game started! Use arrow keys to aim, Space or click FIRE to shoot.');
  requestAnimationFrame(gameLoop);

}
