/**
 * Squad credit pooling. Credits are stored per-tank but a team shares them (a human squad shares one
 * depot bound to its lead tank; squad-mates hold display copies). A buy debits the banker; without
 * re-syncing the copies, a squad-mate's later earn pools its stale, undebited balance back over the
 * banker and REFUNDS the purchase — so a buy debits the whole squad in lock-step.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController} from '../src/game/CGameController';
import {WEAPON_DATABASE} from '../src/core/CWeapon';
import type {CTank} from '../src/core/CTank';

const COSTLY = WEAPON_DATABASE.findIndex(w => w.cost > 0 && w.cost <= 3000);

function squadGame(): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(1);
  gc.setTanksPerTeam(2); // one human SQUAD of 2 tanks (+ a CPU squad)
  gc.setStartCredits(6000);
  gc.startGame(2);
  return gc;
}
const humansOf = (gc: CGameController) => (gc as unknown as {m_tanks: CTank[]}).m_tanks.filter(t => t.isHuman());

describe('Squad credit pooling', () => {
  it('a mid-cost weapon exists to buy', () => {
    expect(COSTLY).toBeGreaterThanOrEqual(0);
  });

  it('a squad buy debits EVERY squad tank in lock-step (no refund window)', () => {
    const gc = squadGame();
    expect(gc.getCurrentTank().isHuman()).toBe(true); // the human squad acts first
    const humans = humansOf(gc);
    expect(humans.length).toBe(2);

    const cost = WEAPON_DATABASE[COSTLY].cost;
    const before = humans[0].getCredits();
    expect(before).toBeGreaterThanOrEqual(cost);

    expect(gc.buyWeapon(COSTLY)).toBe(true);

    // Both squad tanks reflect the debit — so a squad-mate's later earn+pool re-syncs from the
    // ALREADY-debited balance and can never refund the purchase.
    expect(humans[0].getCredits()).toBe(before - cost);
    expect(humans[1].getCredits()).toBe(before - cost);
  });
});
