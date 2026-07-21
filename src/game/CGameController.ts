/**
 * CGameController - Main Game Controller
 *
 * Central coordinator for:
 * - Turn-based battle flow state machine
 * - Tank management and player turns
 * - Firing sequence coordination
 * - Wind and physics parameters
 */

import {CLand} from '../core/CLand';
import {CTank, TEAM_COLORS} from '../core/CTank';
import {Roster} from '../core/CRoster';
import {CShot} from '../core/CShot';
import {GameConfig} from '../core/CGameConfig';
import {landEnabled, weaponEnabled} from '../core/CGameContent';
import {CWeapon, getDefaultWeaponIndex, getWeapon, WEAPON_DATABASE} from '../core/CWeapon';
import {Vec2} from '../math/Vec2';
import {CParticleSystem} from '../core/CParticleSystem';
import {ScreenShake} from '../core/rendering/ScreenShake';
import {RenderGate} from './RenderGate';
import {CWeather} from '../core/CWeather';
import {
  CEconomy,
  START_CREDITS,
  CREDIT_PER_DAMAGE,
  CREDIT_PER_KILL,
  CREDIT_PER_TURN,
  CREDIT_PER_ROUND,
} from '../core/CEconomy';
import {
  AI_DEFAULT_LEVEL,
  aimProbability,
  angleError,
  bestAim,
  pickMoveWeapon,
  pickTarget,
  pickWeapon,
} from '../core/CBotAI';
import {CAssetManager} from '../core/rendering/CAssetManager';
import {EXT, type ShotWorld, weaponDetonate, weaponFlyStep} from '../core/weapons/WeaponBehavior';
import {CAudio} from '../audio/CAudio';
import landData from '../data/land.json';

/**
 * Game state machine states
 */
export enum EGameState {
  Battle = 'battle',
  Flying = 'flying',
  ShotFlying = 'shot_flying',
  Explosion = 'explosion',
  BattleEnd = 'battle_end',
}

/** Match type. Deathmatch pays a per-kill bounty; Rounds (Point) scores by damage. */
export enum EGameType {
  Rounds = 0,
  Deathmatch = 1,
  FastTest = 2,
}

// Bot names
const BOT_NAMES = [
  'Whopper',
  'BrainBot',
  'RandBot',
  'AlphaBot',
  'MechaBot',
  'FlashBot',
  'GammaBot',
  'ShazBot',
  'BetaBot',
  'DeltaBot',
];

interface LandConfig {
  bg: string;
  weather: {type: string; intensity: number}[];
  layers: {tile: string; depth: number}[];
}

const LAND_DATA = landData as LandConfig[];

// TEMPORARY (explosion-FX testing): lock the weapon selection to one control
// weapon so it can be spammed to review effects. Set to null to restore the
// full arsenal.
const CONTROL_WEAPON: string | null = null;

// A beam holds on screen for ~this long, then the earth collapses (the removed dirt
// falls/settles over the following ~second). Keep it just under the beam's on-screen
// life so the ground drops as the ray fades — "beam holds → earth falls".
const BEAM_COLLAPSE_DELAY = 1;

const controlWeaponIndex = (): number =>
  CONTROL_WEAPON ? WEAPON_DATABASE.findIndex(w => w.name === CONTROL_WEAPON) : -1;

// Camera pan speed (world px/sec) — the constant-speed ease toward the follow
// target (the original scrolls at dt·gameSpeed·scrollSpeed; this is that budget
// in px/sec). Fast enough to keep a shot roughly framed without whipping.
const CAMERA_SCROLL_SPEED = 1100;
// Where the followed object sits in the view: 0.5 = dead centre.
const CAMERA_CENTER = 0.5;

/**
 * CGameController - Main game controller
 */
export class CGameController implements ShotWorld {
  // ========================================================================
  // CONSTRUCTION & INITIALIZATION
  // ========================================================================

  constructor(canvas: HTMLCanvasElement) {
    this.m_canvas = canvas;
    this.m_ctx = canvas.getContext('2d')!;

    // Large maps: the WORLD can be several viewports wide (Land Size); the scene
    // canvas is the VIEW. World width = viewWidth × landScale (1 = no scroll);
    // world height = view height (scroll is horizontal only). `m_camX` is the
    // world X of the view's left edge.
    this.m_worldWidth = Math.round(canvas.width * this.landScale());

    // Terrain fills the full world so its body covers the bottom of the screen —
    // the background's foreground never shows in the HUD strip.
    this.m_land = new CLand(this.m_worldWidth, canvas.height);

    this.m_tanks = [];
    this.m_shots = [];
    this.m_particles = new CParticleSystem();
    this.m_particles.setBounds(this.m_worldWidth, canvas.height);
    // Weather fills the VIEW (rain/snow are screen-space), not the world.
    this.m_weather = new CWeather(canvas.width, canvas.height);
    this.m_economy = new CEconomy();
    this.m_screenShake = new ScreenShake();
    this.m_assets = new CAssetManager();

    // Initialize weapon list (index into WEAPON_DATABASE). The control-weapon
    // override (if set) forces the FX-test weapon.
    this.m_currentWeaponIndex =
      controlWeaponIndex() >= 0 ? controlWeaponIndex() : getDefaultWeaponIndex();

    // Wind: positive = right, negative = left
    this.m_wind = new Vec2(0, 0);

    // UI control values
    this.m_angle = 45;
    this.m_power = 500;
  }

  /**
   * Start new game with specified number of players
   */
  startGame(nPlayers: number = 2): void {
    // Reset state
    this.m_tanks = [];
    this.m_shots = [];
    this.m_mines = [];
    this.m_sentries = [];
    this.m_aimMarkers = [];

    // Generate terrain: a DEV flat test surface (`?flatland=1`), a forced landscape shape
    // (Settings → Land Type), or, for "Random", the usual random landscape.
    if (this.m_flatLand) {
      this.m_land.generateFlat();
    } else if (this.m_landMode >= 0 && this.m_landMode <= 4) {
      this.m_land.generateTerrainMode(this.m_landMode);
    } else {
      this.m_land.generateRandomTerrain();
    }

    // Per-player roster (name / tank model / colour) from Customize Players. Colour
    // is the player's identity: tanks sharing a colour are a team, so team ids are
    // derived by grouping equal colours (distinct colours → free-for-all).
    const players = Roster.players;
    const teamOfColor = new Map<string, number>();

    for (let i = 0; i < nPlayers; i++) {
      const cfg = players[i] ?? {
        name: i === 0 ? 'Player' : BOT_NAMES[i % BOT_NAMES.length],
        model: '',
        color: TEAM_COLORS[i] ?? '#0000ff',
      };

      // Team = the colour's group; the first tank of a colour defines a new team id.
      let teamId = teamOfColor.get(cfg.color);
      if (teamId === undefined) {
        teamId = teamOfColor.size;
        teamOfColor.set(cfg.color, teamId);
      }

      // Position tanks across the whole WORLD (not just the view) so a large map
      // is actually used — ends anchored left/right, others scattered between.
      const worldW = this.m_worldWidth;
      let xPos: number;
      if (i === 0) {
        xPos = 100 + Math.random() * 50; // Left side for player 1
      } else if (i === nPlayers - 1) {
        xPos = worldW - 150 + Math.random() * 50; // Right side
      } else {
        // Bots scattered in between
        xPos = 200 + Math.random() * (worldW - 400);
      }

      const pTank = new CTank(cfg.name, teamId);
      pTank.setColor(cfg.color); // hull colour (and team identity)
      if (cfg.model) pTank.setTankType(cfg.model);
      pTank.init(xPos, this.m_land);
      pTank.setHuman(i === 0); // Only first player is human
      pTank.setWeaponIndex(this.m_currentWeaponIndex); // its own starting weapon
      pTank.setCredits(this.m_startCredits); // per-tank starting credits (Economy → Credit Start)

      this.m_tanks.push(pTank);
    }

    // Credits are per-tank; the human's depot spends against the human tank's
    // balance. Reset the shared inventory (owned rounds) for the fresh match.
    this.m_economy.bindCredits(this.m_tanks[0]);
    this.m_economy.reset(this.m_startCredits);

    // Preload hull sprites for the tanks in play (fire-and-forget; the renderer
    // falls back to vector hulls until they are ready).
    for (const tank of this.m_tanks) {
      for (const s of tank.getRequiredSprites()) {
        this.m_assets.loadSprite(s.name, s.file);
      }
    }

    // Preload projectile sprites (each weapon's `bitmap` under assets/weapons/) —
    // this includes the beam weapons' colour textures (magma.bmp, grate.bmp, …), which
    // the beam draw stretches along the ray. They use a magenta (255,0,255) background,
    // same as the hull sprites.
    const bitmaps = new Set(WEAPON_DATABASE.map(w => w.bitmap).filter(Boolean));
    for (const bmp of bitmaps) {
      this.m_assets.loadSprite(`weapons/${bmp}`, `/assets/weapons/${bmp}`);
    }
    // The green turn-indicator triangle (bounces over the active tank).
    this.m_assets.loadSprite('gui/turn-arrow', '/assets/gui/arrow.bmp');
    // Shield icon shown on a tank's badge when it has shields (magenta-keyed).
    this.m_assets.loadSprite('gui/shield', '/assets/gui/shield.bmp');
    // The aim crosshair (magenta-keyed white "+" with a black outline) that marks
    // the (angle, power) aim point — the "target turret" reticle.
    this.m_assets.loadSprite('gui/target', '/assets/gui/target turret.bmp');
    // Off-screen shot notches (gated on the "Tracking" option): top arrows (up
    // while rising, down while falling) + left/right edge brackets pointing at a
    // projectile that has left the view.
    this.m_assets.loadSprite('gui/notch-center', '/assets/gui/notch center.bmp');
    this.m_assets.loadSprite('gui/notch-decent', '/assets/gui/notch center decent.bmp');
    this.m_assets.loadSprite('gui/notch-left', '/assets/gui/notch left.bmp');
    this.m_assets.loadSprite('gui/notch-right', '/assets/gui/notch right.bmp');

    // Particle FX sprites (the real game art): grey smoke puff (magenta-keyed)
    // and the additive starburst flare used for trail plumes / fireballs.
    this.m_assets.loadSprite('fx:smoke', '/assets/gui/smoke.bmp').then(() => {
      // Hand the smoke sprite to the terrain so radiation heat plumes use the
      // real (tinted) smoke art instead of a procedural blob.
      const s = this.m_assets.getSprite('fx:smoke');
      if (s) this.m_land.setSmokeSprite(s.bitmap, s.width, s.height);
    });
    this.m_assets.loadImage('fx:flare', '/assets/flares/04.bmp');
    // The generic fallback fireball, keyed on its light blue-purple bg.
    this.m_assets.loadSprite('fx:explosion', '/assets/effects/explosion1.bmp', [127, 127, 255]);
    // Each weapon explodes with its OWN flare sprite (expBitmap): load the distinct
    // set. They're on a black background → additive blit, no colorkey needed.
    for (const b of new Set(WEAPON_DATABASE.map(w => w.expBitmap).filter(Boolean))) {
      this.m_assets.loadImage(`fx:${b}`, `/assets/${b}`);
    }
    // The in-flight rocket flare (flareType/flareBmp), black-bg → additive.
    this.m_assets.loadImage('fx:flares/01.bmp', '/assets/flares/01.bmp');
    this.m_particles.setAssets(this.m_assets);

    // Pick a landscape (background + depth-layered terrain textures + weather).
    this.loadLandscape();

    // Randomize wind
    this.updateWind();

    // Set initial state
    // Player 0 (the human) takes the first turn.
    this.m_currentPlayerIndex = 0;
    this.beginTurn();
    // Snap the camera onto the first player so a large map opens framed on them
    // (rather than panning in from the world's left edge).
    this.m_manualScroll = false;
    this.centerCameraOn(this.getCurrentTank().getPosition().x);

    // Warm the combat SFX set and start a random battle track.
    this.m_audio?.preloadCombat();
    this.m_audio?.battleMusic();
  }

