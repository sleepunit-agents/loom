/**
 * Live collections (docs/specs/collections.md, "Changes: from provider to window"; "What the tests must pin": pull,
 * handover, windows and membership, transactions, gaps and epochs, expiry, revocation), through the real HTTP server
 * and a stub provider with a commit log ($LOOM_HOME/plog.json) and a `changes` verb, as a real one keeps:
 *
 *  - a window's stream says hello; a subscribed query's answer says the stream seq (`at`) its frames follow;
 *  - a change the provider commits reaches the subscriptions it concerns as one frame per transaction, and nothing
 *    in a frame is a provider revision, an epoch or a transaction id;
 *  - a record that leaves a filter, or whose audience drops a viewer, is a leave for the subscriptions that held it,
 *    and nobody else learns its key; a delete goes only where it was delivered;
 *  - a store restored behind core's cursor, the log pruned past a subscription, a viewer's agents narrowed, a session
 *    revoked: reset or closed, never a partial or stale history.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, revokeToken, type Household } from '../household.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
import { clearPieceCache } from '../ui/pieces.js';
import { clearOutOfContract, providers } from './serve.js';
import { pullDomain } from './pull.js';
import { deliverNow, pullNow } from './subs.js';
import { withLog, seedIndex, setCursor } from './log.js';

// A provider with a commit log: plog.json is [{rev, txn, op, id, record?, audience?}], records.json its current state.
const PROVIDER_BIN = `#!${process.execPath}
const fs = require('node:fs');
const home = process.env.LOOM_HOME;
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(home + '/' + f, 'utf-8')); } catch { return d; } };
// Its page and its one action, close: committed to its log like any write, then answered.
if (process.argv[2] === 'ui' && process.argv[3] === '--json') { console.log(JSON.stringify({ v: 2, owners: 2, tab: { label: 'Tasks', kind: 'place' } })); process.exit(0); }
if (process.argv[2] === 'ui' && process.argv[3] === 'act') {
  const req = JSON.parse(fs.readFileSync(0, 'utf-8'));
  fs.appendFileSync(home + '/acted', req.action + ' ' + (req.fields.id || '') + '\\n');
  const all = read('records.json', []);
  const r = all.find((x) => x.id === req.fields.id);
  if (req.action !== 'close' || !r) { console.log(JSON.stringify({ ok: false, message: 'No such task.' })); process.exit(0); }
  const log = read('plog.json', []);
  const rev = (log.length ? log[log.length - 1].rev : 0) + 1;
  const { id, audience, ...rest } = r;
  const record = { ...rest, status: 'closed' };
  log.push({ rev, txn: 'act' + String(rev).padStart(6, '0'), op: 'upsert', id, record, audience });
  fs.writeFileSync(home + '/plog.json', JSON.stringify(log));
  fs.writeFileSync(home + '/records.json', JSON.stringify(all.map((x) => x.id === id ? { id, ...record, audience } : x)));
  console.log(JSON.stringify({ ok: true, message: 'Closed.' }));
  process.exit(0);
}
if (process.argv[2] === 'ui') { console.log(JSON.stringify({ title: 'Tasks', sections: [] })); process.exit(0); }
let s = ''; process.stdin.on('data', (d) => s += d).on('end', async () => {
  const ask = JSON.parse(s);
  const log = read('plog.json', []);
  const head = log.length ? log[log.length - 1] : { rev: 0, txn: 'genesis000' };
  if (process.argv[2] === 'changes') {
    const c = ask['tasks/task'];
    if (read('hold-change.json', false)) { fs.writeFileSync(home + '/change-started', 'yes'); await new Promise((r) => setTimeout(r, 200)); }
    if (c.rev === null) return console.log(JSON.stringify({ 'tasks/task': { head: head.rev, txn: head.txn, changes: [] } }));
    // The proof: this log holds that transaction at that revision (rev 0 is the empty log's start).
    const at = c.rev === 0 ? { txn: 'genesis000' } : log.find((e) => e.rev === c.rev);
    if (!at || at.txn !== c.txn || head.rev < c.rev) return console.log(JSON.stringify({ 'tasks/task': { reset: true } }));
    const changes = log.filter((e) => e.rev > c.rev).map((e) => ({ op: e.op, id: e.id, rev: e.rev, txn: e.txn, ...(e.op === 'upsert' ? { audience: e.audience, record: e.record } : {}), ...(e.expires ? { expires: e.expires } : {}) }));
    const limit = read('change-page.json', ask.limit || 1000);
    return console.log(JSON.stringify({ 'tasks/task': { head: head.rev, txn: head.txn, changes: changes.slice(0, limit), more: changes.length > limit } }));
  }
  const all = read('records.json', []);
  if (read('hold-snapshot.json', false)) { fs.writeFileSync(home + '/snapshot-started', 'yes'); await new Promise((r) => setTimeout(r, 200)); }
  const v = ask.viewer;
  const mine = (r) => {
    const a = r.audience;
    if (r.expires && r.expires <= Date.parse(ask.now)) return false;
    if (v.kind === 'core') return true;
    if (v.kind === 'member') {
      const named = (a.members || []).includes(v.who);
      if (v.agents === '*') return named || !!(a.household || a.owners || a.ownersOf || a.agents);
      if (!r.agent) return named;
      if (!v.agents.includes(r.agent)) return false;
      return named || !!a.household || (a.ownersOf || []).some((x) => v.agents.includes(x));
    }
    return (a.agents || []).includes(v.agent);
  };
  const answers = ask.queries.map((q) => {
    let rs = all.filter(mine).filter((r) => q.where.every(([f, op, val]) => op === 'eq' ? r[f] === val : op === 'in' ? val.includes(r[f]) : true));
    rs.sort((a, b) => a.id < b.id ? -1 : 1);
    if (q.after) rs = rs.filter((r) => r.id > q.after[q.after.length - 1]);
    return { id: q.id, more: rs.length > q.limit, rows: rs.slice(0, q.limit).map((r) => { const o = { id: r.id, audience: r.audience }; if (r.expires) o.expires = r.expires; for (const f of q.fields) if (f in r) o[f] = r[f]; return o; }) };
  });
  // JSON lines: what it read at (the head of its log, in the same read as the rows), each row, whether there's more.
  const out = [JSON.stringify({ at: { 'tasks/task': { rev: head.rev, txn: head.txn } } })];
  for (const a of answers) { for (const r of a.rows) out.push(JSON.stringify({ id: a.id, row: r })); out.push(JSON.stringify({ id: a.id, more: a.more })); }
  process.stdout.write(out.join('\\n') + '\\n');
});
`;

const TASK = {
  version: '1.0', schema: { type: 'object' }, agent: 'agent',
  fields: { agent: { class: 'member', filter: ['eq', 'in'] }, title: { class: 'member' }, status: { class: 'member', filter: ['eq', 'in'] } },
  default_fields: ['title', 'status', 'agent'], max_page: 50, aggregates: { count: {} },
};

function piece(home: string, name: string, raw: Record<string, unknown>, body: string): void {
  const loom = parseLoomBlock(raw, name, [`loom-${name}`]);
  if (typeof loom === 'string') throw new Error(`${name}: ${loom}`);
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'sleepunit-agents/taskstore', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
    bins: [`loom-${name}`], loom: { settings: [], services: [], ...loom } }));
  const bin = join(dir, 'current', 'cli');
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  rmSync(join(home, 'pieces', 'bin', `loom-${name}`), { force: true });
  symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
}

interface Frame { event: string; data: Record<string, unknown> }

/** A window's stream: its frames as they come, and whether it's still open. */
async function openEvents(base: string, token: string): Promise<{ frames: Frame[]; closed: () => boolean; stop: () => void; hello: Record<string, unknown> }> {
  const ac = new AbortController();
  const r = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ac.signal });
  if (r.status !== 200) throw new Error(`events: ${r.status}`);
  const frames: Frame[] = [];
  let closed = false;
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data) frames.push({ event: ev, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
    closed = true;
  })();
  for (let t = 0; t < 100 && !frames.some((f) => f.event === 'hello'); t++) await new Promise((r) => setTimeout(r, 20));
  return { frames, closed: () => closed, stop: () => ac.abort(), hello: frames.find((f) => f.event === 'hello')!.data };
}

