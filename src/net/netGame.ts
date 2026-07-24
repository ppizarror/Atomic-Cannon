/**
 * NetGame — the bridge between room messages and the live game. It boots a
 * synchronized match from `startGame`, hands turns to the controller as the server
 * dictates them (`turnBegin`), applies the authoritative post-turn state everyone
 * shares (`stateUpdate`), and — when the LOCAL player's turn resolves — reports that
 * client's outcome back so the server can advance the turn.
 *
 * The server is the turn arbiter; this class holds no game logic of its own.
 */
import type {CGameController, NetSnapshot} from '../game/CGameController';
import type {RoomClient} from './roomClient';
import type {ServerMessage} from './protocol';
import {applyCommand} from './commands';

/** What NetGame needs from its embedder (kept free of Preact/store details). */
export interface NetGameHost {
  controller: CGameController;
  /** Switch the UI into the battle once the match boots. */
  onMatchStart(): void;
}

/** Distinct team colours assigned by turn order (same on every client). */
const TEAM_HEX = [
  '#e23b3b',
  '#3b7de2',
  '#3bd06a',
  '#e0c23b',
  '#b23be0',
  '#3bd8e0',
  '#e07f3b',
  '#c8c8c8',
];

export class NetGame {
  private m_seq = 0;
  // The authoritative keyframe (+ its hash) that arrived WHILE we were still simulating —
  // checked against our own result once we settle; applied only if we actually drifted.
  private m_pendingKeyframe: {result: NetSnapshot; hash: number} | null = null;
  // A server turn hand-off that arrived mid-simulation — applied once our sim settles, so
  // a late `turnBegin` can never interrupt an in-flight shot.
  private m_pendingTurn: number | null = null;

  constructor(
    private readonly client: RoomClient,
    private readonly host: NetGameHost,
  ) {}

  /** Route one server message. Non-game messages are ignored here. */
  handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'startGame':
        return this.onStart(msg.seed, msg.order, msg.wind, msg.mapSize);
      case 'turnBegin':
        return this.onTurnBegin(msg.playerIdx);
      case 'stateUpdate':
        return this.onStateUpdate(msg.result as NetSnapshot, msg.hash);
      case 'cmd':
        return this.onRemoteCommand(msg.cmd);
      case 'gameOver':
        return this.host.controller.netFinishBattle();
      // chat: handled in a later phase (in-match chat).
    }
  }

  /**
   * A relayed intent from the acting player, replayed verbatim through the command bus:
   * select-weapon, aim, then fire. Because the sim is deterministic (seeded RNG + fixed
   * timestep), every client computes the SAME shot outcome — no one has to trust the
   * shooter's reported damage (that's the cheat-resistance).
   */
  private onRemoteCommand(cmd: Parameters<typeof applyCommand>[1]): void {
    applyCommand(this.host.controller, cmd);
  }

  /** Server turn hand-off — queue it if we're mid-shot, else apply now. */
  private onTurnBegin(playerIdx: number): void {
    if (this.host.controller.isNetSimBusy()) this.m_pendingTurn = playerIdx;
    else this.applyTurn(playerIdx);
  }

  private applyTurn(playerIdx: number): void {
    this.m_pendingKeyframe = null; // stale — belongs to the turn that just ended
    this.host.controller.netSetActivePlayer(playerIdx);
  }

  /**
   * The authoritative snapshot is a DRIFT KEYFRAME, not the per-shot source of truth
   * (every client simulated the shot). Mid-shot it's stashed for a post-settle check;
   * when idle it's applied ONLY if our own hash disagrees — so an in-sync client keeps
   * its own simulation (cheat-resistant) and a drifted/reconnecting one is corrected.
   */
  private onStateUpdate(result: NetSnapshot, hash: number): void {
    if (this.host.controller.isNetSimBusy()) {
      this.m_pendingKeyframe = {result, hash};
      return;
    }
    this.applyKeyframeIfDrifted(result, hash);
  }

  private applyKeyframeIfDrifted(result: NetSnapshot, hash: number): void {
    if (this.host.controller.stateHash() !== hash) {
      this.host.controller.applyNetSnapshot(result); // desync / catch-up → resync
    }
  }

  private onStart(seed: number, order: readonly number[], wind: number, mapSize: number): void {
    this.m_pendingKeyframe = null;
    this.m_pendingTurn = null;
    const st = this.client.getState();
    const byId = new Map(st.players.map(p => [p.id, p]));
    // Same order on every client → same names, same team colours, same tank indices.
    const roster = order.map((id, i) => ({
      name: byId.get(id)?.name ?? `Player ${id}`,
      color: TEAM_HEX[i % TEAM_HEX.length],
    }));
    const localIndex = Math.max(0, order.indexOf(st.youId ?? -1));

    this.host.controller.startNetworkGame({
      seed,
      players: order.length,
      localIndex,
      roster,
      wind,
      mapSize,
      onTurnEnd: () => this.onTurnSettled(),
      onCommand: cmd => this.client.send({t: 'cmd', seq: ++this.m_seq, cmd}),
    });
    this.host.onMatchStart();
  }

  /**
   * Our local simulation for this turn just settled (fires on every client). The acting
   * client reports its authoritative state + hash; a spectator reconciles against any
   * keyframe that raced in mid-shot. Then we apply a turn hand-off that was held back.
   */
  private onTurnSettled(): void {
    const gc = this.host.controller;
    if (gc.isLocalNetTurn()) {
      this.client.send({
        t: 'shotResult',
        seq: ++this.m_seq,
        result: gc.getNetSnapshot(),
        hash: gc.stateHash(),
        over: gc.isNetBattleOver(),
      });
    } else if (this.m_pendingKeyframe) {
      this.applyKeyframeIfDrifted(this.m_pendingKeyframe.result, this.m_pendingKeyframe.hash);
      this.m_pendingKeyframe = null;
    }
    if (this.m_pendingTurn !== null) {
      const idx = this.m_pendingTurn;
      this.m_pendingTurn = null;
      this.applyTurn(idx);
    }
  }
}
