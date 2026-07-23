/**
 * NetTransport — the client's swappable link to a room. The game talks to this
 * interface, never to a socket, so the same client runs against a Cloudflare
 * Durable Object, a self-hosted `ws` server, or anything else.
 *
 * Browser-side only (uses the `WebSocket` global). The room server speaks the
 * same {@link ServerMessage}/{@link ClientMessage} protocol.
 */
import {type ClientMessage, type ServerMessage, parseServerMessage} from './protocol';

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface NetTransport {
  connect(): void;
  send(msg: ClientMessage): void;
  /** Subscribe to inbound messages; returns an unsubscribe fn. */
  onMessage(cb: (msg: ServerMessage) => void): () => void;
  /** Subscribe to connection-status changes; returns an unsubscribe fn. */
  onStatus(cb: (s: ConnStatus) => void): () => void;
  close(): void;
  readonly status: ConnStatus;
}

export interface WebSocketTransportOptions {
  /** Full ws(s):// URL of the room, e.g. wss://host/room/ABCD23. */
  readonly url: string;
  /** Auto-reconnect on unexpected drop (default true). */
  readonly reconnect?: boolean;
  /** Base backoff in ms (default 500); grows exponentially, capped at maxBackoffMs. */
  readonly backoffMs?: number;
  readonly maxBackoffMs?: number;
  /** WebSocket implementation (injectable for tests; defaults to the global). */
  readonly WebSocketImpl?: typeof WebSocket;
}

/** A WebSocket-backed transport with buffered send and exponential-backoff reconnect. */
export class WebSocketTransport implements NetTransport {
  private m_ws: WebSocket | null = null;
  private m_status: ConnStatus = 'idle';
  private m_attempts = 0;
  private m_closedByUs = false;
  private m_outbox: string[] = [];
  private m_reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly m_msgSubs = new Set<(m: ServerMessage) => void>();
  private readonly m_statusSubs = new Set<(s: ConnStatus) => void>();
  private readonly m_WS: typeof WebSocket;

  constructor(private readonly opts: WebSocketTransportOptions) {
    this.m_WS = opts.WebSocketImpl ?? WebSocket;
  }

  get status(): ConnStatus {
    return this.m_status;
  }

  connect(): void {
    this.m_closedByUs = false;
    this.open();
  }

  private open(): void {
    if (this.m_ws && (this.m_ws.readyState === 0 || this.m_ws.readyState === 1)) return;
    this.setStatus(this.m_attempts === 0 ? 'connecting' : 'reconnecting');

    const ws = new this.m_WS(this.opts.url);
    this.m_ws = ws;

    ws.onopen = () => {
      this.m_attempts = 0;
      this.setStatus('open');
      // Flush anything queued while offline.
      const pending = this.m_outbox;
      this.m_outbox = [];
      for (const raw of pending) ws.send(raw);
    };

    ws.onmessage = (ev: MessageEvent) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      const msg = parseServerMessage(data);
      if (msg) for (const cb of this.m_msgSubs) cb(msg);
    };

    ws.onclose = () => {
      this.m_ws = null;
      if (this.m_closedByUs) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // Let onclose drive reconnect; just ensure the socket tears down.
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.opts.reconnect === false) {
      this.setStatus('closed');
      return;
    }
    this.setStatus('reconnecting');
    const base = this.opts.backoffMs ?? 500;
    const max = this.opts.maxBackoffMs ?? 10_000;
    const delay = Math.min(max, base * 2 ** this.m_attempts);
    // Full jitter to avoid thundering-herd reconnects (timing only — not gameplay RNG).
    const jittered = delay * (0.5 + Math.random() * 0.5);
    this.m_attempts++;
    this.m_reconnectTimer = setTimeout(() => this.open(), jittered);
  }

  send(msg: ClientMessage): void {
    const raw = JSON.stringify(msg);
    if (this.m_ws && this.m_ws.readyState === 1) {
      this.m_ws.send(raw);
    } else {
      this.m_outbox.push(raw); // delivered on (re)connect
    }
  }

  onMessage(cb: (m: ServerMessage) => void): () => void {
    this.m_msgSubs.add(cb);
    return () => this.m_msgSubs.delete(cb);
  }

  onStatus(cb: (s: ConnStatus) => void): () => void {
    this.m_statusSubs.add(cb);
    return () => this.m_statusSubs.delete(cb);
  }

  close(): void {
    this.m_closedByUs = true;
    if (this.m_reconnectTimer) {
      clearTimeout(this.m_reconnectTimer);
      this.m_reconnectTimer = null;
    }
    this.m_ws?.close();
    this.m_ws = null;
    this.setStatus('closed');
  }

  private setStatus(s: ConnStatus): void {
    if (s === this.m_status) return;
    this.m_status = s;
    for (const cb of this.m_statusSubs) cb(s);
  }
}
