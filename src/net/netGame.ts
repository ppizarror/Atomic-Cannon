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
import type {ServerMessage, MatchConfig} from './protocol';
import {applyCommand} from './commands';
import {strings, fmt} from '../i18n';

/** What NetGame needs from its embedder (kept free of Preact/store details). */
export interface NetGameHost {
  controller: CGameController;
  /** Switch the UI into the battle once the match boots. */
  onMatchStart(): void;
  /** A per-turn keyframe disagreed with our OWN deterministic result after we simulated the turn —
   *  i.e. a cheating client or a genuine desync. We keep our own (trusted) state and never adopt the
   *  reported snapshot; the embedder surfaces this (banner + report to the server for flagging). */
  onDivergence?(info: {localHash: number; keyframeHash: number}): void;
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

/** How long every client lingers on the battle-winner celebration before the next Deathmatch
 *  battle starts. Client-side (not server-timed) — the server sends nextBattle immediately and
 *  each client holds it this long, so no clock sync is needed. */
const NET_BATTLE_INTERMISSION_MS = 4500;

export class NetGame {
  private m_seq = 0;
  // The authoritative keyframe (+ its hash) that arrived WHILE we were still simulating —
  // checked against our own result once we settle; applied only if we actually drifted.
  private m_pendingKeyframe: {result: NetSnapshot; hash: number} | null = null;
  // A server turn hand-off that arrived mid-simulation — applied once our sim settles, so
  // a late `turnBegin` can never interrupt an in-flight shot.
  private m_pendingTurn: number | null = null;
  private m_pendingHandoff = false; // the queued turn's hand-off flag (crate roll + per-turn income)
  private m_pendingRoundWrapped = false; // the queued turn's round-wrap flag (per-round income)
  // True once we've begun playing turns in lockstep (first turnBegin). While FALSE we have no
  // independent simulation to trust (fresh boot / reconnect), so a keyframe is a BOOTSTRAP we adopt;
  // once TRUE our own deterministic sim is authoritative for us and a keyframe is never adopted —
  // only used to DETECT divergence. This is the anti-cheat: a lying actor can't impose fake state.
  private m_hasSimulated = false;

  constructor(
    private readonly client: RoomClient,
    private readonly host: NetGameHost,
  ) {}

  /** Route one server message. Non-game messages are ignored here. */
  handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'startGame':
        return this.onStart(
          msg.seed,
          msg.order,
          msg.wind,
          msg.mapSize,
          msg.battles,
          msg.tanksPerTeam,
          msg.currentBattle,
          msg.viewW,
          msg.viewH,
          msg.config,
        );
      case 'turnBegin':
        return this.onTurnBegin(msg.playerIdx, msg.handoff ?? false, msg.roundWrapped ?? false);
      case 'nextBattle':
        return this.onNextBattle(msg.seed);
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
    // Defend against a malformed relayed command (the server validates too, but never trust the wire):
    // applyCommand switches on cmd.t, which would throw on a non-object.
    if (!cmd || typeof cmd !== 'object') return;
    applyCommand(this.host.controller, cmd);
  }

  /** Server turn hand-off — queue it if we're mid-shot, else apply now. */
  private onTurnBegin(playerIdx: number, handoff: boolean, roundWrapped: boolean): void {
    if (this.host.controller.isNetSimBusy()) {
      this.m_pendingTurn = playerIdx;
      this.m_pendingHandoff = handoff;
      this.m_pendingRoundWrapped = roundWrapped;
    } else {
      this.applyTurn(playerIdx, handoff, roundWrapped);
    }
  }

  private applyTurn(playerIdx: number, handoff: boolean, roundWrapped: boolean): void {
    this.m_pendingKeyframe = null; // stale — belongs to the turn that just ended
    // We're now playing turns in lockstep: from here on our own sim is authoritative for us and a
    // keyframe is detect-only. (A reconnect bootstraps via the keyframe BEFORE this first turnBegin.)
    this.m_hasSimulated = true;
    const gc = this.host.controller;
    // Once-per-turn hand-off effects, driven by the server so they fire EXACTLY once (the local
    // endTurn can repeat). Deterministic: every client runs them from the same settled sim state
    // + shared rates. Crate roll + per-turn income on any hand-off; per-round income on a wrap.
    if (handoff) gc.netTurnHandoff();
    if (roundWrapped) gc.netAwardRoundCredit();
    gc.netSetActivePlayer(playerIdx);
  }

