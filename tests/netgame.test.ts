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
  relativeTurrets: false,
  utilityTurn: false,
  crateChance: 20,
  startCredits: 3000,
  gameType: 1,
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
      settings: {maxPlayers: 6, minPlayers: 2, battles: 2},
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

  it('turnBegin advances the active player', () => {
    const {gc, ng} = harness(1);
    ng.handle({
      t: 'startGame',
      seed: 999,
      order: [1, 2],
      wind: 1,
      mapSize: 2,
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
      settings: {maxPlayers: 6, minPlayers: 2, battles: 2},
      isHost: youId === 1,
      lastError: null,
    };
    const client = {
      getState: () => state,
      send: (m: ClientMessage) => sent.push(m),
    } as unknown as RoomClient;
    const ng = new NetGame(client, {controller: gc, onMatchStart: () => {}});
    ng.handle({
      t: 'startGame',
      seed: 5,
      order: [1, 2],
      wind: 1,
      mapSize: 2,
      viewW: 1280,
      viewH: 720,
      config: CFG,
    });
    return {gc, ng, sent};
  }

  it('applies a keyframe only when the hash disagrees (drift), never when in sync', () => {
    const {gc, ng} = bridge(1);
    ng.handle({t: 'turnBegin', playerIdx: 0, deadline: 0}); // idle
    const inSync = gc.stateHash();

    // A keyframe that WOULD kill tank 1, but whose hash claims we're in sync → ignored.
    const snap = gc.getNetSnapshot();
    snap.tanks[1].life = 0;
    ng.handle({t: 'stateUpdate', from: 1, seq: 1, result: snap, hash: inSync});
    expect(gc.getNetSnapshot().tanks[1].life).toBeGreaterThan(0);

    // Same keyframe, but the hash disagrees → resync (apply it).
    ng.handle({t: 'stateUpdate', from: 1, seq: 2, result: snap, hash: 999999});
    expect(gc.getNetSnapshot().tanks[1].life).toBe(0);
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
    snap.tanks[1].life = 0; // kill the opponent's tank
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
        settings: {maxPlayers: 6, minPlayers: 2, battles: 2},
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
      viewW: 1280,
      viewH: 720,
      config: CFG,
    });
    gc.netSetActivePlayer(0); // my turn

    // Wipe the opponent, then resolve the turn.
    const snap = gc.getNetSnapshot();
    snap.tanks[1].life = 0;
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
