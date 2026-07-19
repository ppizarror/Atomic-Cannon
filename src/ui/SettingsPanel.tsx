/**
 * Audio settings overlay — the options-menu equivalents (SFX / music volume +
 * mute), wired to CAudio and persisted to localStorage. Shown above the battle
 * HUD (via the `showSettings` signal) without switching screens, so the game
 * stays visible behind it. Mirrors the original's "Sound effects volume" /
 * "Music soundtrack volume" sliders + on/off toggles (FUN_0041d240).
 */
import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { showSettings, game, uiClick } from './store';

function VolumeRow({ label, value, enabled, onVolume, onToggle }: {
  label: string; value: number; enabled: boolean;
  onVolume: (v: number) => void; onToggle: (on: boolean) => void;
}) {
  return (
    <div class="set-row">
      <label class="set-label">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle((e.target as HTMLInputElement).checked)} />
        <span>{label}</span>
      </label>
      <input
        class="set-slider" type="range" min={0} max={100} step={1}
        value={value} disabled={!enabled}
        onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => onVolume(Number((e.target as HTMLInputElement).value))}
      />
      <span class="set-val">{enabled ? value : '—'}</span>
    </div>
  );
}

export function SettingsPanel() {
  if (!showSettings.value) return null;
  const audio = game().getAudio();

  // Local mirror of the audio state so the sliders re-render as they move; the
  // authoritative values live in CAudio (which also persists them).
  const [sfxVol, setSfxVol] = useState(audio?.getSfxVolume() ?? 100);
  const [musicVol, setMusicVol] = useState(audio?.getMusicVolume() ?? 100);
  const [sfxOn, setSfxOn] = useState(audio?.isSfxEnabled() ?? true);
  const [musicOn, setMusicOn] = useState(audio?.isMusicEnabled() ?? true);

  const close = () => { uiClick(); showSettings.value = false; };

  return (
    <div class="screen-overlay" onClick={close}>
      <div class="screen-card set-card" onClick={(e) => e.stopPropagation()}>
        <h1>Audio</h1>
        <VolumeRow
          label="Sound effects" value={sfxVol} enabled={sfxOn}
          onVolume={(v) => { setSfxVol(v); audio?.setSfxVolume(v); }}
          onToggle={(on) => { setSfxOn(on); audio?.setSfxEnabled(on); if (on) audio?.uiClick(); }}
        />
        <VolumeRow
          label="Music" value={musicVol} enabled={musicOn}
          onVolume={(v) => { setMusicVol(v); audio?.setMusicVolume(v); }}
          onToggle={(on) => { setMusicOn(on); audio?.setMusicEnabled(on); }}
        />
        <button class="metal-btn set-close" onClick={close}>Close</button>
      </div>
    </div>
  );
}
