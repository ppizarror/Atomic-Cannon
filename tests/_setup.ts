/**
 * Vitest global setup — runs once before every test file (see vitest.config.ts).
 *
 * Installs the minimal headless DOM stubs so game code that reaches for `document`,
 * `Image` or a canvas 2D context can be constructed in Node. Because setup runs
 * before a test file's own imports evaluate, individual tests no longer need to
 * call installDomMocks() themselves.
 */
import {installDomMocks} from './_dom';

installDomMocks();
