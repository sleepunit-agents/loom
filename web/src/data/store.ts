/** The live protocol from src/core/live. No screen owns a connection or a record cache. */
export interface LiveRecord { id: string; [key: string]: unknown }
export type Status = 'loading' | 'live' | 'offline' | 'denied';
export type Failure = { ok: false; code: 'denied' | 'not-found' | 'invalid' | 'conflict' | 'unavailable'; message: string };
export type Result<T = unknown> = { ok: true; value: T } | Failure;
export interface Snapshot<T = LiveRecord> { records: readonly T[]; status: Status; error?: Failure }
export interface CallState<T = unknown> { pending: boolean; status: 'pending' | 'offline' | 'done'; result?: Result<T> }
export interface Call<T = unknown> {
  id: string;
  /** Explicitly resend an unavailable answer with the original id/input. */
  retry?(): void;
  result: Promise<Result<T>>;
  getSnapshot(): CallState<T>;
  subscribe(listener: () => void): () => void;
}
export interface Socket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
}
interface Subscription {
  type: string; scope?: string; ids: Set<string>; listeners: Set<() => void>; snapshot: Snapshot;
}
interface Pending { wire: string; update(state: CallState): void; finish(result: Result): void }
const keyOf = (type: string, scope?: string) => JSON.stringify([type, scope]);
const unavailable: Failure = { ok: false, code: 'unavailable', message: 'Connection closed' };

