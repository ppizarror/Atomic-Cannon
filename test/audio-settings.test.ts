/**
 * The Audio page is a normal catalog page: its six options are stored in `atomic.settings` like
 * every other setting (so they ride backups + profile sync), and `applyGameSettings` pushes them
 * into the live CAudio bus — CAudio itself neither reads nor writes storage.
 *
 * Three things have to hold:
 *  • the catalog owns the defaults (music opens a step below the SFX, see settingsCatalog);
 *  • the push reaches the bus even DURING a net match — volumes aren't simulation state, and
 *    applyGameSettings otherwise returns early to protect lockstep;
 *  • the push is idempotent. The setters have side effects (`setMusicEnabled(true)` re-arms the
 *    current bed, `setMenuSfxEnabled(true)` warms buffers), so re-applying an unchanged page —
 *    which happens on EVERY settings edit, of any row — must not touch the bus.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';
import {CGameController} from '../src/game/CGameController';
import type {CAudio} from '../src/audio/CAudio';
import {getVal, setVal} from '../src/ui/settingsStore';
import {audioSettings} from '../src/ui/settingsValues';
import {applyGameSettings} from '../src/ui/applySettings';

/** A stand-in for the audio bus: records what was pushed and how often. */
function fakeBus() {
  const calls: string[] = [];
  const state = {sfxOn: true, sfxVol: 100, musicOn: true, musicVol: 100, stereo: true, menu: false};
  return {
    calls,
    state,
    isSfxEnabled: () => state.sfxOn,
    setSfxEnabled: (v: boolean) => void (calls.push('sfxOn'), (state.sfxOn = v)),
    getSfxVolume: () => state.sfxVol,
    setSfxVolume: (v: number) => void (calls.push('sfxVol'), (state.sfxVol = v)),
    isMusicEnabled: () => state.musicOn,
    setMusicEnabled: (v: boolean) => void (calls.push('musicOn'), (state.musicOn = v)),
    getMusicVolume: () => state.musicVol,
    setMusicVolume: (v: number) => void (calls.push('musicVol'), (state.musicVol = v)),
    isStereo: () => state.stereo,
    setStereo: (v: boolean) => void (calls.push('stereo'), (state.stereo = v)),
    isMenuSfxEnabled: () => state.menu,
    setMenuSfxEnabled: (v: boolean) => void (calls.push('menu'), (state.menu = v)),
    setWorldWidth: () => {}, // setAudio hands the bus the pan axis
  };
}

function controllerWithBus() {
  const gc = new CGameController(makeCanvas());
  const bus = fakeBus();
  gc.setAudio(bus as unknown as CAudio);
  return {gc, bus};
}

beforeEach(() => {
  // Every id back to its catalog default — the store is module state shared by this file's tests.
  for (const id of ['audio.sound', 'audio.soundVol', 'audio.music', 'audio.musicVol', 'audio.stereo'] as const) {
    setVal(id, getVal(id));
  }
});

describe('catalog defaults', () => {
  it('music opens at 80%, sound at full', () => {
    expect(audioSettings.musicVol()).toBe(80);
    expect(audioSettings.soundVol()).toBe(100);
    expect(audioSettings.soundOn()).toBe(true);
    expect(audioSettings.musicOn()).toBe(true);
    expect(audioSettings.stereo()).toBe(true);
    expect(audioSettings.menuSounds()).toBe(false); // the non-legacy blips stay opt-in
  });
});

describe('the stored page reaches the bus', () => {
  it('applies volumes and toggles', () => {
    const {gc, bus} = controllerWithBus();
    setVal('audio.musicVol', 40);
    setVal('audio.soundVol', 60);
    setVal('audio.stereo', 0);

    applyGameSettings(gc);

    expect(bus.state.musicVol).toBe(40);
    expect(bus.state.sfxVol).toBe(60);
    expect(bus.state.stereo).toBe(false);
  });

  it('still applies mid network match — audio is not simulation state', () => {
    const {gc, bus} = controllerWithBus();
    priv(gc).m_netMode = true; // applyGameSettings returns early past this point (lockstep guard)
    setVal('audio.musicVol', 20);

    applyGameSettings(gc);

    expect(bus.state.musicVol).toBe(20);
  });

  it('re-applying an unchanged page touches nothing', () => {
    const {gc, bus} = controllerWithBus();
    applyGameSettings(gc); // first pass syncs the bus to the stored page (music 100 → 80)
    expect(bus.calls).toContain('musicVol');

    bus.calls.length = 0;
    applyGameSettings(gc);
    applyGameSettings(gc);

    expect(bus.calls).toEqual([]); // no setMusicEnabled → no bed re-armed after a jingle
  });
});
