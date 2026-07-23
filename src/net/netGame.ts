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

  constructor(
    private readonly client: RoomClient,
    private readonly host: NetGameHost,
  ) {}

  /** Route one server message. Non-game messages are ignored here. */
  handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'startGame':
        return this.onStart(msg.seed, msg.order);
      case 'turnBegin':
        return this.host.controller.netSetActivePlayer(msg.playerIdx);
      case 'stateUpdate':
        return this.host.controller.applyNetSnapshot(msg.result as NetSnapshot);
      // cmd / chat: handled in a later phase (live aim relay, in-match chat).
    }
  }

  private onStart(seed: number, order: readonly number[]): void {
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
      onTurnEnd: () => this.reportTurn(),
    });
    this.host.onMatchStart();
  }

  /** The local player's turn resolved → broadcast this client's authoritative state. */
  private reportTurn(): void {
    this.client.send({
      t: 'shotResult',
      seq: ++this.m_seq,
      result: this.host.controller.getNetSnapshot(),
    });
  }
}
