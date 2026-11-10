/**
 * The shared collection runtime (docs/specs/collections.md, "The client runtime, in one paragraph"; t-2023).
 *
 * One per signed-in tab. It holds, for the windows open in it:
 *  - one record store per record type (`provider/type@major`), each record once, whichever views show it;
 *  - one subscription per distinct live query, shared by every view that asks the same thing, with its membership
 *    (which keys are in it, in order), coverage, counts and freshness;
 *  - one request in flight per identical query, batched (up to 32 a POST), and one stream: the page's own /events.
 *
 * Frames that arrive before their subscription's answer are held, then those after its `at` applied. A frame or an
 * answer from an older scope epoch is dropped. A record no subscription holds is dropped; a view nobody has read for
 * LINGER_MS is closed (so a window reopened soon after is warm); a type nobody has read for IDLE_MS is dropped; past
 * MAX_RECORDS the least recently read types go first. Sign-out, a 401 or 403, or a new scope clears what it affected.
 * Nothing is written to disk. No library is imported here: adapter.ts is the only code that does.
 */

export type Scalar = string | number | boolean | null;
export type Clause = [string, string, Scalar | Scalar[]] | [string, 'has'];
export interface QuerySpec {
  type: string;
  where?: Clause[];
  order?: Array<[string, 'asc' | 'desc']>;
  limit?: number;
  fields?: string[];
  aggregates?: string[];
}
export type Rec = { key: string; [field: string]: unknown };
export type Aggs = Record<string, { n: number; exact: boolean; by?: Record<string, number> }>;
export interface Coverage { complete: boolean; total?: { n: number; exact: boolean } }

export type Status = 'loading' | 'live' | 'stale' | 'unavailable' | 'denied' | 'error';
export interface ViewState {
  keys: readonly string[];
  coverage?: Coverage;
  aggregates?: Aggs;
  withheld: readonly string[];
  status: Status;
  error?: string;
  /** Another page can be loaded (more()). */
  more: boolean;
}

/**
 * A command's receipt (collections.md, "Commands"; t-2024): `done` and `failed` are the piece's word; `accepted` is
 * still under way; `unknown` is one loom never heard the end of (never run again: look before trying again).
 */
export interface Receipt { op: string; state: 'done' | 'failed' | 'accepted' | 'unknown'; why?: string; answer?: unknown }

/**
 * What a command may show before its receipt. Only a reversible change to a record the view holds, and never for a
 * grant or an approval: those show as done only on the receipt.
 */
export interface CommandOptions {
  kind?: 'grant' | 'approval' | 'other';
  optimistic?: { type: string; rec: Rec };
}

export const COMMAND_RETRIES = 3;
export const COMMAND_POLLS = 20;

/** What the runtime needs of the page: a way to ask, and its one stream. */
export interface Transport {
  /** POST /collections/query with the body (the page's anti-forgery token added by the transport). */
  post(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; json: unknown }>;
  /** The stream's frames, by event name; answers a function that stops listening. */
  on(event: 'hello' | 'rows' | 'reset' | 'open' | 'error', f: (data: Record<string, unknown>) => void): () => void;
}

/** Hears the record stores move: the adapter mirrors them into the client library's collections. */
export interface StoreHook {
  upsert(type: string, recs: readonly Rec[]): void;
  remove(type: string, keys: readonly string[]): void;
  drop(type: string): void;
}

export const MAX_BATCH = 32;
export const LINGER_MS = 30_000;
export const IDLE_MS = 5 * 60_000;
export const MAX_RECORDS = 20_000;
export const GONE_CHECK_MS = 30_000;

interface Sub {
  id: string;
  spec: QuerySpec;
  specKey: string;
  type: string;
  keys: string[];
  coverage?: Coverage;
  aggregates?: Aggs;
  withheld: string[];
  status: Status;
  error?: string;
  next: string | null;
  /** The stream seq this subscription's frames follow; null until its answer is in. */
  at: number | null;
  held: Array<Record<string, unknown>>;
  listeners: Set<() => void>;
  inflight?: AbortController;
  linger?: ReturnType<typeof setTimeout>;
  /** Asked on this stream (a reconnect asks again). */
  stream?: string;
  /** Answers in a row from an older scope (asked again a few times at most). */
  stale?: number;
  state: ViewState;
}

