/**
 * Networked match: a shared seed makes terrain identical across clients; the boot
 * builds one human tank per player; turn ownership limits local input to the local
 * player's turn; the authoritative snapshot round-trips; and the NetGame bridge boots
 * from `startGame`, advances on `turnBegin`, and reports the local turn's outcome.
 */
import {describe, it, expect} from 'vitest';
import {makeCanvas} from './_dom';
import {CGameController} from '../src/game/CGameController';
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

  it('reports the local turn outcome as a shotResult', () => {
    const {gc, ng, sent} = harness(1);
    ng.handle({t: 'startGame', seed: 999, order: [1, 2]});
    // Fire the controller's turn-end hook (set by startNetworkGame → NetGame.reportTurn).
    (gc as unknown as {m_onNetTurnEnd: () => void}).m_onNetTurnEnd();
    const shot = sent.find(m => m.t === 'shotResult');
    expect(shot).toBeTruthy();
    expect(shot && shot.t === 'shotResult' && shot.result.tanks).toHaveLength(2);
  });
});
