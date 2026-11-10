/**
 * The shared collection runtime (web/src/collections, t-2023; docs/specs/collections.md, "The client runtime"), with a
 * fake transport standing in for /collections/query and the page's stream: requests and subscriptions are shared,
 * frames that come before their answer are held, a warm reopen asks nothing, and sign-out, a new scope, idleness and
 * the memory bound clear what they should. The adapter mirrors the runtime's stores into the pinned client library.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CollectionRuntime, LINGER_MS, IDLE_MS, MAX_RECORDS, type Transport } from '@/collections/runtime';
import { LibraryStores } from '@/collections/adapter';

type Handler = (d: Record<string, unknown>) => void;

function fake(answer: (q: Record<string, unknown>) => Record<string, unknown>) {
  const on = new Map<string, Set<Handler>>();
  const posts: Array<Record<string, unknown>> = [];
  let status = 200;
  const t: Transport = {
    post: async (body) => {
      posts.push(body);
      await Promise.resolve();
      const qs = (body.queries as Array<Record<string, unknown>> | undefined) ?? [];
      return { status, json: { answers: qs.map((q) => ({ id: q.id, ...answer(q) })) } };
    },
    on: (event, f) => { if (!on.has(event)) on.set(event, new Set()); on.get(event)!.add(f); return () => on.get(event)!.delete(f); },
  };
  const emit = (event: string, d: Record<string, unknown>) => { for (const f of on.get(event) ?? []) f(d); };
  return { t, posts, emit, setStatus: (s: number) => { status = s; } };
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const row = (k: string, f: Record<string, unknown> = {}) => ({ key: `tasks/task/${k}`, title: k, ...f });
const answerOf = (rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({ rows, next: null, coverage: { complete: true, total: { n: rows.length, exact: true } }, withheld: [], at: 0, scope: 1, ...extra });

describe('the shared collection runtime', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('two windows asking the same thing share one request and one subscription; different asks go in one batch', async () => {
    const f = fake(() => answerOf([row('t-1'), row('t-2')]));
    const rt = new CollectionRuntime(f.t);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0 });
    const a = rt.view({ type: 'tasks/task@^1' }, () => {});
    const b = rt.view({ type: 'tasks/task@^1' }, () => {});
    const c = rt.view({ type: 'tasks/task@^1', where: [['status', 'eq', 'open']] }, () => {});
    await settle();
    expect(f.posts).toHaveLength(1);
    expect((f.posts[0].queries as unknown[]).length).toBe(2);
    expect(a.state().keys).toEqual(['tasks/task/t-1', 'tasks/task/t-2']);
    expect(b.state()).toBe(a.state());
    expect(rt.subscriptions()).toBe(2);
    // Each record once, however many views hold it.
    expect(rt.size()).toBe(2);
    c.close();
  });

  it('waits for the stream\'s hello before asking, and asks on it', async () => {
    const f = fake(() => answerOf([row('t-1')]));
    const rt = new CollectionRuntime(f.t);
    const v = rt.view({ type: 'tasks/task@^1' }, () => {});
    await settle();
    expect(f.posts).toHaveLength(0);
    expect(v.state().status).toBe('loading');
    f.emit('hello', { stream: 'e-9', scope: 1, seq: 0 });
    await settle();
    expect(f.posts[0].queries).toEqual([expect.objectContaining({ subscribe: true, stream: 'e-9' })]);
    expect(v.state().status).toBe('live');
  });

  it('holds a frame that came before its answer, applies those after the answer\'s at, and ignores the rest', async () => {
    let id = '';
    const f = fake((q) => { id = q.id as string; return answerOf([row('t-1')], { at: 5 }); });
    const rt = new CollectionRuntime(f.t);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0 });
    const v = rt.view({ type: 'tasks/task@^1' }, () => {});
    await Promise.resolve();
    // The post is out; frames race it. id is known once the fake has seen the query, so send after a tick.
    await Promise.resolve();
    f.emit('rows', { seq: 4, sub: id, scope: 1, upserts: [row('t-old')] });
    f.emit('rows', { seq: 6, sub: id, scope: 1, upserts: [row('t-2')] });
    await settle();
    expect(v.state().keys).toEqual(['tasks/task/t-1', 'tasks/task/t-2']);
    f.emit('rows', { seq: 6, sub: id, scope: 1, upserts: [row('t-3')] });
    expect(v.state().keys).toEqual(['tasks/task/t-1', 'tasks/task/t-2']);
    f.emit('rows', { seq: 7, sub: id, scope: 1, leaves: ['tasks/task/t-1'], aggregates: { count: { n: 1, exact: true } } });
    expect(v.state().keys).toEqual(['tasks/task/t-2']);
    expect(v.state().aggregates).toEqual({ count: { n: 1, exact: true } });
    // t-1 is no subscription's now: gone from the store.
    expect(rt.records('tasks/task@^1').has('tasks/task/t-1')).toBe(false);
  });

  it('a record another view still holds stays when it leaves one; a delete goes everywhere', async () => {
    const ids: string[] = [];
    const f = fake((q) => { ids.push(q.id as string); return answerOf([row('t-1'), row('t-2')]); });
    const rt = new CollectionRuntime(f.t);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0 });
    const open = rt.view({ type: 'tasks/task@^1', where: [['status', 'eq', 'open']] }, () => {});
    const all = rt.view({ type: 'tasks/task@^1' }, () => {});
    await settle();
    f.emit('rows', { seq: 1, sub: ids[0], scope: 1, leaves: ['tasks/task/t-1'] });
    expect(open.state().keys).toEqual(['tasks/task/t-2']);
    expect(all.state().keys).toEqual(['tasks/task/t-1', 'tasks/task/t-2']);
    expect(rt.records('tasks/task@^1').has('tasks/task/t-1')).toBe(true);
    f.emit('rows', { seq: 2, sub: ids[1], scope: 1, deletes: ['tasks/task/t-2'] });
    expect(rt.records('tasks/task@^1').has('tasks/task/t-2')).toBe(false);
  });

  it('a window reopened soon after is warm (no request); one left closed is let go, and its records with it', async () => {
    const f = fake(() => answerOf([row('t-1')]));
    const rt = new CollectionRuntime(f.t);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0 });
    const v = rt.view({ type: 'tasks/task@^1' }, () => {});
    await settle();
    v.close();
    vi.advanceTimersByTime(LINGER_MS / 2);
    const again = rt.view({ type: 'tasks/task@^1' }, () => {});
    expect(again.state().keys).toEqual(['tasks/task/t-1']);
    await settle();
    expect(f.posts).toHaveLength(1);
    again.close();
    vi.advanceTimersByTime(LINGER_MS + 1);
    await settle();
    expect(f.posts.at(-1)).toEqual({ close: { stream: 'e-1', ids: [expect.any(String)] } });
    expect(rt.subscriptions()).toBe(0);
    expect(rt.size()).toBe(0);
  });

  it('sign-out (or a 401) clears every record and view, and nothing more is asked', async () => {
    const f = fake(() => answerOf([row('t-1')]));
    const stores = new LibraryStores();
    const rt = new CollectionRuntime(f.t, stores);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0 });
    let heard = 0;
    const v = rt.view({ type: 'tasks/task@^1' }, () => { heard++; });
    await settle();
    expect(stores.held('tasks/task@^1')).toBe(1);
    rt.clear();
    expect(rt.size()).toBe(0);
    expect(stores.held('tasks/task@^1')).toBe(0);
    expect(v.state()).toMatchObject({ keys: [], status: 'denied' });
    expect(heard).toBeGreaterThan(1);
    expect(() => rt.view({ type: 'tasks/task@^1' }, () => {})).toThrow();

    const g = fake(() => answerOf([row('t-1')]));
    const rt2 = new CollectionRuntime(g.t);
    g.emit('hello', { stream: 'e-2', scope: 1, seq: 0 });
    g.setStatus(401);
    const w = rt2.view({ type: 'tasks/task@^1' }, () => {});
    await settle();
    expect(w.state().status).toBe('denied');
    expect(rt2.size()).toBe(0);
  });

  it('a new scope drops everything from before it, and every view is asked again; an answer from an older scope is dropped', async () => {
    const ids: string[] = [];
    let scope = 1;
    const f = fake((q) => { ids.push(q.id as string); return answerOf([row('t-1')], { scope }); });
    const rt = new CollectionRuntime(f.t);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0 });
    const a = rt.view({ type: 'tasks/task@^1' }, () => {});
    const b = rt.view({ type: 'notes/note@^1' }, () => {});
    await settle();
    expect(f.posts).toHaveLength(1);
    f.emit('reset', { seq: 1, sub: ids[0], reason: 'scope', scope: 2 });
    expect(a.state().keys).toEqual([]);
    expect(b.state().keys).toEqual([]);
    expect(rt.size()).toBe(0);
    // An answer still from scope 1 is dropped, and asked again; scope 2's is shown.
    await settle();
    expect(a.state().keys).toEqual([]);
    scope = 2;
    // The server closes that stream: the views are asked again on the next one's hello.
    f.emit('hello', { stream: 'e-2', scope: 2, seq: 0 });
    await vi.waitFor(async () => { await settle(); expect(a.state().keys).toEqual(['tasks/task/t-1']); });
  });

  it('a reconnect (a new stream) asks every view again; a provider\'s epoch reset drops its records everywhere', async () => {
    const ids: string[] = [];
    const f = fake((q) => { ids.push(q.id as string); return answerOf([row('t-1')]); });
    const rt = new CollectionRuntime(f.t);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0 });
    const a = rt.view({ type: 'tasks/task@^1' }, () => {});
    const b = rt.view({ type: 'tasks/task@^1', where: [['status', 'eq', 'open']] }, () => {});
    await settle();
    f.emit('hello', { stream: 'e-2', scope: 1, seq: 0 });
    await settle();
    expect(f.posts.at(-1)!.queries).toEqual([expect.objectContaining({ stream: 'e-2' }), expect.objectContaining({ stream: 'e-2' })]);
    const posts = f.posts.length;
    f.emit('reset', { seq: 3, sub: ids[0], reason: 'epoch' });
    expect(a.state().keys).toEqual([]);
    expect(b.state().keys).toEqual([]);
    await settle();
    expect(f.posts.length).toBe(posts + 1);
    expect(a.state().keys).toEqual(['tasks/task/t-1']);
  });

  it('a type nobody has read for five minutes goes, and past the memory bound the least recently read go first', async () => {
    const f = fake((q) => answerOf(q.type === 'big/thing@^1' ? Array.from({ length: MAX_RECORDS }, (_, i) => ({ key: `big/thing/x${i}` })) : [row('t-1')]));
    const rt = new CollectionRuntime(f.t);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0 });
    const old = rt.view({ type: 'tasks/task@^1' }, () => {});
    await settle();
    old.close();
    vi.advanceTimersByTime(LINGER_MS + 1);
    const again = rt.view({ type: 'tasks/task@^1' }, () => {});
    await settle();
    again.close();
    vi.advanceTimersByTime(IDLE_MS + 1);
    rt.sweep();
    expect(rt.records('tasks/task@^1').size).toBe(0);
    const t = rt.view({ type: 'tasks/task@^1' }, () => {});
    await settle();
    t.close();
    vi.advanceTimersByTime(10);
    // A big type while tasks lingers, unread: over the bound, tasks (read least recently, no view open) goes first.
    const big = rt.view({ type: 'big/thing@^1' }, () => {});
    await settle();
    expect(rt.size()).toBeLessThanOrEqual(MAX_RECORDS);
    expect(big.state().keys).toHaveLength(MAX_RECORDS);
  });

  it('a provider that\'s unavailable keeps what was shown, marked stale; a page with more loads on the same subscription', async () => {
    let n = 0;
    const f = fake(() => (++n === 1 ? answerOf([row('t-1')], { next: 'c1', coverage: { complete: false } }) : n === 2 ? answerOf([row('t-2')]) : { error: 'unavailable' }));
    const rt = new CollectionRuntime(f.t);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0 });
    const v = rt.view({ type: 'tasks/task@^1', limit: 1 }, () => {});
    await settle();
    expect(v.state()).toMatchObject({ keys: ['tasks/task/t-1'], more: true });
    v.more();
    await settle();
    expect(f.posts.at(-1)!.queries).toEqual([expect.objectContaining({ after: 'c1' })]);
    expect(v.state()).toMatchObject({ keys: ['tasks/task/t-1', 'tasks/task/t-2'], more: false });
    f.emit('hello', { stream: 'e-2', scope: 1, seq: 0 });
    await settle();
    expect(v.state()).toMatchObject({ keys: ['tasks/task/t-1', 'tasks/task/t-2'], status: 'stale' });
  });
});

describe('the adapter: the runtime\'s stores in the pinned client library', () => {
  it('mirrors each type into one collection, upserts and removes included', async () => {
    const stores = new LibraryStores();
    const coll = stores.collection('tasks/task@^1');
    await coll.preload();
    stores.upsert('tasks/task@^1', [{ key: 'tasks/task/t-1', title: 'a' }, { key: 'tasks/task/t-2', title: 'b' }]);
    expect(coll.size).toBe(2);
    stores.upsert('tasks/task@^1', [{ key: 'tasks/task/t-1', title: 'a2' }]);
    expect(coll.get('tasks/task/t-1')).toMatchObject({ title: 'a2' });
    stores.remove('tasks/task@^1', ['tasks/task/t-2']);
    expect(coll.size).toBe(1);
    stores.drop('tasks/task@^1');
    expect(stores.held('tasks/task@^1')).toBe(0);
  });
});

describe('commands: one operation, its receipt, and an honest preview', () => {
  const setup = async () => {
    const f = fake(() => answerOf([row('t-1', { status: 'open' })]));
    const rt = new CollectionRuntime(f.t);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0 });
    const v = rt.view({ type: 'tasks/task@^1' }, () => {});
    await settle();
    return { rt, v };
  };
  const now = () => Promise.resolve();

  it('a dropped connection is retried under the same operation id; accepted is asked again until it settles', async () => {
    const { rt } = await setup();
    const ops: string[] = [];
    let n = 0;
    const r = await rt.command(async (op) => {
      ops.push(op);
      n++;
      if (n === 1) throw new Error('network');
      if (n === 2) return { status: 202, json: { receipt: { op, state: 'accepted' } } };
      return { status: 200, json: { ok: true, receipt: { op, state: 'done' } } };
    }, {}, now);
    expect(r.state).toBe('done');
    expect(new Set(ops).size).toBe(1);
    expect(ops[0]).toMatch(/^op-[A-Za-z0-9_-]{18}$/);
    expect(rt.pending()).toBe(0);
  });

  it('an optimistic preview shows at once and is taken back on failure, unless the record moved since', async () => {
    const { rt, v } = await setup();
    const p = rt.command(async (op) => ({ status: 200, json: { ok: false, message: 'No.', receipt: { op, state: 'failed', why: 'No.' } } }),
      { kind: 'other', optimistic: { type: 'tasks/task@^1', rec: { key: 'tasks/task/t-1', status: 'closed' } } }, now);
    expect(rt.records('tasks/task@^1').get('tasks/task/t-1')).toMatchObject({ status: 'closed' });
    expect(await p).toMatchObject({ state: 'failed', why: 'No.' });
    expect(rt.records('tasks/task@^1').get('tasks/task/t-1')).toMatchObject({ status: 'open' });
    expect(v.state().keys).toEqual(['tasks/task/t-1']);
  });

  it('a grant or an approval is never shown done before its receipt', async () => {
    const { rt } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = rt.command(async (op) => { await gate; return { status: 200, json: { ok: true, receipt: { op, state: 'done' } } }; },
      { kind: 'approval', optimistic: { type: 'tasks/task@^1', rec: { key: 'tasks/task/t-1', status: 'allowed' } } }, now);
    expect(rt.records('tasks/task@^1').get('tasks/task/t-1')).toMatchObject({ status: 'open' });
    expect(rt.pending()).toBe(1);
    release();
    expect((await p).state).toBe('done');
  });

  it('without kind: other, there\'s no preview; after a dropped try, an answer with no receipt is unknown, not failed', async () => {
    const { rt } = await setup();
    const p = rt.command(async (op) => ({ status: 200, json: { ok: true, receipt: { op, state: 'done' } } }), { optimistic: { type: 'tasks/task@^1', rec: { key: 'tasks/task/t-1', status: 'closed' } } }, now);
    expect(rt.records('tasks/task@^1').get('tasks/task/t-1')).toMatchObject({ status: 'open' });
    await p;
    let n = 0;
    const r = await rt.command(async () => { if (++n === 1) throw new Error('dropped'); return { status: 500, json: null }; }, {}, now);
    expect(r.state).toBe('unknown');
  });

  it('one never heard the end of is unknown, never sent again past its retries', async () => {
    const { rt } = await setup();
    let sent = 0;
    const r = await rt.command(async () => { sent++; throw new Error('gone'); }, {}, now);
    expect(r.state).toBe('unknown');
    expect(sent).toBe(4);
  });
});

describe('whose records: another viewer, revocation, a closed stream', () => {
  it('a hello with no viewer tag after one with a tag counts as someone else', async () => {
    const f = fake(() => answerOf([row('t-1')]));
    const rt = new CollectionRuntime(f.t);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0, viewer: 'va' });
    rt.view({ type: 'tasks/task@^1' }, () => {});
    await settle();
    f.emit('hello', { stream: 'e-2', scope: 1, seq: 0 });
    expect(rt.size()).toBe(0);
  });

  it('a hello for another viewer drops everything the last one held before anything is asked', async () => {
    const f = fake(() => answerOf([row('t-1', { secret: 'a' })]));
    const rt = new CollectionRuntime(f.t);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0, viewer: 'va' });
    const v = rt.view({ type: 'tasks/task@^1' }, () => {});
    await settle();
    expect(rt.size()).toBe(1);
    f.emit('hello', { stream: 'e-2', scope: 1, seq: 0, viewer: 'vb' });
    expect(rt.size()).toBe(0);
    expect(v.state().keys).toEqual([]);
  });

  it('a stream that gave up for good (revoked) clears every record; a passing error only marks them stale', async () => {
    const f = fake(() => answerOf([row('t-1')]));
    const rt = new CollectionRuntime(f.t);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0 });
    const v = rt.view({ type: 'tasks/task@^1' }, () => {});
    await settle();
    f.emit('error', { closed: false });
    expect(v.state()).toMatchObject({ status: 'stale', keys: ['tasks/task/t-1'] });
    // Gave up for good, but the session is still there (a proxy's outage): kept, stale.
    f.emit('error', { closed: true });
    await settle();
    expect(rt.size()).toBe(1);
    // Gave up because the session is gone: cleared.
    f.setStatus(401);
    f.emit('error', { closed: true });
    await settle();
    expect(rt.size()).toBe(0);
    expect(v.state().status).toBe('denied');
  });

  it('a scope reset drops everything and waits for the next stream\'s hello to ask again', async () => {
    const ids: string[] = [];
    const f = fake((q) => { ids.push(q.id as string); return answerOf([row('t-1')], { scope: 2 }); });
    const rt = new CollectionRuntime(f.t);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0 });
    const v = rt.view({ type: 'tasks/task@^1' }, () => {});
    await settle();
    const posts = f.posts.length;
    f.emit('reset', { seq: 2, sub: ids[0], reason: 'scope', scope: 2 });
    await settle();
    expect(f.posts.length).toBe(posts);
    expect(rt.size()).toBe(0);
    f.emit('hello', { stream: 'e-2', scope: 2, seq: 0 });
    await settle();
    expect(v.state().keys).toEqual(['tasks/task/t-1']);
  });

  it('a command\'s undo never puts a record back after sign-out', async () => {
    const f = fake(() => answerOf([row('t-1', { status: 'open' })]));
    const stores = new LibraryStores();
    const rt = new CollectionRuntime(f.t, stores);
    f.emit('hello', { stream: 'e-1', scope: 1, seq: 0 });
    rt.view({ type: 'tasks/task@^1' }, () => {});
    await settle();
    await rt.command(async () => ({ status: 401, json: null }), { kind: 'other', optimistic: { type: 'tasks/task@^1', rec: { key: 'tasks/task/t-1', status: 'closed' } } }, () => Promise.resolve());
    expect(rt.size()).toBe(0);
    expect(stores.held('tasks/task@^1')).toBe(0);
  });
});
