/**
 * WebSocketTransport: buffers sends until open then flushes, delivers parsed
 * server messages to subscribers, reports status transitions, does NOT reconnect
 * on an explicit close, and DOES reconnect (with backoff) on an unexpected drop.
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {WebSocketTransport, type ConnStatus} from '../src/net/transport';
import type {ServerMessage} from '../src/net/protocol';

/** Minimal fake WebSocket we can drive by hand. */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: {data: string}) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(raw: string) {
    this.sent.push(raw);
  }
  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }
  // test helpers
  fireOpen() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  fireMessage(msg: ServerMessage) {
    this.onmessage?.({data: JSON.stringify(msg)});
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const makeTransport = (over: Partial<ConstructorParameters<typeof WebSocketTransport>[0]> = {}) =>
  new WebSocketTransport({
    url: 'wss://example/room/ABCD23',
    WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    ...over,
  });

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('WebSocketTransport', () => {
  it('reports connecting → open and flushes buffered sends on open', () => {
    const t = makeTransport();
    const statuses: ConnStatus[] = [];
    t.onStatus(s => statuses.push(s));

    t.connect();
    expect(t.status).toBe('connecting');

    // queued while not yet open
    t.send({t: 'ready', ready: true});
    const ws = MockWebSocket.instances[0];
    expect(ws.sent).toHaveLength(0);

    ws.fireOpen();
    expect(t.status).toBe('open');
    expect(ws.sent).toEqual([JSON.stringify({t: 'ready', ready: true})]);
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('delivers parsed server messages to subscribers', () => {
    const t = makeTransport();
    const got: ServerMessage[] = [];
    t.onMessage(m => got.push(m));
    t.connect();
    const ws = MockWebSocket.instances[0];
    ws.fireOpen();

    ws.fireMessage({t: 'chat', from: 2, text: 'gg'});
    expect(got).toEqual([{t: 'chat', from: 2, text: 'gg'}]);
  });

  it('sends immediately when already open', () => {
    const t = makeTransport();
    t.connect();
    const ws = MockWebSocket.instances[0];
    ws.fireOpen();
    t.send({t: 'leave'});
    expect(ws.sent).toContain(JSON.stringify({t: 'leave'}));
  });

  it('does not reconnect after an explicit close', () => {
    const t = makeTransport();
    t.connect();
    MockWebSocket.instances[0].fireOpen();

    t.close();
    expect(t.status).toBe('closed');
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1); // no new socket
  });

  it('reconnects with backoff after an unexpected drop', () => {
    const t = makeTransport({backoffMs: 500});
    const statuses: ConnStatus[] = [];
    t.onStatus(s => statuses.push(s));
    t.connect();
    MockWebSocket.instances[0].fireOpen();

    MockWebSocket.instances[0].drop();
    expect(t.status).toBe('reconnecting');

    vi.advanceTimersByTime(2000); // past the first backoff (500ms + jitter ≤ 500ms)
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(statuses).toContain('reconnecting');
  });

  it('honors reconnect:false', () => {
    const t = makeTransport({reconnect: false});
    t.connect();
    MockWebSocket.instances[0].fireOpen();
    MockWebSocket.instances[0].drop();
    expect(t.status).toBe('closed');
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
