/**
 * The desktop's per-agent Comms summary (docs/specs/agent-desk.md, "Unread"; t-1959): GET /comms/agents answers, for the
 * signed-in member alone, each agent they own with their last thread, how many of its replies they haven't read across
 * their open threads, and the first of those replies' words, one line. Read state is the member's own (a thread is one
 * member's), so another member's threads with the same agent never count, an agent they don't own never shows, and a
 * token that isn't a member's gets nothing. Needs the `age` programs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from './household.js';
import { createConversationTables, recordTurn } from './backends/conversations.js';
import { adapterCall, agentThreadRead, agentsComms, firstLine, FIRST_LINE_MAX, markRead, messagesOf, openThread, postActivity, setArchived, stateOf, sweepComms, threadFor, threadsOf, type AgentComms } from './comms.js';
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

  it('a spell of work starts only with a running step: finished steps or a sign of life alone after a turn ends never bring the working line back (t-2109)', async () => {
    const t = thread('jonathan', 'mark', 'working check');
    const tt = () => threadFor(h, member('jonathan'), t.id);
    expect(stateOf(tt()).working).toBe(false);
    postActivity(h, process.env, { conversation: t.conversation, run: 'r-w', cards: [], alive: { at: new Date().toISOString() } });
    expect(stateOf(tt()).working).toBe(false);
    postActivity(h, process.env, { conversation: t.conversation, run: 'r-w', cards: [{ id: 'w-t', tool: 'text', summary: 'Done.', state: 'done', body: 'Done.' }] });
    expect(stateOf(tt()).working).toBe(false);
    postActivity(h, process.env, { conversation: t.conversation, run: 'r-w', cards: [{ id: 'w-1', tool: 'Bash', summary: 'Ran a command', state: 'running' }] });
    expect(stateOf(tt()).working).toBe(true);
    // A sign of life moves only forward.
    const later = new Date().toISOString();
    postActivity(h, process.env, { conversation: t.conversation, run: 'r-w', cards: [], alive: { at: later } });
    postActivity(h, process.env, { conversation: t.conversation, run: 'r-w', cards: [], alive: { at: new Date(Date.parse(later) - 5000).toISOString() } });
    expect(stateOf(tt()).alive_at).toBe(later);
  });

  it('keeps a step\'s further parts sealed with its label, its times and exit plain, and its body\'s sign of life on the thread (t-2109)', async () => {
    const t = thread('jonathan', 'mark', 'parts check');
    const card = { id: 'p1', at: '2026-11-10T10:00:00.000Z', tool: 'Bash', summary: 'Ran the tests', state: 'running', detail: 'npm test -- comms', limit: 120, parent: 'h:0123456789abcdef' };
    expect(postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [card], alive: { at: new Date(Date.now() - 10 * 60_000).toISOString(), tokens: 4100 } }).added).toBe(1);
    expect(postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [{ ...card, state: 'failed', result: 'exit 1: 3 passed, 1 failed', body: 'OUTPUT-NEVER-KEPT', exit: 1, end: '2026-11-10T10:00:09.000Z' }] }).updated).toBe(1);
    // A step first heard of as done, with no end of its own, ended when core saw it end (not when it started).
    const t0 = new Date(Date.now() - 5000).toISOString();
    postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [{ id: 'q1', at: t0, tool: 'Bash', summary: 'Ran ls', state: 'done' }] });
    const q1 = (await messagesOf(h, process.env, threadFor(h, member('jonathan'), t.id))).find((m) => m.id === 'q1')!;
    expect(Date.parse(String(q1.card?.t1)) - Date.parse(t0)).toBeGreaterThanOrEqual(4000);
    // A diff from a file with CRLF line ends is taken.
    expect(postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [{ id: 'd0', tool: 'Edit', summary: 'Edited b.ts', state: 'done', detail: 'b.ts', body: '+a\r\n+b' }] }).added).toBe(1);
    // An edit's diff is kept, sealed, with its colours.
    expect(postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [{ id: 'd1', tool: 'Edit', summary: 'Edited a.ts', state: 'done', detail: 'a.ts', body: '\x1b[32m+ok\x1b[0m' }] }).added).toBe(1);
    const tt = threadFor(h, member('jonathan'), t.id);
    const step = (await messagesOf(h, process.env, tt)).find((m) => m.kind === 'card' && m.id === 'p1')!;
    expect(step.card).toMatchObject({ tool: 'Bash', state: 'failed', exit: 1, limit: 120, parent: 'h:0123456789abcdef', t0: '2026-11-10T10:00:00.000Z', t1: '2026-11-10T10:00:09.000Z',
      step: { detail: 'npm test -- comms', result: 'exit 1: 3 passed, 1 failed' } });
    // A shell step's output is never kept (t-2109), in its words or anywhere in the store.
    expect((step.card?.step as Record<string, unknown>).body).toBeUndefined();
    expect((await messagesOf(h, process.env, tt)).find((m) => m.id === 'd1')!.card?.step).toEqual({ detail: 'a.ts', body: '\x1b[32m+ok\x1b[0m' });
    // Its words are sealed: never plain in the store.
    const raw = new BetterSqlite3(join(h.home, 'comms.db'), { readonly: true });
    const row = raw.prepare("SELECT card_json, step FROM comms_messages WHERE id = 'p1'").get() as { card_json: string; step: Buffer };
    raw.close();
    expect(row.card_json).not.toContain('npm test');
    expect(row.step.toString('latin1')).not.toContain('npm test');
    // A sign of life from before this spell of work isn't this run's.
    expect(stateOf(tt)).toMatchObject({ working: true });
    expect(stateOf(tt).alive_at).toBeUndefined();
    // A sign of life from the future isn't taken as this run's either.
    postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [], alive: { at: new Date(Date.now() + 3_600_000).toISOString() } });
    expect(stateOf(threadFor(h, member('jonathan'), t.id)).alive_at).toBeUndefined();
    const fresh = new Date(Date.now() + 1000).toISOString();
    postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [], alive: { at: fresh, tokens: 4100 } });
    expect(stateOf(threadFor(h, member('jonathan'), t.id))).toMatchObject({ working: true, alive_at: fresh, tokens: 4100 });
    // A sign of life alone is taken; a bad part refuses the post whole.
    expect(postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [], alive: { at: '2026-11-10T10:00:30.000Z' } })).toMatchObject({ ok: true, added: 0 });
    // Refused whole: a good card before a bad one isn't kept either.
    expect(() => postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [{ ...card, id: 'p3' }, { ...card, id: 'p4', exit: 1.5 }] })).toThrow(/bad-input/);
    expect((await messagesOf(h, process.env, tt)).some((m) => m.id === 'p3')).toBe(false);
    // An older core's wording, pinned here so the runtime's fallback (loom-box delivery.mjs OLD_CORE) can trust it.
    expect(() => postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [{ ...card, id: 'p5', bogus: 1 }] })).toThrow(/^bad-input: card 0 has unknown keys: bogus$/);
    expect(() => postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [] })).toThrow(/^bad-input: cards is a list of 1-50$/);
    // A body is kept only for a diff or the body's words: what a read or a search found never.
    expect(postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [{ id: 'r1', tool: 'Read', summary: 'Read a.ts', state: 'done', detail: 'a.ts', body: 'FILE-CONTENTS-NEVER-KEPT' }] }).added).toBe(1);
    expect((await messagesOf(h, process.env, tt)).find((m) => m.id === 'r1')!.card?.step).toEqual({ detail: 'a.ts' });
    // A card keeps its first tool: a later post naming another can't get a shell step's output kept.
    expect(postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [{ id: 's1', tool: 'Bash', summary: 'Ran a command', state: 'running', detail: 'cat x' }] }).added).toBe(1);
    expect(postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [{ id: 's1', tool: 'Edit', summary: 'Ran a command', state: 'done', detail: 'cat x', body: 'SHELL-OUTPUT-NEVER-KEPT' }] }).updated).toBe(1);
    expect((await messagesOf(h, process.env, tt)).find((m) => m.id === 's1')!.card).toMatchObject({ tool: 'Bash', step: { detail: 'cat x' } });
    expect(JSON.stringify((await messagesOf(h, process.env, tt)).find((m) => m.id === 's1'))).not.toContain('SHELL-OUTPUT');
    // A post of a card is the card whole: its words replace those kept.
    expect(postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [{ id: 'd1', tool: 'Edit', summary: 'Edited a.ts', state: 'done', detail: 'a.ts' }] }).updated).toBe(1);
    expect((await messagesOf(h, process.env, tt)).find((m) => m.id === 'd1')!.card?.step).toEqual({ detail: 'a.ts' });
    for (const bad of [{ summary: 'a\u0085b' }, { detail: 'x'.repeat(4001) }, { body: 'x'.repeat(32_001) }, { result: 'x'.repeat(121) }, { items: Array.from({ length: 21 }, () => ({ text: 'a', state: 'todo' })) }, { items: [{ text: 'x'.repeat(101), state: 'todo' }] }, { body: 'nel\u0085line' }, { body: 'csi\u009b2J' }, { result: 'x\u0085y' }, { body: 'bell\x07' }, { body: 'osc \x1b]0;x' }, { detail: 'a\x1b[1mb' }, { result: 'two\nlines' }, { exit: 1.5 }, { limit: 0 }, { end: 'soon' }, { parent: 'a b' }, { items: [{ text: 'x', state: 'maybe' }] }, { detail: 'rm \u202eb' }, { result: 'z\u200bw' }, { end: '2026-19-45T99:99:99Z' }, { other: 1 }]) {
      // A body is checked where it may be kept (an edit's diff); on a shell step it's dropped unread.
      expect(() => postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [{ ...card, id: 'p2', ...('body' in bad ? { tool: 'Edit' } : {}), ...bad }] })).toThrow(/bad-input/);
    }
    expect(postActivity(h, process.env, { conversation: t.conversation, run: 'r-2', cards: [{ ...card, id: 'p6', body: 'bell\x07' }] }).added).toBe(1);
    // Nothing a command printed or a file held is kept, read back opened (the store holds words only sealed).
    const opened = JSON.stringify(await messagesOf(h, process.env, tt));
    for (const never of ['OUTPUT-NEVER-KEPT', 'FILE-CONTENTS-NEVER-KEPT']) expect(opened.includes(never)).toBe(false);
    // An agent reading its own thread past the words' time, before the sweep has run: no label and no words.
    { const db = new BetterSqlite3(join(h.home, 'comms.db')); db.prepare("UPDATE comms_messages SET at = '2026-01-01T00:00:00.000Z' WHERE thread = ? AND id = 'd0'").run(tt.id); db.close(); }
    const asAgent = (await agentThreadRead(h.home, process.env, 'mark', { thread: tt.id })).messages.find((m) => m.id === 'd0')!;
    expect(asAgent.text).toBeNull();
    expect(asAgent.card?.step).toBeUndefined();
    // Swept with its label: the sealed words go from the row itself.
    sweepComms({ ...h, commsDays: 0 }, new Date(Date.now() + 60_000));
    const gone = (await messagesOf(h, process.env, tt)).find((m) => m.id === 'p1')!;
    expect(gone.text).toBeNull();
    expect(gone.card?.step).toBeUndefined();
    const swept = new BetterSqlite3(join(h.home, 'comms.db'), { readonly: true });
    expect(swept.prepare("SELECT COUNT(*) AS n FROM comms_messages WHERE step IS NOT NULL").get()).toEqual({ n: 0 });
    swept.close();
    markRead(h, tt, 99);
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
