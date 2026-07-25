/**
 * CAudio — the game's audio facade.
 *
 * A single audio funnel: gameplay code calls **semantic** events here
 * (fire / hit / tankExplode / battleWon…), and this class maps them to the
 * SFX manager and music player. It also owns the one shared AudioContext and
 * the master gain, and handles the browser's autoplay policy (the context
 * starts suspended and is resumed on the first user gesture).
 *
 * Track-selection policy (see CMusicPlayer):
 *   menu → "Four Ages.it" (loop);  battle → random of 3 (loop);
 *   win → "Airborne.it" (once);    lose → "Well.it" (once).
 */

import {CSoundManager} from './CSoundManager';
import {CMusicPlayer} from './CMusicPlayer';
import {loadJSON, saveJSON} from '../util/storage';

// Hardcoded (non-weapon) event sounds — the files present in assets/sound/ that
// no weapon references. Mapped to game events at their trigger sites.
export const SFX = {
  TANK_EXPLODE: 'tank explode.wav',
  TANK_MOVING: 'tank moving.wav',
  JET: 'jet.wav',
  BATTLE_WON: 'battle won.wav',
  BATTLE_LOST: 'battle lost.wav',
  CLICK: 'click.wav',
  TYPING: 'typing.wav',
  PANEL_OPEN: 'Panel1.wav', // a screen / dialog panel opens
  PANEL_CLOSE: 'Panel3.wav', // …and closes
  START_GAME: 'Mechanismus4.wav', // the Start Game "chunk" as a battle launches
  MENU_HOVER: 'Pacdot2.wav', // blip as the highlighted menu item changes
  MENU_FORWARD: 'Mechanismus1.wav', // navigating INTO a menu screen (Play / Settings / …)
  MENU_BACK: 'Mechanismus2.wav', // …and Back to the main menu
  FIREWORK: ['Slapthunder1.wav', 'Slapthunder2.wav'] as const,
} as const;

// Persisted audio preferences (options-menu equivalents).
const SETTINGS_KEY = 'atomic.audio';

interface AudioSettings {
  sfxVol: number;
  musicVol: number;
  sfxOn: boolean;
  musicOn: boolean;
  stereoOn: boolean;
  /** Menu navigation blips (hover / forward / back). NOT part of the original game,
   *  so this is opt-in and defaults OFF. */
  menuSfxOn: boolean;
}

// Music policy.
const MENU_MUSIC = 'Four Ages.it';
const BATTLE_TRACKS = ['Into the Wild Blue Monster.it', 'Anubis Claws.it', 'Rust.it'];
const VICTORY_MUSIC = 'Airborne.it';
const DEFEAT_MUSIC = 'Well.it';

// Combat-set effects to warm up front. The weapon fire/hit samples load lazily
// on first use; these are the guaranteed event sounds plus the most common
// shared weapon hits.
const COMBAT_PRELOAD = [
  SFX.TANK_EXPLODE,
  SFX.TANK_MOVING,
  SFX.JET,
  SFX.BATTLE_WON,
  SFX.BATTLE_LOST,
  SFX.CLICK,
  SFX.JET,
  'fire.wav',
  'cannon.wav',
  'hit.wav',
  'hit high.wav',
  'bomb.wav',
];

export class CAudio {
  // Two audio contexts so a game pause can FREEZE gameplay sound without touching music/UI:
  //  • m_ctxMain — music + UI/chrome SFX (clicks, panels, menu blips, buy/sell). Resumed once at
  //    unlock and left running; a pause never suspends it, so music plays and UI stays responsive.
  //  • m_ctxGame — gameplay SFX (weapon fire, hits, explosions, drive/jet loops). SUSPENDED on
  //    pause: suspending the context stops its render clock, so an in-flight nuke boom or a drive
  //    loop FREEZES in place and resumes exactly where it left off — in sync with the animation
  //    that also resumes. (A single shared context would have to freeze the music too.)
  private readonly m_ctxMain: AudioContext;
  private readonly m_ctxGame: AudioContext;
  private readonly m_masterMain: GainNode;
  private readonly m_masterGame: GainNode;
  private readonly m_gameSfx: CSoundManager; // fire / hit / explosions / drive+jet loops
  private readonly m_uiSfx: CSoundManager; // clicks / panels / menu blips / buy-sell (never frozen)
  private readonly m_music: CMusicPlayer;
  private m_unlocked = false;
  private m_paused = false; // intended pause state driving the gameplay-context suspend
  // Menu navigation blips (hover / forward / back) — a non-legacy nicety, OFF by default.
  private m_menuSfxOn = false;

