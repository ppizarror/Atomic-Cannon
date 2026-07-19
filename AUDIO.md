# Audio — original engine & the web port

The 2007 build drove audio through **FMOD 3.x** (the `FSOUND` sample/stream API +
the `FMUSIC` tracker API). This document records how that system worked (from the
Ghidra decompile) and how the preservation port reproduces it in the browser.

## 1. The original engine (from the RE)

A single **sound-manager singleton** (`0x5055a8`) owned everything. It held two
**name-keyed** collections — SFX samples and streams — plus one dedicated music
slot. Sounds were looked up by their `"sound/xxx.wav"` **path string**; there is
no numeric enum. Every SFX request funnelled through one API, `PlaySound(name)`
(`FUN_00410fa0`), which:

- prefixed `"sound/"` and gated on the SFX-enabled flag (`this+0x9f6`);
- **deduped + rate-limited** each name via a `GetTickCount` throttle
  (`this+0x1ce0`/`+0x1cf0`) so the same effect can't retrigger every frame;
- loaded on demand, then played with per-channel **volume** `(vol*255)/100`
  (`FUN_004a07a0`) and **pan** (`FUN_0049f380`).

The `CSound` wrapper (`FUN_0049f1d0` play / `…f930` stop / `…faa0` isPlaying)
holds a `FMUSIC_MODULE*` (+0x00), `FSOUND_SAMPLE*` (+0x04) or `FSOUND_STREAM*`
(+0x08) — one object, three possible backends.

### Music policy

Six Impulse Tracker `.it` modules, played through `FMUSIC` (never as PCM):

| Context | Track(s) | Loop | RE site |
|---|---|---|---|
| Menu / title | `Four Ages.it` | yes | `FUN_0040f2a0`, `FUN_0042e3f0`, … |
| **Battle start** | **random 1 of 3**: `Into the Wild Blue Monster.it`, `Anubis Claws.it`, `Rust.it` | yes | `FUN_00445160:474-519` (`rand()%3`) |
| Victory | `Airborne.it` | no | `FUN_0047d2d0:63` |
| Defeat | `Well.it` | no | `FUN_0047d2d0:54` |

Battle music is **one randomly-chosen looped track per round**, not a sequential
playlist. (A hidden hook swaps in a 10-track `subatomicglue - aeonblue` album if
that folder exists — bonus content, intentionally not ported.)

### Event → sound (trigger sites)

| Event | Sound | RE site |
|---|---|---|
| Weapon fire | weapon `soundFire` (field +0xbc) | `FUN_00458c20:313`, `FUN_004678b0:312` |
| Projectile impact | shot `soundHit` (field +0xC4) | `FUN_0046c280:1131`, `FUN_004535f0:1598` |
| Tank destroyed | `tank explode.wav` | `FUN_00488910`, `FUN_00474ff0:2626` |
| Tank driving (loop) | `tank moving.wav` | `FUN_00460d60:1888` |
| Jet unit (loop) | `jet.wav` | `FUN_00460d60:1862` |
| Battle won / lost | `battle won/lost.wav` + jingle | `FUN_0047d2d0` |
| UI click / typing | `click.wav` / `typing.wav` | ~12 menu fns / `FUN_004328e0` |

### Panning (confirmed faithful)

The original applies a **stored pan float** via `FSOUND_SetPan` (FMOD's linear
0–255 axis, 128 = centre) in `FUN_0049f380`, fed a screen-position value at the
trigger site — there is no exotic curve. `FUN_0049f150` (manager load+play) sets
volume then pan right after `PlaySound`. **`FUN_0049f430` is NOT the pan curve** —
it's a channel-ownership guard (`FSOUND_GetCurrentSample(channel) == this.sample`)
run before touching a channel, so a recycled channel isn't repanned or revolumed
by the wrong sound. The port's linear `worldX/width*2−1 → [-1,1]` (centre = 0,
edges = ±1) matches the original's behaviour.

## 2. The web port

Two runtime concerns differ from FMOD: browsers can't play `.it` natively, and
`AudioContext` needs a user gesture. Everything else maps 1:1.

