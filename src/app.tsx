/**
 * Atomic Cannon - the app itself: builds the compositor, controller, audio and UI, then runs
 * the frame loop.
 *
 * The game renders to an offscreen 2D canvas; PixiJS presents it full-screen with
 * post-FX. Preact owns the DOM UI (HUD + screens) and reads live game state from
 * signals pumped once per frame. The two never touch each other's DOM.
 *
 * Deliberately NOT the entry module. `main.tsx` imports this DYNAMICALLY, after profile sync has
 * had its chance to pull a newer cloud save into localStorage — every store here seeds its signal
 * from storage at import time, so the pull has to finish before this module is even loaded.
 */
import {render} from 'preact';
import {effect} from '@preact/signals';
import {CGameController, EGameType} from './game/CGameController';
import {GameConfig} from './core/CGameConfig';
import {CLand} from './core/CLand';
import {CPixiCompositor} from './core/rendering/CPixiCompositor';
import {CAudio} from './audio/CAudio';
import {App} from './ui/App';
import {applyGameSettings} from './ui/applySettings';
import {watchDocumentMeta} from './ui/documentMeta';
import {resolveAction} from './core/CControls';
import {bindings} from './ui/controlsStore';
import {stepWeapon} from './ui/Hud';
import {initProfileSync} from './ui/syncStore';
import {
  setController,
  syncHud,
  screen,
  canFire,
  openDepot,
  triggerHudWave,
  paused as pausedSignal,
  openPauseMenu,
  goToMenu,
  playNewGame,
  openSettings,
  openSettingsPage,
  openPlaySetup,
  initRouter,
  watchViewport,
  escapeBack,
  showFramerate,
  fps,
  showFrameCount,
  frameCount,
  maxFps,
  POWER_MIN,
  POWER_MAX,
  wrapAngle,
} from './ui/store';