export class DataStore {
  private socket?: Socket;
  private subscriptions = new Map<string, Subscription>();
  private records = new Map<string, Map<string, LiveRecord>>();
  private calls = new Map<string, Pending>();
  private timer?: () => void;
  private attempts = 0;
  private stopped = false;
  private denied = false;
  constructor(private options: {
    socket(): Socket;
    id(): string;
    after(ms: number, fn: () => void): () => void;
  }) {}
  private subscription(type: string, scope?: string) {
    const key = keyOf(type, scope);
    let sub = this.subscriptions.get(key);
    if (!sub) {
      sub = { type, scope, ids: new Set(), listeners: new Set(), snapshot: { records: [], status: this.denied ? 'denied' : this.attempts > 0 ? 'offline' : 'loading' } };
      this.subscriptions.set(key, sub);
      if (this.socket?.readyState === 1) this.sendSubscription(sub);
    }
    return sub;
  }
  getSnapshot = (type: string, scope?: string): Snapshot => this.subscription(type, scope).snapshot;
  subscribe = (type: string, scope: string | undefined, listener: () => void) => {
    const sub = this.subscription(type, scope);
    sub.listeners.add(listener);
    this.connect();
    // The protocol has no unsubscribe. Retain subscriptions until this window closes.
    return () => { sub.listeners.delete(listener); };
  };
  private publish(sub: Subscription, status = sub.snapshot.status, error?: Failure) {
    const map = this.records.get(sub.type);
    sub.snapshot = { status, ...(error ? { error } : {}), records: [...sub.ids].flatMap(id => { const r = map?.get(id); return r ? [r] : []; }) };
    sub.listeners.forEach(fn => fn());
  }
  private collect(type: string) {
    const map = this.records.get(type);
    if (map) for (const id of map.keys()) {
      if (![...this.subscriptions.values()].some(s => s.type === type && s.ids.has(id))) map.delete(id);
    }
  }
  private sendSubscription(sub: Subscription) { this.send(JSON.stringify({ kind: 'subscribe', type: sub.type, scope: sub.scope })); }
  private send(wire: string) {
    try { this.socket?.send(wire); } catch { this.socket?.close(); }
  }
  private connect() {
    if (this.socket || this.timer || this.stopped || this.denied) return;
    let socket: Socket;
    try { socket = this.options.socket(); } catch { this.reconnect(); return; }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.subscriptions.forEach(sub => this.sendSubscription(sub));
      this.calls.forEach(call => { call.update({ pending: true, status: 'pending' }); this.send(call.wire); });
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      this.receive(message);
    };
    socket.onerror = () => { if (this.socket === socket) socket.close(); };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.denied = event.code === 1008;
      // Discard stale/private records immediately, including memberships in other scopes.
      this.records.clear();
      this.subscriptions.forEach(sub => { sub.ids.clear(); this.publish(sub, this.denied ? 'denied' : 'offline'); });
      if (this.denied) {
        this.calls.forEach(call => call.finish({ ok: false, code: 'denied', message: 'Session ended' }));
        this.calls.clear();
      } else {
        this.calls.forEach(call => call.update({ pending: true, status: 'offline' }));
        this.reconnect();
      }
    };
  }
  private reconnect() {
    if (this.stopped || this.denied || this.timer) return;
    this.subscriptions.forEach(sub => this.publish(sub, 'offline'));
    const delay = Math.min(250 * 2 ** Math.min(this.attempts++, 7), 30_000);
    this.timer = this.options.after(delay, () => { this.timer = undefined; this.connect(); });
  }
  private receive(message: any) {
    if (!message || typeof message !== 'object') return;
    // The foundation's subscription failures have no request/type correlation.
    if (isResult(message) && !message.ok) {
      this.subscriptions.forEach(sub => {
        if (sub.snapshot.status === 'live' && message.code !== 'denied') return;
        sub.ids.clear(); this.collect(sub.type);
        this.publish(sub, message.code === 'denied' ? 'denied' : 'offline', message);
      });
      return;
    }
    if (message.kind === 'pending' || message.kind === 'result') {
      const call = this.calls.get(message.request);
      if (!call) return;
      if (message.kind === 'pending') call.update({ pending: true, status: 'pending' });
      else if (isResult(message.result)) { this.attempts = 0; call.finish(message.result); this.calls.delete(message.request); }
      return;
    }
    if (!['set', 'put', 'del'].includes(message.kind) || typeof message.type !== 'string') return;
    const sub = this.subscriptions.get(keyOf(message.type, message.scope));
    if (!sub) return;
    let map = this.records.get(sub.type);
    if (!map) { map = new Map(); this.records.set(sub.type, map); }
    if (message.kind === 'set') {
      if (!Array.isArray(message.records) || !message.records.every(isRecord)) return;
      sub.ids = new Set(message.records.map((r: LiveRecord) => r.id));
      message.records.forEach((r: LiveRecord) => map.set(r.id, r));
      this.collect(sub.type);
      this.attempts = 0;
    } else if (message.kind === 'put') {
      if (!isRecord(message.record)) return;
      sub.ids.add(message.record.id); map.set(message.record.id, message.record);
    } else {
      if (typeof message.id !== 'string') return;
      sub.ids.delete(message.id); this.collect(sub.type);
    }
    // Shared records may also have changed in overlapping scopes.
    this.subscriptions.forEach(s => { if (s.type === sub.type) this.publish(s, s === sub ? 'live' : s.snapshot.status); });
  }
  call<T = unknown>(name: string, input: unknown): Call<T> {
    const id = this.options.id();
    let state: CallState<T> = { pending: true, status: this.socket?.readyState === 1 ? 'pending' : 'offline' };
    const listeners = new Set<() => void>();
    let resolve!: (result: Result<T>) => void;
    let result = new Promise<Result<T>>(r => { resolve = r; });
    const update = (next: CallState) => { state = next as CallState<T>; listeners.forEach(fn => fn()); };
    const finish = (answer: Result) => { update({ pending: false, status: 'done', result: answer }); resolve(answer as Result<T>); };
    let wire: string | undefined;
    const handle = { id, get result() { return result; }, retry: () => {
      if (state.pending || state.result?.ok !== false || state.result.code !== 'unavailable' || !wire || this.stopped || this.denied) return;
      result = new Promise<Result<T>>(r => { resolve = r; });
      update({ pending: true, status: this.socket?.readyState === 1 ? 'pending' : 'offline' });
      this.calls.set(id, { wire, update, finish });
      if (this.socket?.readyState === 1) this.send(wire);
      this.connect();
    }, getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } };
    if (this.stopped || this.denied) { finish(this.denied ? { ok: false, code: 'denied', message: 'Session ended' } : unavailable); return handle; }
    // Freeze the wire input now: edits to a caller's object cannot change a retry.
    try { wire = JSON.stringify({ kind: 'call', request: id, name, input, id }); }
    catch { finish({ ok: false, code: 'invalid', message: 'Input must be JSON' }); return handle; }
    this.calls.set(id, { wire, update, finish });
    if (this.socket?.readyState === 1) this.send(wire);
    this.connect();
    return handle;
  }
  close() {
    this.stopped = true; this.timer?.(); this.timer = undefined;
    const socket = this.socket; this.socket = undefined; socket?.close();
    this.records.clear();
    this.subscriptions.forEach(sub => { sub.ids.clear(); this.publish(sub, 'offline'); });
    this.calls.forEach(call => call.finish(unavailable)); this.calls.clear();
  }
}
function isRecord(value: unknown): value is LiveRecord { return !!value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'; }
function isResult(value: any): value is Result {
  return value?.ok === true || value?.ok === false && ['denied', 'not-found', 'invalid', 'conflict', 'unavailable'].includes(value.code) && typeof value.message === 'string';
}
/** A screen-local projection; never changes the shared authoritative records. */
export function optimistic<T>(call: Call, before: T, change: (value: T) => T): () => T {
  const preview = change(structuredClone(before));
  return () => call.getSnapshot().pending ? preview : before;
}
