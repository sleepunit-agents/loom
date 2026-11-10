/**
 * Comms threads as live records (t-2027): core's `thread` type carries each thread's list state (unread, at work,
 * Background work, newest seq), never a word. Pinned here, through the real HTTP server:
 *
 *  - parity: a member's open threads in the collection, and which are unread, are exactly the Comms list's (GET /comms);
 *    the per-agent unread threads are what the desktop's cards count (threads, the owner's decision 3);
 *  - scope: one member's thread never reaches another member, not even another owner of the same agent;
 *  - live: a reply and a read reach the member's live subscription as one row's change, and no one else's;
 *  - the list: the rows the app draws from the set (web/src/thread-rows.ts listOf), for the open list, archived threads,
 *    Background work and both, are GET /comms's own, field for field and in its order, for each member; and a pin, an
 *    archive and a title made by another process (no same-process bump) reach a live subscription on the tick file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables, recordTurn } from '../backends/conversations.js';
import { adapterCall, markRead, openThread, setArchived, setPinned, setTitle, threadFor } from '../comms.js';
import { listOf, SPEC as APP_SPEC } from '../../web/src/thread-rows.js';
import type { Rec, ViewState } from '../../web/src/collections/runtime.js';
import { stopCommsWatch } from '../ui/comms-live.js';
import { closeAllBackends } from '../backends/index.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const at = () => new Date().toISOString();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = any;
interface Frame { event: string; data: Record<string, unknown> }

async function openEvents(base: string, token: string): Promise<{ frames: Frame[]; stop: () => void; hello: Record<string, unknown> }> {
  const ac = new AbortController();
  const r = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ac.signal });
  const frames: Frame[] = [];
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
  })();
  for (let t = 0; t < 100 && !frames.some((f) => f.event === 'hello'); t++) await new Promise((r) => setTimeout(r, 20));
  return { frames, stop: () => ac.abort(), hello: frames.find((f) => f.event === 'hello')!.data };
}
const until = async (f: () => boolean, ms = 6000) => { for (let t = 0; t < ms / 25 && !f(); t++) await new Promise((r) => setTimeout(r, 25)); return f(); };

describe.skipIf(!hasAge)('Comms threads as live records (t-2027)', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;
  const streams: Array<{ stop: () => void }> = [];
  let n = 0;
  const id = () => `bbbbbbbbbbbbbb${'abcdefghijklmnopqrstuvwxyz234567'[Math.floor(n / 32)]}${'abcdefghijklmnopqrstuvwxyz234567'[n++ % 32]}`;
  const member = (p: string) => h.members.find((m) => m.person === p)!;
  const thread = (person: string, agent: string, text = 'is the build green?') => {
    const o = openThread(h, process.env, member(person), { agent, id: id(), text });
    recordTurn(agentDir(h, agent), agent, { venue: 'loom', place: o.thread.id, at: at(), from: { kind: 'person', slug: person }, kind: 'message', label: 'New thread' } as never, 'runtime:runtime');
    return o.thread;
  };
  const reply = (t: { id: string; agent: string }, text: string) => adapterCall(h, process.env, { op: 'post', place: t.id, agent: t.agent, text });
  const SPEC: Record<string, unknown> = { ...APP_SPEC };
  const ask = async (who: string, q: Record<string, unknown> = {}) => {
    const r = await fetch(`${base}/collections/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok[who]}` }, body: JSON.stringify({ queries: [{ id: 'q', ...SPEC, ...q }] }) });
    return ((await r.json()) as { answers: Data[] }).answers[0];
  };
  const list = async (who: string, qs = ''): Promise<Data> => (await fetch(`${base}/comms${qs}`, { headers: { authorization: `Bearer ${tok[who]}`, accept: 'application/json' } })).json();
  /** The rows the app draws from an answer, as the live set hands them over (thread-rows.ts listOf). */
  const drawn = (a: Data) => {
    const records = new Map<string, Rec>((a.rows as Rec[]).map((r) => [r.key, r]));
    return listOf({ keys: [...records.keys()], coverage: a.coverage, withheld: a.withheld, status: 'live', more: false } as ViewState, records);
  };
  /** GET /comms's rows as the list draws them (comms-routes.ts view, threadsOf's unread). */
  const served = (l: Data) => (l.threads as Data[]).map((t) => ({ id: t.id, agent: t.agent, title: t.title, titled_by: t.titled_by, project: t.project, pinned: t.pinned,
    archived: t.archived, opened: t.opened, last: t.last, read_seq: t.read_seq, channel: t.channel, conversation: t.conversation, unread: t.unread, last_seq: t.last_seq, state: t.state }));

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-threads-live-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
      createConversationTables(db);
      db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan', members: [
      { person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['art'] },
    ] }));
    process.env.LOOM_HOME = home;
    h = loadHousehold(home)!;
    tok.jonathan = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    tok.sam = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  }, 60_000);
  afterAll(async () => {
    for (const s of streams) s.stop();
    stopCommsWatch();
    await handle?.close();
    await closeAllBackends();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  it('holds exactly the Comms list\'s open threads and their unread; never another member\'s', async () => {
    const a1 = thread('jonathan', 'art', 'one'); const a2 = thread('jonathan', 'art', 'two'); const m1 = thread('jonathan', 'mark', 'three');
    const s1 = thread('sam', 'art', 'sam\'s own');
    reply(a1, 'yes'); reply(m1, 'done'); reply(s1, 'for sam');
    for (const who of ['jonathan', 'sam']) {
      const l = await list(who);
      const a = await ask(who);
      expect(a.coverage.complete).toBe(true);
      const keyed = (a.rows as Data[]).map((r) => ({ id: r.key.split('/')[2], unread: r.unread })).sort((x, y) => (x.id < y.id ? -1 : 1));
      const listed = (l.threads as Data[]).map((t) => ({ id: t.id, unread: t.unread })).sort((x, y) => (x.id < y.id ? -1 : 1));
      expect(keyed, who).toEqual(listed);
      expect((a.rows as Data[]).filter((r) => r.unread).length, who).toBe(l.unread);
    }
    const sam = (await ask('sam')).rows.map((r: Data) => r.key.split('/')[2]);
    expect(sam).toEqual([s1.id]);
    expect((await ask('jonathan')).rows.map((r: Data) => r.key.split('/')[2])).not.toContain(s1.id);
    void a2;
  });

  it('a reply and a read reach the member\'s live subscription, and no one else\'s', async () => {
    const t = thread('jonathan', 'art', 'live?');
    const jon = await openEvents(base, tok.jonathan); streams.push(jon);
    const sam = await openEvents(base, tok.sam); streams.push(sam);
    await ask('jonathan', { subscribe: true, stream: jon.hello.stream });
    await ask('sam', { subscribe: true, stream: sam.hello.stream });
    const key = `loom/thread/${t.id}`;
    const saw = (ev: { frames: Frame[] }, unread: boolean) => ev.frames.some((f) => f.event === 'rows' && ((f.data.upserts as Data[]) ?? []).some((u) => u.key === key && u.unread === unread));
    const t0 = Date.now();
    reply(t, 'it is');
    expect(await until(() => saw(jon, true))).toBe(true);
    const replyMs = Date.now() - t0;
    const t1 = Date.now();
    markRead(h, threadFor(h, member('jonathan'), t.id), 1_000_000);
    expect(await until(() => saw(jon, false))).toBe(true);
    const readMs = Date.now() - t1;
    // LOOM_BENCH names a file for the times (the runner keeps a passing test's console to itself).
    if (process.env.LOOM_BENCH) writeFileSync(process.env.LOOM_BENCH, JSON.stringify({ replyToFrameMs: replyMs, readToFrameMs: readMs }));
    expect(replyMs).toBeLessThan(4_000);
    expect(readMs).toBeLessThan(4_000);
    expect(sam.frames.some((f) => f.event === 'rows' && JSON.stringify(f.data).includes(t.id))).toBe(false);
  }, 30_000);

  it('draws the Comms list, archived threads, Background work and both exactly as GET /comms does, for each member', async () => {
    const pinned = thread('jonathan', 'art', 'pinned one'); setPinned(h, threadFor(h, member('jonathan'), pinned.id), true);
    const gone = thread('jonathan', 'mark', 'archived one'); setArchived(h, threadFor(h, member('jonathan'), gone.id), true);
    const named = thread('jonathan', 'art', 'named'); setTitle(h, threadFor(h, member('jonathan'), named.id), 'A name', 'member');
    reply(named, 'unread reply');
    const samGone = thread('sam', 'art', 'sam archived'); setArchived(h, threadFor(h, member('sam'), samGone.id), true);
    const cv = recordTurn(agentDir(h, 'art'), 'art', { venue: 'spawn', place: 'live-bg', label: 'A job', at: at(), from: { kind: 'agent', id: 'art' }, kind: 'message' } as never, 'runtime:runtime');
    const job = adapterCall(h, process.env, { op: 'spawn', agent: 'art', conversation: cv.conversation, text: 'A brief' }) as { id: string };
    const views: Array<[string, Array<[string, string, unknown?]>]> = [
      ['', [['archived', 'eq', null], ['background', 'eq', false]]],
      ['?archived=1', [['archived', 'has'], ['background', 'eq', false]]],
      ['?background=1', [['archived', 'eq', null], ['background', 'eq', true]]],
      ['?archived=1&background=1', [['archived', 'has'], ['background', 'eq', true]]],
    ];
    let sawJob = false;
    for (const who of ['jonathan', 'sam']) {
      for (const [qs, where] of views) {
        const l = await list(who, qs);
        const a = await ask(who, { where });
        expect(a.coverage.complete, `${who} ${qs}`).toBe(true);
        expect(drawn(a), `${who} ${qs}`).toEqual(served(l));
        // The job's thread is its assigned member's Background work (whichever owner the runtime gave it to).
        if (qs === '?background=1') sawJob ||= (l.threads as Data[]).some((t) => t.id === job.id);
      }
    }
    expect(sawJob).toBe(true);
    expect(JSON.stringify((await ask('sam', { where: views[1][1] })).rows)).not.toContain(gone.id);
  });

  it('hears a thread moved by another process on the tick file, not only in this one', async () => {
    const t = thread('jonathan', 'art', 'moved elsewhere');
    const jon = await openEvents(base, tok.jonathan); streams.push(jon);
    await ask('jonathan', { subscribe: true, stream: jon.hello.stream });
    const key = `loom/thread/${t.id}`;
    // Another process's write: the row changes in household.db and comms.tick is written, with no listener here told.
    const db = new BetterSqlite3(join(h.home, 'household.db'));
    db.prepare('UPDATE comms_threads SET pinned = 1, updated = ? WHERE id = ?').run(Date.now(), t.id);
    db.close();
    writeFileSync(join(h.home, 'comms.tick'), String(Date.now()));
    const t0 = Date.now();
    expect(await until(() => jon.frames.some((f) => f.event === 'rows' && ((f.data.upserts as Data[]) ?? []).some((u) => u.key === key && u.pinned === true)), 6000)).toBe(true);
    // Well inside the 15 s pull: the tick file brought it.
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 30_000);
});
