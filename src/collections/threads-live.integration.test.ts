/**
 * Comms threads as live records (t-2027): core's `thread` type carries each thread's list state (unread, at work,
 * Background work, newest seq), never a word. Pinned here, through the real HTTP server:
 *
 *  - parity: a member's open threads in the collection, and which are unread, are exactly the Comms list's (GET /comms);
 *    the per-agent unread threads are what the desktop's cards count (threads, the owner's decision 3);
 *  - scope: one member's thread never reaches another member, not even another owner of the same agent;
 *  - live: a reply and a read reach the member's live subscription as one row's change, and no one else's.
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
import { adapterCall, markRead, openThread, threadFor } from '../comms.js';
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
  const SPEC = { type: 'loom/thread@^1', where: [['archived', 'eq', null], ['background', 'eq', false]], order: [['updated', 'desc']], limit: 200, fields: ['agent', 'title', 'updated', 'unread', 'working', 'last_seq'] };
  const ask = async (who: string, q: Record<string, unknown> = {}) => {
    const r = await fetch(`${base}/collections/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok[who]}` }, body: JSON.stringify({ queries: [{ id: 'q', ...SPEC, ...q }] }) });
    return ((await r.json()) as { answers: Data[] }).answers[0];
  };
  const list = async (who: string): Promise<Data> => (await fetch(`${base}/comms`, { headers: { authorization: `Bearer ${tok[who]}`, accept: 'application/json' } })).json();

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
});
