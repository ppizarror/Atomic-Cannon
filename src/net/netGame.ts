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

type RelayedCommand = Parameters<typeof applyCommand>[1];

/** One turn-flow event, queued in wire order when it can't be applied yet (see NetGame.m_queue). */
type QueuedEvent =
  | {readonly t: 'cmd'; readonly cmd: RelayedCommand}
  | {
      readonly t: 'turn';
      readonly playerIdx: number;
      readonly handoff: boolean;
      readonly roundWrapped: boolean;
    }
  | {readonly t: 'state'; readonly result: NetSnapshot; readonly hash: number};

export class NetGame {
  private m_seq = 0;
  // Ordered queue of turn-flow events (relayed cmd / turnBegin / stateUpdate) that arrived while our
  // own sim was still resolving a shot — or behind an already-queued event. Draining them IN ORDER
  // once the sim settles preserves lockstep: applying a LATER turn's command to the current tank, or
  // dropping an intervening turnBegin's once-per-turn effects (seeded crate/income draws), would
  // diverge. Replaces the old single-slot pending-turn/keyframe stash, which lost intervening turns
  // under a stall (e.g. a backgrounded tab whose rAF sim freezes while messages keep arriving).
  private m_queue: QueuedEvent[] = [];
  private m_intermissionTimer: ReturnType<typeof setTimeout> | null = null; // between-battle advance
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
        return this.dispatch({
          t: 'turn',
          playerIdx: msg.playerIdx,
          handoff: msg.handoff ?? false,
          roundWrapped: msg.roundWrapped ?? false,
        });
      case 'nextBattle':
        return this.onNextBattle(msg.seed);
      case 'stateUpdate':
        return this.dispatch({t: 'state', result: msg.result as NetSnapshot, hash: msg.hash});
      case 'cmd':
        // Defend against a malformed relayed command (the server validates too, but never trust the
        // wire): applyCommand switches on cmd.t, which would throw on a non-object.
        if (msg.cmd && typeof msg.cmd === 'object') this.dispatch({t: 'cmd', cmd: msg.cmd});
        return;
      case 'gameOver':
        return this.host.controller.netFinishBattle();
      // chat: handled in a later phase (in-match chat).
    }
  }

  /**
   * Apply a turn-flow event now, or QUEUE it (in wire order) if our sim is still resolving a shot or
   * events are already queued ahead of it. This is the single ordering point: relayed commands
   * (select-weapon/aim/fire), turn hand-offs, and keyframes all flow through it so a stalled client
   * can't apply a later turn's command to the current tank or skip an intervening turn's effects.
   */
  private dispatch(ev: QueuedEvent): void {
    if (this.m_queue.length > 0 || this.host.controller.isNetSimBusy()) {
      this.m_queue.push(ev);
    } else {
      this.runEvent(ev);
    }
  }

  private runEvent(ev: QueuedEvent): void {
    switch (ev.t) {
      case 'cmd':
        // Deterministic replay of the actor's intent — every client computes the SAME shot outcome
        // (seeded RNG + fixed timestep), so no one trusts the shooter's reported damage.
        return applyCommand(this.host.controller, ev.cmd);
      case 'turn':
        return this.applyTurn(ev.playerIdx, ev.handoff, ev.roundWrapped);
      case 'state':
        return this.reconcileKeyframe(ev.result, ev.hash);
    }
  }

  /** Drain queued events in order, stopping the moment one makes the sim busy again (a relayed fire) —
   *  the settle callback resumes the drain. So each pass applies exactly one turn's worth of events. */
  private drainQueue(): void {
    while (this.m_queue.length > 0 && !this.host.controller.isNetSimBusy()) {
      this.runEvent(this.m_queue.shift()!);
    }
  }

  private applyTurn(playerIdx: number, handoff: boolean, roundWrapped: boolean): void {
    // NOTE: m_hasSimulated is flipped in onTurnSettled (after we actually simulate a turn), NOT here.
    // A client that reconnects/joins DURING a shot's flight misses the already-broadcast fire cmd, so
    // it never simulates that shot; keeping it in bootstrap mode lets it ADOPT the shot's result
    // keyframe instead of comparing a stale pre-shot hash and false-flagging a permanent desync.
    const gc = this.host.controller;
    // Once-per-turn hand-off effects, driven by the server so they fire EXACTLY once (the local
    // endTurn can repeat). Deterministic: every client runs them from the same settled sim state
    // + shared rates. Crate roll + per-turn income on any hand-off; per-round income on a wrap.
    if (handoff) gc.netTurnHandoff();
    if (roundWrapped) gc.netAwardRoundCredit();
    gc.netSetActivePlayer(playerIdx);
  }

  /**
   * A server snapshot, reconciled in wire order (see the queue). BOOTSTRAP (we haven't simulated yet
   * — fresh boot / reconnect): adopt it to catch up. KEYFRAME (we've been playing): we simulated this
   * turn ourselves, so we TRUST OUR OWN state and never adopt the actor's self-reported snapshot — a
   * mismatch is a cheat/desync we flag.
   */
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
    this.m_queue = []; // drop anything queued for a prior match/boot
    // Clear a pending between-battle timer — a reconnect can re-boot via startGame DURING the
    // intermission, and a stale timer would then advance a battle with the WRONG (old) seed.
    if (this.m_intermissionTimer !== null) {
      clearTimeout(this.m_intermissionTimer);
      this.m_intermissionTimer = null;
    }
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
   * Our local simulation for this turn just settled (fires on every client). The acting client
   * reports its authoritative state + hash; then the queued turn-flow events drain IN ORDER — the
   * just-ended turn's keyframe reconciles first, then the next turnBegin + that turn's commands (up
   * to the fire that makes us busy again, which re-triggers this on settle).
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
    }
    // Battle over → show the battle-winner celebration on EVERY client (deterministic: the same last
    // team stands). The server then ends the war (gameOver) or sends nextBattle. Don't drain a turn:
    // the queue's stale entries are cleared on nextBattle / gameOver ends the match.
    if (gc.isNetBattleOver()) {
      gc.netFinishBattle();
      return;
    }
    this.drainQueue();
  }

  /**
   * A Deathmatch battle ended and the war continues. Hold on the battle-winner celebration for a
   * short intermission, then advance to the fresh battle (new terrain from the shared seed). The
   * server's turnBegin for the new battle races in immediately; it's queued (the controller reads
   * BattleEnd as "busy") until the advance completes, then drained here.
   */
  private onNextBattle(seed: number): void {
    // Drop the ended battle's queued events (its final stateUpdate) — reconciling them against the
    // regenerated battle would flag a bogus divergence. The new battle's turnBegin arrives AFTER this
    // message (server order) and re-queues behind the BattleEnd "busy" gate, then drains below.
    this.m_queue = [];
    if (this.m_intermissionTimer !== null) clearTimeout(this.m_intermissionTimer);
    this.m_intermissionTimer = setTimeout(() => {
      this.m_intermissionTimer = null;
      const gc = this.host.controller;
      if (!gc.isNetBattleActive()) return; // left the match during the intermission
      gc.netNextBattle(seed);
      this.drainQueue(); // apply the new battle's first turnBegin (queued behind BattleEnd)
    }, NET_BATTLE_INTERMISSION_MS);
  }

  /** Tear down — cancel the pending intermission timer so it can't advance a battle on an orphaned
   *  NetGame after the user has left the match (the controller's m_netMode stays true, so its own
   *  guard wouldn't stop it). Call before dropping the reference. */
  dispose(): void {
    if (this.m_intermissionTimer !== null) {
      clearTimeout(this.m_intermissionTimer);
      this.m_intermissionTimer = null;
    }
  }
}
