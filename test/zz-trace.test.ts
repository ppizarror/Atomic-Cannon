import {it} from 'vitest';
import {writeFileSync} from 'node:fs';
import {makeCanvas} from './_dom';
import {CGameController, EGameState} from '../src/game/CGameController';
import {GameConfig} from '../src/core/CGameConfig';

let fakeNow = 0;
(globalThis as unknown as {performance: unknown}).performance = {now: () => fakeNow};
let s = 0;
const seed = (n: number) => {
  s = n >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000 + n;
};

it('trace', () => {
  GameConfig.crateChance = 20;
  seed(7); fakeNow = 0;
  const gc = new CGameController(makeCanvas(900, 600)) as unknown as {
    setHumanCount(n: number): void; setDifficulty(n: number): void; setTanksPerTeam(n: number): void;
    setStartCredits(n: number): void; startGame(n: number): void; update(dt: number): void;
    getState(): EGameState; getNetSnapshot(): {rngState: number; crates?: unknown[]};
  };
  gc.setHumanCount(0); gc.setDifficulty(9); gc.setTanksPerTeam(1);
  gc.setStartCredits(12000); gc.startGame(2);
  const log: string[] = [];
  let prev = '';
  for (let i = 0; i < 300 * 60; i++) {
    fakeNow += 1000 / 60;
    gc.update(1 / 60);
    const s2 = gc.getNetSnapshot();
    // Log only on CHANGE — the seeded cursor plus the crate count is enough to localise a
    // divergence to the exact frame and tell a spawn difference from an rng-phase difference.
    const sig = `${s2.rngState}|${s2.crates?.length ?? -1}`;
    if (sig !== prev) { log.push(`${i} ${sig}`); prev = sig; }
    if (gc.getState() === EGameState.BattleEnd) break;
  }
  writeFileSync(process.env.TRACE_OUT!, log.join('\n'));
});
