/** TEMPORARY behaviour-equivalence harness — delete after. */
import {it} from 'vitest';
import {writeFileSync} from 'node:fs';
import {makeCanvas} from './_dom';
import {CGameController, EGameState} from '../src/game/CGameController';
import {AI_LEVEL_ULTRA} from '../src/core/CBotAI';
import {WEAPON_DATABASE} from '../src/core/CWeapon';
import {GameConfig} from '../src/core/CGameConfig';

let fakeNow = 0;
(globalThis as unknown as {performance: unknown}).performance = {now: () => fakeNow};
let s = 0;
const seedRandom = (n: number) => {
  s = n >>> 0;
  Math.random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  Date.now = () => 1_700_000_000_000 + n; // startGame resets m_terrainSeed → falls back to Date.now
};

function runMatch(level: number, seed: number, perTeam: number, crates = 20) {
  GameConfig.crateChance = crates;
  seedRandom(seed);
  fakeNow = 0;
  const gc = new CGameController(makeCanvas(900, 600)) as unknown as {
    setHumanCount(n: number): void; setDifficulty(n: number): void;
    setTanksPerTeam(n: number): void; setStartCredits(n: number): void;
    startGame(n: number): void; update(dt: number): void; getState(): EGameState;
    m_tanks: {getCredits(): number; getHealth(): {nLife: number}; getPosition(): {x: number; y: number}}[];
    economyFor(t: unknown): {getOwned(i: number): number};
  };
  gc.setHumanCount(0); gc.setDifficulty(level); gc.setTanksPerTeam(perTeam);
  gc.setStartCredits(12000); gc.startGame(2);
  for (let i = 0; i < 300 * 60; i++) {
    fakeNow += 1000 / 60;
    gc.update(1 / 60);
    if (gc.getState() === EGameState.BattleEnd) break;
  }
  return gc.m_tanks.map(t => {
      const e = gc.economyFor(t);
      const inv: number[] = [];
      for (let i = 0; i < WEAPON_DATABASE.length; i++) {
        const n = e.getOwned(i);
        if (Number.isFinite(n) && n > 0) inv.push(i, n);
      }
    // Crate spawn rolls + pickups show up here transitively: they draw from the same seeded RNG
    // and change credits/life, so a divergence in the crate field moves these numbers.
    return {credits: Math.round(t.getCredits()), life: Math.round(t.getHealth().nLife),
            x: Math.round(t.getPosition().x), inv};
  });
}

it('fingerprint', () => {
  const out: Record<string, unknown> = {};
  const crates = Number(process.env.CRATES ?? 20);
  for (const [lvl, name] of [[AI_LEVEL_ULTRA, 'ultra'], [9, 'L9'], [5, 'L5']] as const)
    for (const seed of [7, 4242])
      for (const perTeam of [1, 2])
        out[`${name}-s${seed}-t${perTeam}`] = runMatch(lvl as number, seed, perTeam, crates);
  writeFileSync(process.env.MATCH_OUT!, JSON.stringify(out, null, 2));
});
