/**
 * Networked match: a shared seed makes terrain identical across clients; the boot
 * builds one human tank per player; turn ownership limits local input to the local
 * player's turn; the authoritative snapshot round-trips; and the NetGame bridge boots
 * from `startGame`, advances on `turnBegin`, and reports the local turn's outcome.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController, EGameState} from '../src/game/CGameController';
import {GameConfig} from '../src/core/CGameConfig';
import {WEAPON_DATABASE} from '../src/core/CWeapon';
import {NetGame, type NetGameHost} from '../src/net/netGame';
import {applyCommand, type GameCommand} from '../src/net/commands';
import type {RoomClient, RoomClientState} from '../src/net/roomClient';
import type {ClientMessage} from '../src/net/protocol';

const ROSTER = [
  {name: 'Ada', color: '#f00'},
  {name: 'Bo', color: '#0f0'},
];

// The host's shared gameplay config (defaults). A net match adopts this on every client.
const CFG = {
  hitpoints: 1000,
  tankSizeScale: 1,
  explosionScale: 1,
  powerScale: 1,
  kickbackScale: 1,
  buryTanks: false,
  variance: true,
  relativeTurrets: false,
  utilityTurn: false,
  crateChance: 20,
  radiationDamage: true,
  startCredits: 3000,
  gameType: 1,
  sellRate: 0.5,
  creditDamage: 1,
  creditKill: 500,
  creditTurn: 0,
  creditRound: 1000,
};

function netController(localIndex: number, seed = 12345): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.startNetworkGame({
    seed,
    players: 2,
    localIndex,
    roster: ROSTER,
    wind: 1,
    mapSize: 2,
    battles: 2,
    tanksPerTeam: 1,
    currentBattle: 1,
    viewW: 1280,
    viewH: 720,
    config: CFG,
  });
  return gc;
}

describe('network match boot', () => {
  it('seeds identical terrain across clients', () => {
    const a = netController(0);
    const b = netController(1); // different local index, SAME seed
    expect(a.getNetSnapshot().heights).toEqual(b.getNetSnapshot().heights);
  });

  it('different seeds → different terrain', () => {
    const a = netController(0, 111);
    const b = netController(0, 222);
    expect(a.getNetSnapshot().heights).not.toEqual(b.getNetSnapshot().heights);
  });

  it('builds one tank per player', () => {
    const gc = netController(0);
    expect(gc.getNetSnapshot().tanks).toHaveLength(2);
  });

  it('multi-tank teams: builds a squad per player and owns turns per-tank', () => {
    const gc = new CGameController(makeCanvas());
    gc.startNetworkGame({
      seed: 12345,
      players: 2,
      localIndex: 0, // I am player 0
      roster: ROSTER,
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 2, // squads of 2 → 4 tanks total
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: CFG,
    });
    expect(gc.getNetSnapshot().tanks).toHaveLength(4); // 2 players × 2 tanks

    // Contiguous squads: player 0 owns tanks 0-1, player 1 owns tanks 2-3. The active tank is
    // MINE iff its owner (floor(tankIdx / 2)) is my local player index (0).
    gc.netSetActivePlayer(0);
    expect(gc.isLocalNetTurn()).toBe(true); // my first tank
    gc.netSetActivePlayer(1);
    expect(gc.isLocalNetTurn()).toBe(true); // my second tank
    gc.netSetActivePlayer(2);
    expect(gc.isLocalNetTurn()).toBe(false); // opponent's tank
    gc.netSetActivePlayer(3);
    expect(gc.isLocalNetTurn()).toBe(false);
  });

  it('alternate turns interleaves the team turn order', () => {
    const gc = new CGameController(makeCanvas());
    gc.setHumanCount(2);
    gc.setTanksPerTeam(2); // 2 teams × 2 tanks → [A1, A2, B1, B2]

    GameConfig.alternateTurns = false;
    gc.startGame(2);
    expect(gc.getTurnOrder()).toEqual([0, 1, 2, 3]); // contiguous: A1, A2, B1, B2

    GameConfig.alternateTurns = true;
    gc.startGame(2);
    expect(gc.getTurnOrder()).toEqual([0, 2, 1, 3]); // interleaved: A1, B1, A2, B2
    GameConfig.alternateTurns = false; // restore global
  });

  it('multi-tank teams stay identical across clients (same seed)', () => {
    const mk = (localIndex: number) => {
      const c = new CGameController(makeCanvas());
      c.startNetworkGame({
        seed: 909,
        players: 2,
        localIndex,
        roster: ROSTER,
        wind: 1,
        mapSize: 2,
        battles: 2,
        tanksPerTeam: 3,
        currentBattle: 1,
        viewW: 1280,
        viewH: 720,
        config: CFG,
      });
      return c;
    };
    const a = mk(0);
    const b = mk(1);
    expect(a.getNetSnapshot().tanks).toHaveLength(6); // 2 × 3
    expect(a.stateHash()).toBe(b.stateHash()); // identical squads/terrain on both clients
  });

  it('host map size scales world width identically on every client', () => {
    const mk = (mapSize: number, localIndex: number) => {
      const c = new CGameController(makeCanvas());
      c.startNetworkGame({
        seed: 99,
        players: 2,
        localIndex,
        roster: ROSTER,
        wind: 1,
        mapSize,
        battles: 2,
        tanksPerTeam: 1,
        currentBattle: 1,
        viewW: 1280,
        viewH: 720,
        config: CFG,
      });
      return c.getNetSnapshot().heights.length;
    };
    // Same host map size → identical heightmap length on both clients…
    expect(mk(3, 0)).toBe(mk(3, 1));
    // …and a larger map size makes a strictly wider world.
    expect(mk(4, 0)).toBeGreaterThan(mk(2, 0));
    expect(mk(1, 0)).toBeLessThan(mk(2, 0));
  });

  it('clients on DIFFERENT windows build the identical world from the HOST resolution', () => {
    const mk = (w: number, h: number) => {
      const c = makeCanvas();
      c.width = w;
      c.height = h;
      return c;
    };
    const a = new CGameController(mk(800, 480));
    const b = new CGameController(mk(1920, 1080)); // very different window
    // Both are handed the HOST's resolution (1400×900), regardless of their own window.
    a.startNetworkGame({
      seed: 55,
      players: 2,
      localIndex: 0,
      roster: ROSTER,
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1400,
      viewH: 900,
      config: CFG,
    });
    b.startNetworkGame({
      seed: 55,
      players: 2,
      localIndex: 1,
      roster: ROSTER,
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1400,
      viewH: 900,
      config: CFG,
    });

    const ha = a.getNetSnapshot().heights;
    const hb = b.getNetSnapshot().heights;
    expect(ha.length).toBe(hb.length); // same heightmap length regardless of window
    expect(ha.length).toBe(1400 * 2); // = host viewW × mapSize (both clients build the host world)
    expect(ha).toEqual(hb); // and identical terrain
    expect(a.stateHash()).toBe(b.stateHash());
  });

  it('the host resolution drives the shared world width', () => {
    const worldLen = (viewW: number) => {
      const c = new CGameController(makeCanvas());
      c.startNetworkGame({
        seed: 7,
        players: 2,
        localIndex: 0,
        roster: ROSTER,
        wind: 1,
        mapSize: 2,
        battles: 2,
        tanksPerTeam: 1,
        currentBattle: 1,
        viewW,
        viewH: 720,
        config: CFG,
      });
      return c.getNetSnapshot().heights.length;
    };
    expect(worldLen(1600)).toBeGreaterThan(worldLen(1000)); // bigger host window → wider world
  });

  it('boots to an identical deterministic stateHash across clients', () => {
    // Same seed → same terrain AND same seeded spawn positions → same hash.
    const a = netController(0);
    const b = netController(1); // different local index, same seed
    expect(a.stateHash()).toBe(b.stateHash());

    // A different seed diverges.
    const c = new CGameController(makeCanvas());
    c.startNetworkGame({
      seed: 424242,
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
      config: CFG,
    });
    expect(c.stateHash()).not.toBe(a.stateHash());
  });

  it('two clients simulate the same shot to an identical stateHash (lockstep)', () => {
    const FIXED = 1 / 60;
    const shotClient = (seed: number): CGameController => {
      const gc = new CGameController(makeCanvas());
      gc.startNetworkGame({
        seed,
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
        config: CFG,
      });
      gc.netSetActivePlayer(0); // tank 0 is local + active → it fires
      gc.setAngle(45);
      gc.setPower(650);
      gc.fire();
      return gc;
    };
    const a = shotClient(31337);
    const b = shotClient(31337);
    // Step both deterministically (fixed dt) through the whole shot resolution.
    for (let i = 0; i < 1200; i++) {
      a.update(FIXED);
      b.update(FIXED);
    }
    expect(a.getNetSnapshot().heights).toEqual(b.getNetSnapshot().heights); // terrain carved identically
    expect(a.stateHash()).toBe(b.stateHash()); // tanks + terrain + RNG all agree
  });

  it('a bootstrapping client restores the RNG cursor so its hash matches the room', () => {
    // The state hash mixes the seeded-RNG cursor, and every shot advances it (kickback / crates /
    // variance). A mid-battle reconnect or spectator boots to the BATTLE-START cursor, so without
    // carrying the cursor in the snapshot it runs out of phase → false desync + real divergence.
    const rngOf = (gc: CGameController) =>
      (gc as unknown as {m_rng: {float(): number; getState(): number}}).m_rng;

    const room = netController(0);
    for (let i = 0; i < 7; i++) rngOf(room).float(); // advance as prior shots in the battle would

    const snap = room.getNetSnapshot();
    expect(snap.rngState).toBe(rngOf(room).getState()); // the snapshot captured the live cursor

    const joiner = netController(0); // a fresh (re)joining client — same seed → battle-start cursor
    expect(joiner.stateHash()).not.toBe(room.stateHash()); // out of phase BEFORE bootstrap (the bug)

    joiner.applyNetSnapshot(snap);
    expect(rngOf(joiner).getState()).toBe(rngOf(room).getState()); // cursor restored
    expect(joiner.stateHash()).toBe(room.stateHash()); // now IN PHASE with the room
  });

  it('live aim: streams throttled aim commands to spectators while the local player adjusts', () => {
    const FIXED = 1 / 60;
    const cmds: {t: string}[] = [];
    const gc = new CGameController(makeCanvas());
    gc.startNetworkGame({
      seed: 999,
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
      config: CFG,
      onCommand: c => cmds.push(c),
    });
    gc.netSetActivePlayer(0); // my turn → my aim is streamed
    const aims = () => cmds.filter(c => c.t === 'aim').length;

    // Warm the sim clock past the throttle window, then adjust aim: one relay goes out.
    for (let i = 0; i < 5; i++) gc.update(FIXED);
    gc.setAngle(40);
    gc.update(FIXED);
    const afterFirst = aims();
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // A second change on the very next frame is inside the throttle interval → suppressed.
    gc.setAngle(41);
    gc.update(FIXED);
    expect(aims()).toBe(afterFirst);

    // Let the interval pass, change again → a further relay is allowed.
    for (let i = 0; i < 6; i++) gc.update(FIXED);
    gc.setAngle(42);
    gc.update(FIXED);
    expect(aims()).toBeGreaterThan(afterFirst);
  });

  it('live aim: a spectator (not their turn) streams nothing', () => {
    const cmds: {t: string}[] = [];
    const gc = new CGameController(makeCanvas());
    gc.startNetworkGame({
      seed: 999,
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
      config: CFG,
      onCommand: c => cmds.push(c),
    });
    gc.netSetActivePlayer(1); // the OPPONENT's turn — not mine
    for (let i = 0; i < 8; i++) gc.update(1 / 60);
    gc.setAngle(33);
    gc.update(1 / 60);
    expect(cmds.filter(c => c.t === 'aim')).toHaveLength(0); // I don't relay on someone else's turn
  });

  it('ignores local dev switches (flatland/weapontest) so clients stay identical', () => {
    // One client has ?flatland + ?weapontest set; the match must ignore both.
    const dirty = new CGameController(makeCanvas());
    dirty.setFlatLand(true);
    dirty.setWeaponTest(true);
    dirty.startNetworkGame({
      seed: 777,
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
      config: CFG,
    });

    const clean = new CGameController(makeCanvas());
    clean.startNetworkGame({
      seed: 777,
      players: 2,
      localIndex: 1,
      roster: ROSTER,
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: CFG,
    });

    // Same seed → identical (non-flat) terrain despite the dirty client's switches.
    expect(dirty.getNetSnapshot().heights).toEqual(clean.getNetSnapshot().heights);
  });

  it('forces the HOST match config over each client’s local Settings', () => {
    // A client whose local Settings differ wildly from the host's…
    GameConfig.explosionScale = 3;
    GameConfig.hitpoints = 250;
    GameConfig.buryTanks = true;
    GameConfig.relativeTurrets = true;
    GameConfig.randomizeTurns = true; // must be forced OFF in net (server owns turn order)
    netController(0); // …adopts the host CFG (explosionScale 1, hitpoints 1000, bury/relative off)
    expect(GameConfig.explosionScale).toBe(1);
    expect(GameConfig.hitpoints).toBe(1000);
    expect(GameConfig.buryTanks).toBe(false);
    expect(GameConfig.relativeTurrets).toBe(false);
    expect(GameConfig.randomizeTurns).toBe(false);
  });

  it('advances to a fresh battle on the server signal (multi-battle war)', () => {
    const gc = netController(0); // CFG war length = 2 battles
    expect(gc.getBattleNum()).toBe(1);
    expect(gc.getTotalBattles()).toBe(2);
    const before = gc.getNetSnapshot().heights.slice();

    gc.netFinishBattle(); // battle over → show the winner celebration
    expect(gc.isNetSimBusy()).toBe(true); // the intermission queues the server's next turn

    gc.netNextBattle(0x0badf00d); // server advances the war with a fresh seed
    expect(gc.getBattleNum()).toBe(2);
    expect(gc.isNetSimBusy()).toBe(false); // back in a live battle
    expect(gc.getNetSnapshot().heights).not.toEqual(before); // regenerated terrain
    expect(gc.getNetSnapshot().tanks.every(t => t.life > 0)).toBe(true); // everyone respawned
  });

  it('two clients advance to an identical next battle from the shared seed', () => {
    const a = netController(0);
    const b = netController(1);
    a.netFinishBattle();
    b.netFinishBattle();
    a.netNextBattle(0x51234abc);
    b.netNextBattle(0x51234abc); // SAME server seed on both clients
    expect(a.getNetSnapshot().heights).toEqual(b.getNetSnapshot().heights);
    expect(a.stateHash()).toBe(b.stateHash());
  });

  it('runs a real economy (free-fire off) bound to the LOCAL player', () => {
    const gc = netController(1); // I am tank 1 — the depot spends MY purse
    const costly = WEAPON_DATABASE.findIndex(w => w.cost > 0);
    expect(costly).toBeGreaterThanOrEqual(0);
    expect(gc.isUnlimitedWeapon(costly)).toBe(false); // free-fire is OFF in net → weapons cost
    expect(gc.getCredits()).toBe(3000); // the local player's starting purse (CFG.startCredits)

    // Buying spends the local player's credits and stocks the round.
    const cost = WEAPON_DATABASE[costly].cost;
    expect(gc.buyWeapon(costly)).toBe(true);
    expect(gc.getCredits()).toBe(3000 - cost);
    expect(gc.getOwnedCounts()[costly]).toBe(1);
  });

  it('relays a buy on the local turn so peers apply it to the buyer', () => {
    const cmds: {t: string; index?: number}[] = [];
    const gc = new CGameController(makeCanvas());
    gc.startNetworkGame({
      seed: 5,
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
      config: CFG,
      onCommand: c => cmds.push(c as {t: string; index?: number}),
    });
    gc.netSetActivePlayer(0); // my turn
    const costly = WEAPON_DATABASE.findIndex(w => w.cost > 0);
    gc.buyWeapon(costly);
    expect(cmds).toContainEqual({t: 'buy', index: costly}); // buy is relayed to the room

    // A relayed buy applied on a SPECTATOR hits the ACTIVE (buyer's) economy, not the spectator's.
    const spectator = netController(1); // I am tank 1; tank 0 is buying
    spectator.netSetActivePlayer(0); // it's tank 0's turn
    const cost = WEAPON_DATABASE[costly].cost;
    applyCommand(spectator, {t: 'buy', index: costly});
    // The buyer (tank 0) — not me (tank 1) — is charged; and no re-relay off my turn.
    expect(spectator.getNetSnapshot().tanks[0].credits).toBe(3000 - cost);
    expect(spectator.getNetSnapshot().tanks[1].credits).toBe(3000);
  });

  // Jet flight steering must be relayed. Flight is followed by an aim+fire in the SAME turn
  // (before any turn-end keyframe), so a spectator that only replayed the ignite would land the tank
  // elsewhere and mis-simulate the relayed shot. The controller relays each thrust CHANGE + the cut.
  function bootNetWithSink(localIndex: number, sink: (c: GameCommand) => void): CGameController {
    const gc = new CGameController(makeCanvas());
    gc.startNetworkGame({
      seed: 7,
      players: 2,
      localIndex,
      roster: ROSTER,
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: CFG,
      onCommand: sink,
    });
    return gc;
  }
  const forceFlying = (gc: CGameController): void => {
    (gc as unknown as {m_gameState: EGameState}).m_gameState = EGameState.Flying;
  };

  it('relays thrust changes and the cut on the local turn, deduping identical repeats', () => {
    const cmds: GameCommand[] = [];
    const gc = bootNetWithSink(0, c => cmds.push(c));
    gc.netSetActivePlayer(0); // my tank
    forceFlying(gc);

    gc.setJetInput(true, false, false);
    gc.setJetInput(true, false, false); // identical → deduped, no second relay
    gc.setJetInput(true, true, false); // changed → relays
    gc.cutJet();

    const jets = cmds.filter(c => c.t === 'jet');
    expect(jets).toEqual([
      {t: 'jet', up: true, left: false, right: false},
      {t: 'jet', up: true, left: true, right: false},
    ]);
    expect(cmds.filter(c => c.t === 'cutJet')).toHaveLength(1);
  });

  it('does not relay jet input on a remote turn', () => {
    const cmds: GameCommand[] = [];
    const gc = bootNetWithSink(0, c => cmds.push(c));
    gc.netSetActivePlayer(1); // the opponent's tank is active → not my input to relay
    forceFlying(gc);

    gc.setJetInput(true, false, false);
    gc.cutJet();
    expect(cmds.filter(c => c.t === 'jet' || c.t === 'cutJet')).toHaveLength(0);
  });

  it('a spectator applying a relayed jet command reproduces the thrust (tank rises)', () => {
    // The actor ignites and thrusts up; the spectator, fed the relayed `jet`, climbs the same way.
    // Without the relay the tank keeps its (empty) thrust and just idles/falls. Ignite the flying
    // tank on the spectator, feed it the relayed up-thrust, and confirm it lifts off the surface.
    const spec = netController(1); // I am tank 1; tank 0 (remote) is the one flying
    spec.netSetActivePlayer(0);
    const tank = (
      spec as unknown as {m_tanks: {igniteJet(s: number): boolean; getPosition(): {y: number}}[]}
    ).m_tanks[0];
    tank.igniteJet(15); // give the flight fuel (the ignite the actor's `fire` performed)
    forceFlying(spec);
    const startY = tank.getPosition().y;

    applyCommand(spec, {t: 'jet', up: true, left: false, right: false}); // the relayed thrust
    for (let i = 0; i < 30; i++) spec.update(1 / 60);

    // Screen-Y grows downward: an up-thrust lifts the tank ABOVE where it started.
    expect(tank.getPosition().y).toBeLessThan(startY);
  });

  it('two clients earn credits deterministically from the same shot', () => {
    const FIXED = 1 / 60;
    const shoot = (): CGameController => {
      const gc = netController(0);
      gc.netSetActivePlayer(0);
      gc.setAngle(60);
      gc.setPower(700);
      gc.fire();
      for (let i = 0; i < 1200; i++) gc.update(FIXED);
      return gc;
    };
    const a = shoot();
    const b = shoot();
    // Same seed + synced rates → identical per-tank credit balances on both clients.
    expect(a.getNetSnapshot().tanks.map(t => t.credits)).toEqual(
      b.getNetSnapshot().tanks.map(t => t.credits),
    );
  });

  it('two clients with different local settings still simulate a shot to the same hash', () => {
    const FIXED = 1 / 60;
    // Each client boots with a DIFFERENT local explosionScale; startNetworkGame must overwrite
    // it with the shared CFG so the carve/damage — and thus the stateHash — match.
    const shot = (localExplosion: number): CGameController => {
      GameConfig.explosionScale = localExplosion; // divergent local — should be ignored in net
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
        config: CFG,
      });
      gc.netSetActivePlayer(0);
      gc.setAngle(45);
      gc.setPower(650);
      gc.fire();
      return gc;
    };
    const a = shot(3); // client A had explosionScale 3
    const b = shot(0.5); // client B had explosionScale 0.5
    for (let i = 0; i < 1200; i++) {
      a.update(FIXED);
      b.update(FIXED);
    }
    expect(a.stateHash()).toBe(b.stateHash()); // identical despite divergent pre-start settings
  });
});

describe('turn ownership', () => {
  it('local input is allowed only on the local player’s turn', () => {
    const gc = netController(0); // I am tank 0
    gc.netSetActivePlayer(0);
    expect(gc.isLocalNetTurn()).toBe(true);
    expect(gc.isPlayerTurn()).toBe(true);

    gc.netSetActivePlayer(1); // opponent's turn
    expect(gc.isLocalNetTurn()).toBe(false);
    expect(gc.isPlayerTurn()).toBe(false); // input locked out
  });

  it('a spectator (non-zero local index) never has local control on player 0’s turn', () => {
    const gc = netController(1); // I am tank 1
    gc.netSetActivePlayer(0);
    expect(gc.isPlayerTurn()).toBe(false);
    gc.netSetActivePlayer(1);
    expect(gc.isPlayerTurn()).toBe(true);
  });
});

describe('authoritative snapshot', () => {
  it('round-trips tank + terrain + wind state to a spectator', () => {
    const host = netController(0);
    const spectator = netController(1);

    // Diverge the spectator, then apply the host's authoritative snapshot.
    spectator.getNetSnapshot().tanks[0].life = 1; // (local mutation; ignored — proves apply overwrites)
    const snap = host.getNetSnapshot();
    snap.tanks[0].life = 250; // host says tank 0 is at 250
    snap.wind.x = 7;
    spectator.applyNetSnapshot(snap);

    const after = spectator.getNetSnapshot();
    expect(after.tanks[0].life).toBe(250);
    expect(after.wind.x).toBe(7);
    expect(after.heights).toEqual(snap.heights);
  });

  it('reconciles a remote crater onto a spectator (terrain, not just collision)', () => {
    const host = netController(0);
    const spectator = netController(1);
    const pristine = spectator.getNetSnapshot().heights.slice();

    // Carve a crater on the host's terrain AT the surface (robust to world size), then sync.
    const land = (
      host as unknown as {
        m_land: {
          carveDiscCollapse(x: number, y: number, r: number): void;
          getHeightAt(x: number): number;
        };
      }
    ).m_land;
    const cx = 200;
    land.carveDiscCollapse(cx, land.getHeightAt(cx) + 10, 40);

    const snap = host.getNetSnapshot();
    expect(snap.heights).not.toEqual(pristine); // the host's terrain actually changed
    spectator.applyNetSnapshot(snap);

    // The spectator now matches the host exactly (the crater transferred).
    expect(spectator.getNetSnapshot().heights).toEqual(snap.heights);
    expect(spectator.getNetSnapshot().heights).not.toEqual(pristine);
  });
});

describe('NetGame bridge', () => {
  function harness(youId: number) {
    const gc = new CGameController(makeCanvas());
    const sent: ClientMessage[] = [];
    const state: RoomClientState = {
      phase: 'playing',
      status: 'open',
      code: 'ABCD23',
      youId,
      players: [
        {id: 1, name: 'Ada', color: '#f00', ready: true, connected: true, isHost: true},
        {id: 2, name: 'Bo', color: '#0f0', ready: true, connected: true, isHost: false},
      ],
      settings: {
        maxPlayers: 6,
        minPlayers: 2,
        battles: 2,
        wind: 1,
        mapSize: 2,
        tanksPerTeam: 1,
        alternateTurns: false,
      },
      config: null,
      isHost: youId === 1,
      lastError: null,
    };
    const client = {
      getState: () => state,
      send: (m: ClientMessage) => sent.push(m),
    } as unknown as RoomClient;
    let started = false;
    const host: NetGameHost = {
      controller: gc,
      onMatchStart: () => {
        started = true;
      },
    };
    const ng = new NetGame(client, host);
    return {gc, ng, sent, started: () => started};
  }

  it('boots the match from startGame and enters battle', () => {
    const {gc, ng, started} = harness(2); // I am player id 2 → local index 1
    ng.handle({
      t: 'startGame',
      seed: 999,
      order: [1, 2],
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: CFG,
    });
    expect(started()).toBe(true);
    expect(gc.getNetSnapshot().tanks).toHaveLength(2);
    // order [1,2], youId 2 → local index 1
    gc.netSetActivePlayer(1);
    expect(gc.isLocalNetTurn()).toBe(true);
  });

  it('spectator: a client not in the turn order boots as a watcher and never owns a turn', () => {
    const {gc, ng, started} = harness(9); // youId 9 is NOT in order [1,2] → a late-join spectator
    ng.handle({
      t: 'startGame',
      seed: 999,
      order: [1, 2],
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: CFG,
    });
    expect(started()).toBe(true);
    expect(gc.isNetSpectator()).toBe(true); // local index resolved to -1, not clamped to 0
    gc.netSetActivePlayer(0);
    expect(gc.isLocalNetTurn()).toBe(false);
    gc.netSetActivePlayer(1);
    expect(gc.isLocalNetTurn()).toBe(false); // no tank is ever ours
  });

  it('turnBegin advances the active player', () => {
    const {gc, ng} = harness(1);
    ng.handle({
      t: 'startGame',
      seed: 999,
      order: [1, 2],
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: CFG,
    });
    ng.handle({t: 'turnBegin', playerIdx: 1, deadline: 0});
    expect(gc.isLocalNetTurn()).toBe(false); // I'm index 0; it's index 1's turn
  });

  it('reports the local turn outcome as a shotResult (acting player only)', () => {
    const {gc, ng, sent} = harness(1); // I am player 1 → local index 0
    ng.handle({
      t: 'startGame',
      seed: 999,
      order: [1, 2],
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: CFG,
    });
    gc.netSetActivePlayer(0); // my turn
    (gc as unknown as {m_onNetTurnEnd: () => void}).m_onNetTurnEnd();
    const shot = sent.find(m => m.t === 'shotResult');
    expect(shot).toBeTruthy();
    expect(shot && shot.t === 'shotResult' && shot.result.tanks).toHaveLength(2);
  });

  it('does NOT report on a spectator’s turn-end', () => {
    const {gc, ng, sent} = harness(1); // local index 0
    ng.handle({
      t: 'startGame',
      seed: 999,
      order: [1, 2],
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: CFG,
    });
    gc.netSetActivePlayer(1); // opponent's turn — I'm a spectator now
    (gc as unknown as {m_onNetTurnEnd: () => void}).m_onNetTurnEnd();
    expect(sent.find(m => m.t === 'shotResult')).toBeUndefined();
  });

  it('firing on the local turn relays selectWeapon + aim + fire', () => {
    const {gc, ng, sent} = harness(1); // local index 0
    ng.handle({
      t: 'startGame',
      seed: 999,
      order: [1, 2],
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: CFG,
    });
    gc.netSetActivePlayer(0);
    gc.setAngle(50);
    gc.setPower(400);
    gc.fire();
    const cmds = sent.filter(m => m.t === 'cmd').map(m => (m.t === 'cmd' ? m.cmd : null));
    expect(cmds.map(c => c?.t)).toEqual(['selectWeapon', 'aim', 'fire']);
    expect(cmds[1]).toEqual({t: 'aim', angle: 50, power: 400});
  });

  it('a relayed opponent shot is SIMULATED on spectators (real shot, not a stream)', () => {
    const {gc, ng} = harness(1);
    ng.handle({
      t: 'startGame',
      seed: 999,
      order: [1, 2],
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: CFG,
    });
    ng.handle({t: 'turnBegin', playerIdx: 1, deadline: 0}); // opponent's turn
    ng.handle({t: 'cmd', from: 2, seq: 1, cmd: {t: 'aim', angle: 33, power: 500}});
    expect(gc.getAngle()).toBe(33); // their turret tracks
    expect(gc.getShotCount()).toBe(0);
    ng.handle({t: 'cmd', from: 2, seq: 2, cmd: {t: 'fire'}});
    expect(gc.getShotCount()).toBeGreaterThan(0); // the spectator fires the real shot itself
  });
});

describe('lockstep sync (desync detector + turn queuing)', () => {
  function bridge(youId: number) {
    const gc = new CGameController(makeCanvas());
    const sent: ClientMessage[] = [];
    const state: RoomClientState = {
      phase: 'playing',
      status: 'open',
      code: 'ABCD23',
      youId,
      players: [
        {id: 1, name: 'A', color: '#f00', ready: true, connected: true, isHost: true},
        {id: 2, name: 'B', color: '#0f0', ready: true, connected: true, isHost: false},
      ],
      settings: {
        maxPlayers: 6,
        minPlayers: 2,
        battles: 2,
        wind: 1,
        mapSize: 2,
        tanksPerTeam: 1,
        alternateTurns: false,
      },
      config: null,
      isHost: youId === 1,
      lastError: null,
    };
    const client = {
      getState: () => state,
      send: (m: ClientMessage) => sent.push(m),
    } as unknown as RoomClient;
    const divergences: {localHash: number; keyframeHash: number}[] = [];
    const ng = new NetGame(client, {
      controller: gc,
      onMatchStart: () => {},
      onDivergence: info => divergences.push(info),
    });
    ng.handle({
      t: 'startGame',
      seed: 5,
      order: [1, 2],
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: CFG,
    });
    return {gc, ng, sent, divergences};
  }

  it('true lockstep: a peer keyframe never overwrites our own simulated state; a mismatch is flagged', () => {
    const {gc, ng, divergences} = bridge(1);
    ng.handle({t: 'turnBegin', playerIdx: 0, deadline: 0}); // we're now simulating in lockstep
    const inSync = gc.stateHash();

    // A keyframe that WOULD kill tank 1.
    const snap = gc.getNetSnapshot();
    snap.tanks[1].life = 0;

    // Hash agrees → nothing to do (not applied, no flag).
    ng.handle({t: 'stateUpdate', from: 1, seq: 1, result: snap, hash: inSync});
    expect(gc.getNetSnapshot().tanks[1].life).toBeGreaterThan(0);
    expect(divergences).toHaveLength(0);

    // Hash disagrees → we KEEP our own (trusted) state and FLAG it. A lying actor can't impose state.
    ng.handle({t: 'stateUpdate', from: 1, seq: 2, result: snap, hash: 999999});
    expect(gc.getNetSnapshot().tanks[1].life).toBeGreaterThan(0); // NOT overwritten (was applied pre-Option-A)
    expect(divergences).toHaveLength(1);
    expect(divergences[0].keyframeHash).toBe(999999);
  });

  it('bootstrap: a snapshot before the first turnBegin (reconnect catch-up) IS adopted', () => {
    const {gc, ng, divergences} = bridge(1);
    // No turnBegin yet → we have no independent simulation, so this snapshot is the reconnect
    // bootstrap (resumeMatch sends startGame→stateUpdate→turnBegin) and must be adopted.
    const snap = gc.getNetSnapshot();
    snap.tanks[1].life = 0;
    ng.handle({t: 'stateUpdate', from: 0, seq: 0, result: snap, hash: 12345});
    expect(gc.getNetSnapshot().tanks[1].life).toBe(0); // adopted to catch up
    expect(divergences).toHaveLength(0); // bootstrap never flags
  });

  it('queues a turn hand-off that arrives mid-shot until the sim settles', () => {
    const {gc, ng} = bridge(1);
    ng.handle({t: 'turnBegin', playerIdx: 0, deadline: 0});
    gc.setAngle(45);
    gc.setPower(600);
    gc.fire();
    expect(gc.isNetSimBusy()).toBe(true);

    ng.handle({t: 'turnBegin', playerIdx: 1, deadline: 0}); // arrives mid-shot
    expect(gc.isLocalNetTurn()).toBe(true); // NOT advanced — held back

    for (let i = 0; i < 1200; i++) gc.update(1 / 60); // resolve the shot
    expect(gc.isNetSimBusy()).toBe(false);
    expect(gc.isLocalNetTurn()).toBe(false); // the queued hand-off applied after settle
  });
});

describe('network battle-end', () => {
  it('isNetBattleOver flips once one team is wiped', () => {
    const gc = netController(0);
    expect(gc.isNetBattleOver()).toBe(false); // both alive

    const snap = gc.getNetSnapshot();
    snap.tanks[1].life = 0; // kill the opponent's tank…
    snap.tanks[1].alive = false; // …and clear the explicit alive flag (life alone doesn't kill in Rounds)
    gc.applyNetSnapshot(snap);
    expect(gc.isNetBattleOver()).toBe(true);
  });

  it('the killing shot is reported with over:true', () => {
    const gc = new CGameController(makeCanvas());
    const sent: ClientMessage[] = [];
    const client = {
      getState: () => ({
        phase: 'playing' as const,
        status: 'open' as const,
        code: 'ABCD23',
        youId: 1,
        players: [
          {id: 1, name: 'A', color: '#f00', ready: true, connected: true, isHost: true},
          {id: 2, name: 'B', color: '#0f0', ready: true, connected: true, isHost: false},
        ],
        settings: {
          maxPlayers: 6,
          minPlayers: 2,
          battles: 2,
          wind: 1,
          mapSize: 2,
          tanksPerTeam: 1,
          alternateTurns: false,
        },
        isHost: true,
        lastError: null,
      }),
      send: (m: ClientMessage) => sent.push(m),
    } as unknown as RoomClient;
    const ng = new NetGame(client, {controller: gc, onMatchStart: () => {}});
    ng.handle({
      t: 'startGame',
      seed: 5,
      order: [1, 2],
      wind: 1,
      mapSize: 2,
      battles: 2,
      tanksPerTeam: 1,
      currentBattle: 1,
      viewW: 1280,
      viewH: 720,
      config: CFG,
    });
    gc.netSetActivePlayer(0); // my turn

    // Wipe the opponent, then resolve the turn.
    const snap = gc.getNetSnapshot();
    snap.tanks[1].life = 0;
    snap.tanks[1].alive = false; // life alone doesn't kill (Rounds); clear the explicit flag
    gc.applyNetSnapshot(snap);
    (gc as unknown as {m_onNetTurnEnd: () => void}).m_onNetTurnEnd();

    const shot = sent.find(m => m.t === 'shotResult');
    expect(shot && shot.t === 'shotResult' && shot.over).toBe(true);
  });

  it('a gameOver message ends the battle locally (standings)', () => {
    const gc = netController(1);
    ng2(gc).handle({t: 'gameOver'});
    expect(gc.getState()).toBe(EGameState.BattleEnd);
  });
});

/** Minimal bridge over an already-booted controller (no client sends needed). */
function ng2(gc: CGameController): NetGame {
  const client = {
    getState: () => ({players: [], youId: 1}),
    send: () => {},
  } as unknown as RoomClient;
  return new NetGame(client, {controller: gc, onMatchStart: () => {}});
}
