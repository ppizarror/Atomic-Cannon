/**
 * Structural validators at the socket boundary — the server calls these before storing/relaying an
 * actor's authoritative shotResult or a relayed command, so a malformed or hostile payload can't
 * poison the room snapshot or crash peers.
 */
import {describe, it, expect} from 'vitest';
import {isValidShotResult, isValidGameCommand} from '../src/net/protocol';

const goodTank = () => ({
  x: 1,
  y: 2,
  life: 1000,
  shield: 0,
  armor: 0,
  hazmat: 0,
  credits: 3000,
  alive: true,
});
const goodResult = (n: number) => ({
  tanks: Array.from({length: n}, goodTank),
  heights: [100, 101, 102],
  wind: {x: 1, y: 0},
  rngState: 12345,
});

describe('isValidShotResult', () => {
  it('accepts a well-formed result with the expected tank count', () => {
    expect(isValidShotResult(goodResult(2), 2)).toBe(true);
  });

  it('rejects non-objects and wrong tank counts', () => {
    expect(isValidShotResult(null, 2)).toBe(false);
    expect(isValidShotResult('nope', 2)).toBe(false);
    expect(isValidShotResult(goodResult(2), 3)).toBe(false); // short/long array
  });

  it('rejects a null or non-finite tank (the room-bricking payload)', () => {
    const withNull = {...goodResult(2), tanks: [null, goodTank()]};
    expect(isValidShotResult(withNull, 2)).toBe(false);
    const withNaN = goodResult(2);
    withNaN.tanks[0].x = NaN;
    expect(isValidShotResult(withNaN, 2)).toBe(false);
  });

  it('requires an explicit boolean alive flag (0-life tanks are alive in Rounds)', () => {
    const noAlive = goodResult(1);
    delete (noAlive.tanks[0] as {alive?: boolean}).alive;
    expect(isValidShotResult(noAlive, 1)).toBe(false);
  });

  it('rejects a missing/degenerate heightmap, wind, or rngState', () => {
    expect(isValidShotResult({...goodResult(1), heights: undefined}, 1)).toBe(false);
    expect(isValidShotResult({...goodResult(1), heights: []}, 1)).toBe(false);
    expect(isValidShotResult({...goodResult(1), heights: [NaN]}, 1)).toBe(false);
    expect(isValidShotResult({...goodResult(1), wind: {x: 1}}, 1)).toBe(false);
    expect(isValidShotResult({...goodResult(1), rngState: 'x'}, 1)).toBe(false);
  });

  it('range-checks mine indices (peers use them to index arrays)', () => {
    const mine = (o: object) => ({x: 1, y: 2, armed: 0, weaponIndex: 5, ownerIdx: 0, ...o});
    expect(isValidShotResult({...goodResult(2), mines: [mine({})]}, 2)).toBe(true);
    expect(isValidShotResult({...goodResult(2), mines: [mine({ownerIdx: 2})]}, 2)).toBe(false); // >= tankCount
    expect(isValidShotResult({...goodResult(2), mines: [mine({ownerIdx: -2})]}, 2)).toBe(false); // < -1
    expect(isValidShotResult({...goodResult(2), mines: [mine({weaponIndex: 1e9})]}, 2)).toBe(false);
    expect(isValidShotResult({...goodResult(2), mines: [mine({weaponIndex: 1.5})]}, 2)).toBe(false); // non-int
  });

  it('validates crates (kind + integer weapon index)', () => {
    const crate = (o: object) => ({
      x: 1,
      y: 2,
      vy: 0,
      kind: 'weapon',
      amount: 0,
      weaponIndex: 5,
      landed: true,
      ...o,
    });
    expect(isValidShotResult({...goodResult(1), crates: [crate({})]}, 1)).toBe(true);
    expect(isValidShotResult({...goodResult(1), crates: [crate({kind: 'lolgrenade'})]}, 1)).toBe(
      false,
    );
    expect(isValidShotResult({...goodResult(1), crates: [crate({weaponIndex: 1.5})]}, 1)).toBe(
      false,
    );
    expect(isValidShotResult({...goodResult(1), crates: [crate({landed: 'yes'})]}, 1)).toBe(false);
  });
});

describe('isValidGameCommand', () => {
  it('accepts every well-formed command in the union', () => {
    expect(isValidGameCommand({t: 'fire'})).toBe(true);
    expect(isValidGameCommand({t: 'resetAim'})).toBe(true);
    expect(isValidGameCommand({t: 'autobuy'})).toBe(true);
    expect(isValidGameCommand({t: 'cutJet'})).toBe(true);
    expect(isValidGameCommand({t: 'aim', angle: 45, power: 600})).toBe(true);
    expect(isValidGameCommand({t: 'selectWeapon', index: 3})).toBe(true);
    expect(isValidGameCommand({t: 'buy', index: 0})).toBe(true);
    expect(isValidGameCommand({t: 'sell', index: 2})).toBe(true);
    expect(isValidGameCommand({t: 'move', destX: 500})).toBe(true);
    expect(isValidGameCommand({t: 'jet', up: true, left: false, right: false})).toBe(true);
  });

  it('rejects null, unknown types, and non-finite / wrong-typed fields', () => {
    expect(isValidGameCommand(null)).toBe(false);
    expect(isValidGameCommand({t: 'bogus'})).toBe(false);
    expect(isValidGameCommand({t: 'aim', angle: NaN, power: 600})).toBe(false);
    expect(isValidGameCommand({t: 'move', destX: NaN})).toBe(false); // the peers'-tank-to-NaN payload
    expect(isValidGameCommand({t: 'selectWeapon', index: 1.5})).toBe(false); // non-integer index
    expect(isValidGameCommand({t: 'jet', up: 'yes', left: false, right: false})).toBe(false);
  });
});