  /**
   * Pick a random landscape from land.json and load its background + depth-sorted
   * terrain textures. Fire-and-forget: the terrain shows a gradient until ready.
   */
  private async loadLandscape(): Promise<void> {
    const cfg = LAND_DATA[this.pickLandscapeIndex()];

    // Precipitation / blowing sand declared by this map (snow, rain, hail, dust).
    this.m_weather.configure(cfg.weather);

    // A themed name for the depot footer, derived from the map's dominant weather.
    const wx = new Set((cfg.weather ?? []).map(w => w.type));
    this.m_mapName = wx.has('snow')
      ? 'Frozen Wastes'
      : wx.has('dust')
        ? 'Desert'
        : wx.has('rain')
          ? 'Wetlands'
          : wx.has('hail')
            ? 'Highlands'
            : 'Battlefield';

    await this.m_assets.loadImage('bg', '/assets/' + cfg.bg);

    await Promise.all(
      cfg.layers.map(l => this.m_assets.loadImage('tile:' + l.tile, '/assets/' + l.tile)),
    );

    const layers = cfg.layers
      .map(l => {
        const sprite = this.m_assets.getSprite('tile:' + l.tile);
        return sprite ? {image: sprite.bitmap, depth: l.depth} : null;
      })
      .filter((x): x is {image: CanvasImageSource; depth: number} => x !== null);

    // Bare-earth texture for de-grassed craters + the raised radiation deposit: a
    // single dirt bitmap (`ldirt1.bmp`), loaded explicitly and used everywhere
    // craters expose / fallout deposits earth — a consistent brown dirt regardless
    // of the landscape (which may be mossy rock, marble, …).
    await this.m_assets.loadImage('tile:land/ldirt1.bmp', '/assets/land/ldirt1.bmp');
    const bareTile =
      cfg.layers.find(l => /dirt|sand|mud|clay/i.test(l.tile)) ??
      cfg.layers.find(l => !/grass/i.test(l.tile)) ??
      cfg.layers[cfg.layers.length - 1];
    const bareImage =
      this.m_assets.getSprite('tile:land/ldirt1.bmp')?.bitmap ??
      (bareTile ? this.m_assets.getSprite('tile:' + bareTile.tile)?.bitmap : undefined);

    this.m_land.setLayers(layers, bareImage);
  }

