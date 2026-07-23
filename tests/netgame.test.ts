/**
 * Networked match: a shared seed makes terrain identical across clients; the boot
 * builds one human tank per player; turn ownership limits local input to the local
 * player's turn; the authoritative snapshot round-trips; and the NetGame bridge boots
 * from `startGame`, advances on `turnBegin`, and reports the local turn's outcome.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController, EGameState} from '../src/game/CGameController';
import {NetGame, type NetGameHost} from '../src/net/netGame';
import type {RoomClient, RoomClientState} from '../src/net/roomClient';
import type {ClientMessage} from '../src/net/protocol';

const ROSTER = [
  {name: 'Ada', color: '#f00'},
  {name: 'Bo', color: '#0f0'},
];

function netController(localIndex: number, seed = 12345): CGameController {
  const gc = new CGameController(makeCanvas());
  gc.startNetworkGame({seed, players: 2, localIndex, roster: ROSTER});
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

  it('ignores local dev switches (flatland/weapontest) so clients stay identical', () => {
    // One client has ?flatland + ?weapontest set; the match must ignore both.
    const dirty = new CGameController(makeCanvas());
    dirty.setFlatLand(true);
    dirty.setWeaponTest(true);
    dirty.startNetworkGame({seed: 777, players: 2, localIndex: 0, roster: ROSTER});

    const clean = new CGameController(makeCanvas());
    clean.startNetworkGame({seed: 777, players: 2, localIndex: 1, roster: ROSTER});

    // Same seed → identical (non-flat) terrain despite the dirty client's switches.
    expect(dirty.getNetSnapshot().heights).toEqual(clean.getNetSnapshot().heights);
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

    // Carve a crater on the host's terrain, then sync it to the spectator.
    const land = (host as unknown as {m_land: {blastCircle(x: number, y: number, r: number): void}})
      .m_land;
    land.blastCircle(200, 240, 40);

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
    ng.handle({t: 'startGame', seed: 999, order: [1, 2]});
    expect(started()).toBe(true);
    expect(gc.getNetSnapshot().tanks).toHaveLength(2);
    // order [1,2], youId 2 → local index 1
    gc.netSetActivePlayer(1);
    expect(gc.isLocalNetTurn()).toBe(true);
  });

  it('turnBegin advances the active player', () => {
    const {gc, ng} = harness(1);
    ng.handle({t: 'startGame', seed: 999, order: [1, 2]});
    ng.handle({t: 'turnBegin', playerIdx: 1, deadline: 0});
    expect(gc.isLocalNetTurn()).toBe(false); // I'm index 0; it's index 1's turn
  });

  it('reports the local turn outcome as a shotResult (acting player only)', () => {
    const {gc, ng, sent} = harness(1); // I am player 1 → local index 0
    ng.handle({t: 'startGame', seed: 999, order: [1, 2]});
    gc.netSetActivePlayer(0); // my turn
    (gc as unknown as {m_onNetTurnEnd: () => void}).m_onNetTurnEnd();
    const shot = sent.find(m => m.t === 'shotResult');
    expect(shot).toBeTruthy();
    expect(shot && shot.t === 'shotResult' && shot.result.tanks).toHaveLength(2);
  });

  it('does NOT report on a spectator’s turn-end', () => {
    const {gc, ng, sent} = harness(1); // local index 0
    ng.handle({t: 'startGame', seed: 999, order: [1, 2]});
    gc.netSetActivePlayer(1); // opponent's turn — I'm a spectator now
    (gc as unknown as {m_onNetTurnEnd: () => void}).m_onNetTurnEnd();
    expect(sent.find(m => m.t === 'shotResult')).toBeUndefined();
  });

  it('firing on the local turn relays aim + fire commands', () => {
    const {gc, ng, sent} = harness(1); // local index 0
    ng.handle({t: 'startGame', seed: 999, order: [1, 2]});
    gc.netSetActivePlayer(0);
    gc.setAngle(50);
    gc.setPower(400);
    gc.fire();
    const cmds = sent.filter(m => m.t === 'cmd').map(m => (m.t === 'cmd' ? m.cmd : null));
    expect(cmds).toEqual([{t: 'aim', angle: 50, power: 400}, {t: 'fire'}]);
  });

  it('a relayed opponent fire flies a ghost arc; aim rotates their turret', () => {
    const {gc, ng} = harness(1);
    ng.handle({t: 'startGame', seed: 999, order: [1, 2]});
    ng.handle({t: 'turnBegin', playerIdx: 1, deadline: 0}); // opponent's turn
    ng.handle({t: 'cmd', from: 2, seq: 1, cmd: {t: 'aim', angle: 33, power: 500}});
    expect(gc.getAngle()).toBe(33);
    expect(gc.getGhostShotCount()).toBe(0);
    ng.handle({t: 'cmd', from: 2, seq: 2, cmd: {t: 'fire'}});
    expect(gc.getGhostShotCount()).toBe(1); // ghost arc spawned (not a real shot)
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
    ng.handle({t: 'startGame', seed: 5, order: [1, 2]});
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
