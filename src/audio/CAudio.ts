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
  private readonly m_ctx: AudioContext;
  private readonly m_master: GainNode;
  private readonly m_sfx: CSoundManager;
  private readonly m_music: CMusicPlayer;
  private m_unlocked = false;
  private m_suspended = false; // suspended by a game pause (distinct from the autoplay lock)
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
    this.m_ctx = new Ctor();
    this.m_master = this.m_ctx.createGain();
    this.m_master.gain.value = 1;
    this.m_master.connect(this.m_ctx.destination);
    this.m_sfx = new CSoundManager(this.m_ctx, this.m_master);
    this.m_music = new CMusicPlayer(this.m_ctx, this.m_master);
  }

  get sfx(): CSoundManager {
    return this.m_sfx;
  }

  get music(): CMusicPlayer {
    return this.m_music;
  }

  /** The pan axis — world width in pixels. */
  setWorldWidth(w: number): void {
    this.m_sfx.setWorldWidth(w);
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
    // Don't wake the context if the game is paused (e.g. the very first gesture is
    // the pause key) — resume() is the only thing that clears a game suspend.
    if (!this.m_suspended && this.m_ctx.state === 'suspended') {
      try {
        await this.m_ctx.resume();
      } catch {
        /* ignore */
      }
    }
    // A track requested before this gesture (menu music at boot) was posted to a
    // suspended context and won't reliably auto-start on resume — replay it now.
    this.m_music.replay();
  }

  isUnlocked(): boolean {
    return this.m_unlocked;
  }

  // ── Pause (freeze/restore all audio through the shared context) ──────────────

  /**
   * Freeze all audio for a game pause. Suspending the shared AudioContext halts
   * every SFX voice, looping sounds AND the music worklet in one shot (the graph
   * clock stops), so nothing needs to know it was paused to come back cleanly.
   */
  async suspend(): Promise<void> {
    this.m_suspended = true;
    await this.applyAudioState();
  }

  /** Resume audio after a game pause (no-op until the autoplay lock is cleared). */
  async resume(): Promise<void> {
    this.m_suspended = false;
    await this.applyAudioState();
  }

  /**
   * Drive the AudioContext to the latest INTENDED state (`m_suspended`). `ctx.suspend()`/`resume()`
   * resolve a render-quantum later, and a rapid pause↔unpause (e.g. opening then closing the depot)
   * can flip the intent mid-await — the naive `if (state === 'running')` check then misses and the
   * context is left stuck-suspended while the game runs. So loop: re-read the intent each pass and
   * converge, guarded against re-entrancy (a concurrent call just lets the in-flight loop re-check).
   */
  private m_applyingAudio = false;
  private async applyAudioState(): Promise<void> {
    if (this.m_applyingAudio) return; // an apply is running; it re-reads m_suspended after each await
    this.m_applyingAudio = true;
    try {
      // Apply the intent, then apply ONCE MORE: a rapid pause↔unpause can flip `m_suspended` during
      // the first await, which the naive one-shot check would miss (leaving the context stuck). Two
      // passes cover that realistic race; each pass re-reads the latest intent.
      await this.stepAudioState();
      await this.stepAudioState();
    } finally {
      this.m_applyingAudio = false;
    }
  }

  /** One convergence step: drive the context toward the current intended `m_suspended` state. */
  private async stepAudioState(): Promise<void> {
    if (!this.m_unlocked) return; // can't touch the context until the autoplay lock clears
    if (this.m_suspended && this.m_ctx.state === 'running') {
      await this.m_ctx.suspend().catch(() => {});
    } else if (!this.m_suspended && this.m_ctx.state === 'suspended') {
      await this.m_ctx.resume().catch(() => {});
    }
  }

  /** Preload the combat effect set (fire-and-forget). */
  preloadCombat(): void {
    void this.m_sfx.preload(COMBAT_PRELOAD);
  }

  /** Preload the front-end menu effect set (fire-and-forget) so the first hover /
   *  navigation isn't a silent cache miss. Idempotent — buffers are cached. */
  preloadMenu(): void {
    void this.m_sfx.preload([SFX.MENU_HOVER, SFX.MENU_FORWARD, SFX.MENU_BACK, SFX.CLICK]);
  }

  // ── Semantic game events (the play funnel) ──────────────────────────────────

  /** Weapon fire — the weapon's `soundFire` string, panned to the muzzle. */
  fire(soundFire: string, worldX: number): void {
    this.m_sfx.play(soundFire, worldX);
  }

  /** Projectile impact — the weapon's `soundHit` string, panned to the blast. */
  hit(soundHit: string, worldX: number): void {
    this.m_sfx.play(soundHit, worldX);
  }

  tankExplode(worldX: number): void {
    this.m_sfx.play(SFX.TANK_EXPLODE, worldX, {throttle: false});
  }

  /** A victory-fireworks burst — one of the two thunder claps at random, panned to
   *  the burst's WORLD column (the pan axis is world width, like every other SFX). */
  firework(worldX: number): void {
    const s = SFX.FIREWORK[Math.random() < 0.5 ? 0 : 1];
    this.m_sfx.play(s, worldX, {throttle: false});
  }

  /** A supply-crate pickup chime, panned to the crate. */
  crate(worldX: number): void {
    this.m_sfx.play('RobotLimb5.wav', worldX, {throttle: false});
  }

  startTankMove(worldX?: number): void {
    this.m_sfx.startLoop(SFX.TANK_MOVING, worldX);
  }

  updateTankMove(worldX: number): void {
    this.m_sfx.setLoopPan(SFX.TANK_MOVING, worldX);
  }

  stopTankMove(): void {
    this.m_sfx.stopLoop(SFX.TANK_MOVING);
  }

  startJet(worldX?: number): void {
    this.m_sfx.startLoop(SFX.JET, worldX);
  }

  updateJet(worldX: number): void {
    this.m_sfx.setLoopPan(SFX.JET, worldX);
  }

  stopJet(): void {
    this.m_sfx.stopLoop(SFX.JET);
  }

  uiClick(): void {
    this.m_sfx.play(SFX.CLICK);
  }

  /** A screen / dialog panel opening (menu, settings, depot, pause, help). */
  uiOpen(): void {
    this.m_sfx.play(SFX.PANEL_OPEN);
  }

  /** …and the same panel closing. */
  uiClose(): void {
    this.m_sfx.play(SFX.PANEL_CLOSE);
  }

  /** Weapons Depot buy / sell confirmation. The original reused Panel1.wav for both
   *  the successful buy and sell, not the generic click. */
  depotTransaction(): void {
    this.m_sfx.play(SFX.PANEL_OPEN);
  }

  /** The Start Game "chunk" as a battle launches. */
  startGameSound(): void {
    this.m_sfx.play(SFX.START_GAME);
  }

  /** Blip as the highlighted main-menu item changes (throttled, so a fast sweep
   *  across items doesn't machine-gun). Gated by the Menu Sounds toggle (OFF by default). */
  menuHover(): void {
    if (!this.m_menuSfxOn) return;
    this.m_sfx.play(SFX.MENU_HOVER);
  }

  /** Mechanical whirr when navigating INTO a menu screen from the main menu. */
  menuForward(): void {
    if (!this.m_menuSfxOn) return;
    this.m_sfx.play(SFX.MENU_FORWARD);
  }

  /** …and its counterpart when stepping Back to the main menu. */
  menuBack(): void {
    if (!this.m_menuSfxOn) return;
    this.m_sfx.play(SFX.MENU_BACK);
  }

  /** A keystroke while typing a name (Customize Players). */
  typingSound(): void {
    this.m_sfx.play(SFX.TYPING);
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
    this.m_sfx.play(SFX.BATTLE_WON, undefined, {throttle: false});
    void this.m_music.play(VICTORY_MUSIC, false);
  }

  battleLost(): void {
    this.m_sfx.play(SFX.BATTLE_LOST, undefined, {throttle: false});
    void this.m_music.play(DEFEAT_MUSIC, false);
  }

  stopMusic(): void {
    this.m_music.stop();
  }

  // ── Settings (options menu: SFX vol / music vol / on-off toggles) ───────────

  setSfxVolume(v: number): void {
    this.m_sfx.setVolume(v);
    this.saveSettings();
  }

  setMusicVolume(v: number): void {
    this.m_music.setVolume(v);
    this.saveSettings();
  }

  setSfxEnabled(on: boolean): void {
    this.m_sfx.setEnabled(on);
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
    this.m_sfx.setStereo(on);
    this.saveSettings();
  }
  isStereo(): boolean {
    return this.m_sfx.isStereo();
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
    return this.m_sfx.getVolume();
  }

  getMusicVolume(): number {
    return this.m_music.getVolume();
  }

  isSfxEnabled(): boolean {
    return this.m_sfx.isEnabled();
  }

  isMusicEnabled(): boolean {
    return this.m_music.isEnabled();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  /** Apply saved volume/enable settings (call once, after construction). */
  loadSettings(): void {
    const s = loadJSON<Partial<AudioSettings>>(SETTINGS_KEY, {});
    if (typeof s.sfxVol === 'number') this.m_sfx.setVolume(s.sfxVol);
    if (typeof s.musicVol === 'number') this.m_music.setVolume(s.musicVol);
    if (typeof s.sfxOn === 'boolean') this.m_sfx.setEnabled(s.sfxOn);
    if (typeof s.musicOn === 'boolean') this.m_music.setEnabled(s.musicOn);
    if (typeof s.stereoOn === 'boolean') this.m_sfx.setStereo(s.stereoOn);
    if (typeof s.menuSfxOn === 'boolean') this.m_menuSfxOn = s.menuSfxOn;
  }

  private saveSettings(): void {
    saveJSON(SETTINGS_KEY, {
      sfxVol: this.m_sfx.getVolume(),
      musicVol: this.m_music.getVolume(),
      sfxOn: this.m_sfx.isEnabled(),
      musicOn: this.m_music.isEnabled(),
      stereoOn: this.m_sfx.isStereo(),
      menuSfxOn: this.m_menuSfxOn,
    } satisfies AudioSettings);
  }
}
