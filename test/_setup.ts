/**
 * Vitest global setup — runs once before every test file (see vitest.config.ts).
 *
 * Installs the minimal headless DOM stubs so game code that reaches for `document`,
 * `Image` or a canvas 2D context can be constructed in Node. Because setup runs
 * before a test file's own imports evaluate, individual tests never need to call
 * installDomMocks() themselves.
 */
import {installDomMocks} from './_dom';
import {applyGameConfig} from '../src/ui/applySettings';

installDomMocks();

// GameConfig's settings-mirror fields hold only inert placeholders; their real defaults live in
// settingsCatalog and are pushed in by applyGameConfig (the same writer used in-game). Seed them
// here so every test runs against the real catalog defaults, not stale literals. Runs once per test
// file (setupFiles re-evaluate per file), re-establishing the baseline; a test that needs a specific
// value still sets it directly.
applyGameConfig();