interface TypeStore { records: Map<string, Rec>; read: number }

let counter = 0;
/** An operation id: random, and the window's own (never derived from what it does). */
function opId(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  let out = '';
  for (const x of b) out += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[x & 63];
  return `op-${out}`;
}
const key = (spec: QuerySpec) => JSON.stringify([spec.type, spec.where ?? [], spec.order ?? [], spec.limit ?? null, spec.fields ?? null, spec.aggregates ?? []]);

const rank = (v: unknown) => (v === undefined || v === null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : 3);
function cmp(a: unknown, b: unknown): number {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (typeof a === 'string') return a < (b as string) ? -1 : a > (b as string) ? 1 : 0;
  return (a as number) - (b as number);
}

export class CollectionRuntime {
  private stores = new Map<string, TypeStore>();
  private subs = new Map<string, Sub>();
  private bySpec = new Map<string, string>();
  private stream: string | null = null;
  private scope = 0;
  /** Whose records these are (the hello's opaque tag): another's means everything goes first. */
  private viewer: string | null = null;
  private queue: Sub[] = [];
  private flushing = false;
  private offs: Array<() => void> = [];
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private cleared = false;

  constructor(private readonly t: Transport, private readonly hook?: StoreHook, private readonly now: () => number = Date.now) {
    this.offs.push(
      t.on('hello', (d) => this.hello(d)),
      t.on('rows', (d) => this.frame(d)),
      t.on('reset', (d) => this.reset(d)),
      // A stream that gave up for good (signed out, revoked: its reconnect was refused) clears everything.
      t.on('error', (d) => { this.markAll('stale'); if (d.closed) this.watchGone(); }),
    );
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  /** Records of a type the views read (the adapter's source). */
  records(type: string): ReadonlyMap<string, Rec> {
    const s = this.stores.get(type);
    if (s) s.read = this.now();
    return s?.records ?? new Map();
  }

  /**
   * A live view of `spec`: `onChange` hears it move; answers its state now, `more()` for the next page, and `close()`.
   * Two views of the same query share one subscription and one request.
   */
  view(spec: QuerySpec, onChange: () => void): { state: () => ViewState; more: () => void; close: () => void } {
    if (this.cleared) throw new Error('this runtime was cleared (signed out): make a new one');
    const sk = key(spec);
    let sub = this.subs.get(this.bySpec.get(sk) ?? '');
    if (!sub) {
      const id = `v${++counter}`;
      sub = { id, spec, specKey: sk, type: spec.type, keys: [], withheld: [], status: 'loading', next: null, at: null, held: [], listeners: new Set(), state: { keys: [], withheld: [], status: 'loading', more: false } };
      this.subs.set(id, sub);
      this.bySpec.set(sk, id);
      this.ask(sub);
    }
    const s = sub;
    clearTimeout(s.linger); s.linger = undefined;
    s.listeners.add(onChange);
    this.touch(s.type);
    return {
      state: () => { this.touch(s.type); return s.state; },
      more: () => this.more(s),
      close: () => {
        s.listeners.delete(onChange);
        if (!s.listeners.size) s.linger = setTimeout(() => this.closeSub(s), LINGER_MS);
      },
    };
  }

  /**
   * The stream gave up for good, which a proxy's outage does too: ask once whether the session is still there, and clear
   * only if it isn't (signed out, revoked).
   */
  private async confirmGone(): Promise<boolean> {
    try {
      const r = await this.t.post({ close: { stream: this.stream ?? 'e-none', ids: [] } });
      if (r.status === 401 || r.status === 403) { this.clear(); return true; }
    } catch { /* unreachable: what's shown stays, stale */ }
    return false;
  }

  /** Asked now, and every GONE_CHECK_MS while the stream stays down, until it's back or the session is gone. */
  private goneTimer: ReturnType<typeof setInterval> | undefined;
  private watchGone(): void {
    void this.confirmGone();
    if (this.goneTimer) return;
    this.goneTimer = setInterval(() => { if (this.cleared) { clearInterval(this.goneTimer); return; } void this.confirmGone(); }, GONE_CHECK_MS);
    (this.goneTimer as { unref?: () => void }).unref?.();
  }

  /** Every record goes, and every view is asked again (from the next hello): another viewer, a new scope. */
  private dropAll(): void {
    for (const [type, store] of this.stores) { store.records.clear(); this.hook?.drop(type); }
    this.stores.clear();
    for (const s of this.subs.values()) { s.inflight?.abort(); s.keys = []; s.at = null; s.held = []; s.next = null; s.coverage = undefined; s.aggregates = undefined; s.status = 'loading'; this.publish(s); }
  }

  /** Sign-out, a revoked session: every record and subscription goes, and nothing more is asked. */
  clear(): void {
    this.cleared = true;
    for (const s of this.subs.values()) { s.inflight?.abort(); clearTimeout(s.linger); }
    for (const [type, store] of this.stores) { store.records.clear(); this.hook?.drop(type); }
    this.stores.clear();
    const all = [...this.subs.values()];
    this.subs.clear(); this.bySpec.clear(); this.queue = [];
    for (const s of all) { s.keys = []; s.status = 'denied'; this.publish(s); }
    for (const off of this.offs) off();
    clearInterval(this.sweeper);
    clearInterval(this.goneTimer);
  }

  /**
   * Run a command (an action) under one operation id: `send(op)` posts it with `_op`. A dropped connection is retried
   * with the same id, so the action runs once, whatever happens to its answers; `accepted` (another try of it still
   * running) is asked again until it's settled. What it changed reaches the views through the stream, as any change
   * does; nothing here writes records but an optimistic preview, which a failure takes back (unless the record has
   * moved since). Answers its receipt.
   */
  async command(send: (op: string) => Promise<{ status: number; json: unknown }>, opts: CommandOptions = {}, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<Receipt> {
    const op = opId();
    this.pendingOps.add(op);
    let undo: (() => void) | undefined;
    // Asked for, for an ordinary change only: never by default, never for a grant or an approval.
    if (opts.optimistic && opts.kind === 'other') {
      const { type, rec } = opts.optimistic;
      const store = this.stores.get(type);
      const before = store?.records.get(rec.key);
      if (store && before) {
        const shown = { ...before, ...rec } as Rec;
        store.records.set(rec.key, shown);
        this.hook?.upsert(type, [shown]);
        this.republish(type);
        undo = () => {
          // Only if nothing has written the record since: a frame's newer word stands.
          if (store.records.get(rec.key) !== shown) return;
          store.records.set(rec.key, before);
          this.hook?.upsert(type, [before]);
          this.republish(type);
        };
      }
    }
    try {
      for (let tries = 0, polls = 0, dropped = false; ;) {
        let r: { status: number; json: unknown };
        try { r = await send(op); } catch {
          dropped = true;
          if (++tries > COMMAND_RETRIES) return this.settle(op, { op, state: 'unknown' }, undo);
          await wait(500 * tries);
          continue;
        }
        // Signed out: after a try that dropped, the first may still have run, so unknown; else it never ran.
        if (r.status === 401) { this.clear(); return this.settle(op, dropped ? { op, state: 'unknown' } : { op, state: 'failed', why: 'signed out' }, undo); }
        const j = (r.json ?? {}) as { ok?: boolean; message?: string; receipt?: { state?: string; why?: string } };
        // After a try that dropped, only a receipt says how it went: the first try may have run (an approval spent), so
        // anything else is unknown, never failed (which would invite pressing again under a new id).
        if (dropped && !j.receipt) return this.settle(op, { op, state: 'unknown', answer: r.json }, undo);
        const state = j.receipt?.state ?? (r.status >= 400 ? 'failed' : j.ok ? 'done' : 'failed');
        if (state === 'accepted') {
          if (++polls > COMMAND_POLLS) return this.settle(op, { op, state: 'unknown' }, undo);
          await wait(1000);
          continue;
        }
        const receipt: Receipt = { op, state: state as Receipt['state'], ...(state === 'failed' ? { why: j.receipt?.why ?? j.message ?? `status ${r.status}` } : {}), answer: r.json };
        return this.settle(op, receipt, undo);
      }
    } finally { this.pendingOps.delete(op); }
  }

  /** Commands under way (a window may show them as pending). */
  pending(): number { return this.pendingOps.size; }

  private pendingOps = new Set<string>();

  private settle(op: string, r: Receipt, undo?: () => void): Receipt {
    // Cleared meanwhile (signed out): nothing is put back.
    if (r.state !== 'done' && undo && !this.cleared) undo();
    void op;
    return r;
  }

  /** A record's views hear it moved (an optimistic preview, or its undoing). */
  private republish(type: string): void {
    for (const s of this.subs.values()) if (s.type === type) this.publish(s);
  }

  /** Whether it was cleared (signed out): a new one is made for the next window. */
  isCleared(): boolean { return this.cleared; }

  /** How many records the stores hold (tests, and the memory bound). */
  size(): number { let n = 0; for (const s of this.stores.values()) n += s.records.size; return n; }
  subscriptions(): number { return this.subs.size; }

  private touch(type: string): void {
    let s = this.stores.get(type);
    if (!s) { s = { records: new Map(), read: this.now() }; this.stores.set(type, s); }
    s.read = this.now();
  }

  private hello(d: Record<string, unknown>): void {
    if (typeof d.stream !== 'string') return;
    // Someone else now (a sign-in as another person in this browser): nothing of the last viewer's survives.
    // No tag at all (someone the page has no member for) after one counts as someone else too.
    const tag = typeof d.viewer === 'string' ? d.viewer : '';
    if (this.viewer !== null && tag !== this.viewer) this.dropAll();
    this.viewer = tag;
    const fresh = d.stream !== this.stream;
    this.stream = d.stream;
    // A scope epoch is its stream's: a new stream starts its own (everything from before was dropped or is asked
    // again); within one stream it only moves forward.
    if (fresh) this.scope = typeof d.scope === 'number' ? d.scope : 0;
    else if (typeof d.scope === 'number' && d.scope > this.scope) this.scope = d.scope;
    if (this.goneTimer) { clearInterval(this.goneTimer); this.goneTimer = undefined; }
    // A new stream (a reconnect, another listener) is a new snapshot: every subscription is asked again.
    if (fresh) for (const s of this.subs.values()) { s.at = null; s.held = []; s.next = null; if (s.status === 'live') s.status = 'stale'; this.ask(s); }
  }

  private ask(s: Sub, after: string | null = null): void {
    if (!this.stream) { this.publish(s); return; }
    s.inflight?.abort();
    s.inflight = new AbortController();
    s.stream = this.stream;
    (s as Sub & { after?: string | null }).after = after;
    if (!this.queue.includes(s)) this.queue.push(s);
    if (!this.flushing) { this.flushing = true; queueMicrotask(() => void this.flush()); }
  }

  /** The queued asks, up to MAX_BATCH a request: one POST for every view a window opens at once. */
  private async flush(): Promise<void> {
    this.flushing = false;
    while (this.queue.length) {
      // No stream now (a scope reset closed it): the next hello asks every view again.
      if (!this.stream) { this.queue = []; return; }
      const batch = this.queue.splice(0, MAX_BATCH);
      const stream = this.stream;
      const scope = this.scope;
      const queries = batch.map((s) => ({ id: s.id, ...s.spec, subscribe: true, stream, ...((s as Sub & { after?: string | null }).after ? { after: (s as Sub & { after?: string | null }).after } : {}) }));
      const ac = new AbortController();
      for (const s of batch) s.inflight?.signal.addEventListener('abort', () => { if (batch.every((x) => x.inflight?.signal.aborted)) ac.abort(); });
      let r: { status: number; json: unknown };
      try { r = await this.t.post({ queries }, ac.signal); } catch { for (const s of batch) if (!s.inflight?.signal.aborted) { s.status = s.keys.length ? 'stale' : 'unavailable'; this.publish(s); } continue; }
      if (this.cleared) return;
      if (r.status === 401 || r.status === 403) { this.clear(); return; }
      const answers = Array.isArray((r.json as { answers?: unknown })?.answers) ? (r.json as { answers: Array<Record<string, unknown>> }).answers : [];
      for (const s of batch) {
        if (s.inflight?.signal.aborted || this.subs.get(s.id) !== s) continue;
        // Asked on a stream that's gone, or under an older scope: its answer is no one's now; it's asked again.
        if (this.stream !== stream || this.scope !== scope) { this.ask(s); continue; }
        const a = answers.find((x) => x.id === s.id);
        this.answer(s, a);
      }
    }
  }

  private answer(s: Sub, a: Record<string, unknown> | undefined): void {
    const extending = (s as Sub & { after?: string | null }).after != null;
    if (!a || typeof a.error === 'string') {
      const e = (a?.error as string | undefined) ?? 'unavailable';
      // Refused, or not served any more: what it held isn't theirs to see (or isn't there); it goes.
      if (e === 'denied' || e === 'unsupported-version') { const k = s.keys; s.keys = []; s.next = null; s.coverage = undefined; s.aggregates = undefined; this.evict(s.type, k); }
      // Kept, marked stale: what it held is still what was last known.
      s.status = e === 'denied' ? 'denied' : e === 'unavailable' ? (s.keys.length ? 'stale' : 'unavailable') : 'error';
      s.error = e === 'unavailable' || e === 'denied' ? undefined : `${e}${typeof a?.why === 'string' ? `: ${a.why}` : ''}`;
      this.publish(s);
      return;
    }
    // From an older scope: asked again, a few times at most (the next hello asks again anyway).
    if (typeof a.scope === 'number' && a.scope < this.scope) {
      s.stale = (s.stale ?? 0) + 1;
      if (s.stale <= 3) this.ask(s); else { s.status = 'stale'; this.publish(s); }
      return;
    }
    s.stale = 0;
    const rows = Array.isArray(a.rows) ? (a.rows as Rec[]) : [];
    const before = new Set(s.keys);
    this.write(s.type, rows);
    s.keys = extending ? [...s.keys, ...rows.map((r) => r.key).filter((k) => !before.has(k))] : rows.map((r) => r.key);
    if (!extending) { const now = new Set(s.keys); this.evict(s.type, [...before].filter((k) => !now.has(k))); }
    s.coverage = a.coverage as Coverage | undefined;
    s.aggregates = a.aggregates as Aggs | undefined;
    s.withheld = Array.isArray(a.withheld) ? (a.withheld as string[]) : [];
    s.next = typeof a.next === 'string' ? a.next : null;
    s.status = 'live';
    s.error = undefined;
    const at = typeof a.at === 'number' ? a.at : 0;
    // Frames that came first: those after this answer's `at` apply on top of it.
    if (!extending) { s.at = at; const held = s.held; s.held = []; for (const f of held) if ((f.seq as number) > at) this.apply(s, f); }
    else this.sortKeys(s);
    this.publish(s);
  }

  private more(s: Sub): void {
    if (s.next) this.ask(s, s.next);
  }

  private frame(d: Record<string, unknown>): void {
    if (typeof d.scope !== 'number' || d.scope < this.scope) return;
    const s = this.subs.get(d.sub as string);
    if (!s) return;
    if (s.at === null) { s.held.push(d); return; }
    if ((d.seq as number) <= s.at) return;
    this.apply(s, d);
    this.publish(s);
  }

  private apply(s: Sub, d: Record<string, unknown>): void {
    const ups = Array.isArray(d.upserts) ? (d.upserts as Rec[]) : [];
    const leaves = Array.isArray(d.leaves) ? (d.leaves as string[]) : [];
    const deletes = Array.isArray(d.deletes) ? (d.deletes as string[]) : [];
    this.write(s.type, ups);
    const gone = new Set([...leaves, ...deletes]);
    const keys = s.keys.filter((k) => !gone.has(k));
    const have = new Set(keys);
    for (const u of ups) if (!have.has(u.key)) { keys.push(u.key); have.add(u.key); }
    s.keys = keys;
    this.sortKeys(s);
    if (d.aggregates && typeof d.aggregates === 'object') s.aggregates = d.aggregates as Aggs;
    // A delete is the record gone, everywhere; a leave only takes it out of this subscription.
    const store = this.stores.get(s.type);
    if (deletes.length && store) { for (const k of deletes) store.records.delete(k); this.hook?.remove(s.type, deletes); }
    this.evict(s.type, leaves);
    if (typeof d.seq === 'number') s.at = d.seq;
  }

  private reset(d: Record<string, unknown>): void {
    // The scope moved (the viewer's authority changed): everything from before it goes, not just this view's, whichever
    // subscription it names.
    if (d.reason === 'scope') {
      // The stream's new scope epoch, as the server says it; it closes this stream, so the views are asked again on the
      // next one's hello, never on this one.
      if (typeof d.scope === 'number' && d.scope > this.scope) this.scope = d.scope;
      this.dropAll();
      this.stream = null;
      return;
    }
    const s = this.subs.get(d.sub as string);
    if (!s) return;
    const k = s.keys;
    s.keys = []; s.at = null; s.held = []; s.next = null;
    if (d.reason === 'provider-gone' || d.reason === 'epoch' || d.reason === 'version') {
      // That domain's records are another history now: dropped wherever they are.
      const store = this.stores.get(s.type);
      if (store) { this.hook?.remove(s.type, [...store.records.keys()]); store.records.clear(); }
      for (const x of this.subs.values()) if (x !== s && x.type === s.type) { x.keys = []; x.at = null; x.held = []; x.status = 'loading'; this.publish(x); this.ask(x); }
    } else this.evict(s.type, k);
    s.status = 'loading';
    this.publish(s);
    this.ask(s);
  }

  /** Records in, merged: a field an upsert leaves out is unknown, not gone (a projection, a hidden field). */
  private write(type: string, rows: readonly Rec[]): void {
    if (!rows.length) return;
    this.touch(type);
    const store = this.stores.get(type)!;
    const merged = rows.map((r) => { const m = { ...(store.records.get(r.key) ?? {}), ...r } as Rec; store.records.set(r.key, m); return m; });
    this.hook?.upsert(type, merged);
    this.bound();
  }

  /** Records no subscription holds any more go. */
  private evict(type: string, keys: readonly string[]): void {
    if (!keys.length) return;
    const held = new Set<string>();
    for (const s of this.subs.values()) if (s.type === type) for (const k of s.keys) held.add(k);
    const store = this.stores.get(type);
    if (!store) return;
    const gone = keys.filter((k) => !held.has(k) && store.records.has(k));
    for (const k of gone) store.records.delete(k);
    if (gone.length) this.hook?.remove(type, gone);
  }

  private sortKeys(s: Sub): void {
    const order = s.spec.order ?? [];
    const recs = this.stores.get(s.type)?.records;
    if (!recs) return;
    s.keys.sort((a, b) => {
      const ra = recs.get(a), rb = recs.get(b);
      for (const [f, dir] of order) { const c = cmp(ra?.[f], rb?.[f]); if (c) return dir === 'desc' ? -c : c; }
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  private closeSub(s: Sub): void {
    if (s.listeners.size) return;
    s.inflight?.abort();
    this.subs.delete(s.id);
    this.bySpec.delete(s.specKey);
    this.evict(s.type, s.keys);
    if (this.stream) void this.t.post({ close: { stream: this.stream, ids: [s.id] } }).catch(() => {});
  }

  /** Types nobody has read for IDLE_MS go, with any lingering views of them. */
  sweep(): void {
    const now = this.now();
    for (const [type, store] of this.stores) {
      if (now - store.read < IDLE_MS) continue;
      if ([...this.subs.values()].some((s) => s.type === type && s.listeners.size)) continue;
      for (const s of [...this.subs.values()]) if (s.type === type) this.closeSub(s);
      this.stores.delete(type);
      this.hook?.drop(type);
    }
  }

  /** Past MAX_RECORDS, the least recently read types without a view open go first. */
  private bound(): void {
    if (this.size() <= MAX_RECORDS) return;
    const idle = [...this.stores].filter(([type]) => ![...this.subs.values()].some((s) => s.type === type && s.listeners.size)).sort((a, b) => a[1].read - b[1].read);
    for (const [type] of idle) {
      if (this.size() <= MAX_RECORDS) break;
      for (const s of [...this.subs.values()]) if (s.type === type) this.closeSub(s);
      this.stores.delete(type);
      this.hook?.drop(type);
    }
  }

  private markAll(status: Status): void {
    for (const s of this.subs.values()) if (s.status === 'live') { s.status = status; this.publish(s); }
  }

  private publish(s: Sub): void {
    s.state = { keys: [...s.keys], ...(s.coverage ? { coverage: s.coverage } : {}), ...(s.aggregates ? { aggregates: s.aggregates } : {}), withheld: s.withheld, status: s.status, ...(s.error ? { error: s.error } : {}), more: s.next !== null };
    for (const f of s.listeners) f();
  }
}