  /**
   * A server snapshot. Mid-shot it's stashed for a post-settle reconcile. Otherwise:
   *  • BOOTSTRAP (we haven't simulated yet — fresh boot / reconnect): adopt it to catch up.
   *  • KEYFRAME (we've been playing): we simulated this turn ourselves, so we TRUST OUR OWN state
   *    and never adopt the actor's self-reported snapshot — a mismatch is a cheat/desync we flag.
   */
  private onStateUpdate(result: NetSnapshot, hash: number): void {
    if (this.host.controller.isNetSimBusy()) {
      this.m_pendingKeyframe = {result, hash};
      return;
    }
    this.reconcileKeyframe(result, hash);
  }

  private reconcileKeyframe(result: NetSnapshot, hash: number): void {
    const gc = this.host.controller;
    if (!this.m_hasSimulated) {
      gc.applyNetSnapshot(result); // bootstrap: no independent sim yet → adopt the authoritative state
      return;
    }
    // True lockstep: our deterministic sim is the truth for us. Never overwrite it with the acting
    // client's snapshot (the old cheat vector). A hash mismatch → cheat or genuine desync: flag it.
    const localHash = gc.stateHash();
    if (localHash !== hash) this.host.onDivergence?.({localHash, keyframeHash: hash});
  }

  private onStart(
    seed: number,
    order: readonly number[],
    wind: number,
    mapSize: number,
    battles: number,
    tanksPerTeam: number,
    currentBattle: number,
    viewW: number,
    viewH: number,
    config: MatchConfig,
  ): void {
    this.m_pendingKeyframe = null;
    this.m_pendingTurn = null;
    // Fresh boot (or reconnect re-boot): until the first turnBegin we have no sim to trust, so the
    // next keyframe is a bootstrap to adopt. resumeMatch sends startGame→stateUpdate→turnBegin, so
    // the reconnect snapshot lands here while this is still false and is correctly adopted.
    this.m_hasSimulated = false;
    const st = this.client.getState();
    const byId = new Map(st.players.map(p => [p.id, p]));
    // Same order on every client → same names, same team colours, same tank indices.
    const roster = order.map((id, i) => ({
      name: byId.get(id)?.name ?? fmt(strings.value.net.playerNum, {n: id}),
      color: TEAM_HEX[i % TEAM_HEX.length],
    }));
    // A local index of -1 means we're NOT in the turn order — i.e. a mid-match spectator. Keep it
    // -1 (don't clamp to 0): isLocalNetTurn then never fires, so we watch without ever controlling.
    const localIndex = order.indexOf(st.youId ?? -1);

    this.host.controller.startNetworkGame({
      seed,
      players: order.length,
      localIndex,
      roster,
      wind,
      mapSize,
      battles,
      tanksPerTeam,
      currentBattle,
      viewW,
      viewH,
      config,
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
      this.reconcileKeyframe(this.m_pendingKeyframe.result, this.m_pendingKeyframe.hash);
      this.m_pendingKeyframe = null;
    }
    // Battle over → show the battle-winner celebration on EVERY client (deterministic: the same
    // last team stands). The server then either ends the war (gameOver) or, for a Deathmatch with
    // battles left, sends nextBattle. No in-battle turn hand-off follows, so don't drain one.
    if (gc.isNetBattleOver()) {
      gc.netFinishBattle();
      return;
    }
    if (this.m_pendingTurn !== null) {
      const idx = this.m_pendingTurn;
      this.m_pendingTurn = null;
      this.applyTurn(idx, this.m_pendingHandoff, this.m_pendingRoundWrapped);
    }
  }

  /**
   * A Deathmatch battle ended and the war continues. Hold on the battle-winner celebration for a
   * short intermission, then advance to the fresh battle (new terrain from the shared seed). The
   * server's turnBegin for the new battle races in immediately; it's queued (the controller reads
   * BattleEnd as "busy") until the advance completes, then drained here.
   */
  private onNextBattle(seed: number): void {
    setTimeout(() => {
      const gc = this.host.controller;
      if (!gc.isNetBattleActive()) return; // left the match during the intermission
      gc.netNextBattle(seed);
      if (this.m_pendingTurn !== null) {
        const idx = this.m_pendingTurn;
        this.m_pendingTurn = null;
        this.applyTurn(idx, this.m_pendingHandoff, this.m_pendingRoundWrapped);
      }
    }, NET_BATTLE_INTERMISSION_MS);
  }
}