  constructor() {
    const Ctor =
      window.AudioContext ??
      (
        window as unknown as {
          webkitAudioContext: typeof AudioContext;
        }
      ).webkitAudioContext;
    this.m_ctxMain = new Ctor();
    this.m_ctxGame = new Ctor();
    this.m_masterMain = this.m_ctxMain.createGain();
    this.m_masterMain.gain.value = 1;
    this.m_masterMain.connect(this.m_ctxMain.destination);
    this.m_masterGame = this.m_ctxGame.createGain();
    this.m_masterGame.gain.value = 1;
    this.m_masterGame.connect(this.m_ctxGame.destination);
    this.m_music = new CMusicPlayer(this.m_ctxMain, this.m_masterMain);
    this.m_uiSfx = new CSoundManager(this.m_ctxMain, this.m_masterMain);
    this.m_gameSfx = new CSoundManager(this.m_ctxGame, this.m_masterGame);
  }

  /** The pan axis — world width in pixels. Only gameplay SFX are panned. */
  setWorldWidth(w: number): void {
    this.m_gameSfx.setWorldWidth(w);
  }

  // ── Autoplay unlock ────────────────────────────────────────────────────────

  /** Attach one-time gesture listeners that resume the context (autoplay policy). */
  attachUnlock(target: EventTarget = window): void {
    const unlock = () => {
      void this.unlock();
    };
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      target.addEventListener(ev, unlock, {once: true, passive: true} as AddEventListenerOptions);
    }
  }

  async unlock(): Promise<void> {
    if (this.m_unlocked) return;
    this.m_unlocked = true;
    // Wake both contexts on the first gesture (clears the autoplay lock). The main context (music +
    // UI) always wakes. The gameplay context wakes only if we're NOT currently paused — a pause
    // keeps it suspended so any in-flight effect stays frozen until resume() lifts it.
    await CAudio.resumeCtx(this.m_ctxMain);
    if (!this.m_paused) await CAudio.resumeCtx(this.m_ctxGame);
    // A track requested before this gesture (menu music at boot) was posted to a
    // suspended context and won't reliably auto-start on resume — replay it now.
    this.m_music.replay();
  }

  private static async resumeCtx(ctx: AudioContext): Promise<void> {
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
  }

  isUnlocked(): boolean {
    return this.m_unlocked;
  }

  // ── Pause (freeze/restore gameplay audio for a modal game freeze) ─────────────

  /**
   * Freeze gameplay audio for a game pause (depot / pause menu / help): suspend the gameplay-SFX
   * context so every in-flight weapon boom, explosion tail and drive/jet loop stops advancing and
   * later resumes in sync with the animation that also resumes. Music and UI sounds live on the
   * separate always-on context and keep playing — so the depot isn't silent, but a nuke caught
   * mid-blast doesn't play on (and then fall silent) behind a frozen screen.
   */
  suspend(): void {
    this.m_paused = true;
    void this.applyGameCtx();
  }

  /** Resume gameplay audio after a game pause: un-suspend the gameplay-SFX context (frozen effects
   *  and loops pick up where they left off). */
  resume(): void {
    this.m_paused = false;
    void this.applyGameCtx();
  }

  /**
   * Drive the gameplay context to the latest INTENDED state (`m_paused`). `ctx.suspend()`/`resume()`
   * resolve a render-quantum later, and a rapid pause↔unpause (open then close the depot) can flip
   * the intent mid-await — a naive one-shot check would then miss and leave the context stuck. So
   * apply twice, re-reading the intent each pass, guarded against re-entrancy.
   */
  private m_applyingGameCtx = false;
  private async applyGameCtx(): Promise<void> {
    if (this.m_applyingGameCtx) return; // an apply is running; it re-reads m_paused after each await
    this.m_applyingGameCtx = true;
    try {
      await this.stepGameCtx();
      await this.stepGameCtx();
    } finally {
      this.m_applyingGameCtx = false;
    }
  }

  /** One convergence step: drive the gameplay context toward the current intended `m_paused` state. */
  private async stepGameCtx(): Promise<void> {
    if (!this.m_unlocked) return; // can't touch the context until the autoplay lock clears
    if (this.m_paused && this.m_ctxGame.state === 'running') {
      await this.m_ctxGame.suspend().catch(() => {});
    } else if (!this.m_paused && this.m_ctxGame.state === 'suspended') {
      await this.m_ctxGame.resume().catch(() => {});
    }
  }

  /** Preload the combat effect set (fire-and-forget). */
  preloadCombat(): void {
    void this.m_gameSfx.preload(COMBAT_PRELOAD);
  }

  /** Preload the front-end menu effect set (fire-and-forget) so the first hover /
   *  navigation isn't a silent cache miss. Idempotent — buffers are cached. */
  preloadMenu(): void {
    void this.m_uiSfx.preload([SFX.MENU_HOVER, SFX.MENU_FORWARD, SFX.MENU_BACK, SFX.CLICK]);
  }

  // ── Semantic game events (the play funnel) ──────────────────────────────────
  // Gameplay effects go through m_gameSfx (frozen by a pause); UI/chrome through m_uiSfx (never frozen).

  /** Weapon fire — the weapon's `soundFire` string, panned to the muzzle. */
  fire(soundFire: string, worldX: number): void {
    this.m_gameSfx.play(soundFire, worldX);
  }

  /** Projectile impact — the weapon's `soundHit` string, panned to the blast. */
  hit(soundHit: string, worldX: number): void {
    this.m_gameSfx.play(soundHit, worldX);
  }

  tankExplode(worldX: number): void {
    this.m_gameSfx.play(SFX.TANK_EXPLODE, worldX, {throttle: false});
  }

  /** A victory-fireworks burst — one of the two thunder claps at random, panned to
   *  the burst's WORLD column (the pan axis is world width, like every other SFX). */
  firework(worldX: number): void {
    const s = SFX.FIREWORK[Math.random() < 0.5 ? 0 : 1];
    this.m_gameSfx.play(s, worldX, {throttle: false});
  }

  /** A supply-crate pickup chime, panned to the crate. */
  crate(worldX: number): void {
    this.m_gameSfx.play('RobotLimb5.wav', worldX, {throttle: false});
  }

  startTankMove(worldX?: number): void {
    this.m_gameSfx.startLoop(SFX.TANK_MOVING, worldX);
  }

  updateTankMove(worldX: number): void {
    this.m_gameSfx.setLoopPan(SFX.TANK_MOVING, worldX);
  }

  stopTankMove(): void {
    this.m_gameSfx.stopLoop(SFX.TANK_MOVING);
  }

  startJet(worldX?: number): void {
    this.m_gameSfx.startLoop(SFX.JET, worldX);
  }

  updateJet(worldX: number): void {
    this.m_gameSfx.setLoopPan(SFX.JET, worldX);
  }

  stopJet(): void {
    this.m_gameSfx.stopLoop(SFX.JET);
  }

  uiClick(): void {
    this.m_uiSfx.play(SFX.CLICK);
  }

  /** A screen / dialog panel opening (menu, settings, depot, pause, help). */
  uiOpen(): void {
    this.m_uiSfx.play(SFX.PANEL_OPEN);
  }

  /** …and the same panel closing. */
  uiClose(): void {
    this.m_uiSfx.play(SFX.PANEL_CLOSE);
  }

  /** Weapons Depot buy / sell confirmation. The original reused Panel1.wav for both
   *  the successful buy and sell, not the generic click. On the UI context so it plays
   *  even though the depot has the gameplay context suspended. */
  depotTransaction(): void {
    this.m_uiSfx.play(SFX.PANEL_OPEN);
  }

  /** The Start Game "chunk" as a battle launches. */
  startGameSound(): void {
    this.m_uiSfx.play(SFX.START_GAME);
  }

  /** Blip as the highlighted main-menu item changes (throttled, so a fast sweep
   *  across items doesn't machine-gun). Gated by the Menu Sounds toggle (OFF by default). */
  menuHover(): void {
    if (!this.m_menuSfxOn) return;
    this.m_uiSfx.play(SFX.MENU_HOVER);
  }

  /** Mechanical whirr when navigating INTO a menu screen from the main menu. */
  menuForward(): void {
    if (!this.m_menuSfxOn) return;
    this.m_uiSfx.play(SFX.MENU_FORWARD);
  }

  /** …and its counterpart when stepping Back to the main menu. */
  menuBack(): void {
    if (!this.m_menuSfxOn) return;
    this.m_uiSfx.play(SFX.MENU_BACK);
  }

  /** A keystroke while typing a name (Customize Players). */
  typingSound(): void {
    this.m_uiSfx.play(SFX.TYPING);
  }

  // ── Music ────────────────────────────────────────────────────────────────

  // Which looped bed is the CURRENT context — recorded even while music is DISABLED so a later
  // "enable music" re-arms the RIGHT track (menu music on the menu, not a battle track).
  private m_musicContext: 'menu' | 'battle' | null = null;
  private m_battleTrack: string | null = null; // the battle bed picked for THIS battle (replayed on re-arm)

  menuMusic(): void {
    this.m_musicContext = 'menu';
    this.preloadMenu(); // warm the menu SFX so the first hover / click isn't silent
    void this.m_music.play(MENU_MUSIC, true);
  }

  /** Start a battle: one random looped track. */
  battleMusic(): void {
    this.m_musicContext = 'battle';
    this.m_battleTrack = BATTLE_TRACKS[Math.floor(Math.random() * BATTLE_TRACKS.length)];
    void this.m_music.play(this.m_battleTrack, true);
  }

  battleWon(): void {
    this.m_uiSfx.play(SFX.BATTLE_WON, undefined, {throttle: false});
    void this.m_music.play(VICTORY_MUSIC, false);
  }

  battleLost(): void {
    this.m_uiSfx.play(SFX.BATTLE_LOST, undefined, {throttle: false});
    void this.m_music.play(DEFEAT_MUSIC, false);
  }

  stopMusic(): void {
    this.m_music.stop();
  }

  // ── Settings (options menu: SFX vol / music vol / on-off toggles) ───────────

  /** The gameplay + UI SFX buses share one set of options (volume / enabled / stereo). */
  private eachSfx(fn: (m: CSoundManager) => void): void {
    fn(this.m_gameSfx);
    fn(this.m_uiSfx);
  }

  setSfxVolume(v: number): void {
    this.eachSfx(m => m.setVolume(v));
    this.saveSettings();
  }

  setMusicVolume(v: number): void {
    this.m_music.setVolume(v);
    this.saveSettings();
  }

  setSfxEnabled(on: boolean): void {
    this.eachSfx(m => m.setEnabled(on));
    this.saveSettings();
  }

  setMusicEnabled(on: boolean): void {
    this.m_music.setEnabled(on);
    // Re-arm the CURRENT context's bed when unmuted (setEnabled(false) stopped it) — menu music on
    // the menu, battle music in a battle. A screen-unaware re-arm played a battle track over the menu.
    if (on && !this.m_music.currentTrack()) {
      // Replay the SAME battle bed that was muted (not a fresh random pick — that swapped the track
      // on a mute/unmute toggle mid-battle). Fall back to a fresh pick if none was chosen yet.
      if (this.m_musicContext === 'battle') {
        if (this.m_battleTrack) void this.m_music.play(this.m_battleTrack, true);
        else this.battleMusic();
      } else if (this.m_musicContext === 'menu') this.menuMusic();
    }
    this.saveSettings();
  }

  /** Audio → Stereo: SFX pan across the field when on, all-centre (mono) when off. */
  setStereo(on: boolean): void {
    this.eachSfx(m => m.setStereo(on));
    this.saveSettings();
  }
  isStereo(): boolean {
    return this.m_gameSfx.isStereo();
  }

  /** Audio → Menu Sounds: the non-legacy menu navigation blips (hover / forward / back). */
  setMenuSfxEnabled(on: boolean): void {
    this.m_menuSfxOn = on;
    if (on) this.preloadMenu(); // warm the buffers so the first blip isn't a silent miss
    this.saveSettings();
  }
  isMenuSfxEnabled(): boolean {
    return this.m_menuSfxOn;
  }

  getSfxVolume(): number {
    return this.m_gameSfx.getVolume();
  }

  getMusicVolume(): number {
    return this.m_music.getVolume();
  }

  isSfxEnabled(): boolean {
    return this.m_gameSfx.isEnabled();
  }

  isMusicEnabled(): boolean {
    return this.m_music.isEnabled();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  /** Apply saved volume/enable settings (call once, after construction). */
  loadSettings(): void {
    const s = loadJSON<Partial<AudioSettings>>(SETTINGS_KEY, {});
    if (typeof s.sfxVol === 'number') {
      const v = s.sfxVol;
      this.eachSfx(m => m.setVolume(v));
    }
    if (typeof s.musicVol === 'number') this.m_music.setVolume(s.musicVol);
    if (typeof s.sfxOn === 'boolean') {
      const on = s.sfxOn;
      this.eachSfx(m => m.setEnabled(on));
    }
    if (typeof s.musicOn === 'boolean') this.m_music.setEnabled(s.musicOn);
    if (typeof s.stereoOn === 'boolean') {
      const on = s.stereoOn;
      this.eachSfx(m => m.setStereo(on));
    }
    if (typeof s.menuSfxOn === 'boolean') this.m_menuSfxOn = s.menuSfxOn;
  }

  private saveSettings(): void {
    saveJSON(SETTINGS_KEY, {
      sfxVol: this.m_gameSfx.getVolume(),
      musicVol: this.m_music.getVolume(),
      sfxOn: this.m_gameSfx.isEnabled(),
      musicOn: this.m_music.isEnabled(),
      stereoOn: this.m_gameSfx.isStereo(),
      menuSfxOn: this.m_menuSfxOn,
    } satisfies AudioSettings);
  }
}
