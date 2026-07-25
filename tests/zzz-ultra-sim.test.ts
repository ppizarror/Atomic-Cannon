/* TEMP diagnostic: two Ultra bots in strong realistic wind — log ranging + landings to see misses. */
import {describe, it} from 'vitest';
import {writeFileSync} from 'node:fs';
import {makeCanvas} from './_dom';
import {CGameController} from '../src/game/CGameController';
import {GameConfig} from '../src/core/CGameConfig';

const OUT = '/private/tmp/claude-501/-Users-ppizarror-Documents-Atomic/4d472da8-e7cc-41d5-9b5f-c6d27f9790e2/scratchpad/ultra-sim.log';

describe('ULTRA sim diagnostic', () => {
  it('logs ranging over a long fight', () => {
    GameConfig.windModel = 1; // realistic (gusty) wind
    GameConfig.landSize = 1;
    const gc = new CGameController(makeCanvas(900, 600)) as any;
    gc.setHumanCount(0);
    gc.setDifficulty(11);
    gc.setWindScale(2); // strong
    gc.startGame(2);

    type Row = Record<string, unknown>;
    const log: Row[] = [];

    const origRanged = gc.ultraRangedPower.bind(gc);
    gc.ultraRangedPower = (tank: any, targetX: number, solved: number) => {
      const rec = gc.m_ultraShot.get(tank);
      const out = origRanged(tank, targetX, solved);
      log.push({
        ev: 'RANGE',
        name: tank.getName(),
        selfX: Math.round(tank.getPosition().x),
        tgtX: Math.round(targetX),
        prevPow: rec ? Math.round(rec.power) : '-',
        prevTgt: rec ? Math.round(rec.targetX) : '-',
        landedX: rec && rec.landedX !== undefined ? Math.round(rec.landedX) : '-',
        solved: Math.round(solved),
        ranged: Math.round(out),
        windx: +gc.m_wind.x.toFixed(2),
      });
      return out;
    };

    const origStart = gc.startTankMove.bind(gc);
    gc.startTankMove = (tank: any, destX: number) => {
      log.push({ev: 'MOVE', name: tank.getName?.() ?? '?', from: Math.round(tank.getPosition().x), to: Math.round(destX)});
      return origStart(tank, destX);
    };
    const origFire = gc.fire.bind(gc);
    gc.fire = () => {
      log.push({ev: 'FIRE', t: +tsec.toFixed(1), state: gc.m_gameState, wp: gc.m_currentWeaponIndex, pow: Math.round(gc.getPower?.() ?? 0)});
      return origFire();
    };
    const origEnd = gc.endTurn.bind(gc);
    gc.endTurn = () => {
      log.push({ev: 'ENDTURN', t: +tsec.toFixed(1), player: gc.m_currentPlayerIndex});
      return origEnd();
    };

    let tsec = 0;
    let inExpl = 0;
    for (let i = 0; i < 60 * 240; i++) {
      gc.update(1 / 60);
      tsec += 1 / 60;
      if (gc.m_gameState === 'explosion') {
        inExpl += 1 / 60;
        // Unstick: if a blast effect never settles in the headless env, force the handoff so the
        // fight continues and we can observe RANGING across many turns.
        if (inExpl > 5) {
          log.push({ev: 'FORCE', t: +tsec.toFixed(1)});
          try {
            gc.m_screenShake.stop?.();
            gc.checkBattleEnd();
          } catch {
            gc.endTurn();
          }
          inExpl = 0;
        }
      } else inExpl = 0;
      const alive = gc.m_tanks.filter((t: any) => t.isAlive()).length;
      if (alive < 2) {
        log.push({ev: 'DEAD', t: +tsec.toFixed(1)});
        break;
      }
    }

    const counts = log.reduce((m: any, r) => ((m[r.ev as string] = (m[r.ev as string] || 0) + 1), m), {});
    const out =
      `events=${log.length} counts=${JSON.stringify(counts)}\n` +
      `endPositions=${JSON.stringify(gc.m_tanks.map((t: any) => Math.round(t.getPosition().x)))}\n` +
      log.map(r => JSON.stringify(r)).join('\n');
    writeFileSync(OUT, out);
  });
});