export async function startApp(): Promise<void> {
  // ========================================================================
  // DOM ROOTS & VIEWPORT
  // ========================================================================

  const container = document.getElementById('game-container');
  const uiRoot = document.getElementById('ui-root');
  if (!container || !uiRoot) {
    console.error('Missing mount points');
    return;
  }

  // Decide mobile-vs-desktop HUD and stamp the <html>.mobile class FIRST, so the
  // mobile --hud-h (a much shorter bar) is in effect before we read the container
  // height below. The scene buffer + controller capture the world's render
  // resolution from that height at boot; if the class stamped later, the world
  // would be sized for the tall desktop bar and then stretched into the shorter
  // mobile container — a permanent vertical blur until the next resize/reload.
  watchViewport();

  // ========================================================================
  // SCENE BUFFER & COMPOSITOR
  // ========================================================================

  // Offscreen buffer sized to the WORLD area (above the HUD), not the viewport,
  // so the game renders above the HUD rather than behind it.
  const scene = document.createElement('canvas');
  scene.width = container.clientWidth || window.innerWidth;
  scene.height = container.clientHeight || window.innerHeight;

  const compositor = new CPixiCompositor();
  await compositor.init(scene, container);
  container.appendChild(compositor.app.canvas);

  // ========================================================================
  // FOREGROUND FX OVERLAY
  // ========================================================================

  // Foreground FX overlay: a FULL-viewport 2D canvas layered ABOVE the HUD (see
  // #fx-overlay in hud.css). The world scene stops at the HUD's top edge, so the
  // dynamic foreground — tank life-bars/stats, damage numbers, and the blast
  // fireball/particles — is painted here instead so it renders over the HUD, like
  // the original's single screen buffer. Pointer-transparent (clicks pass to the HUD).
  const fx = document.createElement('canvas');
  fx.id = 'fx-overlay';
  document.body.appendChild(fx);
  const fxCtx = fx.getContext('2d')!;
  const sizeFx = () => {
    // CSS-pixel backing store, matching the world scene canvas (which is also sized
    // in CSS px), so foreground draws stay pixel-aligned with the presented world.
    fx.width = window.innerWidth;
    fx.height = window.innerHeight;
  };
  sizeFx();

  // ========================================================================
  // GAME CONTROLLER
  // ========================================================================

  const gameController = new CGameController(scene);
  // Smoke bypasses the 2D scene canvas and is batched on the GPU — drawing the layer as thousands
  // of individual drawImage calls is the dominant cost of a heavy frame.
  gameController.setSmokeSink(compositor);
  gameController.setImpactListener((x, y, s) => {
    // The shockwave maps world→screen against the controller's fixed LOGICAL size (which the
    // scene is authored in), not the native canvas size, so keep the compositor in sync here.
    compositor.setWorldSize(gameController.getViewWidth(), gameController.getViewHeight());
    // The impact is in WORLD coords; the compositor warps in scene (screen) pixels,
    // so subtract the camera scroll (Y never scrolls) or a large-map blast warps in
    // the wrong place / off-screen.
    compositor.shockwave(x - gameController.getCameraX(), y, s); // warp the game scene (WebGL)
    triggerHudWave(s); // and ripple the DOM HUD in sync (SVG displacement)
  });

  // ========================================================================
  // AUDIO
  // ========================================================================

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

  // Arm profile sync's change watcher. AFTER the stores have seeded (they did, at import) and
  // after `bootSync` already resolved this device against the cloud in main.tsx — arming it any
  // earlier would read that pull's own writes as player edits and immediately re-upload them.
  // A device with no linked profile installs the listener and never sends anything.
  initProfileSync();

  // Do NOT build a battle at boot. The main menu is an opaque title screen, so generating
  // terrain, spawning tanks and warming the combat SFX/music behind it is pure waste — and
  // the sim/render/HUD loops all short-circuit on `isStarted()` until a match begins. Play /
  // Quick Play (and the dev URL flags below) call startGame(), which builds the world then.
  setController(gameController);
  render(<App />, uiRoot);
  goToMenu();

  // Put the document itself in the player's language (tab title, <html lang>, share tags) and
  // keep it there across language switches + screen changes. index.html ships the English copy
  // for crawlers; this is the live-document half. AFTER goToMenu on purpose: `screen` starts on
  // 'battle' (the boot title screen), so stamping earlier would title the tab "— Playing" for
  // the whole async boot — and leave it there if the compositor never comes up.
  watchDocumentMeta();

  // ========================================================================
  // DEV URL AFFORDANCES
  // ========================================================================

  // Dev/review-only URL affordances. These are gated to a
  // DEV build — a deployed/production bundle ignores them entirely (`import.meta.env.DEV`
  // is statically false there, so this whole block is tree-shaken out).
  if (import.meta.env.DEV) {
    // Expose the controller for headless review probes (screenshot/inspect the live sim).
    (window as unknown as {__gc: unknown}).__gc = gameController;
    // Read the dev flags underscore-INSENSITIVELY so both the current spellings (`weapontest`,
    // `weaponsel`, `flatland`, `skiptexture`, …) and the older underscored ones (`weapon_test`,
    // `weapon_sel`, …) work — a renamed flag shouldn't silently break existing dev bookmarks. Only
    // this lookup is normalised; `window.location.search` is untouched, so the router still
    // preserves the raw query verbatim in the URL.
    const rawQ = new URLSearchParams(location.search);
    const q = new URLSearchParams();
    for (const [k, v] of rawQ) q.set(k.replace(/_/g, ''), v);
    // `?battle=1` skips the menu into a battle; `?depot=1` / `?pause=1` do that and
    // then open the depot / pause menu; `?settings=1` opens the Settings screen.
    const weaponTest = q.get('weapontest') === '1';
    const weaponSel = q.get('weaponsel'); // force a weapon by its 1-based id
    // `?flatland=1`: force a perfectly flat test surface (set BEFORE playNewGame generates
    // terrain) so weapon/terrain effects can be judged without natural slopes in the way.
    if (q.get('flatland') === '1') gameController.setFlatLand(true);
    // `?skiptexture=1`: material-debug terrain — land grayscale, dirt green, radiation red, sky
    // cyan — so deposits/craters/fallout are unambiguous (no texture guessing).
    if (q.get('skiptexture') === '1') CLand.debugMaterials = true;
    if (
      q.get('battle') === '1' ||
      q.get('depot') === '1' ||
      q.get('pause') === '1' ||
      q.get('crate') !== null || // a crate needs a tank to drop onto (no boot battle exists anymore)
      weaponTest ||
      weaponSel !== null
    )
      playNewGame();
    // Configure the inventory/ammo BEFORE opening any screen, so an auto-opened depot
    // reflects it (its Qty snapshot is taken on open).
    // `?weapontest=1`: start a battle and keep the turn on the human forever (the AI
    // never fires, the shot timer is off) so weapons can be tried back-to-back — with
    // unlimited ammo across the whole arsenal.
    if (weaponTest) gameController.setWeaponTest(true);
    // `?weaponsel=<n>`: force the human onto arsenal row <n> with unlimited ammo.
    if (weaponSel !== null) {
      const n = parseInt(weaponSel, 10);
      if (Number.isInteger(n) && n >= 1 && !gameController.forceWeaponByListNumber(n))
        console.warn(`?weaponsel=${n}: past the end of the enabled arsenal — no weapon selected`);
    }
    if (q.get('depot') === '1') openDepot();
    if (q.get('pause') === '1') openPauseMenu();
    // `?settings=1` opens the Settings root; `?settings=<pageId>` (e.g. gameplay)
    // opens that option page directly.
    const settingsArg = q.get('settings');
    if (settingsArg) {
      openSettings('menu');
      if (settingsArg !== '1') openSettingsPage(settingsArg);
    }
    // `?setup=1` opens the Play game-setup screen.
    if (q.get('setup') === '1') openPlaySetup();
    // `?crate=1|weapon|credits|health|bomb`: drop a supply crate onto the human tank to
    // preview the parachute wobble + pickup (optionally forcing the content kind).
    const crate = q.get('crate');
    if (crate !== null) gameController.devDropCrate(crate);
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

  // Mirror navigation to the URL (browser Back / ESC / in-app Back all go one level up). After the
  // dev affordances above so their `?flag` reads see the original query before the router rewrites
  // the path to the resting screen (e.g. `?settings=graphics` → `/settings/graphics`).
  initRouter();

  // ========================================================================
  // SERVICE WORKER
  // ========================================================================

  // Register the minimal service worker (public/sw.js) so the app is installable on
  // Android/Chromium — its `beforeinstallprompt` (the InstallHint's one-tap Install) only
  // fires with a registered SW. PROD-only so it never interferes with the dev HMR socket.
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // ========================================================================
  // JET STEERING INPUT
  // ========================================================================

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

  // ========================================================================
  // KEYBOARD SHORTCUTS
  // ========================================================================

  // These shortcuts are GAMEPLAY-only. Anywhere else — the menus, the lobby, any
  // Settings/editor text field — the keystroke belongs to the UI (typing a room
  // code, a player name, a taunt), so the handler must not touch it. We gate on the
  // battle screen AND on focus being in an editable element (belt-and-suspenders for
  // in-battle inputs like Phase 2 chat).
  const isTypingTarget = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null;
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  };
  const gameplayKeys = (e: KeyboardEvent): boolean => screen.value === 'battle' && !isTypingTarget(e.target);

  // Keyboard shortcuts (the on-screen controls live in the Preact HUD). Gameplay
  // actions are resolved through the player's key bindings (Customize Controls); the
  // pressed key maps to an action, so rebinding takes effect immediately.
  document.addEventListener('keydown', e => {
    // Escape / the bound Exit action goes ONE LEVEL UP on any screen — a settings sub-page to its
    // parent, a sub-screen to the menu, a battle overlay closed (or, with none open, the pause menu
    // opened). This mirrors the browser Back button (see the router). Skipped while typing in a
    // field (the field owns Escape, e.g. blur) and while a Controls rebind is capturing keys (its
    // capture-phase listener stops propagation first). Escape is always honoured so an unbound /
    // rebound Exit can never lock the player out.
    const isExit =
      e.code === 'Escape' || (screen.value === 'battle' && resolveAction(bindings.value, e.code) === 'exit');
    if (isExit && !isTypingTarget(e.target)) {
      e.preventDefault();
      escapeBack();
      return;
    }

    if (!gameplayKeys(e)) return;
    const action = resolveAction(bindings.value, e.code);

    // Dev-only screenshot freeze on Ctrl/Cmd+P (bare P is left free for normal use /
    // typing; the player-facing pause is Escape → the pause menu).
    if (import.meta.env.DEV && e.code === 'KeyP' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const p = !pausedSignal.value;
      gameController.setPaused(p);
      gameController.getAudio()?.setDebugSilenced(p); // debug freeze halts ALL audio — music + UI too
      pausedSignal.value = p; // freeze DOM FX (HUD ripple); also blocks the HUD (paused → no act)
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
        gameController.requestFire();
        break;
      case 'aimLeft':
        gameController.setAngle(wrapAngle(Math.round(gameController.getAngle()) + 2));
        break;
      case 'aimRight':
        gameController.setAngle(wrapAngle(Math.round(gameController.getAngle()) - 2));
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

  // Release thrust on ANY keyup — a key release must always release thrust, even if focus moved into
  // a text field (chat) between press and release, or the keydown was on the battle screen. Keydown
  // stays gameplay-gated (don't START thrust while typing); keyup is always safe to honour, so it is
  // NOT gated — gating it on `gameplayKeys` strands the jet "on" whenever the gate flips mid-press.
  document.addEventListener('keyup', e => {
    const dir = thrustKey(e.code);
    if (dir && thrust[dir]) {
      thrust[dir] = false;
      pushThrust();
    }
  });

  // Losing the window (Alt-Tab, an OS notification, the tab going hidden) never delivers the keyup,
  // so proactively release all held thrust — otherwise the jet keeps thrusting on return with no key
  // actually down until that exact key is pressed and released again.
  const resetThrust = (): void => {
    if (thrust.up || thrust.left || thrust.right) {
      thrust.up = thrust.left = thrust.right = false;
      pushThrust();
    }
  };
  window.addEventListener('blur', resetThrust);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetThrust();
  });

  // ========================================================================
  // POINTER MAPPING
  // ========================================================================

  // Client coords → the scene's pixel space (SCREEN space; the canvas may be
  // CSS-stretched). The minimap lives here. Adding the camera scroll gives WORLD
  // space, where aiming/hover happen (Y never scrolls).
  const toScene = (e: PointerEvent): [number, number] => {
    // Map the pointer from CSS pixels into the controller's fixed LOGICAL space
    // (the container's on-screen size represents getViewWidth × getViewHeight).
    const r = container.getBoundingClientRect();
    return [
      (e.clientX - r.left) * (gameController.getViewWidth() / r.width),
      (e.clientY - r.top) * (gameController.getViewHeight() / r.height),
    ];
  };
  const toWorld = (e: PointerEvent): [number, number] => {
    const [sx, sy] = toScene(e);
    return [sx + gameController.getCameraX(), sy];
  };
  let aiming = false;
  let minimapDrag = false; // grabbed the minimap → panning the camera (suppresses aim)
  // Right Click Fires (Gameplay, default on): the right mouse button launches the shot,
  // exactly like Space / the FIRE button. Suppress the browser context menu so it can.
  container.addEventListener('contextmenu', e => e.preventDefault());
  container.addEventListener('pointerdown', e => {
    if (e.button === 2) {
      if (GameConfig.rightClickFires && canFire.value) {
        e.preventDefault();
        gameController.requestFire();
      }
      return;
    }
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
    // Placing a Move: a click on the world commits the destination (drives the tank there) rather
    // than starting an aim drag.
    if (gameController.isMovePlacing()) {
      gameController.placeMove(wx);
      return;
    }
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
      // Cursor: a pointer/hand while placing a Move (click to move here), the open-hand over the
      // minimap's draggable handle, else default.
      if (!aiming)
        container.style.cursor = gameController.isMovePlacing()
          ? 'pointer'
          : gameController.hitMinimapBox(sx, sy)
            ? 'grab'
            : '';
      const [wx, wy] = toWorld(e);
      gameController.setMouse(wx, wy); // hover-detail on tank badges
      if (aiming) gameController.dragAim(wx, wy);
    },
    true,
  );
  /** Stop an aim drag, committing the aim — release only sets angle/power, it does NOT fire (that's
   *  the FIRE button / Space). Every drag-ending path runs this. */
  const endAimDrag = (): void => {
    if (!aiming) return;
    aiming = false;
    gameController.endAim(false);
  };
  window.addEventListener(
    'pointerup',
    e => {
      if (minimapDrag) {
        minimapDrag = false;
        // Released the pan: open hand if still over the box handle, else default.
        const [sx, sy] = toScene(e);
        container.style.cursor = gameController.hitMinimapBox(sx, sy) ? 'grab' : '';
      }
      endAimDrag();
    },
    true,
  );
  // Losing the window mid-drag (Alt-Tab, an OS gesture, a native drag) may never deliver
  // pointerup/pointercancel, which would leave `aiming`/`minimapDrag` stuck — subsequent BUTTONLESS
  // moves would then keep re-aiming / panning until the next click. Cancel any drag on blur/hide, the
  // same defence the thrust reset above applies to held keys. `pointercancel` wants exactly this too.
  const cancelPointerDrag = (): void => {
    minimapDrag = false;
    container.style.cursor = '';
    endAimDrag();
  };
  window.addEventListener('pointercancel', cancelPointerDrag, true);
  window.addEventListener('blur', cancelPointerDrag);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelPointerDrag();
  });

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
      // A window resize only re-fits the GPU presentation: the compositor stretches the
      // fixed logical scene canvas to the new viewport (linear-filtered — smooth, no moiré).
      // The scene canvas itself stays at the world's logical size (synced in the render loop).
      // Record the live native size so the NEXT solo match builds its world to fit the window.
      gameController.setDisplaySize(
        container.clientWidth || window.innerWidth,
        container.clientHeight || window.innerHeight,
      );
      compositor.resize();
      sizeFx(); // keep the FX overlay matched to the viewport
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
  let frameNum = 0; // raw monotonic frame index for the frame counter
  let sizePollMs = 0; // accumulates toward the periodic viewport self-heal check (below)
  let wasStarted = false; // last frame's isStarted(): flip → false means a battle was just torn down

  // Max Framerate (More Graphics): cap the Pixi ticker so a high-refresh display doesn't
  // burn CPU running the loop at 120/144 Hz. maxFPS = 0 means uncapped (display rate).
  effect(() => {
    compositor.app.ticker.maxFPS = maxFps.value;
  });

  compositor.app.ticker.add(ticker => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.1);
    // Self-heal the viewport. The refit above is driven by a `resize` event / ResizeObserver, but
    // some real size changes never deliver a usable callback — most notably opening the page with
    // devtools DOCKED and then closing it (the window and container grow back, but no reliable
    // resize notification arrives), and DPR changes from a monitor move or browser zoom. Left
    // unhandled, the renderer stays stuck at the stale size and the world is stranded in a corner
    // with a black band beside it. So a few times a second, compare the live renderer size to the
    // container and re-fit on any drift. This is cheap: refit() coalesces to a single rAF and
    // compositor.resize() no-ops when the sizes already match, so a steady viewport costs only two
    // client-size reads per poll.
    sizePollMs += ticker.deltaMS;
    if (sizePollMs >= 250) {
      sizePollMs = 0;
      const r = compositor.app.renderer;
      if (Math.round(r.width) !== container.clientWidth || Math.round(r.height) !== container.clientHeight) refit();
    }
    // Keep the scene render target at the world's LOGICAL size. It only changes when a new
    // match sets it (solo = the window size at start; net = a fixed shared resolution), so
    // this is a no-op almost every frame; the compositor stretches it to the live viewport.
    const vw = gameController.getViewWidth();
    const vh = gameController.getViewHeight();
    if (scene.width !== vw || scene.height !== vh) {
      scene.width = vw;
      scene.height = vh;
      compositor.setSceneSize();
    }
    // advance() runs the sim in fixed timesteps (deterministic; frame-rate-independent). It also
    // no-ops when no battle is started, so a torn-down match (Quit → menu) can't keep simulating.
    if (!pausedSignal.value) gameController.advance(dt);
    // Present-on-demand: the loop always ticks (so the sim keeps advancing), but the
    // full 2D redraw + GPU texture upload are skipped on frames where nothing visible
    // changed. The shockwave still advances every call (it warps the already-uploaded
    // texture on the GPU), so it animates over a static scene without a re-upload.
    const started = gameController.isStarted();
    // Present ONE frame when a battle tears down (started flips false), so stopGame()'s cleared
    // scene reaches the GPU — otherwise shouldRedraw() stays false and the last battle frame lingers.
    const redraw = gameController.shouldRedraw() || (wasStarted && !started);
    wasStarted = started;
    if (redraw) gameController.draw(); // no-ops when !started; the canvas holds stopGame's clear
    compositor.update(pausedSignal.value ? 0 : dt, redraw);
    // Repaint the foreground FX overlay in lockstep with the world (same redraw
    // gate), clearing first so it's transparent everywhere except its own content.
    if (redraw) {
      fxCtx.clearRect(0, 0, fx.width, fx.height);
      // The world is authored in the controller's fixed LOGICAL space and presented
      // stretched to fill the GAME CONTAINER (window minus the HUD). Map logical→container
      // so badges/damage numbers line up with the presented world — using the container's
      // live viewport RECT (offset + size), so an Avoid-Notch inset (the container shifted
      // in from the notch) moves the overlay with it instead of leaving it at the edge.
      const cr = container.getBoundingClientRect();
      fxCtx.save();
      fxCtx.translate(cr.left, cr.top);
      fxCtx.scale(cr.width / gameController.getViewWidth(), cr.height / gameController.getViewHeight());
      gameController.drawOverlay(fxCtx);
      fxCtx.restore();
    }
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
    // Frame counter (?frame=1): a monotonic tick count, published every frame so you can read
    // the exact frame something happened on. Frozen while paused (a paused game runs no sim
    // frames), and only publishes while shown.
    if (!pausedSignal.value) {
      frameNum++;
      if (showFrameCount.value && frameNum !== frameCount.peek()) frameCount.value = frameNum;
    }
  });

  console.log('Atomic Cannon ready.');
}
