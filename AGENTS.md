# AGENTS.md

Working rules for AI agents (and humans) contributing to **Atomic Cannon** — a
TypeScript/Preact/PixiJS preservation port of the 2007 artillery game. Follow these
exactly; they encode conventions the codebase already relies on.

## Stack & commands

- **Runtime:** TypeScript, [Preact](https://preactjs.com/) + `@preact/signals` for UI,
  [PixiJS](https://pixijs.com/) (WebGL) for presentation, [Vite](https://vitejs.dev/) + `pnpm`.
- **Dev server runs on port 2141** (`pnpm dev`). It is usually already running — reuse it.
- Commands: `pnpm dev` · `pnpm build` · `pnpm preview` · `pnpm typecheck` · `pnpm lint` · `pnpm format`
  · `pnpm test` · `pnpm check` (format:check + typecheck + lint + test in one shot).
- **Always `pnpm check` before considering a change done** (run `pnpm format` first to auto-fix style).
  `typecheck` runs `strict` `tsc` over two projects — `tsconfig.app.json` (browser code in `src/`, DOM
  libs, no node globals) and `tsconfig.node.json` (Vite config + `test/`, node + DOM). `lint` is
  `oxlint --deny-warnings` (config in `.oxlintrc.json`; TS-native, so it works with the native
  TypeScript compiler that `typescript-eslint` does not yet support). **Formatting is Prettier**
  (`.prettierrc.json`): 2-space indent, single quotes, compact braces (`{x}`, `bracketSpacing: false`),
  no-parens single-arg arrows, 100-col. All must be clean.
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
  | `?weapontest=1` | Start a battle and keep the turn on the human forever (AI never fires, shot timer off) so weapons can be fired back-to-back. |
  | `?weaponsel=<n>` | Force the human onto arsenal row `<n>` with unlimited ammo. **`n` is the 1-based number the in-game list prints**, so weapons switched off in Game Content don't count (`n=1` → first row). Combine with `weapontest=1` — free-fire lists every enabled weapon in database order, which is the numbering you can read off the HUD. |
  | `?settings=<id>` | Open the Settings root (`=1`) or a specific option page (e.g. `=gameplay`). |

  Params combine, e.g. `http://localhost:2141/?weapontest=1&weaponsel=65`.

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

### `core/` vs `game/` — where does a new class go?

Layer 1 is two directories, and the split is load-bearing:

- **`src/core`** — the shared domain: everything the UI *and* the match both speak, plus the
  primitives they're built from (`CTank`, `CWeapon`, `CLand`, `CEconomy`, `CGameConfig`,
  `CControls`, `CRoster`, the bot brains, `rendering/*`). The UI imports ~12 of these.
- **`src/game`** — the match itself: `CGameController` plus the subsystems it owns
  (`CCamera`, `CChatter`, `CCrateField`, `CFireworks`, `CHitMarkers`, `CVictoryScene`,
  `RenderGate`). **`CGameController` is the only thing in `game/` the UI imports.**

Imports run ONE way — `ui` → `game` → `core`. `core` must never import from `game` or `ui`;
`game` must never import from `ui`. (Enforced only by review, so check it.)

Rule of thumb: if a Settings screen, an editor or the HUD would need the type, it's `core`.
If it only exists because a battle is running, it's `game`. "Only `CGameController` uses it"
is NOT the test — `CParticleSystem`, `CWeather` and `WeaponBehavior` have one consumer each and
are correctly `core`, because they're domain systems rather than match orchestration.

Two known oddities, both deliberate: `core/CTaunts` (the editable line pools — the UI edits them)
and `game/CChatter` (the speech bubbles — match-only) are a split pair that reads like a mistake
but isn't; and `core/rendering/CPixiCompositor` is really layer 2 above, filed under
`core/rendering/` alongside the other rendering primitives.

## Naming

- Core/game classes are **`C`-prefixed**: `CGameController`, `CLand`, `CTank`, `CWeapon`,
  `CParticleSystem`, `CWeather`, `CPixiCompositor`, … One class per file, filename = class name.
  A module of free functions over a data context is NOT `C`-prefixed (`botEconomy`, `wind`,
  `CVictoryScene`'s draw helpers) — the prefix means "this file exports a class".
- Instance fields are **`m_`-prefixed** (`m_canvas`, `m_particles`, `m_ctx`). They are TS
  soft-private — reachable at runtime in dev, which the browser verify harness relies on.
- UI components/files are plain PascalCase (`Hud.tsx`, `BmpText.tsx`).

## Comment style & file layout

The codebase is heavily commented **on purpose** — comments explain WHY a thing is the way it
is (the legacy behaviour being matched, the tradeoff taken), not what the line does. Keep that,
and keep the shape below so a long file stays navigable by scrolling its section headers.

### Every file opens with a header

A `/** … */` block **above the imports** — never after them — saying what the file is and the
one non-obvious thing about it. `core/rendering/CanvasQuadSink.ts` is the reference.

### Two levels of section banner, both fixed-width (77 cols) and UPPERCASE

**Tier 1** — a major division. At column 0, or indented 2 inside a class body:

```ts
// ==========================================================================
// SECTION NAME
// ==========================================================================
```

The title is **one short line, on its own**. Explanation goes UNDER it, still inside the
banner, after a bare `//` line — never wrapped onto the title line:

```ts
  // ========================================================================
  // STATIC HELPERS
  //
  // Pure lookups over the weapon database, plus one that memoises: the arsenal
  // is immutable once loaded, so the DEATH-class scan is resolved once and kept.
  // ========================================================================
```

**Tier 2** — a subdivision within one tier-1 section. One line, dashes padded to col 77:

```ts
  // ---- TERRAIN PIXEL BUFFER ----------------------------------------------
```

Any prose goes on a plain `//` line directly beneath it. Do **not** invent a third style —
box-drawing rules (`──`, `═══`), lowercase titles and ad-hoc widths have all been normalised
away.

### Canonical section names, in this order

Top level: `INTERFACES & TYPES` · `TUNING` · `<ClassName> CLASS`.

Inside a class: `STATIC HELPERS` · `CONSTRUCTION & INITIALIZATION` (or `SETUP & LIFECYCLE`
when the section is wiring/config setters rather than construction) · the domain sections
(`EMISSION`, `SIMULATION`, `TERRAIN DEFORMATION`, `BATTLE FLOW`, `FIRING SEQUENCE`, …) ·
`RENDERING` · `ACCESSORS & QUERIES` · `MEMBER VARIABLES` **last**.

Reuse an existing name before coining one. (Known drift: a few smaller classes still declare
their fields at the TOP rather than under a trailing `MEMBER VARIABLES` — new classes should
put them last.)

### JSDoc

Two forms, and the continuation indent differs between them — match the one you open with:

```ts
/** Compact: text starts on the opening line, wrapped lines get a HANGING two-space indent.
 *  Like this. */

/**
 * Block: `/**` alone on its line, wrapped lines get a single space.
 */
```

`@param` is used only where a constructor-parameter property needs naming (`RenderGate`,
`AudioAssetCache`); prose is preferred over tag soup everywhere else.

### Never leave an unterminated `/**`

An unterminated block silently swallows code and the *next* comment until it finds a `*/`.
Four of these accumulated in `CGameController.ts` from an extraction that moved code out and
left its docs behind — they had eaten a section banner and two member docs. `pnpm typecheck`
does **not** catch it.

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

- The game renders to an **offscreen 2D canvas** sized to the world area (the `#game-container`
  above the HUD) at load; `CPixiCompositor` presents it as a full-viewport WebGL sprite and
  `resize()` stretches the sprite to the live container size. Tank/turret art is **absolute
  pixels** (`CTank`, `TANK_DRAW_WIDTH` etc.), so the buffer resolution is effectively the
  world's logical scale. (Note: because the buffer is captured at the initial size and the
  sprite stretches, resizing the window after load softens the scene until reload — a deliberate
  tradeoff. Do **not** replace it with a fixed-res letterbox, a dynamic relayout or a high-res
  downscale without explicit agreement.)
  Pointer→world mapping lives in `main.tsx` `toWorld` (client px → scene px).
- **Minimum playable window is 768×432** (`MIN_W`/`MIN_H` in `App.tsx`). Below it, the
  `TooSmallOverlay` gate covers everything. Keep these in sync with any copy that states the size.
- **Present-on-demand:** the loop ticks every frame but the expensive 2D redraw + GPU upload
  are gated by `RenderGate`. If you add state that changes what's on screen, call `markDirty()`
  (or ensure it counts as `animating`) or it won't repaint. Particles are the hot path — mind
  per-particle cost.

## Verifying changes

- `pnpm test` runs `test/*.test.ts` under **Vitest** (`describe`/`it`/`expect`); `pnpm test:watch`
  for the watch UI. `test/_setup.ts` installs the headless DOM stubs before every file. There is
  **no DOM canvas** in tests, so they exercise logic and gradient fallbacks only — **not** real
  `drawImage`/WebGL paths.
- To verify anything visual, **drive the real running game**: dev exposes
  `window.atomic = { gameController, compositor, audio }` on port 2141. Load it headlessly
  (system Chrome), reach in via the `m_`-fields, and sample pixels / screenshot. Use the
  dev-only URL params (see **Stack & commands**) — e.g. `?battle=1`, `?weapontest=1` — to
  jump straight into states.
