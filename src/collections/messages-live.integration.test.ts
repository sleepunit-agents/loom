/** Message records: route parity, member isolation, bounded word reads, key refusal, retention/deletion and a history
 * beyond the generic bridge limit. The bridge/index holds encrypted revisions and safe metadata only. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables, recordTurn } from '../backends/conversations.js';
import { adapterCall, allThreads, markRead, openThread, setArchived, setPinned, setTitle, threadFor } from '../comms.js';
import * as comms from '../comms.js';
import { sentDigest } from './subs.js';
import { CORE_TYPES, coreAnswers } from './core-types.js';
import { withLog, indexOf } from './log.js';
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

describe.skipIf(!hasAge)('Comms message pages as live records (t-2027)', () => {
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
  const SPEC: Record<string, unknown> = { type: 'loom/message@1', fields: ['agent', 'thread', 'seq', 'revision', 'message'], order: [['seq', 'desc']], limit: 50 };
  const ask = async (who: string, q: Record<string, unknown> = {}) => {
    const r = await fetch(`${base}/collections/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok[who]}` }, body: JSON.stringify({ queries: [{ id: 'q', ...SPEC, ...q }] }) });
    return ((await r.json()) as { answers: Data[] }).answers[0];
  };
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

  it('keeps comparison digests instead of decrypted subscription rows', () => {
    const record = { key: 'loom/message/thread:1', message: { text: 'private payload words' } };
    const kept = sentDigest(record);
    expect(kept).toMatch(/^[0-9a-f]{64}$/);
    expect(kept).not.toContain('private payload words');
    expect(sentDigest({ ...record, message: { text: null } })).not.toBe(kept);
  });

  it("pages a member's words exactly as Comms does, and never another member's", async () => {
    const t = thread('jonathan', 'art', 'initial words');
    const other = thread('sam', 'art', 'private words');
    for (let i = 0; i < 104; i++) reply(t, `reply ${i}`);
    const expected = await (await fetch(`${base}/comms/${t.id}`, { headers: { authorization: `Bearer ${tok.jonathan}`, accept: 'application/json' } })).json() as Data;
    const rows: Data[] = [];
    let after: string | undefined;
    do {
      const a = await ask('jonathan', { where: [['thread', 'eq', t.id]], ...(after ? { after } : {}) });
      expect(a.error).toBeUndefined();
      expect(a.rows.length).toBeLessThanOrEqual(50);
      rows.push(...a.rows);
      after = a.next ?? undefined;
    } while (after);
    expect(rows).toHaveLength(105);
    expect(rows.slice(0, 100).map((r) => r.message).reverse()).toEqual(expected.messages);
    expect(new Set(rows.map((r) => r.key)).size).toBe(105);
    expect((await ask('sam', { where: [['thread', 'eq', t.id]] })).rows).toEqual([]);
    expect((await ask('jonathan', { where: [['thread', 'eq', other.id]] })).rows).toEqual([]);
    expect((await ask('sam', { where: [['thread', 'eq', other.id]] })).rows[0].message.text).toBe('private words');
    // The cursor is sealed to its member, even another owner of the same agent.
    const first = await ask('jonathan', { where: [['thread', 'eq', t.id]] });
    expect((await ask('sam', { where: [['thread', 'eq', t.id]], after: first.next })).error).toBe('bad-query');
  });

  it('pairs payload, mutable metadata and revision from the same selected row across a writer race', async () => {
    const t = thread('jonathan', 'art', 'a delivery that moves during a read');
    const original = comms.messagesBySeq;
    let changed = false;
    const spy = vi.spyOn(comms, 'messagesBySeq').mockImplementation(async (...args) => {
      if (args[2].id === t.id && !changed) {
        changed = true;
        const db = new BetterSqlite3(join(h.home, 'comms.db'));
        db.prepare('UPDATE comms_messages SET delivered = 1 WHERE thread = ?').run(t.id); db.close();
      }
      return original(...args);
    });
    try {
      const a = await ask('jonathan', { where: [['thread', 'eq', t.id]], fields: ['thread', 'seq', 'revision', 'delivered', 'message'] });
      expect(a.error).toBeUndefined();
      expect(changed).toBe(true);
      expect(a.rows[0].message.delivered).toBe(true);
      expect(a.rows[0].delivered).toBe(true);
      expect(a.rows[0].revision).toBe(comms.messageRevisions(h.home, [{ thread: t.id, seq: 1 }])[0]);
    } finally { spy.mockRestore(); }
  });

  it('snapshots encrypted revisions with no key and no plaintext; bounded word reads refuse a missing key', async () => {
    const t = thread('jonathan', 'art', 'never put these words in a collection log');
    renameSync(join(h.home, 'comms.key'), join(h.home, 'comms.key.saved'));
    try {
      const q = { id: 'snapshot', type: 'message', version: 1, where: [], order: [], limit: 500, after: null, fields: Object.keys(CORE_TYPES.message.fields).filter((f) => f !== 'message'), aggregates: [] } as Data;
      const a = (await coreAnswers(h, { kind: 'core' }, [q]))[0];
      expect(a.error).toBeUndefined();
      expect(JSON.stringify(a)).not.toContain('never put these words');
      expect(a.rows.some((r) => r.thread === t.id)).toBe(true);
      expect(a.rows.every((r) => !Object.hasOwn(r, 'message'))).toBe(true);
      expect((await ask('jonathan', { where: [['thread', 'eq', t.id]] })).error).toBe('unavailable');
    } finally { renameSync(join(h.home, 'comms.key.saved'), join(h.home, 'comms.key')); }
    expect((await ask('jonathan', { where: [['thread', 'eq', t.id]] })).rows[0].message.text).toBe('never put these words in a collection log');
  });

  it('reports a refused live payload read once and recovers even when the words are unchanged', async () => {
    const t = thread('jonathan', 'art', 'words before the key disappeared');
    const stream = await openEvents(base, tok.jonathan); streams.push(stream);
    const a = await ask('jonathan', { where: [['thread', 'eq', t.id]], subscribe: true, stream: stream.hello.stream });
    expect(a.error).toBeUndefined();
    const { pullNow, deliverNow } = await import('./subs.js');
    await pullNow(h.home, 'loom/message'); await deliverNow(h.home);
    await new Promise((r) => setTimeout(r, 1700));
    renameSync(join(h.home, 'comms.key'), join(h.home, 'comms.key.saved'));
    try {
      // Move metadata to trigger a bounded re-read while the key is missing.
      const db = new BetterSqlite3(join(h.home, 'comms.db'));
      db.prepare('UPDATE comms_messages SET delivered = 1 WHERE thread = ?').run(t.id); db.close();
      comms.bump(h.home);
      expect(await until(() => stream.frames.some((f) => f.event === 'rows' && f.data.sub === 'q' && f.data.status === 'unavailable'))).toBe(true);
      await new Promise((r) => setTimeout(r, 2200));
      expect(stream.frames.filter((f) => f.event === 'rows' && f.data.status === 'unavailable')).toHaveLength(1);
      expect(stream.frames.filter((f) => f.event === 'rows').every((f) => !Object.hasOwn(f.data, 'leaves'))).toBe(true);
    } finally {
      // Restore the original row before the key: successful retry has exactly the original projection.
      const db = new BetterSqlite3(join(h.home, 'comms.db'));
      db.prepare('UPDATE comms_messages SET delivered = NULL WHERE thread = ?').run(t.id); db.close();
      renameSync(join(h.home, 'comms.key.saved'), join(h.home, 'comms.key'));
    }
    expect(await until(() => stream.frames.some((f) => f.event === 'rows' && f.data.status === 'live'))).toBe(true);
    expect(stream.frames.filter((f) => f.event === 'rows' && f.data.upserts)).toHaveLength(0);
    stream.stop();
  }, 20_000);

  it('delivers a changed page including retention and removes a deleted thread, with no words kept in the index', async () => {
    const t = thread('jonathan', 'art', 'live initial');
    const stream = await openEvents(base, tok.jonathan); streams.push(stream);
    const a = await ask('jonathan', { where: [['thread', 'eq', t.id]], subscribe: true, stream: stream.hello.stream });
    expect(a.error).toBeUndefined();
    reply(t, 'live reply words');
    expect(await until(() => stream.frames.some((f) => f.event === 'rows' && (f.data.upserts as Data[] | undefined)?.some((r) => r.message?.text === 'live reply words')))).toBe(true);
    const kept = withLog(h.home, (db) => indexOf(db, 'loom/message'));
    expect(JSON.stringify(kept)).not.toContain('live reply words');
    expect(kept.every((r) => !Object.hasOwn(JSON.parse(r.record ?? '{}'), 'message'))).toBe(true);
    const db = new BetterSqlite3(join(h.home, 'comms.db'));
    db.prepare('UPDATE comms_messages SET text = NULL WHERE thread = ?').run(t.id); db.close();
    // The real sweep bumps Comms too; signal the same revision change without waiting for its hourly timer.
    const { bump, deleteThread } = await import('../comms.js'); bump(h.home);
    expect(await until(() => stream.frames.some((f) => f.event === 'rows' && (f.data.upserts as Data[] | undefined)?.some((r) => r.thread === t.id && r.message?.text === null)))).toBe(true);
    deleteThread(h, threadFor(h, member('jonathan'), t.id));
    expect(await until(() => stream.frames.some((f) => f.event === 'rows' && (f.data.leaves as string[] | undefined)?.includes(`loom/message/${t.id}:1`)))).toBe(true);
  });
  it('opens words only when a changed message can affect the subscribed thread and sequence range', async () => {
    const t = thread('jonathan', 'art', 'watched words');
    const other = thread('jonathan', 'art', 'another thread');
    const stream = await openEvents(base, tok.jonathan); streams.push(stream);
    const a = await ask('jonathan', { where: [['thread', 'eq', t.id], ['seq', 'lte', 1]], subscribe: true, stream: stream.hello.stream });
    expect(a.error).toBeUndefined();
    // Drain the bridge's initial pull before counting. The initial subscription can need one reconciliation.
    const { pullNow, deliverNow } = await import('./subs.js');
    await pullNow(h.home, 'loom/message');
    await deliverNow(h.home);
    await new Promise((r) => setTimeout(r, 1700));
    const spy = vi.spyOn(comms, 'messagesBySeq');
    try {
      reply(other, 'unrelated thread reply');
      reply(t, 'outside the loaded sequence range');
      await pullNow(h.home, 'loom/message');
      await deliverNow(h.home);
      await new Promise((r) => setTimeout(r, 1800));
      expect(spy.mock.calls.filter((args) => args[2].id === t.id)).toHaveLength(0);
      const db = new BetterSqlite3(join(h.home, 'comms.db'));
      db.prepare('UPDATE comms_messages SET text = NULL WHERE thread = ? AND seq = 1').run(t.id); db.close();
      comms.bump(h.home);
      expect(await until(() => stream.frames.some((f) => f.event === 'rows' && (f.data.upserts as Data[] | undefined)?.some((r) => r.thread === t.id && r.seq === 1 && r.message?.text === null)))).toBe(true);
      expect(spy.mock.calls.some((args) => args[2].id === t.id)).toBe(true);
      comms.deleteThread(h, threadFor(h, member('jonathan'), t.id));
      expect(await until(() => stream.frames.some((f) => f.event === 'rows' && (f.data.leaves as string[] | undefined)?.includes(`loom/message/${t.id}:1`)))).toBe(true);
    } finally { spy.mockRestore(); stream.stop(); }
  }, 20_000);

  it('keeps live coverage after 10,000 retained message identities', async () => {
    const t = thread('jonathan', 'art', 'old history');
    const db = new BetterSqlite3(join(h.home, 'comms.db'));
    db.transaction(() => {
      const insert = db.prepare("INSERT INTO comms_messages (thread, seq, at, kind, sender, id, text) VALUES (?, ?, ?, 'reply', 'art', ?, NULL)");
      for (let seq = 2; seq <= 10_020; seq++) insert.run(t.id, seq, at(), `retained-${seq}`);
    })(); db.close();
    const key = `loom/message/${t.id}:10020`;
    const { bump } = await import('../comms.js'); bump(h.home);
    expect(await until(() => withLog(h.home, (db) => indexOf(db, 'loom/message')).some((r) => r.key === key))).toBe(true);
    const stream = await openEvents(base, tok.jonathan); streams.push(stream);
    const a = await ask('jonathan', { where: [['thread', 'eq', t.id]], subscribe: true, stream: stream.hello.stream });
    expect(a.error).toBeUndefined();
    const edit = new BetterSqlite3(join(h.home, 'comms.db'));
    edit.prepare('UPDATE comms_messages SET delivered = 1 WHERE thread = ? AND seq = 10020').run(t.id); edit.close();
    bump(h.home);
    expect(await until(() => stream.frames.some((f) => f.event === 'rows' && (f.data.upserts as Data[] | undefined)?.some((r) => r.key === key && r.message?.delivered === true)))).toBe(true);
  }, 20_000);

});
