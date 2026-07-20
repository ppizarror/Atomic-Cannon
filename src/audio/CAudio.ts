/**
 * CAudio — the game's audio facade.
 *
 * Mirrors the original's single audio funnel: gameplay code calls **semantic**
 * events here (fire / hit / tankExplode / battleWon…), and this class maps them
 * to the SFX manager and music player. It also owns the one shared AudioContext
 * and the master gain, and handles the browser's autoplay policy (the context
 * starts suspended and is resumed on the first user gesture).
 *
 * Track-selection policy is straight from the RE (see CMusicPlayer):
 *   menu → "Four Ages.it" (loop);  battle → random of 3 (loop);
 *   win → "Airborne.it" (once);    lose → "Well.it" (once).
 */

import {CSoundManager} from './CSoundManager';
import {CMusicPlayer} from './CMusicPlayer';

// Hardcoded (non-weapon) event sounds — the files present in assets/sound/ that
// no weapon references. Mapped to game events per the decompiled trigger sites.
export const SFX = {
    TANK_EXPLODE: 'tank explode.wav',
    TANK_MOVING: 'tank moving.wav',
    JET: 'jet.wav',
    BATTLE_WON: 'battle won.wav',
    BATTLE_LOST: 'battle lost.wav',
    CLICK: 'click.wav',
    TYPING: 'typing.wav',
} as const;

// Persisted audio preferences (options-menu equivalents).
const SETTINGS_KEY = 'atomic.audio';

interface AudioSettings {
    sfxVol: number;
    musicVol: number;
    sfxOn: boolean;
    musicOn: boolean;
}

// Music policy (RE: FUN_00445160 battle-start, FUN_0047d2d0 end jingles).
const MENU_MUSIC = 'Four Ages.it';
const BATTLE_TRACKS = ['Into the Wild Blue Monster.it', 'Anubis Claws.it', 'Rust.it'];
const VICTORY_MUSIC = 'Airborne.it';
const DEFEAT_MUSIC = 'Well.it';

// Combat-set effects to warm up front (the original's FUN_0044c4b0 preload). The
// weapon fire/hit samples load lazily on first use; these are the guaranteed
// event sounds plus the most common shared weapon hits.
const COMBAT_PRELOAD = [
    SFX.TANK_EXPLODE, SFX.TANK_MOVING, SFX.JET, SFX.BATTLE_WON, SFX.BATTLE_LOST,
    SFX.CLICK, SFX.JET, 'fire.wav', 'cannon.wav', 'hit.wav', 'hit high.wav', 'bomb.wav',
];

export class CAudio {
    private readonly m_ctx: AudioContext;
    private readonly m_master: GainNode;
    private readonly m_sfx: CSoundManager;
    private readonly m_music: CMusicPlayer;
    private m_unlocked = false;
    private m_suspended = false;   // suspended by a game pause (distinct from the autoplay lock)

    constructor() {
        const Ctor = window.AudioContext ?? (window as unknown as {
            webkitAudioContext: typeof AudioContext
        }).webkitAudioContext;
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
            } catch { /* ignore */
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
        if (this.m_ctx.state === 'running') {
            try {
                await this.m_ctx.suspend();
            } catch { /* ignore */
            }
        }
    }

    /** Resume audio after a game pause (no-op until the autoplay lock is cleared). */
    async resume(): Promise<void> {
        this.m_suspended = false;
        if (this.m_unlocked && this.m_ctx.state === 'suspended') {
            try {
                await this.m_ctx.resume();
            } catch { /* ignore */
            }
        }
    }

    /** Preload the combat effect set (fire-and-forget). */
    preloadCombat(): void {
        void this.m_sfx.preload(COMBAT_PRELOAD);
    }

    // ── Semantic game events (the PlaySound funnel) ─────────────────────────────

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

    // ── Music ────────────────────────────────────────────────────────────────

    menuMusic(): void {
        void this.m_music.play(MENU_MUSIC, true);
    }

    /** Start a battle: one random looped track, exactly like the original. */
    battleMusic(): void {
        const pick = BATTLE_TRACKS[Math.floor(Math.random() * BATTLE_TRACKS.length)];
        void this.m_music.play(pick, true);
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
        // Re-arm the current bed when unmuted mid-battle (setEnabled(false) stops it).
        if (on && !this.m_music.currentTrack()) this.battleMusic();
        this.saveSettings();
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
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) return;
            const s = JSON.parse(raw) as Partial<AudioSettings>;
            if (typeof s.sfxVol === 'number') this.m_sfx.setVolume(s.sfxVol);
            if (typeof s.musicVol === 'number') this.m_music.setVolume(s.musicVol);
            if (typeof s.sfxOn === 'boolean') this.m_sfx.setEnabled(s.sfxOn);
            if (typeof s.musicOn === 'boolean') this.m_music.setEnabled(s.musicOn);
        } catch { /* corrupt/absent storage — keep defaults */
        }
    }

    private saveSettings(): void {
        try {
            const s: AudioSettings = {
                sfxVol: this.m_sfx.getVolume(), musicVol: this.m_music.getVolume(),
                sfxOn: this.m_sfx.isEnabled(), musicOn: this.m_music.isEnabled(),
            };
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
        } catch { /* storage unavailable (private mode) — settings just won't persist */
        }
    }
}
