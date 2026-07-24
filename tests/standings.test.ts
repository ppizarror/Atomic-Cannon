/**
 * T3 — between-battles standings labels. The original floats a per-tank "Name: X% life / N points"
 * over each surviving tank on the standings screen; the port draws one per living non-sentry tank,
 * mode-aware (Points in Rounds, kills in Deathmatch).
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';

import {CGameController, EGameType} from '../src/game/CGameController';
import type {CTank} from '../src/core/CTank';

type GCInternals = {
  m_tanks: CTank[];
  m_gameType: EGameType;
  standingLabelFor(t: CTank): string;
  drawStandingsLabels(ctx: unknown): void;
  drawBmpCentered: (...args: unknown[]) => void;
};
const priv = (gc: CGameController) => gc as unknown as GCInternals;

function twoPlayerGame(): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.setHumanCount(2);
  gc.startGame(2);
  return gc;
}

describe('Standings labels (T3)', () => {
  it('label wording is mode-aware: net points in Rounds, life% in Deathmatch', () => {
    const gc = twoPlayerGame();
    const p = priv(gc);
    const a = p.m_tanks[0];
    a.setMaxLife(1000);
    a.hit(200); // knock life down; compute pct from the actual result (no reliance on exact soak)
    a.addHit(340); // 340 net damage dealt → the Points value

    const pct = Math.round((a.getHealth().nLife / a.getMaxLife()) * 100);

    p.m_gameType = EGameType.Rounds; // Points mode → net damage points
    expect(p.standingLabelFor(a)).toBe(`${a.getName()}: 340 points`);

    p.m_gameType = EGameType.Deathmatch; // Deathmatch → life percentage
    expect(p.standingLabelFor(a)).toBe(`${a.getName()}: ${pct}% life`);
  });

  it('draws exactly one label per LIVING tank (dead tanks are skipped)', () => {
    const gc = twoPlayerGame();
    const p = priv(gc);
    const labels: string[] = [];
    p.drawBmpCentered = (_ctx, _font, text: unknown) => labels.push(text as string);

    p.drawStandingsLabels({});
    expect(labels).toHaveLength(2); // both survivors labelled

    labels.length = 0;
    p.m_tanks[1].explode(); // one tank destroyed
    p.drawStandingsLabels({});
    expect(labels).toHaveLength(1); // only the survivor keeps a label
  });
});
