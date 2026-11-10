/**
 * The desktop's per-agent Comms summary (docs/specs/agent-desk.md, "Unread"; t-1959): GET /comms/agents answers, for the
 * signed-in member alone, each agent they own with their last thread, how many of its replies they haven't read across
 * their open threads, and the first of those replies' words, one line. Read state is the member's own (a thread is one
 * member's), so another member's threads with the same agent never count, an agent they don't own never shows, and a
 * token that isn't a member's gets nothing. Needs the `age` programs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from './household.js';
import { createConversationTables, recordTurn } from './backends/conversations.js';
import { adapterCall, agentsComms, firstLine, FIRST_LINE_MAX, markRead, openThread, postActivity, setArchived, threadFor, threadsOf, type AgentComms } from './comms.js';
import { stopCommsWatch } from './ui/comms-live.js';
import { closeAllBackends } from './backends/index.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const at = () => new Date().toISOString();

describe.skipIf(!hasAge)('the desktop\'s per-agent Comms summary', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;
  let n = 0;
  const id = () => `aaaaaaaaaaaaaa${'abcdefghijklmnopqrstuvwxyz234567'[Math.floor(n / 32)]}${'abcdefghijklmnopqrstuvwxyz234567'[n++ % 32]}`;
  const member = (p: string) => h.members.find((m) => m.person === p)!;
  const thread = (person: string, agent: string, text = 'is the build green?') => {
    const o = openThread(h, process.env, member(person), { agent, id: id(), text });
    recordTurn(agentDir(h, agent), agent, { venue: 'loom', place: o.thread.id, at: at(), from: { kind: 'person', slug: person }, kind: 'message', label: 'New thread' } as never, 'runtime:runtime');
    return o.thread;
  };
  const reply = (t: { id: string; agent: string }, text: string) => adapterCall(h, process.env, { op: 'post', place: t.id, agent: t.agent, text });
  const get = async (who: string) => {
    const r = await fetch(`${base}/comms/agents`, { headers: { authorization: `Bearer ${tok[who]}`, accept: 'application/json' } });
    const json = (r.headers.get('content-type') ?? '').startsWith('application/json');
    return { status: r.status, body: (json ? await r.json() : {}) as { agents?: AgentComms[]; error?: string }, cache: r.headers.get('cache-control') };
  };

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-comms-agents-'));
    for (const a of ['art', 'mark', 'pond-bot']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
      createConversationTables(db);
      db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark', 'pond-bot'], default: 'art', owner: 'jonathan', members: [
      { person: 'jonathan', role: 'owner', agents: '*' },
      { person: 'sam', role: 'owner', agents: ['art'] },
    ] }));
    process.env.LOOM_HOME = home;
    h = loadHousehold(home)!;
    tok.jonathan = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    tok.sam = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    tok.agent = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'art' } as never).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  }, 60_000);
  afterAll(async () => {
    stopCommsWatch();
    await handle?.close();
    await closeAllBackends();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  it('counts the member\'s unread replies per agent, opens on the first one, and moves with their read', async () => {
    const older = thread('jonathan', 'art', 'first question');
    reply(older, 'an old answer');
    const t = thread('jonathan', 'art', 'second question');
    reply(t, 'The lock is cleared.\n\nThe run is going now.');
    reply(t, 'Done: 42 snapshots.');
    // Read the older thread up to its end: only the newer one's two replies are new.
    markRead(h, threadFor(h, member('jonathan'), older.id), 99);
    let art = (await agentsComms(h, process.env, member('jonathan'))).find((a) => a.agent === 'art')!;
    // Unread counts threads (collections.md, owner decision 3): one thread, whatever its two replies.
    expect(art).toMatchObject({ agent: 'art', unread: 1, first: { thread: t.id, text: 'The lock is cleared. The run is going now.' }, last: { thread: t.id } });
    // Read one of them: one left, and the line is the next.
    const firstReply = 2;
    markRead(h, threadFor(h, member('jonathan'), t.id), firstReply);
    art = (await agentsComms(h, process.env, member('jonathan'))).find((a) => a.agent === 'art')!;
    expect(art).toMatchObject({ unread: 1, first: { thread: t.id, text: 'Done: 42 snapshots.' } });
    markRead(h, threadFor(h, member('jonathan'), t.id), 99);
    art = (await agentsComms(h, process.env, member('jonathan'))).find((a) => a.agent === 'art')!;
    expect(art.unread).toBe(0);
    expect(art.first).toBeUndefined();
    expect(art.last?.thread).toBe(t.id);
  });

  it('is each member\'s own: another member\'s threads with the same agent never count, and only owned agents show', async () => {
    // Jonathan has nothing unread with Art while Sam's newer thread does: a `first` from anyone's threads would be Sam's.
    for (const t of threadsOf(h, member('jonathan')).filter((x) => x.agent === 'art')) markRead(h, threadFor(h, member('jonathan'), t.id), 99);
    const theirs = thread('sam', 'art', 'sam asks');
    reply(theirs, 'for sam only');
    const j = await get('jonathan');
    expect(j.status).toBe(200);
    expect(j.body.agents!.map((a) => a.agent)).toEqual(['art', 'mark', 'pond-bot']);
    const jart = j.body.agents!.find((a) => a.agent === 'art')!;
    expect(jart.unread).toBe(0);
    expect(jart.first).toBeUndefined();
    expect(JSON.stringify(j.body)).not.toContain('for sam only');
    expect(JSON.stringify(j.body)).not.toContain(theirs.id);
    expect(jart.last?.thread).not.toBe(theirs.id);
    const s = await get('sam');
    expect(s.status).toBe(200);
    expect(s.body.agents!.map((a) => a.agent)).toEqual(['art']);
    expect(s.body.agents![0]).toMatchObject({ unread: 1, first: { thread: theirs.id, text: 'for sam only' }, last: { thread: theirs.id } });
    // Never kept by a cache along the way.
    expect(s.cache).toBe('no-store');
  });

  it('refuses a caller that isn\'t a member, and a write', async () => {
    // No session, or an agent's token: sent to sign in, and nothing else.
    for (const auth of [{}, { authorization: `Bearer ${tok.agent}` }]) {
      const r = await fetch(`${base}/comms/agents`, { headers: { accept: 'application/json', ...auth }, redirect: 'manual' });
      expect(r.status).toBe(303);
      expect(new URL(r.headers.get('location') ?? '', base).pathname).toBe('/login');
      expect(await r.text()).not.toContain('agents');
    }
    const post = await fetch(`${base}/comms/agents`, { method: 'POST', headers: { authorization: `Bearer ${tok.jonathan}`, accept: 'application/json', 'content-type': 'application/json' }, body: '{}' });
    expect(post.status).toBe(405);
  });

  it('leaves out archived threads, and an agent with no threads has nothing but its name', async () => {
    const t = thread('jonathan', 'mark', 'about the week');
    reply(t, 'the plan is ready');
    let mark = (await agentsComms(h, process.env, member('jonathan'))).find((a) => a.agent === 'mark')!;
    expect(mark.unread).toBe(1);
    setArchived(h, threadFor(h, member('jonathan'), t.id), true);
    mark = (await agentsComms(h, process.env, member('jonathan'))).find((a) => a.agent === 'mark')!;
    expect(mark).toEqual({ agent: 'mark', unread: 0 });
    const pond = (await agentsComms(h, process.env, member('jonathan'))).find((a) => a.agent === 'pond-bot')!;
    expect(pond).toEqual({ agent: 'pond-bot', unread: 0 });
  });

  it('sums across the member\'s threads and opens on the newest thread that has any unread', async () => {
    const one = thread('jonathan', 'pond-bot', 'first');
    reply(one, 'old unread A');
    reply(one, 'old unread B');
    const two = thread('jonathan', 'pond-bot', 'second');
    reply(two, 'new unread C');
    const three = thread('jonathan', 'pond-bot', 'third, all read');
    reply(three, 'read already');
    markRead(h, threadFor(h, member('jonathan'), three.id), 99);
    const pond = (await agentsComms(h, process.env, member('jonathan'))).find((a) => a.agent === 'pond-bot')!;
    // The two threads with unread replies (threads, not their 2 + 1 replies); the first is in the newer of those two,
    // not the oldest, and not the newest thread (read already).
    expect(pond.unread).toBe(2);
    expect(pond.first).toEqual({ thread: two.id, text: 'new unread C' });
    expect(pond.last?.thread).toBe(three.id);
    for (const t of [one, two]) markRead(h, threadFor(h, member('jonathan'), t.id), 99);
  });

  it('counts the agent\'s replies only: its activity cards and errors aren\'t replies', async () => {
    const t = thread('jonathan', 'mark', 'cards check');
    // A run's step cards (POST /api/loom/comms/activity): from the agent, not replies.
    expect(postActivity(h, process.env, { conversation: t.conversation, run: 'r-1', cards: [
      { id: 'c1', tool: 'Bash', summary: 'ran restic snapshots', state: 'done' }, { id: 'c2', tool: 'Read', summary: 'read the log', state: 'done' }] }).added).toBe(2);
    reply(t, 'the one reply');
    const mark = (await agentsComms(h, process.env, member('jonathan'))).find((a) => a.agent === 'mark')!;
    expect(mark.unread).toBe(1);
    expect(mark.first).toEqual({ thread: t.id, text: 'the one reply' });
    markRead(h, threadFor(h, member('jonathan'), t.id), 99);
  });

  it('refuses no member at all, whatever the route does', async () => {
    await expect(agentsComms(h, process.env, undefined)).rejects.toMatchObject({ status: 403 });
  });

  it('never puts a reply\'s words in Home\'s page (a device keeps a copy of it)', async () => {
    const t = thread('jonathan', 'art', 'home check');
    reply(t, 'A distinctive reply for the home check.');
    const r = await fetch(`${base}/`, { headers: { authorization: `Bearer ${tok.jonathan}`, accept: 'application/json' } });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('"house-home"');
    expect(text).not.toContain('A distinctive reply for the home check.');
    expect((await get('jonathan')).body.agents!.find((a) => a.agent === 'art')!.first?.text).toBe('A distinctive reply for the home check.');
    markRead(h, threadFor(h, member('jonathan'), t.id), 99);
  });

  it('cuts a long reply to one line', () => {
    const long = `${'word '.repeat(100)}end`;
    const l = firstLine(long);
    expect(l.length).toBeLessThanOrEqual(FIRST_LINE_MAX);
    expect(l.endsWith('…')).toBe(true);
    expect(firstLine('  two\nlines  ')).toBe('two lines');
    // never half a character: an emoji at the cut stays whole
    const emoji = firstLine(`${'x'.repeat(FIRST_LINE_MAX - 2)}😀😀😀`);
    expect([...emoji].length).toBe(FIRST_LINE_MAX);
    expect(emoji).toMatch(/😀…$/);
    // a flag (two code points) and a family (joined) stay whole too
    expect(firstLine(`${'x'.repeat(FIRST_LINE_MAX - 2)}🇳🇿🇳🇿🇳🇿`)).toMatch(/x🇳🇿…$/);
    expect(firstLine(`${'x'.repeat(FIRST_LINE_MAX - 2)}👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧`)).toMatch(/x👨‍👩‍👧…$/);
  });
});