const until = async (f: () => boolean, ms = 4000) => { for (let t = 0; t < ms / 25 && !f(); t++) await new Promise((r) => setTimeout(r, 25)); return f(); };

describe('live collections: ordered changes, and recovering after gaps', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;
  let rev = 0;
  const streams: Array<{ stop: () => void }> = [];

  const records = (): Array<Record<string, unknown>> => JSON.parse(readFileSync(join(h.home, 'records.json'), 'utf-8'));
  /** The provider commits one transaction: its changes get the next revisions, one txn id, and the current state moves. */
  const commit = (changes: Array<{ op: 'upsert' | 'delete'; id: string; record?: Record<string, unknown>; audience?: Record<string, unknown>; expires?: number }>) => {
    const log = JSON.parse(readFileSync(join(h.home, 'plog.json'), 'utf-8')) as Array<Record<string, unknown>>;
    const txn = `t${Math.random().toString(16).slice(2, 14)}`;
    let rs = records();
    for (const c of changes) {
      rev++;
      log.push({ rev, txn, ...c });
      rs = rs.filter((r) => r.id !== c.id);
      if (c.op === 'upsert') rs.push({ id: c.id, ...c.record, audience: c.audience, ...(c.expires ? { expires: c.expires } : {}) });
    }
    writeFileSync(join(h.home, 'plog.json'), JSON.stringify(log));
    writeFileSync(join(h.home, 'records.json'), JSON.stringify(rs));
  };
  const ask = async (token: string, queries: unknown[]) => {
    const r = await fetch(`${base}/collections/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ queries }) });
    return (await r.json()) as { answers: Array<Record<string, unknown>> };
  };
  const live = async (token: string, q: Record<string, unknown> = {}) => {
    const ev = await openEvents(base, token);
    streams.push(ev);
    const { answers } = await ask(token, [{ id: 'q', type: 'tasks/task@^1', subscribe: true, stream: ev.hello.stream, ...q }]);
    return { ev, answer: answers[0] };
  };
  const rowsFrames = (ev: { frames: Frame[] }) => ev.frames.filter((f) => f.event === 'rows');
  const sync = async () => { await pullNow(h.home, 'tasks/task'); await deliverNow(h.home); };

  beforeAll(async () => {
    h = loadHousehold((() => {
      const home = mkdtempSync(join(tmpdir(), 'loom-sync-'));
      for (const a of ['art', 'pond-bot']) { mkdirSync(join(home, 'agents', a), { recursive: true }); writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`); }
      writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'pond-bot'], default: 'art', members: [
        { person: 'jonathan', role: 'owner', agents: '*' }, { person: 'loren', role: 'owner', agents: ['pond-bot'] },
      ] }));
      return home;
    })())!;
    process.env.LOOM_HOME = h.home;
    piece(h.home, 'taskstore', { role: 'tasks', collections: { owners: 2, query: ['loom-taskstore', 'query'], changes: ['loom-taskstore', 'changes'], types: { task: TASK } } }, PROVIDER_BIN);
    // Found as a piece of the page too (its manifest and its action), as an installed one is.
    process.env.PATH = `${join(h.home, 'pieces', 'bin')}:${process.env.PATH}`;
    tok.jonathan = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    tok.loren = createToken(h, { role: { kind: 'owner', member: 'loren' }, label: 'loren' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    for (const s of streams) s.stop();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });
  beforeEach(() => {
    for (const s of streams.splice(0)) s.stop();
    rev = 0;
    rmSync(join(h.home, 'change-page.json'), { force: true });
    rmSync(join(h.home, 'hold-change.json'), { force: true });
    rmSync(join(h.home, 'change-started'), { force: true });
    rmSync(join(h.home, 'hold-snapshot.json'), { force: true });
    rmSync(join(h.home, 'snapshot-started'), { force: true });
    writeFileSync(join(h.home, 'plog.json'), '[]');
    writeFileSync(join(h.home, 'records.json'), '[]');
    rmSync(join(h.home, 'collections', 'live.db'), { force: true });
    rmSync(join(h.home, 'collections', 'live.db-wal'), { force: true });
    rmSync(join(h.home, 'collections', 'live.db-shm'), { force: true });
    commit([
      { op: 'upsert', id: 't-1', record: { agent: 'art', title: 'art one', status: 'open' }, audience: { ownersOf: ['art'] } },
      { op: 'upsert', id: 't-2', record: { agent: 'pond-bot', title: 'pond two', status: 'open' }, audience: { ownersOf: ['pond-bot'] } },
    ]);
    clearPieceCache();
    clearOutOfContract();
  });

  it('a stream says hello; a subscribed answer says the seq its frames follow; a commit arrives as one frame with nothing of the provider\'s history in it', async () => {
    const { ev, answer } = await live(tok.jonathan, { where: [['status', 'eq', 'open']], aggregates: ['count'] });
    expect(ev.hello).toMatchObject({ stream: expect.stringMatching(/^e-/), scope: 1, seq: 0 });
    expect(answer).toMatchObject({ at: 0, scope: 1, coverage: { complete: true, total: { n: 2, exact: true } }, aggregates: { count: { n: 2, exact: true } } });
    // One transaction, two changes: one frame, with the count it moves.
    commit([
      { op: 'upsert', id: 't-3', record: { agent: 'art', title: 'art three', status: 'open' }, audience: { ownersOf: ['art'] } },
      { op: 'upsert', id: 't-1', record: { agent: 'art', title: 'art one, renamed', status: 'open' }, audience: { ownersOf: ['art'] } },
    ]);
    await sync();
    await until(() => rowsFrames(ev).length >= 1);
    const f = rowsFrames(ev);
    expect(f).toHaveLength(1);
    expect(f[0].data).toEqual({ seq: 1, sub: 'q', scope: 1, upserts: [
      { key: 'tasks/task/t-3', title: 'art three', status: 'open', agent: 'art' },
      { key: 'tasks/task/t-1', title: 'art one, renamed', status: 'open', agent: 'art' },
    ], aggregates: { count: { n: 3, exact: true } } });
    const text = JSON.stringify(ev.frames);
    for (const word of ['rev', 'txn', 'epoch']) expect(text).not.toContain(`"${word}"`);
  });

  it.each([1001, 35])('a %i-row transaction advances through pages and commits whole, even beyond the round budget', async (n) => {
    const { ev } = await live(tok.jonathan);
    if (n === 35) writeFileSync(join(h.home, 'change-page.json'), '2');
    commit(Array.from({ length: n }, (_, i) => ({ op: 'upsert' as const, id: 't-1', record: { agent: 'art', title: `step ${i}`, status: 'open' }, audience: { ownersOf: ['art'] } })));
    await sync();
    const state = withLog(h.home, (db) => ({
      domain: db.prepare("SELECT rev FROM domains WHERE domain = 'tasks/task'").get() as { rev: number },
      row: db.prepare("SELECT record FROM idx WHERE key = 'tasks/task/t-1'").get() as { record: string },
      txns: db.prepare("SELECT COUNT(DISTINCT txn) AS n FROM log WHERE domain = 'tasks/task'").get() as { n: number },
    }));
    expect(state.domain.rev).toBe(n + 2);
    expect(JSON.parse(state.row.record).title).toBe(`step ${n - 1}`);
    expect(state.txns.n).toBe(1);
    commit([{ op: 'upsert', id: 't-2', record: { agent: 'pond-bot', title: 'later transaction', status: 'open' }, audience: { ownersOf: ['pond-bot'] } }]);
    await sync();
    expect(await until(() => JSON.stringify(rowsFrames(ev)).includes('later transaction'))).toBe(true);
    expect(withLog(h.home, (db) => (db.prepare("SELECT rev FROM domains WHERE domain = 'tasks/task'").get() as { rev: number }).rev)).toBe(n + 3);
  });

  it('a suspended initial snapshot cannot seed rows deleted by a successor', async () => {
    writeFileSync(join(h.home, 'hold-snapshot.json'), 'true');
    const pull = () => pullDomain({ env: process.env, household: h }, providers(process.env).get('tasks')!, 'tasks/task');
    const pulling = pull();
    expect(await until(() => { try { return readFileSync(join(h.home, 'snapshot-started'), 'utf-8') === 'yes'; } catch { return false; } })).toBe(true);
    commit([{ op: 'delete', id: 't-1' }]);
    const last = JSON.parse(readFileSync(join(h.home, 'plog.json'), 'utf-8')).at(-1);
    withLog(h.home, (db) => {
      const { epoch } = db.prepare("SELECT epoch FROM domains WHERE domain = 'tasks/task'").get() as { epoch: string };
      db.transaction(() => {
        seedIndex(db, 'tasks/task', epoch, [{ key: 'tasks/task/t-2', audience: { ownersOf: ['pond-bot'] }, agent: 'pond-bot', record: { agent: 'pond-bot', title: 'pond two', status: 'open' } }]);
        setCursor(db, 'tasks/task', epoch, last.rev, last.txn);
      }).immediate();
      db.prepare("UPDATE domains SET lease = 'successor', lease_until = 0 WHERE domain = 'tasks/task'").run();
    });
    await pulling;
    expect(withLog(h.home, (db) => db.prepare("SELECT key FROM idx WHERE key = 'tasks/task/t-1'").get())).toBeUndefined();
    expect(withLog(h.home, (db) => db.prepare("SELECT key FROM idx WHERE key = 'tasks/task/t-2'").get())).toBeDefined();
    expect(withLog(h.home, (db) => (db.prepare("SELECT rev FROM domains WHERE domain = 'tasks/task'").get() as { rev: number }).rev)).toBe(3);
  });

  it('losing a first snapshot leaves initialization retryable, including unchanged expiring records', async () => {
    const expires = Date.now() + 60_000;
    writeFileSync(join(h.home, 'records.json'), JSON.stringify(records().map((r) => r.id === 't-2' ? { ...r, expires } : r)));
    writeFileSync(join(h.home, 'hold-snapshot.json'), 'true');
    const pull = () => pullDomain({ env: process.env, household: h }, providers(process.env).get('tasks')!, 'tasks/task');
    const pulling = pull();
    expect(await until(() => { try { return readFileSync(join(h.home, 'snapshot-started'), 'utf-8') === 'yes'; } catch { return false; } })).toBe(true);
    withLog(h.home, (db) => db.prepare("UPDATE domains SET lease = 'other-listener', lease_until = ? WHERE domain = 'tasks/task'").run(Date.now() + 30_000));
    await pulling;
    expect(withLog(h.home, (db) => (db.prepare("SELECT rev FROM domains WHERE domain = 'tasks/task'").get() as { rev: number | null }).rev)).toBeNull();
    rmSync(join(h.home, 'hold-snapshot.json'), { force: true });
    withLog(h.home, (db) => db.prepare("UPDATE domains SET lease_until = 0 WHERE domain = 'tasks/task'").run());
    await pull();
    expect(withLog(h.home, (db) => db.prepare("SELECT expires FROM idx WHERE key = 'tasks/task/t-2'").get())).toEqual({ expires });
    expect(withLog(h.home, (db) => (db.prepare("SELECT COUNT(*) AS n FROM idx").get() as { n: number }).n)).toBe(2);
  });

  it.each([false, true])('a provider call that loses its lease cannot commit (successor already expired: %s)', async (expired) => {
    await live(tok.jonathan);
    commit([{ op: 'upsert', id: 't-1', record: { agent: 'art', title: 'after lease loss', status: 'open' }, audience: { ownersOf: ['art'] } }]);
    writeFileSync(join(h.home, 'hold-change.json'), 'true');
    const pulling = sync();
    expect(await until(() => { try { return readFileSync(join(h.home, 'change-started'), 'utf-8') === 'yes'; } catch { return false; } })).toBe(true);
    if (expired) {
      // The slow call already read head 3. A successor reads head 4, then its lease expires too.
      commit([{ op: 'upsert', id: 't-2', record: { agent: 'pond-bot', title: 'successor progress', status: 'open' }, audience: { ownersOf: ['pond-bot'] } }]);
      const last = JSON.parse(readFileSync(join(h.home, 'plog.json'), 'utf-8')).at(-1);
      withLog(h.home, (db) => db.prepare("UPDATE domains SET rev = ?, txn = ?, lease = 'successor', lease_until = 0 WHERE domain = 'tasks/task'").run(last.rev, last.txn));
    } else withLog(h.home, (db) => db.prepare("UPDATE domains SET lease = 'other-listener', lease_until = ? WHERE domain = 'tasks/task'").run(Date.now() + 30_000));
    await pulling;
    expect(withLog(h.home, (db) => (db.prepare("SELECT rev FROM domains WHERE domain = 'tasks/task'").get() as { rev: number }).rev)).toBe(expired ? 4 : 2);
    expect(withLog(h.home, (db) => (db.prepare("SELECT COUNT(*) AS n FROM log WHERE domain = 'tasks/task'").get() as { n: number }).n)).toBe(0);
    rmSync(join(h.home, 'hold-change.json'), { force: true });
    if (expired) commit([{ op: 'upsert', id: 't-2', record: { agent: 'pond-bot', title: 'next transaction', status: 'open' }, audience: { ownersOf: ['pond-bot'] } }]);
    withLog(h.home, (db) => db.prepare("UPDATE domains SET lease_until = 0 WHERE domain = 'tasks/task'").run());
    await sync();
    expect(withLog(h.home, (db) => (db.prepare("SELECT rev FROM domains WHERE domain = 'tasks/task'").get() as { rev: number }).rev)).toBe(expired ? 5 : 3);
  });

  it('pulling twice writes nothing twice, and changes come in commit order', async () => {
    const { ev } = await live(tok.jonathan);
    commit([{ op: 'upsert', id: 't-3', record: { agent: 'art', title: 'a', status: 'open' }, audience: { ownersOf: ['art'] } }]);
    commit([{ op: 'upsert', id: 't-3', record: { agent: 'art', title: 'b', status: 'open' }, audience: { ownersOf: ['art'] } }]);
    await Promise.all([pullNow(h.home, 'tasks/task'), pullNow(h.home, 'tasks/task')]);
    await pullNow(h.home, 'tasks/task');
    await deliverNow(h.home);
    await until(() => rowsFrames(ev).length >= 1);
    const ups = rowsFrames(ev).flatMap((f) => (f.data.upserts as Array<Record<string, unknown>>) ?? []);
    expect(ups.map((u) => u.title)).toEqual(['b']);
    expect(withLog(h.home, (db) => (db.prepare("SELECT COUNT(*) AS n FROM log WHERE key = 'tasks/task/t-3'").get() as { n: number }).n)).toBe(2);
  });

  it('a record that leaves the filter is a leave for that subscription; a delete goes only where it was delivered, and nobody else learns the key', async () => {
    const jon = await live(tok.jonathan, { where: [['status', 'eq', 'open']] });
    const loren = await live(tok.loren);
    commit([{ op: 'upsert', id: 't-1', record: { agent: 'art', title: 'art one', status: 'closed' }, audience: { ownersOf: ['art'] } }]);
    commit([{ op: 'delete', id: 't-1' }]);
    await sync();
    await until(() => rowsFrames(jon.ev).length >= 1);
    expect(rowsFrames(jon.ev).map((f) => f.data)).toEqual([{ seq: 1, sub: 'q', scope: 1, leaves: ['tasks/task/t-1'] }]);
    // Loren never held t-1 (art's). Deliver an allowed update as a barrier: seeing it proves her
    // reader consumed the earlier writes too, so an undelivered private frame can't escape the check.
    commit([{ op: 'upsert', id: 't-2', record: { agent: 'pond-bot', title: 'pond two, after', status: 'open' }, audience: { ownersOf: ['pond-bot'] } }]);
    await sync();
    expect(await until(() => rowsFrames(loren.ev).some((f) =>
      (f.data.upserts as Array<Record<string, unknown>> | undefined)?.some((r) => r.title === 'pond two, after') ?? false))).toBe(true);
    // hello's random stream id can itself contain 't-1'. Require the exact frames instead:
    // no private leave, delete, upsert, count or extra event, before or alongside the barrier.
    expect(loren.ev.frames).toEqual([
      { event: 'hello', data: loren.ev.hello },
      { event: 'rows', data: { seq: 1, sub: 'q', scope: 1, upserts: [
        { key: 'tasks/task/t-2', title: 'pond two, after', status: 'open', agent: 'pond-bot' },
      ] } },
    ]);
  });

  it('a change to a record the viewer can\'t see sends their subscription nothing at all, not even a count', async () => {
    const loren = await live(tok.loren, { aggregates: ['count'] });
    expect(loren.answer).toMatchObject({ aggregates: { count: { n: 1, exact: true } } });
    commit([{ op: 'upsert', id: 't-1', record: { agent: 'art', title: 'art one, again', status: 'open' }, audience: { ownersOf: ['art'] } }]);
    commit([{ op: 'upsert', id: 't-7', record: { agent: 'art', title: 'art seven', status: 'open' }, audience: { ownersOf: ['art'] } }]);
    await sync();
    await new Promise((r) => setTimeout(r, 300));
    await deliverNow(h.home);
    expect(rowsFrames(loren.ev)).toEqual([]);
  });

  it('a change to a field the viewer can\'t see, on a record they hold, sends nothing', async () => {
    const loren = await live(tok.loren, { fields: ['title'] });
    // status isn't in loren's fields: the record moved, but nothing she sees did.
    commit([{ op: 'upsert', id: 't-2', record: { agent: 'pond-bot', title: 'pond two', status: 'closed' }, audience: { ownersOf: ['pond-bot'] } }]);
    await sync();
    await new Promise((r) => setTimeout(r, 300));
    await deliverNow(h.home);
    expect(rowsFrames(loren.ev)).toEqual([]);
    commit([{ op: 'upsert', id: 't-2', record: { agent: 'pond-bot', title: 'pond two, renamed', status: 'closed' }, audience: { ownersOf: ['pond-bot'] } }]);
    await sync();
    await until(() => rowsFrames(loren.ev).length >= 1);
    expect(rowsFrames(loren.ev)[0].data).toMatchObject({ upserts: [{ key: 'tasks/task/t-2', title: 'pond two, renamed' }] });
  });

  it('a stream is opened only from loom\'s own page', async () => {
    const r = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${tok.jonathan}`, accept: 'text/event-stream', origin: 'http://evil.example', 'sec-fetch-site': 'same-site' } });
    expect(r.status).toBe(403);
    await r.body?.cancel();
  });

  it('a later page names its own subscription\'s query', async () => {
    const { ev } = await live(tok.jonathan, { limit: 1 });
    const { answers } = await ask(tok.jonathan, [{ id: 'q', type: 'tasks/task@^1', subscribe: true, stream: ev.hello.stream, limit: 1, where: [['status', 'eq', 'open']], after: 'x' }]);
    expect(answers[0]).toMatchObject({ error: 'bad-query' });
  });

  it('an audience that narrows is a leave for the viewer it dropped, and only for them', async () => {
    const jon = await live(tok.jonathan);
    const loren = await live(tok.loren);
    expect(loren.answer.rows).toEqual([{ key: 'tasks/task/t-2', title: 'pond two', status: 'open', agent: 'pond-bot' }]);
    commit([{ op: 'upsert', id: 't-2', record: { agent: 'pond-bot', title: 'pond two', status: 'open' }, audience: { owners: true } }]);
    await sync();
    await until(() => rowsFrames(loren.ev).length >= 1);
    expect(rowsFrames(loren.ev)[0].data).toMatchObject({ sub: 'q', leaves: ['tasks/task/t-2'] });
    // Jonathan still holds it, and nothing he sees of it changed (he didn't ask for its audience): no frame.
    await deliverNow(h.home);
    expect(rowsFrames(jon.ev)).toEqual([]);
  });

  it('a change committed between the query and its answer is delivered once, after the answer\'s at', async () => {
    const ev = await openEvents(base, tok.jonathan);
    streams.push(ev);
    // The provider reads at rev 2; core's log is at 2 too. Then rev 3 lands before the stream hears of anything.
    const { answers } = await ask(tok.jonathan, [{ id: 'q', type: 'tasks/task@^1', subscribe: true, stream: ev.hello.stream }]);
    commit([{ op: 'upsert', id: 't-9', record: { agent: 'art', title: 'nine', status: 'open' }, audience: { ownersOf: ['art'] } }]);
    await sync();
    await sync();
    await until(() => rowsFrames(ev).length >= 1);
    const ups = rowsFrames(ev).flatMap((f) => (f.data.upserts as Array<{ key: string }>) ?? []).map((u) => u.key);
    expect(ups).toEqual(['tasks/task/t-9']);
    expect((rowsFrames(ev)[0].data.seq as number)).toBeGreaterThan(answers[0].at as number);
  });

  it('a store restored behind core\'s cursor is caught on the next pull: a new epoch, and every subscription in the domain resets', async () => {
    const { ev } = await live(tok.jonathan);
    commit([{ op: 'upsert', id: 't-3', record: { agent: 'art', title: 'three', status: 'open' }, audience: { ownersOf: ['art'] } }]);
    await sync();
    // Restored to the first transaction, then written past core's cursor with another history.
    const log = JSON.parse(readFileSync(join(h.home, 'plog.json'), 'utf-8')).slice(0, 2);
    writeFileSync(join(h.home, 'plog.json'), JSON.stringify(log));
    rev = 2;
    commit([{ op: 'upsert', id: 't-4', record: { agent: 'art', title: 'four', status: 'open' }, audience: { ownersOf: ['art'] } }]);
    expect(await pullNow(h.home, 'tasks/task')).toBe('reset');
    await deliverNow(h.home);
    await until(() => ev.frames.some((f) => f.event === 'reset'));
    expect(ev.frames.filter((f) => f.event === 'reset').map((f) => f.data)).toEqual([expect.objectContaining({ sub: 'q', reason: 'epoch' })]);
  });

  it('past the log, a subscription resets with a gap rather than a partial history', async () => {
    const { ev } = await live(tok.jonathan);
    withLog(h.home, (db) => db.prepare("UPDATE domains SET pruned = 1000000 WHERE domain = 'tasks/task'").run());
    await deliverNow(h.home);
    await until(() => ev.frames.some((f) => f.event === 'reset'));
    expect(ev.frames.find((f) => f.event === 'reset')!.data).toMatchObject({ sub: 'q', reason: 'gap' });
  });

  it('an expired record leaves, and its count moves in the same frame, with no provider run', { timeout: 15_000 }, async () => {
    commit([{ op: 'upsert', id: 't-5', record: { agent: 'art', title: 'soon', status: 'open' }, audience: { ownersOf: ['art'] }, expires: Date.now() + 1500 }]);
    const { ev, answer } = await live(tok.jonathan, { aggregates: ['count'] });
    expect((answer.rows as Array<{ key: string }>).map((r) => r.key)).toContain('tasks/task/t-5');
    await new Promise((r) => setTimeout(r, 1600));
    withLog(h.home, (db) => db.prepare('SELECT 1').get());
    const { expire } = await import('./log.js');
    withLog(h.home, (db) => expire(db));
    await deliverNow(h.home);
    await until(() => rowsFrames(ev).length >= 1);
    expect(rowsFrames(ev)[0].data).toMatchObject({ deletes: ['tasks/task/t-5'], aggregates: { count: { n: 2, exact: true } } });
  });

  it('a member whose agents narrow gets a new scope and every subscription resets; a revoked token\'s stream closes, and a new one is refused', async () => {
    const { ev } = await live(tok.loren);
    const hj = JSON.parse(readFileSync(join(h.home, 'household.json'), 'utf-8'));
    hj.members[1].agents = ['art'];
    writeFileSync(join(h.home, 'household.json'), JSON.stringify(hj));
    try {
      await deliverNow(h.home);
      await until(() => ev.frames.some((f) => f.event === 'reset'));
      expect(ev.frames.find((f) => f.event === 'reset')!.data).toMatchObject({ sub: 'q', reason: 'scope', scope: 2 });
      // And the stream closes: everything else it carried was fixed when it opened.
      expect(await until(() => ev.closed())).toBe(true);
    } finally {
      hj.members[1].agents = ['pond-bot'];
      writeFileSync(join(h.home, 'household.json'), JSON.stringify(hj));
    }
    const t = createToken(h, { role: { kind: 'owner', member: 'loren' }, label: 'loren two' }).token;
    const two = await live(t);
    revokeToken(h, 'loren two');
    await deliverNow(h.home);
    expect(await until(() => two.ev.closed())).toBe(true);
    const r = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${t}`, accept: 'text/event-stream' }, redirect: 'manual' });
    // To the sign-in page, never a stream.
    expect(r.status).toBe(303);
    expect(r.headers.get('content-type') ?? '').not.toContain('event-stream');
    await r.body?.cancel();
  });

  it('a query names only its own session\'s stream; /api has no stream to subscribe on', async () => {
    const jon = await openEvents(base, tok.jonathan);
    streams.push(jon);
    const { answers } = await ask(tok.loren, [{ id: 'q', type: 'tasks/task@^1', subscribe: true, stream: jon.hello.stream }]);
    expect(answers[0]).toMatchObject({ error: 'bad-query' });
    const api = await fetch(`${base}/api/loom/collections/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.jonathan}` },
      body: JSON.stringify({ queries: [{ id: 'q', type: 'tasks/task@^1', subscribe: true, stream: jon.hello.stream }] }) });
    expect(((await api.json()) as { answers: unknown[] }).answers[0]).toMatchObject({ error: 'bad-query' });
  });

  describe('commands: an action answers with its receipt, and its changes are already on their way', () => {
    const act = (token: string, fields: Record<string, string>) => fetch(`${base}/act/taskstore`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${token}`, 'x-loom-fetch': '1' },
      body: new URLSearchParams({ _path: '', ...fields }).toString(),
    });
    const acted = () => { try { return readFileSync(join(h.home, 'acted'), 'utf-8').trim().split('\n').filter(Boolean); } catch { return []; } };
    beforeEach(() => rmSync(join(h.home, 'acted'), { force: true }));

    it('the change reaches every window through the stream, the acting one included, before or with the answer; a retry never runs it twice', async () => {
      const { ev } = await live(tok.jonathan, { where: [['status', 'eq', 'open']] });
      const op = 'op-' + 'a'.repeat(20);
      const r = await act(tok.jonathan, { _action: 'close', id: 't-1', _op: op });
      const body = await r.json() as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, message: 'Closed.', receipt: { op, state: 'done' } });
      // Pulled and delivered before the answer was sent.
      expect(await until(() => rowsFrames(ev).length >= 1, 1500)).toBe(true);
      expect(rowsFrames(ev)[0].data).toMatchObject({ leaves: ['tasks/task/t-1'] });
      // A retry (the connection dropped): the same answer, and the piece isn't run again.
      const again = await act(tok.jonathan, { _action: 'close', id: 't-1', _op: op });
      expect(await again.json()).toEqual(body);
      expect(acted()).toEqual(['close t-1']);
      // Another session can't use or read it, and this one can't spend the id on another action.
      expect((await act(tok.loren, { _action: 'close', id: 't-1', _op: op })).status).toBe(409);
      expect((await act(tok.jonathan, { _action: 'close', id: 't-2', _op: op })).status).toBe(409);
      expect(acted()).toEqual(['close t-1']);
    });

    it('a failed action says so in its receipt, with why', async () => {
      const r = await act(tok.jonathan, { _action: 'close', id: 'nope', _op: 'op-' + 'b'.repeat(20) });
      expect(await r.json()).toMatchObject({ ok: false, receipt: { state: 'failed', why: 'No such task.' } });
    });
  });

  it('a nudge says nothing back about the domain, and is held to one a second per token', async () => {
    const nudge = (domain: string) => fetch(`${base}/api/loom/collections/nudge`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.jonathan}` }, body: JSON.stringify({ domain }) });
    const a = await nudge('tasks/task');
    expect([a.status, await a.text()]).toEqual([202, '{"ok":true}']);
    const b = await nudge('nothing/here');
    expect(b.status).toBe(429);
    await new Promise((r) => setTimeout(r, 1050));
    const c = await nudge('nothing/here');
    expect([c.status, await c.text()]).toEqual([202, '{"ok":true}']);
  });

  it('a reconnect (or another listener) is a fresh snapshot, and the log carries on from core\'s cursor', async () => {
    const one = await live(tok.jonathan);
    one.ev.stop();
    commit([{ op: 'upsert', id: 't-6', record: { agent: 'art', title: 'six', status: 'open' }, audience: { ownersOf: ['art'] } }]);
    const other = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    try {
      const ev = await openEvents(`http://127.0.0.1:${other.port}`, tok.jonathan);
      streams.push(ev);
      const r = await fetch(`http://127.0.0.1:${other.port}/collections/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.jonathan}` },
        body: JSON.stringify({ queries: [{ id: 'q', type: 'tasks/task@^1', subscribe: true, stream: ev.hello.stream }] }) });
      const a = ((await r.json()) as { answers: Array<{ rows: Array<{ key: string }> }> }).answers[0];
      expect(a.rows.map((x) => x.key)).toEqual(['tasks/task/t-1', 'tasks/task/t-2', 'tasks/task/t-6']);
    } finally { await other.close(); }
  });
});