  /** Pick which landscape to load. Honours a `?land=N` override (for reviewing a
   * specific map / its weather), otherwise random. */
  private pickLandscapeIndex(): number {
    if (typeof location !== 'undefined') {
      const p = new URLSearchParams(location.search).get('land');
      if (p !== null) {
        const i = parseInt(p, 10);
        if (Number.isInteger(i) && i >= 0 && i < LAND_DATA.length) return i;
      }
    }
    // Choose only among enabled landscapes (Game Content); if all are disabled,
    // degrade to the full set rather than blocking.
    const enabled = LAND_DATA.map((_, i) => i).filter(landEnabled);
    const pool = enabled.length ? enabled : LAND_DATA.map((_, i) => i);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ========================================================================
  // GAME LOOP & UPDATE
  // ========================================================================

  /**
   * Main update tick - called every frame via requestAnimationFrame
   */
  update(dt: number): void {
    // Game-speed multiplier (Settings → Gameplay → Update Scale; 1 = normal).
    dt *= this.m_speedScale;
    switch (this.m_gameState) {
      case EGameState.Battle:
        this.updateBattle(dt);
        break;

      case EGameState.Flying:
        this.updateFlying(dt);
        break;

      case EGameState.ShotFlying:
        this.updateShotInFlight(dt);
        break;

      case EGameState.Explosion:
        // Wait for explosion effects to complete — including a beam-slice
        // collapse still falling / debris still settling (m_land.isSettling).
        if (
          !this.m_particles.hasActiveExplosions() &&
          !this.m_screenShake.isActive() &&
          !this.m_land.isSettling()
        ) {
          this.checkBattleEnd();
        }
        break;
    }

    // Always update terrain, wind and visual effects
    this.m_time += dt;
    this.updateCamera(dt); // ease the large-map camera toward the shot / active tank
    this.m_land.update(dt);
    this.updateWindDrift(dt);
    this.m_particles.update(dt, this.m_wind);
    this.m_weather.update(dt, this.m_wind);
    if (this.m_screenFlash > 0) this.m_screenFlash = Math.max(0, this.m_screenFlash - dt / 0.6);
    this.updateMoveSound();

    // Fire any due deferred actions (bot turns, turn hand-off). These run off the
    // sim clock — not wall-clock timers — so they freeze with the rest of the game
    // while paused (update() is skipped) instead of firing behind the pause.
    this.runTimers();
  }

  /**
   * Invalidate the frame — the next draw must be rendered. Called on any input or
   * one-off state change (aim, weapon, mouse move, entity placement, resize). Also
   * the hook a future networking layer calls when it applies a remote update, so
   * the scene redraws for the remote player's actions even while the local player
   * is idle.
   */
  markDirty(): void {
    this.m_renderGate.markDirty(performance.now());
  }

  /**
   * Whether any GAMEPLAY motion is on screen this frame (as opposed to the purely
   * cosmetic turn-arrow bob / star twinkle, which the gate handles via its grace
   * window). Deliberately conservative: if anything here can move, we keep drawing.
   */
  private isAnimating(): boolean {
    switch (this.m_gameState) {
      case EGameState.Flying:
      case EGameState.ShotFlying:
      case EGameState.Explosion:
        return true; // shot/flight/blast in progress
    }
    if (this.m_screenShake.isActive()) return true;
    if (this.m_camX !== this.m_camTargetX) return true; // camera still panning
    if (this.m_screenFlash > 0) return true;
    if (this.m_particles.hasActiveExplosions()) return true;
    if (this.m_weather.isActive()) return true; // rain/snow/dust never rest
    if (this.m_land.isAnimating()) return true; // debris / fallout / slump / terrain rebuild
    if (!this.m_assets.isReady()) return true; // sprites still popping in
    for (const s of this.m_shots) if (!s.isDead()) return true;
    for (const m of this.m_mines) if (m.armed > 0) return true; // arming → colour flips
    for (const t of this.m_tanks)
      if (t.isMoving() || t.isFalling() || t.isThrustingUp()) return true;
    return false;
  }

  /**
   * Decide whether to redraw + re-upload the scene this frame. The game loop always
   * ticks update() (so the sim keeps advancing); only the expensive redraw + GPU
   * upload are gated here. Returns true whenever something changed or is moving.
   */
  shouldRedraw(): boolean {
    return this.m_renderGate.shouldRedraw(this.m_paused, this.isAnimating(), performance.now());
  }

  /**
   * Schedule `fn` to run after `sec` of *simulation* time. Because it's driven by
   * update() (which is skipped while paused), the callback is naturally deferred
   * across a pause rather than firing on the wall clock. Replaces setTimeout for
   * all game-flow delays so pause actually freezes the flow.
   */
  private schedule(sec: number, fn: () => void): void {
    this.m_timers.push({at: this.m_time + sec, fn});
  }

  /** Run (and drop) every scheduled action whose sim-time has arrived. */
  private runTimers(): void {
    if (this.m_timers.length === 0) return;
    const due = this.m_timers.filter(t => this.m_time >= t.at);
    if (due.length === 0) return;
    this.m_timers = this.m_timers.filter(t => this.m_time < t.at);
    for (const t of due) t.fn();
  }

  /**
   * Pause/resume the whole game. This is a DEBUG freeze: the sim clock (update)
   * stops in the loop, audio is suspended, and all player input is rejected (the
   * fire/aim/angle/power/weapon handlers below early-out) so nothing at all moves
   * while paused. (A future player-facing pause with an overlay menu will relax
   * the input + audio parts.)
   */
  setPaused(paused: boolean): void {
    if (paused === this.m_paused) return;
    this.m_paused = paused;
    this.markDirty(); // draw the pause frame once; redraw on resume
    if (paused) void this.m_audio?.suspend();
    else void this.m_audio?.resume();
  }

  isPaused(): boolean {
    return this.m_paused;
  }

  /**
   * Drive the looping `tank moving.wav` from tank motion state: start the named
   * loop while a unit moves, stop it when none do, repan to the mover. Idempotent
   * starts are handled downstream.
   */
  private updateMoveSound(): void {
    if (!this.m_audio) return;
    const mover = this.m_tanks.find(t => t.isAlive() && t.isMoving());
    if (mover) {
      const x = mover.getPosition().x;
      if (!this.m_tanksMoving) {
        this.m_audio.startTankMove(x);
        this.m_tanksMoving = true;
      } else this.m_audio.updateTankMove(x);
    } else if (this.m_tanksMoving) {
      this.m_audio.stopTankMove();
      this.m_tanksMoving = false;
    }

    // jet.wav loops only while the up-thrust is firing, layered
    // under tank moving.wav. Stops the instant thrust releases or fuel runs out.
    const jet = this.m_tanks.find(t => t.isAlive() && t.isThrustingUp());
    if (jet) {
      const x = jet.getPosition().x;
      if (!this.m_jetSounding) {
        this.m_audio.startJet(x);
        this.m_jetSounding = true;
      } else this.m_audio.updateJet(x);
    } else if (this.m_jetSounding) {
      this.m_audio.stopJet();
      this.m_jetSounding = false;
    }
  }

  /**
   * Jet flight (extType 17): the active tank thrusts against gravity until its
   * fuel runs out and it settles. Flight repositions the tank but does NOT end
   * the turn; the player still fires afterwards. Other tanks keep falling/settling
   * passively.
   */
  private updateFlying(dt: number): void {
    const tank = this.getCurrentTank();
    for (const t of this.m_tanks) if (t.isAlive()) t.update(this.m_land, dt);
    this.updateMines(dt);
    // Back to the aim phase once the jet is spent and the tank has settled.
    if (!tank.hasJetFuel() && !tank.isMoving() && !tank.isFalling()) {
      tank.setJetInput(false, false, false);
      this.m_gameState = EGameState.Battle;
    }
  }

  /** Set the flying tank's held thrust (arrow/WASD). No-op outside the Flying state. */
  setJetInput(up: boolean, left: boolean, right: boolean): void {
    if (this.m_gameState !== EGameState.Flying) return;
    this.getCurrentTank().setJetInput(up, left, right);
  }

  /** Cut the jet early (drop remaining fuel); flight ends once the tank lands. */
  cutJet(): void {
    if (this.m_gameState === EGameState.Flying) this.getCurrentTank().cutJet();
  }

  // ========================================================================
  // DRAG-TO-AIM (the primary control)
  // ========================================================================

  /** Longest drag (px) = full power (also the arrow's max length). */
  private static AIM_MAX_DRAG = 400;

  /** Fixed aim origin — the tank body centre. NOT the muzzle (which rotates with aim). */
  private aimOrigin(): Vec2 {
    return this.getCurrentTank().getPosition();
  }

  /** Begin aiming from the current tank (world coords). No-op unless it's a human's turn. */
  beginAim(wx: number, wy: number): boolean {
    if (this.m_paused || this.m_gameState !== EGameState.Battle || !this.isPlayerTurn())
      return false;
    this.m_aim.active = true;
    this.dragAim(wx, wy);
    return true;
  }

  /** Update aim while dragging: angle = tank→cursor direction, power = drag length. */
  dragAim(wx: number, wy: number): void {
    if (this.m_paused || !this.m_aim.active) return;
    this.m_aim.tx = wx;
    this.m_aim.ty = wy;

    const o = this.aimOrigin();
    const dx = wx - o.x,
      dy = wy - o.y;
    // Screen-Y is down; up-aim → negative dy → larger angle. 0 = right, 90 = up,
    // 180 = left, 270 = down. atan2 returns (-180,180]; fold into the wrapping
    // 0..359 range the HUD uses (so down-right reads 315, not -45).
    const angleDeg = ((((Math.atan2(-dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
    const frac = Math.min(1, Math.hypot(dx, dy) / CGameController.AIM_MAX_DRAG);
    const power = 10 + frac * 990; // POWER_MIN(10)..POWER_MAX(1000)

    this.setAngle(Math.round(angleDeg));
    this.setPower(Math.round(power));
  }

  /** Release the drag. If it was a real aim, fire. */
  endAim(fire: boolean): void {
    this.markDirty(); // the aim arrow disappears this frame
    const wasActive = this.m_aim.active;
    this.m_aim.active = false;
    if (fire && wasActive && this.m_gameState === EGameState.Battle && this.isPlayerTurn()) {
      this.fire();
    }
  }

  // ========================================================================
  // CAMERA (large-map horizontal scroll)
  // ========================================================================

  /** Land-Size scale (1..5); world width = viewWidth × scale. */
  private landScale(): number {
    return Math.max(1, Math.min(5, Math.round(GameConfig.landSize)));
  }

  /** Widest the camera can scroll; 0 when the world fits the view (no scroll). */
  private maxCamX(): number {
    return Math.max(0, this.m_worldWidth - this.m_canvas.width);
  }

  private clampCamX(x: number): number {
    return Math.max(0, Math.min(this.maxCamX(), x));
  }

  /** World X of the view's left edge — for input→world mapping and world draw. */
  getCameraX(): number {
    return this.m_camX;
  }

  getWorldWidth(): number {
    return this.m_worldWidth;
  }

  /**
   * What the camera centres on this frame:
   *  1. the latched active shot while it's in the air (a single, stable target — not
   *     "whichever shot is alive", which jumps around a multi-missile salvo);
   *  2. once that shot has landed, the blast, held until the explosion finishes (so a
   *     nuke plays out on screen before the turn hands off);
   *  3. otherwise the active tank.
   * The active shot latches to the first shot of the salvo and never re-picks, so
   * later missiles landing elsewhere don't yank the camera.
   */
  private cameraFollowX(): number {
    if (this.m_activeShot) {
      if (!this.m_activeShot.isDead()) return this.m_activeShot.getPosition().x;
    } else {
      const first = this.m_shots.find(s => !s.isDead());
      if (first) {
        this.m_activeShot = first;
        return first.getPosition().x;
      }
    }
    if (this.m_particles.hasActiveExplosions()) return this.m_lastImpactX;
    return this.getCurrentTank().getPosition().x;
  }

  /**
   * Ease the camera toward its follow target — constant speed, snapping when within
   * one step (matching the original, which is NOT a proportional lerp). Skipped
   * while the player manually scrolls via the minimap or Auto Scroll is off; the
   * result is always clamped to the world.
   */
  private updateCamera(dt: number): void {
    if (this.maxCamX() === 0) {
      this.m_camX = this.m_camTargetX = 0;
      return;
    }
    if (GameConfig.autoScroll && !this.m_manualScroll) {
      this.m_camTargetX = this.clampCamX(
        this.cameraFollowX() - this.m_canvas.width * CAMERA_CENTER,
      );
      const step = CAMERA_SCROLL_SPEED * dt;
      const d = this.m_camTargetX - this.m_camX;
      this.m_camX = Math.abs(d) <= step ? this.m_camTargetX : this.m_camX + Math.sign(d) * step;
    }
    this.m_camX = this.clampCamX(this.m_camX);
  }

  /** Snap the camera to centre `worldX` immediately (battle start / recenter). */
  private centerCameraOn(worldX: number): void {
    this.m_camTargetX = this.clampCamX(worldX - this.m_canvas.width * CAMERA_CENTER);
    this.m_camX = this.m_camTargetX;
  }

  /**
   * Render frame to canvas - called every frame
   */
  draw(): void {
    const ctx = this.m_ctx;

    // Apply screen shake offset
    const shakeOffset = this.m_screenShake.getOffset();
    ctx.save();
    ctx.translate(shakeOffset.x, shakeOffset.y);

    // Backdrop: real background image once loaded, else a night-sky gradient.
    const bg = this.m_assets.getSprite('bg');
    if (bg) {
      ctx.drawImage(bg.bitmap, 0, 0, this.m_canvas.width, this.m_canvas.height);
    } else {
      const skyGradient = ctx.createLinearGradient(0, 0, 0, this.m_canvas.height - 120);
      skyGradient.addColorStop(0, '#1a1a2e'); // Dark night
      skyGradient.addColorStop(0.6, '#16213e'); // Mid blue
      skyGradient.addColorStop(1, '#0f3460'); // Horizon

      ctx.fillStyle = skyGradient;
      ctx.fillRect(0, 0, this.m_canvas.width, this.m_canvas.height);

      // Draw stars (subtle background)
      this.drawStars(ctx);
    }

    // Weather (rain / snow / hail / dust) sits between the backdrop and the
    // terrain, so it only shows against the sky and is occluded by the ground.
    // It fills the VIEW (screen space), so it's drawn before the camera shift.
    this.m_weather.draw(ctx);

    // Everything below is WORLD content: shift left by the camera so a large map
    // scrolls under the fixed view (screen = world − cam). The backdrop above and
    // the notches/minimap below draw OUTSIDE this transform, in screen space.
    ctx.save();
    ctx.translate(-this.m_camX, 0);

    // Draw terrain
    this.m_land.draw(ctx);

    // Draw tanks
    for (const tank of this.m_tanks) {
      if (tank.isAlive()) {
        // Full stat lines when the mouse hovers this tank.
        const hover = tank.isPointInside(this.m_mouse.x, this.m_mouse.y);
        tank.draw(ctx, this.m_assets, hover);

        // Highlight current player's tank with indicator (Graphics → Show Turn)
        if (
          GameConfig.showTurn &&
          this.getCurrentTank() === tank &&
          this.m_gameState !== EGameState.ShotFlying &&
          this.m_gameState !== EGameState.Explosion
        ) {
          this.drawTurnIndicator(ctx, tank);
        }
      } else if (!tank.m_bExploded || tank.isAlive()) {
        // Skip dead tanks that are already exploded
      } else {
        // Draw wreckage for exploded but not yet cleaned up tanks
        tank.draw(ctx, this.m_assets);
      }
    }

    this.drawPlacedEntities(ctx);
    this.drawAimTarget(ctx);
    this.drawAim(ctx);

    // Trail / explosion particles.
    this.m_particles.draw(ctx);

    // Active projectiles ON TOP of their own trail — so the missile sprite is
    // visible ahead of its exhaust+smoke, not buried under the fire head.
    for (const shot of this.m_shots) {
      if (!shot.isDead()) {
        const wi = shot.getWeaponIndex() >= 0 ? shot.getWeaponIndex() : this.m_currentWeaponIndex;
        const weapon = getWeapon(wi);
        const sprite = this.m_assets.getSprite(`weapons/${weapon.getBitmap()}`);
        shot.draw(ctx, weapon.getColor(), sprite?.bitmap ?? null, weapon.getSize());
      }
    }

    ctx.restore(); // end world-space camera transform → back to screen space

    // Edge notches pointing at any projectile that has left the view (Tracking).
    if (GameConfig.tracking) this.drawShotNotches(ctx);

    // Overview minimap (large maps only) — drawn last so it sits on top.
    this.drawMinimap(ctx);

    ctx.restore();
  }

  /**
   * Overview minimap — a top-left strip shown ONLY when the world
   * is wider than the view. It draws the terrain silhouette, a translucent "extents"
   * box for the current camera view, and a dot per tank in its team colour (the
   * active player's dot gets a white outline). Screen-space, with drag-to-pan.
   */
  private drawMinimap(ctx: CanvasRenderingContext2D): void {
    const Vw = this.m_canvas.width;
    const W = this.m_worldWidth;
    if (W <= Vw) return; // no scroll → no minimap
    const Vh = this.m_canvas.height;
    const r = this.minimapRect();
    const {m, width, height} = r;
    const sx = width / W; // world → minimap X
    const sy = height / Vh; // world → minimap Y (Y doesn't scroll; worldH = viewH)

    ctx.save();
    ctx.imageSmoothingEnabled = false;

    // Panel: translucent white plate (α 0x40) with a black frame (α 0xff).
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(m, m, width, height);

    // Extents box: the slice of the world currently on screen (α 0x80).
    const boxX = Math.round(this.m_camX * sx);
    const boxW = Math.round(Vw * sx);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(m + boxX, m, boxW, height);

    // Terrain silhouette: one down-sampled black column per minimap pixel, from the
    // surface down to the strip bottom (α 0x80).
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    for (let col = 0; col < width; col++) {
      const worldX = Math.floor((col * W) / width);
      const surfY = Math.max(0, Math.min(Vh, this.m_land.getHeightAt(worldX)));
      const y = Math.round(surfY * sy) + m;
      ctx.fillRect(m + col, y, 1, m + height - y);
    }

    // Frames: extents box outline then the panel frame, both crisp 1px.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeRect(m + boxX + 0.5, m + 0.5, boxW, height - 1);
    ctx.strokeStyle = '#000';
    ctx.strokeRect(m + 0.5, m + 0.5, width, height);

    // Tank dots: filled square in the tank's team colour; active player outlined white.
    const d = 2;
    const cur = this.getCurrentTank();
    for (const t of this.m_tanks) {
      if (!t.isAlive()) continue;
      const p = t.getPosition();
      const dx = Math.round(Math.max(m + d, Math.min(m + width - d, p.x * sx + m)));
      const dy = Math.round(Math.max(m + d, Math.min(m + height - d, p.y * sy + m)));
      ctx.fillStyle = t.getTeamColor();
      ctx.fillRect(dx - d, dy - d + 1, d * 2, d * 2);
      if (t === cur) {
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(dx - d - 0.5, dy - d + 0.5, d * 2 + 1, d * 2 + 1);
      }
    }
    ctx.restore();
  }

  /**
   * How far (as a fraction of view width) the top-left status text must shift right
   * to clear the minimap — 0 when there's no minimap. In the original the per-tank
   * life lines sit to the RIGHT of the overview strip.
   */
  getMinimapRightFrac(): number {
    if (this.m_worldWidth <= this.m_canvas.width) return 0;
    const r = this.minimapRect();
    return (r.m + r.width + 6) / this.m_canvas.width;
  }

  /** True when scene-pixel (px, py) is inside the minimap strip (false if no minimap). */
  hitMinimap(px: number, py: number): boolean {
    if (this.m_worldWidth <= this.m_canvas.width) return false;
    const r = this.minimapRect();
    return px >= r.m && px <= r.m + r.width && py >= r.m && py <= r.m + r.height;
  }

  /**
   * True when scene-pixel (px, py) is inside the minimap's extents box — the
   * draggable viewport handle (the translucent rectangle). This is what shows the
   * grab cursor and starts a pan; the rest of the strip is inert.
   */
  hitMinimapBox(px: number, py: number): boolean {
    if (this.m_worldWidth <= this.m_canvas.width) return false;
    const r = this.minimapRect();
    const sx = r.width / this.m_worldWidth;
    const boxX = r.m + this.m_camX * sx;
    const boxW = this.m_canvas.width * sx;
    return px >= boxX && px <= boxX + boxW && py >= r.m && py <= r.m + r.height;
  }

  /**
   * Drag/click the minimap to pan: a scene-pixel X on the strip snaps the camera so
   * the picked world column is centred (`camX = ((mouseX − m)/width)·W − viewWidth/2`,
   * clamped). Instant (no easing) and sets the manual-scroll override so auto-follow
   * yields until the next fire/turn.
   */
  panFromMinimap(px: number): void {
    if (this.m_worldWidth <= this.m_canvas.width) return;
    const r = this.minimapRect();
    const cam = ((px - r.m) / r.width) * this.m_worldWidth - this.m_canvas.width * CAMERA_CENTER;
    this.m_camX = this.m_camTargetX = this.clampCamX(cam);
    this.m_manualScroll = true;
    this.markDirty();
  }

  /**
   * Minimap strip rect (px) — top-left, ~half the view wide (`width = viewWidth/2 − 19`).
   * For a wide (>320) view the strip is 48px tall, or 64px at large-display scale. Our
   * canvas is always a large display, so we take the 64px height — 48 leaves the strip
   * over-elongated.
   */
  private minimapRect(): {m: number; width: number; height: number} {
    const Vw = this.m_canvas.width;
    const m = Vw < 240 ? 2 : Vw > 320 ? 4 : 3;
    const height = Vw < 240 ? 24 : Vw > 320 ? 64 : 29;
    const width = Math.floor(Vw / 2 - (Vw < 240 ? 8 : 19));
    return {m, width, height};
  }

  /**
   * Off-screen shot indicators — the "notch" markers (gated on the "Tracking"
   * graphics option). For every live projectile outside the view we draw an edge
   * marker: a top arrow at the shot's X when it's above the ceiling (pointing up
   * while it rises, down once it's descending), and a left/right bracket at the
   * shot's Y when it's off that side. Drawn in screen space: the shot's screen X is
   * its world X minus the camera, so on large maps the notch tracks a shot that has
   * scrolled off either side of the view.
   */
  private drawShotNotches(ctx: CanvasRenderingContext2D): void {
    const live = this.m_shots.filter(s => !s.isDead());
    if (live.length === 0) return;
    const W = this.m_canvas.width,
      H = this.m_canvas.height;
    const up = this.m_assets.getSprite('gui/notch-center'); // rising  → arrow up
    const down = this.m_assets.getSprite('gui/notch-decent'); // falling → arrow down
    const left = this.m_assets.getSprite('gui/notch-left');
    const right = this.m_assets.getSprite('gui/notch-right');
    const clampY = (y: number, h: number) => Math.max(0, Math.min(H - h, y));

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (const shot of live) {
      const p = shot.getPosition();
      const v = shot.getVelocity();
      const sx = p.x - this.m_camX; // world → screen X (Y doesn't scroll)
      // Above the ceiling: top arrow at the shot's X (+y is downward, so v.y >= 0
      // means it's on the way down → the "descent" arrow).
      if (p.y < 0) {
        const s = v.y >= 0 ? down : up;
        if (s) ctx.drawImage(s.bitmap, Math.round(sx - s.width / 2), 0);
      }
      // Off the left / right edge: a bracket at the shot's Y, clamped into the view.
      if (sx < 0 && left) {
        ctx.drawImage(left.bitmap, 0, clampY(Math.round(p.y - left.height / 2), left.height));
      }
      if (sx > W && right) {
        ctx.drawImage(
          right.bitmap,
          W - right.width,
          clampY(Math.round(p.y - right.height / 2), right.height),
        );
      }
    }
    ctx.restore();
  }

  /** Mines, sentries and tracer markers placed on the field. */
  private drawPlacedEntities(ctx: CanvasRenderingContext2D): void {
    for (const m of this.m_mines) {
      ctx.fillStyle = m.armed > 0 ? '#886600' : '#ffcc00';
      ctx.beginPath();
      ctx.arc(m.x, m.y - 2, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.fillRect(m.x - 5, m.y - 1, 10, 2);
    }
    for (const s of this.m_sentries) {
      ctx.fillStyle = '#9aa';
      ctx.fillRect(s.x - 5, s.y - 10, 10, 10);
      ctx.fillRect(s.x, s.y - 8, 12, 3);
    }
    for (const mk of this.m_aimMarkers) {
      ctx.strokeStyle = 'rgba(255,80,80,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mk.x - 6, mk.y);
      ctx.lineTo(mk.x + 6, mk.y);
      ctx.moveTo(mk.x, mk.y - 6);
      ctx.lineTo(mk.x, mk.y + 6);
      ctx.stroke();
    }
  }

  /**
   * The drag-aim indicator: a hollow green block-arrow from the tank toward the
   * cursor (no fill). Its length is capped at full power, and its thickness + head
   * grow with power. A target crosshair sits at the tip.
   */
  private drawAim(ctx: CanvasRenderingContext2D): void {
    if (!this.m_aim.active) return;
    // The arrow starts at the cannon tip (muzzle) and its tip reaches the cursor.
    // (The crosshair markers still use the fixed body centre, so the faded
    // "initial" marker stays put while aiming.)
    const o = this.getCurrentTank().getMuzzlePosition();
    const dx = this.m_aim.tx - o.x,
      dy = this.m_aim.ty - o.y;
    const ang = Math.atan2(dy, dx);
    // Length = distance to the cursor, capped — so the tip sits on the cursor
    // (until full power). The whole shape scales with length (thickness too).
    const L = Math.min(Math.hypot(dx, dy), CGameController.AIM_MAX_DRAG);

    // Block-arrow shape: base half 1, shaft-junction half 1.5, head half 4,
    // junction at 10/15, tip at 15 — all in units of L/15.
    const sh0 = L * (1 / 15); // base half-width
    const sh1 = L * (1.5 / 15); // shaft-junction half-width
    const hw = L * (4 / 15); // head half-width
    const jn = L * (10 / 15); // shaft/head junction
    const pts: [number, number][] = [
      [0, -sh0],
      [jn, -sh1],
      [jn, -hw],
      [L, 0],
      [jn, hw],
      [jn, sh1],
      [0, sh0],
    ];

    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.translate(o.x, o.y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.lineJoin = 'round';
    // Pure-green line (0x00ff00) over a black backing, no fill.
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  /** World point the current (angle, power) aims at — where the target cross sits. */
  private aimPoint(angleDeg: number, power: number): Vec2 {
    const o = this.aimOrigin();
    const r = (angleDeg * Math.PI) / 180;
    const f = Math.max(0, (power - 10) / 990); // POWER_MIN..MAX → 0..1
    const L = f * CGameController.AIM_MAX_DRAG; // = the arrow tip (drag distance, capped)
    return new Vec2(o.x + Math.cos(r) * L, o.y - Math.sin(r) * L); // screen-Y up = -sin
  }

  /**
   * The target crosshair marking the aim point of the (power, angle) tuple. Shown
   * whenever it's a human's turn: a faded "initial" cross at the turn-start aim and
   * a solid "current" cross at the live aim — so you can see how you've adjusted.
   */
  private drawAimTarget(ctx: CanvasRenderingContext2D): void {
    if (this.m_gameState !== EGameState.Battle || !this.isPlayerTurn()) return;

    // The "target turret" reticle sprite, centred on the aim point.
    // Falls back to a drawn white/grey "+" until the sprite has loaded.
    const sprite = this.m_assets.getSprite('gui/target');
    const cross = (p: Vec2, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = false;
      if (sprite) {
        const s = 13;
        ctx.drawImage(sprite.bitmap, Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s);
      } else {
        const arm = 6,
          gap = 2;
        const path = () => {
          ctx.beginPath();
          ctx.moveTo(p.x - arm, p.y);
          ctx.lineTo(p.x - gap, p.y);
          ctx.moveTo(p.x + gap, p.y);
          ctx.lineTo(p.x + arm, p.y);
          ctx.moveTo(p.x, p.y - arm);
          ctx.lineTo(p.x, p.y - gap);
          ctx.moveTo(p.x, p.y + gap);
          ctx.lineTo(p.x, p.y + arm);
        };
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2.5;
        path();
        ctx.stroke();
        ctx.strokeStyle = '#e6e6e6';
        ctx.lineWidth = 1;
        path();
        ctx.stroke();
      }
      ctx.restore();
    };

    // Faded marker at the turn's initial power/angle (Graphics → Show Last Aim).
    if (GameConfig.showLastAim)
      cross(this.aimPoint(this.m_turnStartAngle, this.m_turnStartPower), 0.35);
    // While dragging, the arrow's tip already marks the current aim — hide the
    // active cross and show it again on release.
    if (!this.m_aim.active) cross(this.aimPoint(this.m_angle, this.m_power), 1);
  }

  /**
   * Background stars for atmosphere
   */
  private drawStars(ctx: CanvasRenderingContext2D): void {
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
      ctx.globalAlpha = 0.3 + Math.sin(Date.now() / 1000 + x) * 0.2;
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
  }

  /**
   * Draw indicator around current player's tank
   */
  private drawTurnIndicator(ctx: CanvasRenderingContext2D, tank: CTank): void {
    const pos = tank.getPosition();
    const sprite = this.m_assets.getSprite('gui/turn-arrow');

    // Draw the green triangle sprite so its bottom tip points at (x, y).
    const drawTri = (x: number, y: number, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = false;
      if (sprite) {
        const w = 20,
          h = 20;
        ctx.drawImage(sprite.bitmap, x - w / 2, y - h, w, h);
      } else {
        ctx.fillStyle = '#22e04a';
        ctx.strokeStyle = '#0a3a12';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - 9, y - 12);
        ctx.lineTo(x + 9, y - 12);
        ctx.lineTo(x, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    };

    // A single green triangle bouncing over the tank's current position.
    const bob = Math.abs(Math.sin(this.m_time * 4)) * 8;
    drawTri(pos.x, pos.y - 26 - bob, 1);
  }

  // ========================================================================
  // BATTLE FLOW
  // ========================================================================

  /**
   * Update during battle state (waiting for player input)
   */
  private updateBattle(dt: number): void {
    this.updateTurnTimer(dt);
    this.updateMines(dt);

    // Update tanks on terrain (for falling/movement animations)
    for (const tank of this.m_tanks) {
      if (tank.isAlive()) {
        tank.update(this.m_land, dt);

        // Apply radiation damage from nuclear zones — but ONLY where the fallout
        // deposit still exists at the tank's column. A bomb/terrain-clear that
        // overran the fallout zeroed the deposit there, so the irradiation is gone.
        const radZones = this.m_land.getRadiationZones();
        const irradiated = this.m_land.radDepositAt(tank.getPosition().x) > 0;
        if (irradiated) {
          for (const rZone of radZones) {
            const dist = tank.distanceTo(rZone.x, rZone.y);

            if (dist < rZone.radius + 16) {
              // TANK_RADIUS
              tank.applyRadiationDamage(rZone.damagePerSecond * dt, dt);

              if (!tank.isAlive()) {
                this.handleTankDestroyed(tank);
                break;
              }
            }
          }
        }
      }
    }
  }

  /**
   * Update shot that is currently in flight
   */
  private updateShotInFlight(dt: number): void {
    const activeShots = this.m_shots.filter(s => !s.isDead());

    if (activeShots.length === 0) {
      // Between succession salvos (machine gun / gatling burst): no shot is in the
      // air yet the next salvo is still scheduled — hold in ShotFlying and wait.
      if (this.m_pendingSalvos > 0) return;
      // Nothing flying and nothing pending — wait for the explosion to finish before
      // the turn hands off (the Explosion state ends the turn once effects settle).
      this.m_shots = [];
      this.m_gameState = EGameState.Explosion;
      return;
    }

    for (const shot of activeShots) {
      shot.update(dt, this.m_wind);

      // Per-frame behaviour dispatch (extType): roller/digger/airburst/beam/…
      const weapon = getWeapon(
        shot.getWeaponIndex() >= 0 ? shot.getWeaponIndex() : this.m_currentWeaponIndex,
      );
      const sp = shot.getPosition();
      const sv = shot.getVelocity();
      // Trail emission gate — the exhaust/plume AND the nose flare come from ONE
      // test: the shot's "moving down" flag is clear (still rising, motor burning
      // to apex) OR it's a Tracer (extType 4, which streaks its whole path). At
      // apex the flag sets and the WHOLE trail — smoke and fire alike — stops; the
      // rocket then coasts down as just its sprite. Both the smoke and the nose
      // flare must share this gate, or the fire outlives the smoke on the way down.
      const emitTrail = !shot.isMovingDown() || weapon.getExtType() === EXT.TRACER;
      if (emitTrail) {
        // Per-weapon trail (trailType 0 = none, 1 = basic, 2+ = rocket plume).
        // Emitted from the missile's REAR (exhaust), not its centre — the trail
        // is offset back along the heading by half the sprite length so
        // smoke/fire pours from the tail.
        const ex = shot.getExhaustPoint(weapon.getSize());
        this.m_particles.trail(
          ex.x,
          ex.y,
          weapon.getColor(),
          sv.x,
          sv.y,
          weapon.getTrailType(),
          weapon.getTrailLength(),
          dt,
        );
        // In-flight glowing flare on the projectile (rockets: flareType/flareBmp).
        // Kept SMALL — a tight bright nose point, not a big bloom (the ×~7.8 plume
        // draw multiplier means a small size here reads at ~14-18px).
        const iff = weapon.getInFlightFlare();
        if (iff)
          this.m_particles.inflightFlare(
            sp.x,
            sp.y,
            `fx:${iff}`,
            1.5 + weapon.getFlareSize() * 2.5,
          );
      }
      const action = weaponFlyStep(shot, weapon, this, dt);
      if (action === 'detonate') weaponDetonate(shot, weapon, this);
      else if (action === 'consumed') shot.kill();
    }

    // Include submunitions spawned this frame (so a cluster keeps the round in
    // flight until every child lands) AND any succession salvos not yet fired.
    const stillFlying = this.m_shots.some(s => !s.isDead()) || this.m_pendingSalvos > 0;
    if (stillFlying) {
      this.m_gameState = EGameState.ShotFlying;
    } else {
      // The shot (and any submunitions) have resolved — hold in the Explosion state
      // so the camera stays on the blast until the whole effect (a nuke can run for
      // seconds) finishes, THEN the turn hands off.
      this.m_shots = [];
      this.m_gameState = EGameState.Explosion;
    }
  }

  // ========================================================================
  // ShotWorld — the surface the weapon behaviours (WeaponBehavior.ts) act on
  // ========================================================================

  get land(): CLand {
    return this.m_land;
  }

  get tanks(): CTank[] {
    return this.m_tanks;
  }

  spawnShot(shot: CShot): void {
    this.m_shots.push(shot);
  }

  explode(
    x: number,
    y: number,
    scale: number,
    color?: string,
    radiusPx?: number,
    nuclear = false,
    blastPreset?: string,
    expType = 0,
    expBitmap?: string,
  ): void {
    this.m_lastImpactX = x; // the camera holds here while this blast animates
    if (color !== undefined && radiusPx !== undefined) {
      this.m_particles.blast(x, y, radiusPx, color, nuclear, blastPreset, expType, expBitmap);
      // Stage 1: the big flash whites out the WHOLE screen (incl. the HUD) — a
      // full-viewport DOM overlay, since the game canvas can't reach the HUD layer.
      // It inherits the weapon's colour (uranium reads red, plutonium green, …).
      if (expType === 4 || nuclear) this.flashScreen(1, color ?? '#ffffff');
      else if ((radiusPx ?? 0) >= 45) this.flashScreen(0.45, color ?? '#ffffff');
    } else this.m_particles.explode(x, y, scale);
  }

  /** Trigger the full-viewport flash (0..1) tinted by the weapon's colour. */
  flashScreen(intensity: number, color = '#ffffff'): void {
    if (intensity > this.m_screenFlash) {
      this.m_screenFlash = intensity;
      this.m_flashColor = color;
    }
  }

  getScreenFlash(): number {
    return this.m_screenFlash;
  }

  getScreenFlashColor(): string {
    return this.m_flashColor;
  }

  shake(mag: number, dur: number): void {
    this.m_screenShake.trigger(mag, dur);
  }

  hitSound(name: string, x: number): void {
    this.m_audio?.hit(name, x);
  }

  ripple(x: number, y: number, strength: number): void {
    if (!GameConfig.explosionWaves) return; // Graphics → Explosion Waves (nuke wave)
    this.m_onImpact?.(x, y, strength);
  }

  aimMarker(x: number, y: number): void {
    this.m_aimMarkers.push({x, y});
    this.markDirty();
  }

  deployMine(x: number, y: number, owner: CTank | null, weaponIndex: number): void {
    // Arms after a short delay so it doesn't trigger on the tank that laid it.
    this.m_mines.push({x, y, owner, weaponIndex, armed: 0.6});
    this.markDirty();
  }

  deploySentry(x: number, y: number, owner: CTank | null, weaponIndex: number): void {
    // TODO: auto-firing turret each turn. For now the sentry is a static placed marker.
    this.m_sentries.push({x, y, owner, weaponIndex});
    this.markDirty();
  }

  /** Mines detonate when a living tank rolls over them (after they arm). */
  private updateMines(dt: number): void {
    for (let i = this.m_mines.length - 1; i >= 0; i--) {
      const m = this.m_mines[i];
      if (m.armed > 0) {
        m.armed -= dt;
        continue;
      }
      const near = this.m_tanks.find(t => t.isAlive() && t.distanceTo(m.x, m.y) < 20);
      if (!near) continue;
      const w = getWeapon(m.weaponIndex);
      this.m_mines.splice(i, 1);
      this.explode(
        m.x,
        m.y,
        1.3,
        w.getColor(),
        w.getRadius(),
        w.isNuclear(),
        w.getBlastParticle(),
        w.getExpType(),
        w.getExpBitmap(),
      );
      // Only big mines shake the camera (see weaponDetonate — shake is reserved for
      // bomb/nuke-scale blasts; a small proximity charge just pops).
      if (w.isNuclear() || w.getExpType() === 4 || w.getRadius() >= 45) this.shake(8, 0.3);
      this.m_land.blastCircle(Math.floor(m.x), Math.floor(m.y), w.getRadius());
      this.m_land.scorch(Math.floor(m.x), Math.floor(m.y), w.getRadius());
      this.applyBlast(new Vec2(m.x, m.y), w.getRadius(), w.getDamage(), m.owner, false);
    }
  }

  /**
   * Falloff blast damage + kick, applied through the tank's shield/armor model.
   * `full` = beam direct hit: no distance falloff.
   */
  applyBlast(pos: Vec2, radius: number, damage: number, owner: CTank | null, full: boolean): void {
    for (const tank of this.m_tanks) {
      if (!tank.isAlive()) continue;
      const dist = tank.distanceTo(pos.x, pos.y);
      const inRange = full ? dist < Math.max(radius, 20) : dist <= radius + 1;
      if (!inRange) continue;

      const falloff = full ? 1 : Math.max(0, 1 - dist / (radius + 1));
      const dmg = damage * falloff;
      if (dmg <= 0) continue;

      const removed = tank.hit(dmg); // shield/armor applied by the tank
      this.creditDamage(owner, tank, removed); // shooter earns per life removed

      const dx = tank.getPosition().x - pos.x; // kick up and away from the blast
      const kickDir = new Vec2(dx >= 0 ? 0.6 : -0.6, -1).normalize();
      tank.kick(kickDir, Math.min(1, dmg / 400) * 320 * GameConfig.kickbackScale); // Tank → Kickback

      if (!tank.isAlive()) this.handleTankDestroyed(tank);
    }
  }

  private checkBattleEnd(): void {
    this.endTurn();
  }

  /**
   * Handle tank destroyed event
   */
  private handleTankDestroyed(tank: CTank): void {
    const pos = tank.getPosition();

    this.awardKillCredit(tank);

    // Create explosion at tank position
    this.m_particles.tankDeath(pos.x, pos.y + 12);
    this.m_screenShake.trigger(15, 0.5);
    this.m_audio?.tankExplode(pos.x); // tank explode.wav
  }

  /** Kill bounty (Deathmatch only): the killer (the victim's last damager) earns
   *  +CreditKill for an enemy kill, or pays −CreditKill for a team/self kill. An
   *  unattributed death (no last damager) pays nothing. Pooled across the killer's
   *  team afterwards. */
  private awardKillCredit(victim: CTank): void {
    if (this.m_gameType !== EGameType.Deathmatch) return;
    const killer = victim.getLastDamager();
    if (!killer) return;
    const enemy = killer.getTeamId() !== victim.getTeamId();
    killer.addCredits(enemy ? this.m_creditKill : -this.m_creditKill);
    this.poolTeamCredits(killer);
  }

  /** Pool credits within a team: after an award, copy the awarded tank's balance to
   *  every same-team tank (credits are shared per team). */
  private poolTeamCredits(tank: CTank): void {
    const credits = tank.getCredits(),
      team = tank.getTeamId();
    for (const t of this.m_tanks) {
      if (t !== tank && t.getTeamId() === team) t.setCredits(credits);
    }
  }

  /** Award `perTank` to every alive tank (Turn / Round). Credits are shared per team,
   *  so a team's balance rises by `perTank × (its alive members)`. No-op at rate 0. */
  private awardSurvivorCredit(perTank: number): void {
    if (perTank <= 0) return;
    const teams = new Map<number, CTank[]>();
    for (const t of this.m_tanks) {
      if (!t.isAlive()) continue;
      const arr = teams.get(t.getTeamId());
      if (arr) arr.push(t);
      else teams.set(t.getTeamId(), [t]);
    }
    for (const members of teams.values()) {
      const shared = members[0].getCredits() + perTank * members.length;
      for (const m of members) m.setCredits(shared);
    }
  }

  /** Credit the shooter for damage dealt to an ENEMY tank: `lifeRemoved × CreditDamage`
   *  (self/friendly earns nothing), then pool across the shooter's team. Records the
   *  shooter as the victim's last-damager for kill attribution. */
  private creditDamage(shooter: CTank | null, victim: CTank, lifeRemoved: number): void {
    victim.setLastDamager(shooter);
    if (!shooter || lifeRemoved <= 0 || shooter.getTeamId() === victim.getTeamId()) return;
    shooter.addCredits(lifeRemoved * this.m_creditDamage);
    this.poolTeamCredits(shooter);
  }

  /**
   * Advance to next living player's turn
   */
  /** Returns whether the turn order WRAPPED (crossed the last player back to the
   *  start) — i.e. a full round just completed. */
  private advanceToNextPlayer(): boolean {
    const nPlayers = this.m_tanks.length;

    // Weapon-test mode (?weapon_test=1): never hand the turn to the AI — keep it on
    // the (living) human so weapons can be fired back-to-back indefinitely.
    if (this.m_weaponTest) {
      const human = this.m_tanks.findIndex(t => t.isHuman() && t.isAlive());
      if (human >= 0) {
        this.m_currentPlayerIndex = human;
        return false;
      }
    }

    let wrapped = false,
      attempts = 0;
    do {
      if (this.m_currentPlayerIndex + 1 >= nPlayers) wrapped = true; // crossed the end → round complete
      this.m_currentPlayerIndex = (this.m_currentPlayerIndex + 1) % nPlayers;
      attempts++;
      if (attempts > nPlayers * 2) {
        console.warn('All players dead or stuck');
        break;
      }
    } while (!this.getCurrentTank().isAlive());
    return wrapped;
  }

  /** Start the current player's turn. The HUD (Preact) reads state via getters. */
  private beginTurn(): void {
    const tank = this.getCurrentTank();
    // Restore THIS player's own weapon so the previous player's (or a bot's)
    // choice never carries over.
    this.m_currentWeaponIndex = tank.getWeaponIndex();
    // Likewise restore THIS player's own aim + power (per-tank), so the previous
    // player's shot settings never carry over into this turn.
    this.m_angle = tank.getAimAngle();
    this.m_power = tank.getPower();
    if (tank.isHuman()) tank.setTurretAngle(this.m_angle);
    this.m_gameState = EGameState.Battle;
    this.m_turnStartAngle = this.m_angle;
    this.m_turnStartPower = this.m_power;

    // New turn: drop any minimap-scroll override so the camera eases to centre the
    // player whose turn it now is, and clear the shot the camera was tracking.
    this.m_manualScroll = false;
    this.m_activeShot = null;

    // Arm the shot-time countdown for a human turn (bots fire on a schedule and
    // never time out). Reset the clock either way so it never leaks across turns.
    this.m_turnElapsed = 0;
    this.m_turnTimerRunning = this.m_shotTime > 0 && tank.isHuman() && !this.m_weaponTest;

    if (tank.isBot()) {
      this.schedule(0.7, () => this.executeBotTurn());
    }
    this.markDirty(); // new turn: indicator moves, aim resets → redraw
  }

  /** End the current turn: declare a winner, or hand off to the next player. */
  private endTurn(): void {
    this.m_turnTimerRunning = false; // the clock never outlives its turn
    const alive = this.m_tanks.filter(t => t.isAlive());
    if (alive.length <= 1) {
      this.m_gameState = EGameState.BattleEnd;
      this.m_winnerName = alive.length === 1 ? alive[0].getName() : '';
      this.m_audio?.stopTankMove();
      // Win/lose jingle — victory if the human survived.
      if (alive.length === 1 && alive[0].isHuman()) this.m_audio?.battleWon();
      else this.m_audio?.battleLost();
      return;
    }
    // Hand off, then pay the between-turn credits. A completed round (turn order
    // wrapped) pays Credit Round to every survivor first, then Credit Turn every
    // hand-off. Credits are pooled per team inside the award.
    const wrapped = this.advanceToNextPlayer();
    if (wrapped) {
      this.m_currentRound++;
      this.awardSurvivorCredit(this.m_creditRound);
    }
    this.awardSurvivorCredit(this.m_creditTurn);
    this.beginTurn();
  }

  /**
   * Advance the shot-time countdown during a human's turn. When the clock runs
   * out the turn is forfeited (no shot) — the panel bar has already gone red.
   * Only ticks while `m_turnTimerRunning`, so it's inert for bots, after firing,
   * and while a shot/explosion is resolving (those aren't the Battle state).
   */
  private updateTurnTimer(dt: number): void {
    if (!this.m_turnTimerRunning) return;
    this.m_turnElapsed += dt;
    if (this.m_turnElapsed >= this.m_shotTime) {
      this.m_turnTimerRunning = false;
      this.endTurn(); // time's up → forfeit the turn
    }
  }

  /**
   * Shot-timer state for the panel bar below FIRE, or null when it shouldn't
   * show (shot-time disabled, or not a human waiting to fire). `frac` is the
   * fraction of time REMAINING (1 = full); colour goes green→yellow→red as it
   * drains.
   */
  getTurnTimer(): {frac: number; color: string} | null {
    if (!this.m_turnTimerRunning || this.m_shotTime <= 0) return null;
    const frac = Math.max(0, Math.min(1, 1 - this.m_turnElapsed / this.m_shotTime));
    const color = frac > 0.33 ? '#00ff00' : frac > 0.12 ? '#ffff00' : '#ff0000';
    return {frac, color};
  }

  /**
   * Get current player's tank
   */
  getCurrentTank(): CTank {
    return this.m_tanks[this.m_currentPlayerIndex];
  }

  // ========================================================================
  // FIRING SEQUENCE
  // ========================================================================

  /**
   * Fire currently selected weapon from current player
   */
  fire(): void {
    if (this.m_paused) return; // debug freeze rejects all input
    const tank = this.getCurrentTank();
    if (!tank.isAlive()) return;
    if (tank.isMoving()) return; // can't act while a move is under way

    this.m_turnTimerRunning = false; // committed to a shot — stop the clock
    this.m_manualScroll = false; // fire → camera resumes auto-follow (chases the shot)

    const weapon = getWeapon(this.m_currentWeaponIndex);
    const ext = weapon.getExtType();

    // soundFire, panned to the firing tank.
    this.m_audio?.fire(weapon.getFireSound(), tank.getPosition().x);

    // Jet (extType 17): light the jet with fuel = damage (5s/15s) and enter the
    // Flying state. Flight repositions the tank but does NOT end the turn — the
    // player still fires afterwards. Bots don't fly, so for them it just consumes
    // the turn.
    if (ext === EXT.JET) {
      if (tank.isHuman()) {
        tank.igniteJet(weapon.getDamage());
        this.m_gameState = EGameState.Flying;
      } else {
        this.m_gameState = EGameState.Battle;
        this.schedule(0.4, () => this.endTurn());
      }
      return;
    }

    // Move utilities (extType 3 — Move Near/Mid/Far): drive the tank in the aim
    // direction, using the power bar as the distance (up to the weapon's max
    // range = width × power/100). Consumes the turn like any utility; no shot.
    if (ext === 3) {
      const frac = Math.max(0.15, this.m_power / 1000); // power bar → how far
      const dir = Math.cos(tank.getTurretAngle()) >= 0 ? 1 : -1; // aim right → move right
      this.startTankMove(tank, tank.getPosition().x + dir * frac * this.moveRange(weapon));
      return;
    }

    // Utility items apply an effect to the firing tank instead of launching a shot.
    if (this.applyUtility(tank, weapon, ext)) {
      this.m_gameState = EGameState.Battle;
      this.schedule(0.4, () => this.endTurn());
      return;
    }

    this.m_shotsFired++; // a real projectile is launched (utilities don't count)
    // Remember this aim as the tank's "last shot" so the reset (↺) button can
    // restore power+angle to it (non-utility only).
    tank.saveLastShot(this.m_angle, this.m_power);

    // Death weapons ("Six Under", "Cremation", "Ashes", "Toxic Grave"…): a self-targeting
    // round that drops onto the FIRER. The original ignores the player's aim — it forces
    // the turret straight up and the power to 0, so the round leaves the muzzle with no
    // speed and just falls back down onto the tank that fired it (a "bury yourself"
    // shot). We spawn at the straight-up muzzle with zero velocity → a short drop onto
    // the shooter, not a bomb materialising high in the sky.
    if (ext === EXT.DEATH) {
      const drop = new CShot();
      drop.initFromVelocity(
        tank.muzzleForAngle(90),
        0,
        0,
        weapon.getDamage(),
        weapon.getRadius(),
        tank,
      );
      drop.setWeaponIndex(this.m_currentWeaponIndex);
      this.m_shots.push(drop);
      this.m_gameState = EGameState.ShotFlying;
      return;
    }

    const muzzlePos = tank.getMuzzlePosition();
    const baseAngle = tank.getTurretAngle();
    const isBeam = ext === EXT.BEAM || ext === EXT.BEAM2;
    // Per-shot inaccuracy — gated by Settings → Gameplay → Variance.
    const varianceRad = this.m_variance ? (weapon.getVariance() * Math.PI) / 180 : 0;

    // Multi-fire: `spawn` = SIMULTANEOUS rounds in a fan, `spread` = degrees
    // between them, `sucNum` = SUCCESSION (fires sucNum+1 times in a row). So a
    // Cannon (spawn 5) sprays 5 pellets, a Machine Gun (sucNum 11) rattles off
    // ~12, a Tomcat (spawn 3, spread 3) fans 3 rockets.
    const rounds = Math.max(1, weapon.getSpawnCount());
    const spacingRad = (weapon.getFanSpacingDeg() * Math.PI) / 180;

    // Beams are instantaneous hitscan: resolve the whole fan this frame (no flying
    // projectile), then Explosion waits for the flash to fade. (No beam has a
    // succession count, so beams don't burst.)
    if (isBeam) {
      for (let i = 0; i < rounds; i++) {
        const fan = rounds > 1 ? (i - (rounds - 1) / 2) * spacingRad : 0;
        const jitter = varianceRad > 0 ? (Math.random() * 2 - 1) * varianceRad : 0;
        this.fireBeam(muzzlePos, baseAngle + fan + jitter, weapon, tank);
      }
      this.m_shots = [];
      this.m_gameState = EGameState.Explosion;
      return;
    }

    // One salvo = `rounds` rounds fanned `spacingRad` apart, + per-round variance,
    // plus the muzzle blast. `sucNum+1` salvos fire in SUCCESSION across the `sucSec`
    // window (clamped to a rapid cadence) — a burst for machine guns / gatlings.
    const dmg = weapon.getDamage(),
      rad = weapon.getRadius();
    const flash = weapon.getMuzzleFlash(),
      muSmoke = weapon.getMuzzleSmoke();
    const fireSalvo = () => {
      for (let i = 0; i < rounds; i++) {
        const fan = rounds > 1 ? (i - (rounds - 1) / 2) * spacingRad : 0;
        const jitter = varianceRad > 0 ? (Math.random() * 2 - 1) * varianceRad : 0;
        const pShot = new CShot();
        pShot.initFromTank(muzzlePos, baseAngle + fan + jitter, this.m_power, dmg, rad, tank);
        pShot.setWeaponIndex(this.m_currentWeaponIndex);
        this.m_shots.push(pShot);
      }
      if (flash > 0 || muSmoke > 0) {
        const d = {x: Math.cos(baseAngle), y: -Math.sin(baseAngle)};
        this.m_particles.muzzle(
          muzzlePos.x,
          muzzlePos.y,
          d.x,
          d.y,
          flash,
          muSmoke,
          weapon.getColor(),
        );
      }
      this.m_pendingSalvos = Math.max(0, this.m_pendingSalvos - 1);
    };

    const salvos = 1 + weapon.getSuccessionCount();
    const gap = salvos > 1 ? Math.min(0.14, Math.max(0.05, weapon.getSuccessionSec() / salvos)) : 0;
    this.m_pendingSalvos = salvos;
    for (let sv = 0; sv < salvos; sv++) {
      // Each succession salvo is a fresh weapon dispatch and replays soundFire.
      // Salvo 0's sound is the one played above at fire(); scheduled salvos play
      // their own so a Strikers/Machine-Gun burst is heard once per salvo, not
      // once total. (The ~50–140ms salvo gap clears the SFX retrigger throttle,
      // so each is audible.)
      if (sv === 0) fireSalvo();
      else
        this.schedule(gap * sv, () => {
          this.m_audio?.fire(weapon.getFireSound(), tank.getPosition().x);
          fireSalvo();
        });
    }

    this.m_gameState = EGameState.ShotFlying;
  }

  /**
   * Resolve a beam weapon as an instantaneous ray: march muzzle → first
   * terrain/edge, damage every tank the line crosses (once, full damage — beams
   * ignore falloff), carve + scorch the impact, flash a line.
   */
  private fireBeam(muzzle: Vec2, angleRad: number, weapon: CWeapon, owner: CTank): void {
    // Aim unit vector — same unified convention as the projectile velocity so the
    // beam points exactly where the turret does (screen-Y down, up-aim → negative y).
    const dir = new Vec2(Math.cos(angleRad), -Math.sin(angleRad));

    // A beam PENETRATES terrain — it does NOT stop at the first hill. March to the
    // far edge of the world so the ray cuts clean across the map (through mountains,
    // reaching tanks buried behind them).
    const W = this.m_land.width,
      H = this.m_land.height;
    const maxLen = Math.hypot(W, H) + 200;
    let end = muzzle.clone();
    for (let d = 0; d <= maxLen; d += 4) {
      const px = muzzle.x + dir.x * d,
        py = muzzle.y + dir.y * d;
      end = new Vec2(px, py);
      if (px < -40 || px > W + 40 || py > H + 40 || py < -60) break; // left the world
    }

    // Damage every living tank within the beam's half-width of the FULL line — once
    // each, full damage (no falloff), including tanks behind terrain it pierced. The
    // shooter is EXCLUDED: the ray starts at its own muzzle, so it would otherwise sit
    // inside the half-width at the origin and take self-damage on every shot.
    const r = weapon.getRadius();
    const halfWidth = Math.max(8, r * 0.5) + 16; // + tank radius
    for (const t of this.m_tanks) {
      if (!t.isAlive() || t === owner) continue;
      const tp = t.getPosition();
      if (CGameController.pointSegDist(tp.x, tp.y, muzzle.x, muzzle.y, end.x, end.y) > halfWidth)
        continue;
      const removed = t.hit(weapon.getDamage());
      this.creditDamage(owner, t, removed); // shooter earns per life removed
      const dx = tp.x - muzzle.x;
      t.kick(
        new Vec2(dx >= 0 ? 0.5 : -0.5, -1).normalize(),
        Math.min(1, weapon.getDamage() / 400) * 260 * GameConfig.kickbackScale,
      );
      if (!t.isAlive()) this.handleTankDestroyed(t);
    }

    // The beam itself: the weapon's own colour texture (`bitmap` — red magma, striped
    // yellow grate, blue …) rotated to the aim and tiled end-to-end along the line at
    // `size` thickness. It holds on screen for a beat, THEN the earth collapses — a
    // through-beam has no single impact point, no crater/explosion/ripple, just a shake.
    this.m_particles.beam(
      muzzle.x,
      muzzle.y,
      end.x,
      end.y,
      weapon.getColor(),
      `weapons/${weapon.getBitmap()}`,
      weapon.getSize(),
      BEAM_COLLAPSE_DELAY,
    );
    this.shake(3, 0.18);

    // The earth falls AFTER the beam, not with it: the original cuts once but the
    // removed dirt drops and settles over the following ~second, so it reads as
    // "beam holds → ground collapses". We schedule the slice to fire as the beam
    // fades. It cuts a SLICE the width of the beam (the overburden falls in — never
    // planing off everything from the ray up to the surface) with a per-fire width
    // jitter + ragged per-column depth + falling debris, so the collapsed line is
    // noisy, not a clean geometric slot. Our heightmap can't hold a floating tunnel,
    // so the slice drops each crossed column by ~the beam thickness.
    const jitter = 0.85 + Math.random() * 0.3; // per-fire size wobble
    const carveHalf = Math.max(3, Math.min(24, weapon.getSize() * 0.5 * jitter));
    this.schedule(BEAM_COLLAPSE_DELAY, () => {
      this.m_land.carveBeamSlice(muzzle.x, muzzle.y, end.x, end.y, carveHalf);
    });

    const rad = weapon.getRadiation();
    if (rad.time > 0 && rad.dmg > 0) {
      // Fallout spreads within the blast radius, not by `iradiate` — iradiate is
      // only the on/off gate, never a spatial scale (see WeaponBehavior.weaponDetonate).
      const zoneR = r;
      this.m_land.blastIradiate(
        Math.floor(end.x),
        Math.floor(this.m_land.getHeightAt(end.x)),
        zoneR,
        rad.dmg * 60,
        rad.time,
        rad.rgb,
      );
    }
  }

  /** Distance from point (px,py) to segment (ax,ay)-(bx,by). */
  private static pointSegDist(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): number {
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const cx = ax + t * dx,
      cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  /**
   * Utility items (extType 7/10/11/14) modify the firing tank on use rather than
   * firing a projectile — the "use item" handler. Handles the known effects;
   * 3/15/17 are left as no-ops.
   * Returns true if the weapon was a utility (and consumed the turn).
   */
  private applyUtility(tank: CTank, weapon: CWeapon, ext: number): boolean {
    const v = weapon.getDamage(); // the effect magnitude lives in the damage field
    switch (ext) {
      case 7:
        tank.addShield(v);
        return true; // shield boost
      case 10:
        tank.addLife(v);
        return true; // repair
      case 11:
        tank.setArmor(v);
        return true; // set armor %
      case 14:
        return true; // secondary resist (no field yet) — consumes turn
      case 15:
        return true; // wall/bunker — consumes turn (effect TODO)
      // extType 17 (jet) is handled in fire() before this — flight, not a no-op.
      default:
        return false;
    }
  }

  // ========================================================================
  // BOT AI (CPU PLAYER)
  // ========================================================================

  /**
   * Execute bot player's turn (AI calculation and firing)
   */
  private executeBotTurn(): void {
    const botTank = this.getCurrentTank();

    if (!botTank.isAlive() || !botTank.isBot()) return;

    if (this.m_tanks.filter(t => t !== botTank && t.isAlive()).length === 0) {
      this.endTurn();
      return;
    }

    // A bot's turn is ONE action: MOVE or FIRE (mutually exclusive) — spending
    // the turn on a Move Near/Mid/Far utility drives the tank and ends the turn
    // (no shot). Otherwise it aims and fires.
    if (Math.random() < CGameController.BOT_MOVE_CHANCE && this.botMove(botTank)) return;
    this.botAimAndFire(botTank);
  }

  // Chance a bot spends its whole turn moving instead of firing.
  private static readonly BOT_MOVE_CHANCE = 0.25;

  /**
   * Bot move action: pick a Move utility, drive to a random spot within its range,
   * and end the turn. Returns false if no move weapon exists (→ fall back to fire).
   */
  private botMove(botTank: CTank): boolean {
    const wi = pickMoveWeapon();
    if (wi < 0) return false;
    const weapon = getWeapon(wi);
    botTank.setWeaponIndex(wi);
    this.m_currentWeaponIndex = wi;

    const maxDist = this.moveRange(weapon);
    const dir = Math.random() < 0.5 ? -1 : 1;
    const dist = (0.4 + Math.random() * 0.6) * maxDist;
    this.startTankMove(botTank, botTank.getPosition().x + dir * dist);
    return true;
  }

  /** Max move distance for a Move utility: landscape width × (move power / 100). */
  private moveRange(weapon: CWeapon): number {
    return this.m_land.width * (weapon.getDamage() / 100);
  }

  /** Drive a tank to `destX` (a Move utility action), then end the turn once settled. */
  private startTankMove(tank: CTank, destX: number): void {
    const clamped = Math.max(20, Math.min(this.m_land.width - 20, destX));
    tank.startDrive(clamped);
    this.m_gameState = EGameState.Battle;
    this.waitForRest(tank, 0);
  }

  /** Poll until a moving tank has settled (or a safety timeout), then end the turn. */
  private waitForRest(tank: CTank, elapsed: number): void {
    if (!tank.isMoving() || elapsed > 5) {
      this.endTurn();
      return;
    }
    this.schedule(0.15, () => this.waitForRest(tank, elapsed + 0.15));
  }

  /** Pick a target + weapon, solve the firing arc, degrade by difficulty, and fire. */
  private botAimAndFire(botTank: CTank): void {
    if (!botTank.isAlive() || this.m_gameState !== EGameState.Battle) return;
    const enemies = this.m_tanks.filter(t => t !== botTank && t.isAlive());
    if (enemies.length === 0) {
      this.endTurn();
      return;
    }

    const level = this.m_difficulty;
    const botPos = botTank.getPosition();

    // Pick a target — weakest/nearest at high difficulty, random at low.
    const ti = pickTarget(
      enemies.map(e => {
        const p = e.getPosition();
        return {
          x: p.x,
          y: p.y,
          healthFrac: Math.max(0, Math.min(1, e.getHealth().nLife / e.getMaxLife())),
        };
      }),
      botPos.x,
      level,
    );
    const target = enemies[Math.max(0, ti)];

    // Pick a weapon — stronger rounds favoured at high difficulty.
    const weaponIndex = pickWeapon(level);
    botTank.setWeaponIndex(weaponIndex); // store on the bot, not shared
    this.m_currentWeaponIndex = weaponIndex;

    // Whether the bot computes a FRESH solution this turn. Low-skill bots often
    // don't (they fire with their stale aim); a first-round ranging shot is
    // forced for any half-decent bot. Either way a difficulty-scaled angle
    // scatter is added below.
    const willAim =
      Math.random() < aimProbability(level) || (this.getBattleNum() === 1 && level > 3);

    let angleDeg: number;
    let power: number;
    if (willAim) {
      // Solve the firing arc against the target (real ballistics: gravity +
      // wind + any terrain in the way).
      const tp = target.getPosition();
      const field = {
        heightAt: (x: number) => this.m_land.getHeightAt(x),
        width: this.m_land.width,
        height: this.m_land.height,
      };
      const aim = bestAim(
        deg => botTank.muzzleForAngle(deg),
        {x: tp.x, y: tp.y},
        this.m_wind,
        field,
      );
      angleDeg = aim.angleDeg;
      power = aim.power;
    } else {
      // Reuse the bot's stale aim from a previous turn (never recomputed).
      angleDeg = botTank.getAimAngle();
      power = botTank.getPower();
    }

    // Difficulty scatter — angle only, shrinking to 0 at the top level.
    angleDeg += angleError(level);

    // Fold into the HUD's 0..359 range; persist on the bot so its aim carries over.
    angleDeg = ((Math.round(angleDeg) % 360) + 360) % 360;
    this.m_angle = angleDeg;
    this.m_power = Math.round(power);
    botTank.setAimAngle(this.m_angle);
    botTank.setPower(this.m_power);
    botTank.setTurretAngle(angleDeg);
    // The HUD (Preact) shows the bot's angle/power via getAngle()/getPower().

    // Execute fire after a brief "thinking" delay. The turn ends automatically
    // once the shot resolves (updateShotInFlight → endTurn).
    this.schedule(0.8, () => this.fire());
  }

  // Computer-player difficulty (AI_LEVEL_MIN..AI_LEVEL_MAX; higher = sharper aim).
  getDifficulty(): number {
    return this.m_difficulty;
  }

  setDifficulty(level: number): void {
    this.m_difficulty = level;
  }

  // ── Settings pushed from the options menu (see ui/applySettings). Start-time
  // setters take effect on the next startGame; the rest are live. ──────────────
  /** Credits each player starts a match with (applied on the next startGame). */
  setStartCredits(n: number): void {
    this.m_startCredits = Math.max(0, Math.round(n));
  }

  /** Depot sell-back refund fraction (0..1), live. */
  setSellRate(fraction: number): void {
    this.m_economy.setSellRate(fraction);
  }

  /** Number of battles in the match (feeds "Battle X of Y"). */
  setTotalBattles(n: number): void {
    this.m_totalBattles = Math.max(1, Math.round(n));
  }

  /** Forced landscape shape 0..4, or -1 for a random landscape (next startGame). */
  setLandMode(mode: number): void {
    this.m_landMode = mode;
  }

  /** DEV (`?flatland=1`): force a perfectly flat test surface on the next startGame. */
  setFlatLand(on: boolean): void {
    this.m_flatLand = on;
  }

  /** Wind-strength scalar (0 = disabled). Live for drift; reseeds next game. */
  setWindScale(scale: number): void {
    this.m_windScale = Math.max(0, scale);
  }

  /** Per-shot variance (inaccuracy) on/off, live. */
  setVariance(on: boolean): void {
    this.m_variance = on;
  }

  /** Credits earned per point of life removed (Economy → Credit Damage), live. */
  setCreditDamage(n: number): void {
    this.m_creditDamage = Math.max(0, n);
  }

  /** Credits earned per kill (Economy → Credit Kill), live. */
  setCreditKill(n: number): void {
    this.m_creditKill = Math.max(0, n);
  }

  /** Credits each survivor earns per turn (Economy → Credit Turn), live. */
  setCreditTurn(n: number): void {
    this.m_creditTurn = Math.max(0, n);
  }

  /** Credits each survivor earns per round (Economy → Credit Round), live. */
  setCreditRound(n: number): void {
    this.m_creditRound = Math.max(0, n);
  }

  /** Match type — kill credit is only paid in Deathmatch. */
  setGameType(t: EGameType): void {
    this.m_gameType = t;
  }

  getGameType(): EGameType {
    return this.m_gameType;
  }

  /** Game-speed multiplier (1 = normal), live. */
  setGameSpeed(scale: number): void {
    this.m_speedScale = Math.max(0.1, scale);
  }

  // ========================================================================
  // WIND & PHYSICS
  // ========================================================================

  private static readonly MAX_WIND = 5;

  /** Seed a fresh random wind at the start of a game (scaled by Settings → Wind). */
  private updateWind(): void {
    const max = CGameController.MAX_WIND * this.m_windScale;
    this.m_wind = new Vec2((Math.random() * 2 - 1) * max, (Math.random() * 2 - 1) * max * 0.3);
    this.m_windTimer = 0;
  }

  /**
   * Drift the wind vector slowly and re-randomise its acceleration on a timer.
   * Called every frame.
   */
  private updateWindDrift(dt: number): void {
    const MAX = CGameController.MAX_WIND * this.m_windScale; // 0 when wind is Disabled
    this.m_wind.x = Math.max(-MAX, Math.min(MAX, this.m_wind.x + this.m_windAccel.x * dt));
    this.m_wind.y = Math.max(
      -MAX * 0.3,
      Math.min(MAX * 0.3, this.m_wind.y + this.m_windAccel.y * dt),
    );

    this.m_windTimer -= dt;
    if (this.m_windTimer <= 0) {
      this.m_windTimer = Math.random() * 8 + 4; // 4..12 s until next drift target
      this.m_windAccel = new Vec2((Math.random() * 2 - 1) * 2, Math.random() * 2 - 1);
    }
  }

  // ========================================================================
  // UI CONTROL HANDLERS
  // ========================================================================

  setAngle(angle: number): void {
    if (this.m_paused) return;
    this.markDirty();
    this.m_angle = angle;
    const tank = this.getCurrentTank();
    // Persist the aim on the acting tank so it survives the turn cycle.
    tank.setAimAngle(angle);

    if (tank.isHuman()) {
      tank.setTurretAngle(this.m_angle);
    }
  }

  setPower(power: number): void {
    if (this.m_paused) return;
    this.markDirty();
    this.m_power = power;
    // Persist the power on the acting tank so it survives the turn cycle.
    this.getCurrentTank().setPower(power);
  }

  /**
   * Restore the current tank's power AND angle to its last real shot — the "↺"
   * panel button. Tooltip: "Use the reset button to set power and angle to your
   * last shot." (The last-shot fields are seeded to the starting aim before the
   * first shot.)
   */
  resetAim(): void {
    if (this.m_paused) return;
    const tank = this.getCurrentTank();
    this.setAngle(tank.getLastShotAngle());
    this.setPower(tank.getLastShotPower());
  }

  selectWeapon(index: number): void {
    if (this.m_paused) return;
    this.markDirty();
    if (index >= 0 && index < WEAPON_DATABASE.length) {
      this.m_currentWeaponIndex = index;
      // Persist the choice on the acting tank so it survives the turn cycle.
      this.m_tanks[this.m_currentPlayerIndex]?.setWeaponIndex(index);
    }
  }

  /** Dev (?weapon_sel=<id>): grant weapon <id> unlimited ammo and select it on every
   *  tank so it stays picked across the turn cycle (pairs with ?weapon_test=1). */
  forceWeapon(index: number): void {
    if (index < 0 || index >= WEAPON_DATABASE.length) return;
    this.m_economy.setUnlimited(index);
    this.m_currentWeaponIndex = index;
    for (const t of this.m_tanks) t.setWeaponIndex(index);
    this.markDirty();
  }

  // --- HUD accessors ---------------------------------------------------------
  getWeaponDefs() {
    // The control-weapon lock only restricts the HUMAN's own list. During a bot's
    // turn (or normal play) the full arsenal is shown, so the HUD reflects the
    // weapon the active player is actually using rather than the locked one.
    const ci = controlWeaponIndex();
    if (ci >= 0 && this.isPlayerTurn()) return [WEAPON_DATABASE[ci]];
    // Hide weapons disabled in Game Content; the staple (Shell) is always available.
    const staple = getDefaultWeaponIndex();
    return WEAPON_DATABASE.filter(w => w.index === staple || weaponEnabled(w.index));
  }

  getCurrentWeaponIndex(): number {
    return this.m_currentWeaponIndex;
  }

  getCurrentWeapon(): CWeapon {
    return getWeapon(this.m_currentWeaponIndex);
  }

  // --- Weapons Depot / economy ----------------------------------------------
  getCredits(): number {
    return this.m_economy.getCredits();
  }

  getMapName(): string {
    return this.m_mapName;
  }

  /** Per-weapon owned rounds (Infinity = unlimited staple). */
  getOwnedCounts(): number[] {
    return this.m_economy.ownedSnapshot();
  }

  isUnlimitedWeapon(i: number): boolean {
    return this.m_economy.isUnlimited(i);
  }

  buyWeapon(i: number): boolean {
    return this.m_economy.buy(i);
  }

  sellWeapon(i: number): boolean {
    return this.m_economy.sell(i);
  }

  autoBuyWeapons(): void {
    this.m_economy.autoBuy();
  }

  getAngle(): number {
    return this.m_angle;
  }

  getPower(): number {
    return this.m_power;
  }

  getWindValue(): number {
    return this.m_wind.x;
  }

  /** Full 2-D wind velocity, for the "Wind Measurements" LCD ("Vel %.02f %.02f"). */
  getWindVec(): {x: number; y: number} {
    return {x: this.m_wind.x, y: this.m_wind.y};
  }

  /** Wind acceleration (the drift target), for the LCD's "Acc %.02f %.02f". */
  getWindAccel(): {x: number; y: number} {
    return {x: this.m_windAccel.x, y: this.m_windAccel.y};
  }

  /** Whether the acting tank can drive from where it sits (LCD "Can move" /
   *  "Can't move" + "underground"). */
  getCurrentTankCanMove(): boolean {
    return this.getCurrentTank().canMove(this.m_land);
  }

  getCurrentPlayerName(): string {
    return this.getCurrentTank().getName();
  }

  getCurrentTeamColor(): string {
    return TEAM_COLORS[this.getCurrentTank().getTeamId()] || '#ff4444';
  }

  getWinnerName(): string {
    return this.m_winnerName;
  }

  /** Register a callback invoked at each shot impact (world x, y, strength). */
  setImpactListener(cb: (x: number, y: number, strength: number) => void): void {
    this.m_onImpact = cb;
  }

  /** Weapon-test mode (?weapon_test=1): the AI never takes a turn and the human's
   *  shot timer is disabled, so weapons can be fired back-to-back indefinitely. */
  setWeaponTest(on: boolean): void {
    this.m_weaponTest = on;
  }

  /** Wire the audio facade (SFX + music). Optional — the game runs silently without it. */
  setAudio(audio: CAudio): void {
    this.m_audio = audio;
    this.m_audio.setWorldWidth(this.m_worldWidth); // stereo pan spans the whole world
  }

  getAudio(): CAudio | null {
    return this.m_audio;
  }

  // ========================================================================
  // ACCESSORS
  // ========================================================================

  getState(): EGameState {
    return this.m_gameState;
  }

  /** True while the human is jet-flying (Flying state). */
  isFlying(): boolean {
    return this.m_gameState === EGameState.Flying;
  }

  /** Remaining jet fuel (seconds) of the current tank — 0 when not flying. */
  getJetFuel(): number {
    return this.getCurrentTank().getJetFuel();
  }

  isPlayerTurn(): boolean {
    return this.getCurrentTank().isHuman() && this.m_gameState === EGameState.Battle;
  }

  // ========================================================================
  // MEMBER VARIABLES
  // ========================================================================

  private m_canvas: HTMLCanvasElement;
  private m_ctx: CanvasRenderingContext2D;

  // Large-map camera (horizontal only). The world is `m_worldWidth` px wide; the
  // scene canvas is the view. `m_camX` = world X of the view's left edge (current,
  // eased); `m_camTargetX` = where it's heading. `m_manualScroll` = the player
  // dragged the minimap, which suppresses auto-follow until fire / turn change.
  private m_worldWidth = 0;
  private m_camX = 0;
  private m_camTargetX = 0;
  private m_manualScroll = false;
  // The ONE shot the camera tracks this turn (latched to the first of a salvo, so it
  // doesn't zig-zag across a multi-missile volley — the original follows a single
  // active shot). Null once reset each turn; may point at a now-dead shot.
  private m_activeShot: CShot | null = null;
  // World X of the most recent blast — the camera holds here while the explosion
  // animation plays out, so a nuke finishes on screen before the turn hands off.
  private m_lastImpactX = 0;

  private m_land: CLand;
  private m_tanks: CTank[] = [];
  private m_shots: CShot[];
  private m_pendingSalvos = 0; // succession salvos still scheduled to fire this shot
  private m_weaponTest = false; // ?weapon_test=1: AI never takes a turn (endless firing)

  private m_particles: CParticleSystem;
  private m_weather: CWeather;
  private m_economy: CEconomy;
  private m_mapName = 'Battlefield';
  private m_screenShake: ScreenShake;
  private m_assets: CAssetManager;
  private m_onImpact: ((x: number, y: number, strength: number) => void) | null = null;
  private m_audio: CAudio | null = null;
  private m_tanksMoving = false; // tracks the tank-moving loop state
  private m_jetSounding = false; // tracks the jet.wav loop state

  // Placed entities from special weapons (Mine/Sentry) and Tracer aim markers.
  private m_mines: {
    x: number;
    y: number;
    owner: CTank | null;
    weaponIndex: number;
    armed: number;
  }[] = [];
  private m_sentries: {x: number; y: number; owner: CTank | null; weaponIndex: number}[] = [];
  private m_aimMarkers: {x: number; y: number}[] = [];

  // Free-running clock for animated indicators (bouncing turn triangle) — also
  // the timebase for scheduled game-flow actions (see m_timers), so both freeze
  // together while paused.
  private m_time: number = 0;
  private m_screenFlash: number = 0; // full-viewport white-out intensity (0..1), decays each frame
  private m_flashColor: string = '#ffffff'; // weapon-tinted flash colour
  // Deferred sim-clock actions (bot turns, turn hand-off): {at: sim-time due, fn}.
  private m_timers: {at: number; fn: () => void}[] = [];
  // Whole-game pause: freezes the sim clock (update is skipped) and audio.
  private m_paused: boolean = false;
  // Present-on-demand gate: the loop keeps ticking, but the heavy 2D redraw + GPU
  // upload are skipped on frames where nothing visible changed (see shouldRedraw).
  private m_renderGate = new RenderGate();
  // Live drag-aim state: the world-space target the player is dragging toward.
  private m_aim: {active: boolean; tx: number; ty: number} = {active: false, tx: 0, ty: 0};
  // Last known mouse position in world coords (for hover-detail on tank badges).
  private m_mouse: {x: number; y: number} = {x: -1, y: -1};

  setMouse(wx: number, wy: number): void {
    this.m_mouse.x = wx;
    this.m_mouse.y = wy;
    this.markDirty();
  }

  // Top-left status counters ("Battle %d of %d - Shot %d").
  private m_shotsFired = 0;
  private m_currentBattle = 1;
  private m_totalBattles = 5;

  // Gameplay config pushed from the Settings menu (see ui/applySettings). Start-time
  // values (credits, land shape) are read in startGame; the rest are read live.
  private m_startCredits = START_CREDITS;
  private m_landMode = -1; // -1 = random landscape; 0..4 = a forced shape
  private m_flatLand = false; // DEV `?flatland=1`: force a flat test surface next startGame
  private m_windScale = 1; // 0 disables wind
  private m_variance = true; // per-shot inaccuracy on/off
  private m_speedScale = 1; // game-speed multiplier (Update Scale / 10)
  private m_creditDamage = CREDIT_PER_DAMAGE; // credits earned per point of life removed
  private m_creditKill = CREDIT_PER_KILL; // credits earned per kill (Deathmatch)
  private m_creditTurn = CREDIT_PER_TURN; // credits earned by each survivor per turn
  private m_creditRound = CREDIT_PER_ROUND; // credits earned by each survivor per round
  private m_gameType = EGameType.Deathmatch; // match type (kill credit is Deathmatch-only)
  private m_currentRound = 1; // completed turn-order passes + 1

  getShotCount(): number {
    return this.m_shotsFired;
  }

  getBattleNum(): number {
    return this.m_currentBattle;
  }

  getTotalBattles(): number {
    return this.m_totalBattles;
  }

  /** Per-tank life status for the top-left overlay ("%s: %d%% life"). */
  getTankStatuses(): {
    name: string;
    lifePct: number;
    color: string;
    alive: boolean;
    active: boolean;
  }[] {
    const cur = this.m_tanks[this.m_currentPlayerIndex];
    return this.m_tanks.map(t => ({
      name: t.getName(),
      lifePct: Math.max(0, Math.round((t.getHealth().nLife / t.getMaxLife()) * 100)), // → 0..100
      color: t.getTeamColor(),
      alive: t.isAlive(),
      active: t === cur,
    }));
  }

  // The aim (angle, power) at turn start — anchors the faded "initial" target cross.
  private m_turnStartAngle: number = 45;
  private m_turnStartPower: number = 500;

  // Shot-time countdown (from the "Shot Time" setting). The human has this many
  // seconds to aim + fire; the panel bar below FIRE drains green→yellow→red and,
  // on expiry, the turn is forfeited. 0 = disabled (no limit, bar hidden).
  private m_shotTime: number = 30;
  private m_turnElapsed: number = 0;
  // Only counts while awaiting the human's shot: true from beginTurn (human,
  // limit on) until fire()/expiry/turn-end. Bots never time out.
  private m_turnTimerRunning: boolean = false;

  // Game state machine
  private m_gameState: EGameState = EGameState.Battle;
  private m_currentPlayerIndex: number = 0;

  // Firing controls
  private m_angle: number;
  private m_power: number;
  private m_currentWeaponIndex: number; // Index into WEAPON_DATABASE

  // Physics — wind is a slowly-drifting 2-D vector (display units, ~±5).
  private m_wind: Vec2 = new Vec2(0, 0);
  private m_windAccel: Vec2 = new Vec2(0, 0);
  private m_windTimer: number = 0;
  private m_difficulty: number = AI_DEFAULT_LEVEL; // computer-player skill

  private m_winnerName: string = '';
}
