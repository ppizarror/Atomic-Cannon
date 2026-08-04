/**
 * Anything that edits the shared world has to come from the HOST, not from each client's own
 * options — a per-client copy silently forks the deterministic sim.
 *
 *  • Soil Compaction sinks the heightmap around a nuke-class blast (and drops the tanks standing on
 *    it). Read from local Settings it would mean one client's ground sinks and another's doesn't,
 *    from the first nuke onward, so it rides MatchConfig like every other sim-affecting field.
 *  • Game Content (disabled weapons) is deliberately per-client, so the crate prize draw must NOT
 *    filter by it in a net match: the seeded draw lands on a different index when the pool lengths
 *    differ, and the same crate hands out different weapons on each peer. The landscape pick already
 *    takes the full pool in net for the same reason.
 */
import {describe, it, expect, afterEach} from 'vitest';
import {makeCanvas} from './_dom';
import {priv} from './_internals';
import {CGameController} from '../src/game/CGameController';
import {GameConfig} from '../src/core/CGameConfig';
import {GameContent} from '../src/core/CGameContent';
import {sanitizeMatchConfig, type MatchConfig} from '../src/net/protocol';
import {WEAPON_DATABASE, getDefaultWeaponIndex} from '../src/core/CWeapon';
import {CEconomy} from '../src/core/CEconomy';

const ROSTER = [
  {name: 'Ada', color: '#f00'},
  {name: 'Bo', color: '#0f0'},
];

/** Boot a client into a net match running the host's `config`. */
function netGame(config: MatchConfig): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.startNetworkGame({
    seed: 4242,
    players: 2,
    localIndex: 0,
    roster: ROSTER,
    wind: 1,
    mapSize: 2,
    battles: 2,
    tanksPerTeam: 1,
    currentBattle: 1,
    viewW: 1280,
    viewH: 720,
    config,
  });
  return gc;
}

afterEach(() => {
  GameConfig.soilCompaction = false; // catalog default
  GameContent.weaponsOff = new Set();
});

describe('Soil Compaction is host-owned in a net match', () => {
  it('adopts the host value over this client’s local setting', () => {
    GameConfig.soilCompaction = false; // this player has it off locally…
    const gc = netGame(sanitizeMatchConfig({soilCompaction: true})); // …the host runs it on

    expect(GameConfig.soilCompaction).toBe(true); // the host's world wins
    expect(gc.getMatchConfig().soilCompaction).toBe(true); // and it round-trips back out
  });

  it('turns it OFF for a client that has it on locally', () => {
    GameConfig.soilCompaction = true;
    netGame(sanitizeMatchConfig({soilCompaction: false}));

    expect(GameConfig.soilCompaction).toBe(false);
  });
});

describe('crate prizes ignore the per-client Game Content filter in net', () => {
  // Every weapon disabled but the staple and one prize: solo can only ever draw that one prize.
  const setup = () => {
    const staple = getDefaultWeaponIndex();
    const prize = WEAPON_DATABASE.findIndex((w, i) => i !== staple && w.id === 'bomb');
    GameContent.weaponsOff = new Set(WEAPON_DATABASE.map((_, i) => i).filter(i => i !== staple && i !== prize));
    return prize;
  };

  it('a solo match honours it — the only enabled prize is the only prize', () => {
    const prize = setup();
    const gc = new CGameController(makeCanvas());
    gc.startGame(2);
    const p = priv(gc);

    for (let i = 0; i < 20; i++) expect(p.crateWeaponFor('weapon')).toBe(prize);
  });

  it('a net match draws from the FULL pool, so every peer resolves the same crate', () => {
    const prize = setup();
    const p = priv(netGame(sanitizeMatchConfig()));

    const drawn = new Set<number>();
    for (let i = 0; i < 20; i++) drawn.add(p.crateWeaponFor('weapon'));

    // Filtered by this client's content the pool would be [prize] and every draw identical.
    expect(drawn.size).toBeGreaterThan(1);
    expect([...drawn].some(i => i !== prize && GameContent.weaponsOff.has(i))).toBe(true);
  });
});

describe('a deterministic (net) autobuy ignores per-client Game Content', () => {
  const loadout = (e: CEconomy) => e.ownedSnapshot().join(',');

  it('two clients with different content settings buy the same list for the same credits', () => {
    GameContent.weaponsOff = new Set();
    const host = new CEconomy(20_000);
    host.autoBuy({deterministic: true});

    // A peer who has switched off a third of the arsenal in ITS local Game Content.
    GameContent.weaponsOff = new Set(WEAPON_DATABASE.map((_, i) => i).filter(i => i % 3 === 0));
    const peer = new CEconomy(20_000);
    peer.autoBuy({deterministic: true});

    expect(loadout(peer)).toBe(loadout(host)); // same relayed autobuy → same inventory
    expect(peer.getCredits()).toBe(host.getCredits()); // …and the same spend
  });

  it('a solo autobuy still honours it — a disabled weapon is never bought', () => {
    const staple = getDefaultWeaponIndex();
    const allowed = WEAPON_DATABASE.findIndex(
      (w, i) => i !== staple && w.cost > 0 && w.cost <= 500 && !w.extType, // a cheap ballistic round
    );
    GameContent.weaponsOff = new Set(WEAPON_DATABASE.map((_, i) => i).filter(i => i !== staple && i !== allowed));

    const econ = new CEconomy(20_000);
    econ.autoBuy();

    expect(econ.getOwned(allowed)).toBeGreaterThan(0);
    for (const i of GameContent.weaponsOff) expect(econ.getOwned(i)).toBe(0);
  });
});
