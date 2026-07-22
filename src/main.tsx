/**
 * Atomic Cannon - entry point.
 *
 * The game renders to an offscreen 2D canvas; PixiJS presents it full-screen with
 * post-FX. Preact owns the DOM UI (HUD + screens) and reads live game state from
 * signals pumped once per frame. The two never touch each other's DOM.
 */
import './hud.css';
import {render} from 'preact';
import {CGameController, EGameType} from './game/CGameController';
import {CPixiCompositor} from './core/rendering/CPixiCompositor';
import {CAudio} from './audio/CAudio';
import {App} from './ui/App';
import {applyGameSettings} from './ui/applySettings';
import {resolveAction} from './core/CControls';
import {bindings} from './ui/controlsStore';
import {stepWeapon} from './ui/Hud';
import {
  setController,
  syncHud,
  canFire,
  openDepot,
  closeDepot,
  showDepot,
  triggerHudWave,
  paused as pausedSignal,
  openPauseMenu,
  resumeGame,
  showPause,
  goToMenu,
  playNewGame,
  openSettings,
  openSettingsPage,
  openPlaySetup,
  showHelp,
  closeHelp,
  showFramerate,
  fps,
  POWER_MIN,
  POWER_MAX,
  wrapAngle,
} from './ui/store';

async function main(): Promise<void> {
  const container = document.getElementById('game-container');
  const uiRoot = document.getElementById('ui-root');
  if (!container || !uiRoot) {
    console.error('Missing mount points');
    return;
  }

  // Offscreen buffer sized to the WORLD area (above the HUD), not the viewport,
  // so the game renders above the HUD rather than behind it.
  const scene = document.createElement('canvas');
  scene.width = container.clientWidth || window.innerWidth;
  scene.height = container.clientHeight || window.innerHeight;

  const compositor = new CPixiCompositor();
  await compositor.init(scene, container);
  container.appendChild(compositor.app.canvas);

  const gameController = new CGameController(scene);
  gameController.setImpactListener((x, y, s) => {
    // The impact is in WORLD coords; the compositor warps in scene (screen) pixels,
    // so subtract the camera scroll (Y never scrolls) or a large-map blast warps in
    // the wrong place / off-screen.
    compositor.shockwave(x - gameController.getCameraX(), y, s); // warp the game scene (WebGL)
    triggerHudWave(s); // and ripple the DOM HUD in sync (SVG displacement)
  });

  // Audio: one shared AudioContext (SFX + libopenmpt .it music), unlocked on the
  // first user gesture per the browser autoplay policy. Wired before startGame so
  // the combat preload + battle track kick off with the round.
  const audio = new CAudio();
  audio.loadSettings();
  audio.attachUnlock(window);
  gameController.setAudio(audio);

  // Push the saved Settings into the controller so the boot match — and everything
  // after — honours them (difficulty, wind, land shape, credits, …).
  applyGameSettings(gameController);

  // Initialise a battle up front (land + tanks) so the sim is ready, then open the
  // main menu over it — Play starts a fresh round.
  gameController.startGame(2);

  setController(gameController);
  render(<App />, uiRoot);
  goToMenu();

  // Dev/review-only URL affordances. These are gated to a
  // DEV build — a deployed/production bundle ignores them entirely (`import.meta.env.DEV`
  // is statically false there, so this whole block is tree-shaken out).
  if (import.meta.env.DEV) {
    // `?battle=1` skips the menu into a battle; `?depot=1` / `?pause=1` do that and
    // then open the depot / pause menu; `?settings=1` opens the Settings screen.
    const q = new URLSearchParams(location.search);
    const weaponTest = q.get('weapon_test') === '1';
    const weaponSel = q.get('weapon_sel'); // force a weapon by its 1-based id
    // `?flatland=1`: force a perfectly flat test surface (set BEFORE playNewGame generates
    // terrain) so weapon/terrain effects can be judged without natural slopes in the way.
    if (q.get('flatland') === '1') gameController.setFlatLand(true);
    if (
      q.get('battle') === '1' ||
      q.get('depot') === '1' ||
      q.get('pause') === '1' ||
      weaponTest ||
      weaponSel !== null
    )
      playNewGame();
    if (q.get('depot') === '1') openDepot();
    if (q.get('pause') === '1') openPauseMenu();
    // `?weapon_test=1`: start a battle and keep the turn on the human forever (the AI
    // never fires, the shot timer is off) so weapons can be tried back-to-back.
    if (weaponTest) gameController.setWeaponTest(true);
    // `?weapon_sel=<id>`: force the human onto weapon <id> with unlimited ammo. `id`
    // is the weapon's STABLE 1-based id (database position + 1) — the same number now
    // shown next to it in the arsenal list (`weaponDisplayNumber`), so what you read in
    // the list is exactly what you pass here, regardless of which weapons are disabled.
    if (weaponSel !== null) {
      const id = parseInt(weaponSel, 10);
      if (Number.isInteger(id) && id >= 1) gameController.forceWeapon(id - 1);
    }
    // `?settings=1` opens the Settings root; `?settings=<pageId>` (e.g. gameplay)
    // opens that option page directly.
    const settingsArg = q.get('settings');
    if (settingsArg) {
      openSettings('menu');
      if (settingsArg !== '1') openSettingsPage(settingsArg);
    }
    // `?setup=1` opens the Play game-setup screen.
    if (q.get('setup') === '1') openPlaySetup();
    // `?endtest=battle|war`: jump into a 6-team Deathmatch and force it to end, to preview
    // the standings — `battle` = a between-battles screen (war NOT over), `war` = the war-end
    // screen (Victory! banner + fireworks + "exit to menu"). Forces the game type + battle
    // count so the outcome is deterministic regardless of the persisted settings.
    const endtest = q.get('endtest');
    if (endtest === 'battle' || endtest === 'war') {
      playNewGame(); // enter the battle screen
      gameController.setHumanCount(1);
      gameController.startGame(6); // respawn as a 6-team free-for-all
      gameController.setGameType(EGameType.Deathmatch); // the "war" concept is Deathmatch-only
      gameController.setTotalBattles(endtest === 'war' ? 1 : 5); // 1 battle = war over → Victory
      gameController.devForceBattleEnd();
    }
  }

  // Pause lives in the shared `pausedSignal` (store) so the P-key freeze, the ESC
  // pause menu, and the DOM FX all read one source. 'P' = a quiet screenshot freeze
  // (no menu); ESC = the pause menu (Resume / Settings / Quit).

  // Jet-flight steering: held-key state (arrows / WASD), pushed to the controller
  // each event. Only acts while the game is in the Flying state.
  const thrust = {up: false, left: false, right: false};
  const isFlying = () => gameController.getState() === 'flying';
  const pushThrust = () => gameController.setJetInput(thrust.up, thrust.left, thrust.right);
  const thrustKey = (code: string): 'up' | 'left' | 'right' | null =>
    code === 'ArrowUp' || code === 'KeyW'
      ? 'up'
      : code === 'ArrowLeft' || code === 'KeyA'
        ? 'left'
        : code === 'ArrowRight' || code === 'KeyD'
          ? 'right'
          : null;

  // Keyboard shortcuts (the on-screen controls live in the Preact HUD). Gameplay
  // actions are resolved through the player's key bindings (Customize Controls); the
  // pressed key maps to an action, so rebinding takes effect immediately.
  document.addEventListener('keydown', e => {
    const action = resolveAction(bindings.value, e.code);

    if (e.code === 'KeyP') {
      e.preventDefault();
      const p = !pausedSignal.value;
      gameController.setPaused(p);
      pausedSignal.value = p; // freeze DOM FX (HUD ripple) too
      return;
    }

    // The Exit action (Escape by default) backs out of the topmost overlay: Help, then
    // the depot, then the pause menu; with none open it opens the pause menu. Escape is
    // always honoured as a fallback so an unbound/rebound Exit can never lock the player
    // out of the menu.
    if (action === 'exit' || e.code === 'Escape') {
      e.preventDefault();
      if (showHelp.value) closeHelp();
      else if (showDepot.value) closeDepot();
      else if (showPause.value) resumeGame();
      else openPauseMenu();
      return;
    }

    // While flying, arrows/WASD are thrust and Space cuts the engine (ends flight).
    // Jet steering is a fixed port control, independent of the artillery bindings.
    if (isFlying()) {
      const dir = thrustKey(e.code);
      if (dir) {
        e.preventDefault();
        thrust[dir] = true;
        pushThrust();
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        gameController.cutJet();
        return;
      }
      return;
    }

    if (!canFire.value) return;
    switch (action) {
      case 'fire':
        e.preventDefault();
        gameController.fire();
        break;
      // Aim left = increase angle (CCW), aim right = decrease; both wrap at 0/359.
      case 'aimLeft':
        gameController.setAngle(wrapAngle(gameController.getAngle() + 2));
        break;
      case 'aimRight':
        gameController.setAngle(wrapAngle(gameController.getAngle() - 2));
        break;
      case 'powerUp':
        gameController.setPower(Math.min(POWER_MAX, gameController.getPower() + 50));
        break;
      case 'powerDown':
        gameController.setPower(Math.max(POWER_MIN, gameController.getPower() - 50));
        break;
      case 'prevWeapon':
        e.preventDefault();
        stepWeapon(-1);
        break;
      case 'nextWeapon':
        e.preventDefault();
        stepWeapon(1);
        break;
      case 'taunt':
        e.preventDefault();
        gameController.playerTaunt();
        break;
    }
  });

  // Release thrust keys (and clear all thrust when flight ends).
  document.addEventListener('keyup', e => {
    const dir = thrustKey(e.code);
    if (dir) {
      thrust[dir] = false;
      pushThrust();
    }
  });

  // Client coords → the scene's pixel space (SCREEN space; the canvas may be
  // CSS-stretched). The minimap lives here. Adding the camera scroll gives WORLD
  // space, where aiming/hover happen (Y never scrolls).
  const toScene = (e: PointerEvent): [number, number] => {
    const r = container.getBoundingClientRect();
    return [
      (e.clientX - r.left) * (scene.width / r.width),
      (e.clientY - r.top) * (scene.height / r.height),
    ];
  };
  const toWorld = (e: PointerEvent): [number, number] => {
    const [sx, sy] = toScene(e);
    return [sx + gameController.getCameraX(), sy];
  };
  let aiming = false;
  let minimapDrag = false; // grabbed the minimap → panning the camera (suppresses aim)
  container.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const [sx, sy] = toScene(e);
    // Minimap first: only the extents box (the viewport handle) starts a pan-drag;
    // the rest of the strip is inert but still swallows the click so it never aims.
    if (gameController.hitMinimap(sx, sy)) {
      if (gameController.hitMinimapBox(sx, sy)) {
        minimapDrag = true;
        container.style.cursor = 'grabbing'; // closed hand while panning
        gameController.panFromMinimap(sx);
      }
      return;
    }
    const [wx, wy] = toWorld(e);
    if (gameController.beginAim(wx, wy)) aiming = true;
  });
  // Move/up on the window in the CAPTURE phase so they fire even though the Pixi
  // canvas captures the pointer (its handlers run after ours).
  window.addEventListener(
    'pointermove',
    e => {
      const [sx, sy] = toScene(e);
      if (minimapDrag) {
        gameController.panFromMinimap(sx); // continuous pan while held
        return;
      }
      // Only the extents box (the draggable handle) shows the open-hand cursor.
      if (!aiming) container.style.cursor = gameController.hitMinimapBox(sx, sy) ? 'grab' : '';
      const [wx, wy] = toWorld(e);
      gameController.setMouse(wx, wy); // hover-detail on tank badges
      if (aiming) gameController.dragAim(wx, wy);
    },
    true,
  );
  // Release only commits the aim (angle/power) — it does NOT fire. Fire is the
  // FIRE button / Space.
  window.addEventListener(
    'pointerup',
    e => {
      if (minimapDrag) {
        minimapDrag = false;
        // Released the pan: open hand if still over the box handle, else default.
        const [sx, sy] = toScene(e);
        container.style.cursor = gameController.hitMinimapBox(sx, sy) ? 'grab' : '';
      }
      if (aiming) {
        aiming = false;
        gameController.endAim(false);
      }
    },
    true,
  );
  window.addEventListener(
    'pointercancel',
    () => {
      minimapDrag = false;
      container.style.cursor = '';
      if (aiming) {
        aiming = false;
        gameController.endAim(false);
      }
    },
    true,
  );

  // Keep the canvas fitted to the container. A ResizeObserver fires after layout
  // for ANY size change (window resize, devtools open/close, HUD height change) —
  // more reliable than the throttled window `resize` event. We coalesce bursts
  // into a single rAF so a fast drag doesn't thrash the renderer.
  let resizePending = false;
  const refit = () => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      compositor.resize();
    });
  };
  new ResizeObserver(refit).observe(container);
  window.addEventListener('resize', refit);

  if (import.meta.env.DEV) {
    (window as unknown as {atomic: unknown}).atomic = {gameController, compositor, audio};
  }

  // Game loop — drive the sim, present, and pump UI signals. While paused we skip
  // the simulation step entirely (nothing advances or emits); the present-on-demand
  // gate then draws the frozen frame once and skips subsequent identical frames (the
  // GPU texture retains it, so a screenshot still works).
  // FPS readout state: averaged over a ~0.5s window (below), not the per-frame value
  // which wobbles (e.g. 119↔120) and reads as flicker. Persists across frames.
  let fpsFrames = 0,
    fpsAccumMs = 0;
  compositor.app.ticker.add(ticker => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.1);
    if (!pausedSignal.value) gameController.update(dt);
    // Present-on-demand: the loop always ticks (so the sim keeps advancing), but the
    // full 2D redraw + GPU texture upload are skipped on frames where nothing visible
    // changed. The shockwave still advances every call (it warps the already-uploaded
    // texture on the GPU), so it animates over a static scene without a re-upload.
    const redraw = gameController.shouldRedraw();
    if (redraw) gameController.draw();
    compositor.update(pausedSignal.value ? 0 : dt, redraw);
    syncHud();
    // FPS readout (Show Framerate): average frames over a ~0.5s window so the number is
    // steady (the per-frame value flickers, e.g. 119↔120), updating the counter at most
    // ~twice a second and only when the rounded value actually changes.
    if (showFramerate.value) {
      fpsFrames++;
      fpsAccumMs += ticker.deltaMS;
      if (fpsAccumMs >= 500) {
        const f = Math.round((fpsFrames * 1000) / fpsAccumMs);
        if (f !== fps.peek()) fps.value = f;
        fpsFrames = 0;
        fpsAccumMs = 0;
      }
    } else if (fpsFrames || fpsAccumMs) {
      fpsFrames = 0; // hidden → reset so re-enabling starts a fresh, clean window
      fpsAccumMs = 0;
    }
  });

  console.log('Atomic Cannon ready.');
}

main();
