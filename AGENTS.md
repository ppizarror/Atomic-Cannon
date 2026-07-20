# AGENTS.md

Working rules for AI agents (and humans) contributing to **Atomic Cannon** — a
TypeScript/Preact/PixiJS preservation port of the 2007 artillery game. Follow these
exactly; they encode conventions the codebase already relies on.

## Stack & commands

- **Runtime:** TypeScript, [Preact](https://preactjs.com/) + `@preact/signals` for UI,
  [PixiJS](https://pixijs.com/) (WebGL) for presentation, [Vite](https://vitejs.dev/) + `pnpm`.
- **Dev server runs on port 2141** (`pnpm dev`). It is usually already running — reuse it.
- Commands: `pnpm dev` · `pnpm build` · `pnpm preview` · `pnpm typecheck` (`tsc --noEmit`) · `pnpm test`.
- **Always `pnpm typecheck` before considering a change done.** There is no lint/format step to lean on.
- **Dev-only URL params.** The app boots to a MAIN MENU, so a bare `http://localhost:2141`
  renders the menu over everything. Append a query flag to jump straight into a state for
  manual testing or headless screenshots. Handled in `src/main.tsx` inside an
  `import.meta.env.DEV` guard — **development-only**: a production build tree-shakes the
  whole block out and ignores every param below.

  | Param | Effect |
  |-------|--------|
  | `?battle=1` | Skip the menu, start a fresh battle (use this for shot/explosion/trail screenshots). |
  | `?depot=1` | Start a battle and open the Weapons Depot. |
  | `?pause=1` | Start a battle and open the pause menu. |
  | `?weapon_test=1` | Start a battle and keep the turn on the human forever (AI never fires, shot timer off) so weapons can be fired back-to-back. |
  | `?weapon_sel=<id>` | Force the human onto weapon `<id>` with unlimited ammo. **`id` is 1-based** to match the in-game list (`id=1` → first weapon, `id=65` → Machine Gun). Combine with `weapon_test=1` to spam one weapon. |
  | `?settings=<id>` | Open the Settings root (`=1`) or a specific option page (e.g. `=gameplay`). |

  Params combine, e.g. `http://localhost:2141/?weapon_test=1&weapon_sel=65`.

## Architecture — three layers that never touch each other's DOM

1. **Simulation + 2D render** (`src/core`, `src/game`): the game draws its world into an
   **offscreen 2D canvas**.
2. **Presentation** (`src/core/rendering/CPixiCompositor.ts`): Pixi takes that canvas as a
   full-viewport sprite and runs GPU post-FX (the shockwave/diffraction warp).
3. **DOM UI** (`src/ui`): Preact renders the HUD and screens. It reads live game state from
   **signals pumped once per frame** (`syncHud`) — it never reaches into the game, and the
   game never reaches into the DOM.

Keep this separation. New UI is a Preact component driven by a signal; new gameplay is in
`core`/`game` and surfaces state through the signal pump — not by querying the DOM.

## Naming

- Core/game classes are **`C`-prefixed**: `CGameController`, `CLand`, `CTank`, `CWeapon`,
  `CParticleSystem`, `CWeather`, `CPixiCompositor`, … One class per file, filename = class name.
- Instance fields are **`m_`-prefixed** (`m_canvas`, `m_particles`, `m_ctx`). They are TS
  soft-private — reachable at runtime in dev, which the browser verify harness relies on.
- UI components/files are plain PascalCase (`Hud.tsx`, `BmpText.tsx`).

## UI text & chrome — use the game's own assets

- **All in-game text is rendered with the game's bitmap fonts via `<BmpText>`** — never CSS
  text/`font-family` for game-facing UI. Fonts live in `BitmapFont.ts` (`FontId`); pick an
  **outlined** variant (`*-out`) for legibility over light metal.
- Bitmap fonts cover **ASCII 33..126 only** — no `×`, `…`, arrows, en-dash, accents. Use `x`,
  `...`, ASCII. `BmpText` **does not wrap**: break long copy into one `<BmpText>` per line.
- Draw bitmap text at **native or integer scale** (`scale`, not fractional `height`) — the
  1-bit glyph strips turn to mush when downscaled.
- **Frame panels/overlays with real game art**, not CSS chrome: the `atomic/dialog.bmp`
  beveled panel (9-sliced via `border-image`), `gui*.bmp`, `panels/steel.webp`, etc. See
  `HelpOverlay.tsx` / `.help-card` and the resolution gate (`.too-small`) as the reference.

## Rendering rules

- The world renders to a **high, fixed-WIDTH offscreen buffer** (`BUFFER_W` in `main.tsx`,
  `max(1600, screen.width)`); `CPixiCompositor` scales it **down** to fill the window, so every
  size looks like "starting large" (crisp) rather than upscaling a small buffer. The buffer
  **width is constant** (deterministic world + constant tank scale — art is absolute pixels,
  `CTank`); its **height tracks the window aspect** so the fill is never distorted and never
  letterboxed. On resize, `refit` re-fits the height only when the aspect changes, calling
  `CGameController.resizeHeight` → `CLand.resizeHeight` (vertical terrain resample, width kept)
  + entity Y-rescale, then `CPixiCompositor.resyncScene` (re-point the GPU texture). A pure
  size change (same aspect) skips the re-flow and just downscales. Pointer→world mapping is
  `main.tsx` `toWorld` (client px → scene px; the buffer fills the container, so no offset).
- **Minimum playable window is 768×432** (`MIN_W`/`MIN_H` in `App.tsx`). Below it, the
  `TooSmallOverlay` gate covers everything. Keep these in sync with any copy that states the size.
- **Present-on-demand:** the loop ticks every frame but the expensive 2D redraw + GPU upload
  are gated by `RenderGate`. If you add state that changes what's on screen, call `markDirty()`
  (or ensure it counts as `animating`) or it won't repaint. Particles are the hot path — mind
  per-particle cost.

## Verifying changes

- `pnpm test` runs `tests/*.test.ts` under `tsx`. There is **no DOM canvas** in tests, so
  they exercise logic and gradient fallbacks only — **not** real `drawImage`/WebGL paths.
- To verify anything visual, **drive the real running game**: dev exposes
  `window.atomic = { gameController, compositor, audio }` on port 2141. Load it headlessly
  (system Chrome), reach in via the `m_`-fields, and sample pixels / screenshot. Use the
  dev-only URL params (see **Stack & commands**) — e.g. `?battle=1`, `?weapon_test=1` — to
  jump straight into states.