```
CAudio ─ owns the one shared AudioContext + master gain; the semantic event funnel
 ├─ CSoundManager  — Web Audio SFX (AudioBuffer cache, retrigger throttle,
 │                    StereoPanner from world-X, master GainNode, named loops)
 └─ CMusicPlayer   — libopenmpt (WASM) in an AudioWorklet → authentic .it playback
```

- **SFX** (`src/audio/CSoundManager.ts`) — `decodeAudioData` into a name-keyed
  `AudioBuffer` cache; per-shot `StereoPannerNode`; master gain = `vol/100`; a
  `RETRIGGER_MS` (~45ms) throttle reproduces the `GetTickCount` dedup;
  `startLoop`/`stopLoop`/`setLoopPan` cover `tank moving.wav`.
- **Music** (`src/audio/CMusicPlayer.ts`) — drives the **vendored chiptune3
  worklet** (`public/audio/chiptune3.worklet.js` + `libopenmpt.worklet.js`, the
  emscripten libopenmpt build with the wasm embedded). `play(file, loop)` fetches
  the `.it` and posts `{cmd:'play'}` + `{cmd:'repeatCount'}` (−1 loop / 0 once).
  No separate `.wasm` to serve; no npm runtime dep.
- **Facade** (`src/audio/CAudio.ts`) — semantic events (`fire`, `hit`,
  `tankExplode`, `startTankMove`, `battleWon/Lost`, `uiClick`, `menuMusic`,
  `battleMusic`), the exact track-selection policy above, volume/enable settings
  (persisted to localStorage), and the first-gesture `AudioContext` unlock.

### Wiring

| Trigger | File |
|---|---|
| fire → `soundFire` | `CGameController.fire()` |
| impact → `soundHit` | `WeaponBehavior.weaponDetonate` → `ShotWorld.hitSound` |
| tank explode | `CGameController.handleTankDestroyed` |
| tank moving loop | `CGameController.updateMoveSound` (per frame) |
| battle won/lost + jingle | `CGameController.endTurn` |
| preload + battle track | `CGameController.startGame` |
| UI click | `Hud.tsx` weapon rows / nav (`store.uiClick`) |
| settings panel | `Hud.tsx` audio button → `SettingsPanel` |
| init + gesture unlock | `main.tsx` |

### Asset inventory

44 `.wav` in `public/assets/sound/` (29 weapon-referenced via `weapons.json`, 15
event sounds) + 6 `.it` in `public/assets/music/`. All catalogued in
`manifest.json` (`category: "sound" | "music"`).

### Verified

Typecheck + `vite build` clean. Headless-Chrome end-to-end: worklet
`libopenmpt-processor` registers, a random `.it` battle track loads and produces
continuous non-zero output, WAV decodes through the shared context, `fire()`
emits a strong signal (master RMS ≈ 0.36), no console errors.

### Jet flight (extType 17) + `jet.wav`

Jets (Booster Jet 5s, Jump Jet 15s) are now a full mechanic, ported from
`FUN_00460d60`/`FUN_00402a00`: firing one lights the jet (`tank.igniteJet(damage)`)
and enters the `Flying` game state. Fuel = weapon damage in seconds, drains on
real dt; while it lasts the player thrusts with arrows/WASD — UP = `−1.2g`
vertical (net `−0.2g`, a gentle rise), L/R = `∓0.1g` horizontal — against gravity,
with a ceiling clamp and land-on-contact. Flight **repositions but does not end
the turn** (the player still fires afterwards); Space cuts the engine early.
`jet.wav` loops only while up-thrust fires (RE: `local_179`), layered under
`tank moving.wav` (any tank in motion). A top-centre HUD shows fuel + controls.
Bots don't fly (jet just consumes their turn). Wiring: `CTank.update` (flight
integrator), `CGameController.fire`/`updateFlying`/`updateMoveSound`,
`main.tsx` (held-key steering), `App.tsx` `FlightHud`.

### Not yet ported / follow-ups

- `typing.wav` — blocked: no chat UI yet.
