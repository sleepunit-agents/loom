/**
 * Conversations in core, first slice (docs/specs/conversations.md, "Acceptance criteria"
 * 1-5 and 11-15; t-1741). Each describe names its criterion. The audit log, review tokens,
 * redaction, scores and findings writes (6-10) are a later task: here criterion 2 pins only
 * the store's half (who wrote which turn), which the audit write will check.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { createLoomServer } from './server.js';
import { agentDir, createToken, loadHousehold, memberOf, type Household } from './household.js';
import { runtimePieces, parseLoomBlock } from './cli/pieces-managed.js';
import {
  conversationId, createConversationTables, digestId, digestsOf, dueToProgressSeconds, foldConversations, getConversation, listConversations,
  parseDigest, parseTurn, recordTurn, turnsOf, turnWriter, daysOf, writeDigest, ConversationError, type TurnInput,
} from './backends/conversations.js';
import { conversationsSection, conversationView, genericRender, householdConversations, ScopeError, writeTurn } from './conversations.js';
import { listVenues, syncVenues, venueOf } from './household-store.js';
import { coreAsks, conversationAsks } from './ui/handler.js';
import { tapeForContext } from './backends/episodes.js';
import { remember } from './tools/remember.js';
import { projectHubOf } from './tools/project.js';
import { openProjectsStore } from './backends/projects.js';
import { openPeopleStore } from './backends/people.js';
import { closeAllBackends } from './backends/index.js';
import { ROLE_ROUTES, AGENT_ROUTES } from './transport/role-routes.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** A household: art, pond-bot and mark; jonathan owns all, loren only pond-bot. */
function household(prefix: string): Household {
  const home = mkdtempSync(join(tmpdir(), prefix));
  for (const a of ['art', 'pond-bot', 'mark']) {
    mkdirSync(join(home, 'agents', a), { recursive: true });
    writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
    createConversationTables(db);
    db.close();
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({
    v: 1, agents: ['art', 'pond-bot', 'mark'], default: 'art',
    members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'loren', role: 'owner', agents: ['pond-bot'] }],
  }));
  return loadHousehold(home)!;
}

/**
 * A managed piece record and its bin, as an install leaves them: `loom` is the checked block.
 * The bin answers a venue render (`render --conversation <id>`) with a feed naming the id.
 */
function piece(home: string, name: string, loom: Record<string, unknown>, renderOut?: string): void {
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
    bins: [`loom-${name}`], loom: { settings: [], services: [], ...loom } }));
  const bin = join(dir, 'current', 'cli');
  writeFileSync(bin, `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === 'render') {
  ${renderOut ?? "console.log(JSON.stringify({ groups: [{ title: 'From the venue', items: [{ title: 'args ' + a.join(' ') }] }] }));"}
} else process.exit(3);
`);
  chmodSync(bin, 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  rmSync(join(home, 'pieces', 'bin', `loom-${name}`), { force: true });
  symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
}

const SLACK = { slack: { label: 'Slack', kind: 'live', render: ['loom-shuttle', 'render', '--json'] } };

const T0 = Date.parse('2026-11-02T12:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const msg = (place: string, s: number, slug = 'loren'): TurnInput => ({ venue: 'slack', place, at: at(s), from: { kind: 'person', slug }, kind: 'message' });
const reply = (place: string, s: number, run = 'r1', extra: Partial<TurnInput> = {}): TurnInput =>
  ({ venue: 'slack', place, at: at(s), from: { kind: 'agent', id: 'art' }, kind: 'reply', run, outcome: 'answered', model: 'opus', harness: 'claude-code', ...extra });

async function mcp(contextDir: string) {
  const { server } = createLoomServer({ contextDir });
  const client = new Client({ name: 'conv-test', version: '1' });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
    let body: unknown;
    try { body = JSON.parse(r.content[0].text); } catch { body = r.content[0].text; }
    return { error: r.isError === true, body: body as Record<string, unknown> };
  };
  return { client, call };
}

const saved = process.env.LOOM_HOME;
const restoreEnv = () => { if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved; };

// ─── 1. Turn writes ─────────────────────────────────────────────────────────

describe('criterion 1: turn writes (POST /api/loom/conversations/turn)', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};

  beforeAll(async () => {
    h = household('loom-conv-turn-');
    piece(h.home, 'shuttle', { role: 'runtime', venues: SLACK });
    piece(h.home, 'notes', {});
    process.env.LOOM_HOME = h.home;
    tok.owner = createToken(h, { role: { kind: 'owner' }, label: 'owner' }).token;
    tok.art = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'art' }).token;
    tok.box = createToken(h, { role: { kind: 'piece', piece: 'shuttle', subject: 'thor' }, label: 'shuttle · thor' }).token;
    tok.peer = createToken(h, { role: { kind: 'peer', name: 'pal' }, label: 'pal' }).token;
    tok.runtime = createToken(h, { role: { kind: 'runtime', piece: 'shuttle' }, label: 'runtime', runtimePieces: runtimePieces(process.env) }).token;
    // The daemon syncs the venues registry at start.
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    restoreEnv();
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });

  const post = (token: string | undefined, body: unknown) => fetch(`${base}/api/loom/conversations/turn`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });

  it('the route is the runtime\'s (allowlisted), and an agent token\'s for its own session', () => {
    expect(ROLE_ROUTES.runtime).toContain('conversations/turn');
    expect(AGENT_ROUTES).toEqual(['conversations/turn', 'audit']);
    expect(venueOf(h.home, 'slack')).toMatchObject({ piece: 'shuttle', kind: 'live' });
    // Own keys only: an inherited name is neither core's venue nor a registered one.
    for (const name of ['constructor', 'tostring', 'valueof']) expect(venueOf(h.home, name)).toBeUndefined();
  });

  it('a runtime turn creates, then extends, agent · venue · place, answering {conversation, seq}', async () => {
    const r1 = await post(tok.runtime, { agent: 'art', ...msg('dm:U1', 0) });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1).toEqual({ conversation: conversationId('art', 'slack', 'dm:U1'), seq: 1 });
    const b2 = await (await post(tok.runtime, { agent: 'art', ...reply('dm:U1', 30), label: 'Loren (DM)' })).json();
    expect(b2).toEqual({ conversation: b1.conversation, seq: 2 });
    const c = getConversation(agentDir(h, 'art'), b1.conversation)!;
    expect(c).toMatchObject({ agent: 'art', venue: 'slack', place: 'dm:U1', label: 'Loren (DM)', people: ['loren'], started: at(0), last: at(30) });
    expect(b1.conversation).toMatch(/^cv-[0-9a-f]{12}$/);
  });

  it('two places are two conversations', async () => {
    const a = await (await post(tok.runtime, { agent: 'art', ...msg('dm:U2', 0, 'matt') })).json();
    const b = await (await post(tok.runtime, { agent: 'art', ...msg('C0POND', 0, 'matt') })).json();
    expect(a.conversation).not.toBe(b.conversation);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
  });

  it('the runtime writes for any of the household\'s agents, never an unknown one, never venue session, never an unknown venue', async () => {
    expect((await post(tok.runtime, { agent: 'pond-bot', ...msg('dm:U1', 0), from: { kind: 'person', slug: 'loren' } })).status).toBe(200);
    expect(getConversation(agentDir(h, 'pond-bot'), conversationId('pond-bot', 'slack', 'dm:U1'))).toBeDefined();
    expect((await post(tok.runtime, { agent: 'nobody', ...msg('dm:U1', 0) })).status).toBe(400);
    expect((await post(tok.runtime, msg('dm:U1', 0))).status).toBe(400);
    expect((await post(tok.runtime, { agent: 'art', ...msg('x', 0), venue: 'session' })).status).toBe(403);
    expect((await post(tok.runtime, { agent: 'art', ...msg('x', 0), venue: 'discord' })).status).toBe(400);
    // Core's own scheduled venue.
    expect((await post(tok.runtime, { agent: 'art', venue: 'wake', place: 'lane:reflect', at: at(0), from: { kind: 'schedule' }, kind: 'wake' })).status).toBe(200);
  });

  it('an agent token may write only venue session, for itself', async () => {
    const session = { venue: 'session', place: 'claude-code:abc123', at: at(0), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' };
    const r = await post(tok.art, session);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ conversation: conversationId('art', 'session', 'claude-code:abc123'), seq: 1 });
    expect((await post(tok.art, { ...session, agent: 'art' })).status).toBe(200);
    expect((await post(tok.art, { ...session, agent: 'pond-bot' })).status).toBe(403);
    expect((await post(tok.art, msg('dm:U1', 0))).status).toBe(403);
    expect(getConversation(agentDir(h, 'pond-bot'), conversationId('pond-bot', 'session', 'claude-code:abc123'))).toBeUndefined();
  });

  it('any other role is refused: owner, piece credential, peer; and no token at all', async () => {
    const body = { agent: 'art', ...msg('dm:U9', 0) };
    for (const k of ['owner', 'box', 'peer'] as const) expect((await post(tok[k], body)).status, k).toBe(403);
    expect((await post(undefined, body)).status).toBe(401);
    expect(getConversation(agentDir(h, 'art'), conversationId('art', 'slack', 'dm:U9'))).toBeUndefined();
  });

  it('a turn with text, an unknown key, or a place over 200 is refused', async () => {
    const ok = { agent: 'art', ...msg('dm:U3', 0) };
    const text = await post(tok.runtime, { ...ok, text: 'hi there' });
    expect(text.status).toBe(400);
    expect((await text.json()).error).toMatch(/carries no text/);
    expect((await post(tok.runtime, { ...ok, body: 'hi' })).status).toBe(400);
    expect((await post(tok.runtime, { ...ok, place: 'x'.repeat(201) })).status).toBe(400);
    expect((await post(tok.runtime, { ...ok, place: 'x'.repeat(200) })).status).toBe(200);
    expect(getConversation(agentDir(h, 'art'), conversationId('art', 'slack', 'dm:U3'))).toBeUndefined();
    // The session writer is held to the same rules.
    expect((await post(tok.art, { venue: 'session', place: 's:1', at: at(0), from: { kind: 'unknown' }, kind: 'message', text: 'x' })).status).toBe(400);
  });

  it('latency_ms is computed by core: a writer can\'t send one', async () => {
    await post(tok.runtime, { agent: 'art', ...msg('dm:U4', 0) });
    expect((await post(tok.runtime, { agent: 'art', ...reply('dm:U4', 45), latency_ms: 1 })).status).toBe(400);
    expect((await post(tok.runtime, { agent: 'art', ...reply('dm:U4', 45) })).status).toBe(200);
    const turns = turnsOf(agentDir(h, 'art'), conversationId('art', 'slack', 'dm:U4'));
    expect(turns.map((t) => [t.kind, t.latency_ms])).toEqual([['message', undefined], ['reply', 45_000]]);
  });

  it('the turn route is POST and JSON, like the rest of /api', async () => {
    const r = await fetch(`${base}/api/loom/conversations/turn`, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${tok.runtime}` }, body: '{}' });
    expect(r.status).toBe(415);
  });
});

describe('criterion 1: the turn schema (parseTurn)', () => {
  it('the agent\'s own turns carry run and outcome and come from it; others carry neither', () => {
    expect(() => parseTurn({ ...reply('p', 0), run: undefined }, 'art')).toThrow(/names its run/);
    expect(() => parseTurn({ ...reply('p', 0), outcome: 'great' }, 'art')).toThrow(/outcome/);
    expect(() => parseTurn({ ...reply('p', 0), from: { kind: 'agent', id: 'mark' } }, 'art')).toThrow(/agent's own turn/);
    expect(() => parseTurn({ ...msg('p', 0), run: 'r1' }, 'art')).toThrow(/only on the agent's own turns/);
    expect(() => parseTurn({ ...msg('p', 0), from: { kind: 'person', slug: 'loren', name: 'Loren' } }, 'art')).toThrow(/no other keys/);
    expect(() => parseTurn({ ...msg('p', 0), at: '2026-11-02 12:00' }, 'art')).toThrow(/ISO-8601/);
    expect(() => parseTurn({ ...msg('p', 0), kind: 'chat' }, 'art')).toThrow(/kind/);
    expect(() => parseTurn({ ...msg('p', 0), label: 'x'.repeat(81) }, 'art')).toThrow(/label/);
    expect(parseTurn(reply('p', 0), 'art')).toEqual(reply('p', 0));
  });
});

// ─── 2. The audit order (the store's half) ──────────────────────────────────

describe('criterion 2 (store half): a turn knows its writer, and a missing (conversation, seq) has none', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loom-conv-writer-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('turnWriter is what an audit write is checked against', () => {
    const { conversation, seq } = recordTurn(dir, 'art', msg('dm:U1', 0), 'runtime:shuttle');
    expect(turnWriter(dir, conversation, seq)).toBe('runtime:shuttle');
    // A (conversation, seq) that doesn't exist has no writer: the audit write is refused.
    expect(turnWriter(dir, conversation, seq + 1)).toBeUndefined();
    expect(turnWriter(dir, 'cv-000000000000', 1)).toBeUndefined();
    // A different writer is a different string.
    expect(turnWriter(dir, conversation, seq)).not.toBe('agent:art');
  });
});

// ─── 3. Digests ─────────────────────────────────────────────────────────────

describe('criterion 3: digests (conversation_digest)', () => {
  let h: Household;
  let art: string;
  let conv: string;

  beforeEach(() => {
    h = household('loom-conv-digest-');
    process.env.LOOM_HOME = h.home;
    art = agentDir(h, 'art');
    conv = recordTurn(art, 'art', msg('dm:U1', 0), 'runtime:shuttle').conversation;
  });
  afterEach(() => { restoreEnv(); rmSync(h.home, { recursive: true, force: true }); });

  it('goes to the identity\'s conversation and run; the same run replaces, another run adds', async () => {
    const { call } = await mcp(art);
    const none = await call('conversation_digest', { summary: 'Loren asked about the WAF.' });
    expect(none.error).toBe(true);
    expect(String(none.body.error)).toMatch(/pass conversation and run to identity first/);

    await call('identity', { conversation: conv, run: 'run-1' });
    const d1 = await call('conversation_digest', { summary: 'Loren asked about the WAF.', asks: ['unblock the WAF'] });
    expect(d1.error).toBe(false);
    expect(d1.body).toMatchObject({ id: digestId(conv, 'run-1'), conversation: conv, run: 'run-1', asks: ['unblock the WAF'], needs_owner: null });
    await call('conversation_digest', { summary: 'Loren asked about the WAF; it is filed.', tasks: ['t-1271'] });
    let ds = digestsOf(art, conv);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ id: digestId(conv, 'run-1'), summary: 'Loren asked about the WAF; it is filed.', asks: [], tasks: ['t-1271'] });

    await call('identity', { conversation: conv, run: 'run-2' });
    await call('conversation_digest', { summary: 'Followed up.' });
    ds = digestsOf(art, conv);
    expect(ds.map((d) => d.run).sort()).toEqual(['run-1', 'run-2']);
  });

  it('is never written for another agent\'s conversation', async () => {
    const theirs = recordTurn(agentDir(h, 'pond-bot'), 'pond-bot', { ...msg('dm:U1', 0) }, 'runtime:shuttle').conversation;
    const { call } = await mcp(art);
    await call('identity', { conversation: theirs, run: 'run-1' });
    const r = await call('conversation_digest', { summary: 'x' });
    expect(r.error).toBe(true);
    expect(String(r.body.error)).toMatch(/no conversation/);
    expect(digestsOf(agentDir(h, 'pond-bot'), theirs)).toEqual([]);
  });

  it('unknown keys and the caps reject', async () => {
    const { call } = await mcp(art);
    await call('identity', { conversation: conv, run: 'run-1' });
    expect((await call('conversation_digest', { summary: 'x', mood: 'good' })).error).toBe(true);
    expect(() => parseDigest({ summary: 'x', mood: 'good' })).toThrow(/no key "mood"/);
    expect(() => parseDigest({ summary: 'x'.repeat(601) })).toThrow(/summary/);
    expect(() => parseDigest({ summary: '' })).toThrow(/summary/);
    expect(() => parseDigest({ summary: 'x', projects: ['a', 'b', 'c', 'd', 'e'] })).toThrow(/projects/);
    expect(() => parseDigest({ summary: 'x', asks: Array(9).fill('a') })).toThrow(/asks/);
    expect(() => parseDigest({ summary: 'x', asks: ['a'.repeat(201)] })).toThrow(/asks/);
    expect(() => parseDigest({ summary: 'x', decisions: Array(9).fill('a') })).toThrow(/decisions/);
    expect(() => parseDigest({ summary: 'x', tasks: Array(17).fill('t-1') })).toThrow(/tasks/);
    expect(() => parseDigest({ summary: 'x', tasks: ['t'.repeat(65)] })).toThrow(/tasks/);
    expect(() => parseDigest({ summary: 'x', needs_owner: 'x'.repeat(201) })).toThrow(/needs_owner/);
    expect(() => parseDigest({ summary: 'x', needs_owner: 'two\nlines' })).toThrow(/needs_owner/);
    expect(parseDigest({ summary: 'x', asks: Array(8).fill('a'.repeat(200)), tasks: Array(16).fill('t'.repeat(64)), projects: ['a', 'b', 'c', 'd'], needs_owner: 'n'.repeat(200) })).toBeTruthy();
    expect(digestsOf(art, conv)).toEqual([]);
  });

  it('is never compared with audit text: a quote is the agent\'s judgment', () => {
    const d = writeDigest(art, { conversation: conv, run: 'run-1' }, { summary: 'Corrected me on his name: "Nobody calls me Danny." Daniel it is.' });
    expect(d.summary).toBe('Corrected me on his name: "Nobody calls me Danny." Daniel it is.');
  });

  describe('projects (projects.md\'s tables, as its store will hold them)', () => {
    const projects = (cards: Array<{ slug: string; aliases?: string[]; venues?: string[]; archived?: boolean }>) => {
      const db = new BetterSqlite3(join(art, 'memories.db'));
      db.exec(`CREATE TABLE IF NOT EXISTS projects (slug TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT, card_json TEXT NOT NULL, archived_at TEXT, archived_by TEXT, archive_reason TEXT, updated TEXT, synthesized_at TEXT);
               CREATE TABLE IF NOT EXISTS project_names (name TEXT PRIMARY KEY, slug TEXT NOT NULL, kind TEXT NOT NULL);`);
      for (const c of cards) {
        db.prepare('INSERT INTO projects (slug, name, status, card_json, archived_at, updated) VALUES (?, ?, ?, ?, ?, ?)').run(
          c.slug, c.slug, 'active', JSON.stringify({ slug: c.slug, name: c.slug, links: { aliases: c.aliases ?? [], venues: c.venues ?? [] } }), c.archived ? at(0) : null, at(0));
        if (!c.archived) {
          db.prepare('INSERT INTO project_names VALUES (?, ?, ?)').run(c.slug, c.slug, 'slug');
          for (const a of c.aliases ?? []) db.prepare('INSERT INTO project_names VALUES (?, ?, ?)').run(a, c.slug, 'alias');
        }
      }
      db.close();
    };

    it('names resolve to slugs; a name that is no live project\'s is rejected', () => {
      projects([{ slug: 'pond', aliases: ['on-pond'] }, { slug: 'hockey' }]);
      const d = writeDigest(art, { conversation: conv, run: 'r' }, { summary: 'x', projects: ['on-pond', 'pond', 'hockey'] });
      expect(d.projects).toEqual(['pond', 'hockey']);
      expect(() => writeDigest(art, { conversation: conv, run: 'r' }, { summary: 'x', projects: ['mud'] })).toThrow(/mud is no live project's name/);
      expect(getConversation(art, conv)!.projects).toEqual(['hockey', 'pond']);
    });

    it('with none named, falls back to the single live project whose links.venues has <venue>:<place>', () => {
      projects([{ slug: 'pond', venues: ['slack:dm:U1'] }, { slug: 'old', venues: ['slack:dm:U1'], archived: true }, { slug: 'hockey', venues: ['slack:C0HOCKEY'] }]);
      expect(writeDigest(art, { conversation: conv, run: 'r' }, { summary: 'x' }).projects).toEqual(['pond']);
    });

    it('…and to none when several match', () => {
      projects([{ slug: 'pond', venues: ['slack:dm:U1'] }, { slug: 'hockey', venues: ['slack:dm:U1'] }]);
      expect(writeDigest(art, { conversation: conv, run: 'r' }, { summary: 'x' }).projects).toEqual([]);
    });

    it('without a projects store, names are kept as written and nothing falls back', () => {
      expect(writeDigest(art, { conversation: conv, run: 'r' }, { summary: 'x', projects: ['pond'] }).projects).toEqual(['pond']);
      expect(writeDigest(art, { conversation: conv, run: 's' }, { summary: 'x' }).projects).toEqual([]);
    });
  });
});

// ─── 4. Retention ───────────────────────────────────────────────────────────

describe('criterion 4: retention (the fold)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loom-conv-fold-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const day = (d: string, hhmm: string) => `${d}T${hhmm}:00.000Z`;
  const turn = (iso: string, kind: 'message' | 'reply', model?: string, outcome: 'answered' | 'failed' = 'answered'): TurnInput => kind === 'message'
    ? { venue: 'slack', place: 'dm:U1', at: iso, from: { kind: 'person', slug: 'loren' }, kind }
    : { venue: 'slack', place: 'dm:U1', at: iso, from: { kind: 'agent', id: 'art' }, kind, run: 'r', outcome, ...(model ? { model } : {}) };

  it('folds whole days only into conversation_days rows with the stated fields, deletes their turns, and never refolds', () => {
    const now = new Date('2026-11-02T12:00:00.000Z');   // the cutoff is 2026-08-04T12:00Z
    const w = (t: TurnInput) => recordTurn(dir, 'art', t, 'runtime:shuttle');
    // 2026-07-01: whole and old. Latencies 60 s and 120 s (median 90 s); one model, two outcomes; one turn with none.
    w(turn(day('2026-07-01', '09:00'), 'message')); w(turn(day('2026-07-01', '09:01'), 'reply', 'opus'));
    w(turn(day('2026-07-01', '10:00'), 'message')); w(turn(day('2026-07-01', '10:02'), 'reply', 'opus', 'failed'));
    w(turn(day('2026-07-01', '11:00'), 'reply'));
    // 2026-08-04: its first turn is past the cutoff, its last isn't: not a whole day yet.
    w(turn(day('2026-08-04', '01:00'), 'message')); w(turn(day('2026-08-04', '20:00'), 'reply', 'opus'));
    const id = conversationId('art', 'slack', 'dm:U1');
    writeDigest(dir, { conversation: id, run: 'r' }, { summary: 'kept for good' });

    expect(foldConversations(dir, now)).toEqual({ days: 1, turns: 5 });
    const days = daysOf(dir, id);
    expect(days).toEqual([{
      conversation: id, day: '2026-07-01',
      counts: { message: 2, reply: 3 },
      median_latency_ms: 90_000,
      outcomes: { opus: { answered: 1, failed: 1 }, unknown: { answered: 1 } },
    }]);
    expect(turnsOf(dir, id).map((t) => t.at)).toEqual([day('2026-08-04', '01:00'), day('2026-08-04', '20:00')]);
    // The conversation and its digests stay.
    expect(getConversation(dir, id)).toBeDefined();
    expect(digestsOf(dir, id)).toHaveLength(1);

    // Again: nothing to do. A late turn for a folded day is refused, so the row never changes.
    expect(foldConversations(dir, now)).toEqual({ days: 0, turns: 0 });
    expect(() => w(turn(day('2026-07-01', '12:00'), 'message'))).toThrow(ConversationError);
    expect(daysOf(dir, id)).toEqual(days);

    // Later, 2026-08-04 is whole and folds too; 2026-07-01 is still the one row it was.
    expect(foldConversations(dir, new Date('2026-11-03T00:00:00.000Z'))).toEqual({ days: 1, turns: 2 });
    expect(daysOf(dir, id).map((d) => d.day)).toEqual(['2026-07-01', '2026-08-04']);
    expect(daysOf(dir, id)[0]).toEqual(days[0]);
    // seq keeps increasing past the folded turns.
    expect(w(turn(day('2026-11-02', '11:00'), 'message')).seq).toBe(8);
  });

  it('a store without conversations folds nothing', () => {
    expect(foldConversations(dir)).toEqual({ days: 0, turns: 0 });
  });
});

// ─── 5. Venues ──────────────────────────────────────────────────────────────

describe('criterion 5: venues', () => {
  it('every declaration rule rejects at install (the loom block), including kind missing, core names, and relay from a non-runtime piece', () => {
    const bins = ['loom-slack'];
    const block = (venues: unknown, role?: string) => parseLoomBlock({ ...(role ? { role } : {}), venues }, 'slack', bins);
    expect(block({ slack: { label: 'Slack' } })).toMatch(/kind is live, scheduled or agent/);
    expect(block({ slack: { kind: 'live' } })).toMatch(/label is required/);
    expect(block({ slack: { label: 'x'.repeat(41), kind: 'live' } })).toMatch(/label is required/);
    expect(block({ session: { label: 'S', kind: 'live' } })).toMatch(/core's own/);
    expect(block({ wake: { label: 'W', kind: 'scheduled' } })).toMatch(/core's own/);
    expect(block({ relay: { label: 'R', kind: 'agent' } })).toMatch(/only by the runtime/);
    expect(block({ relay: { label: 'R', kind: 'agent' } }, 'runtime')).toMatchObject({ venues: { relay: { label: 'R', kind: 'agent' } } });
    expect(block({ Slack: { label: 'S', kind: 'live' } })).toMatch(/venue's name/);
    expect(block({ ['s'.repeat(33)]: { label: 'S', kind: 'live' } })).toMatch(/venue's name/);
    expect(block(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`v${i}`, { label: 'V', kind: 'live' }])))).toMatch(/at most 8/);
    expect(block({ slack: { label: 'S', kind: 'live', colour: 'blue' } })).toMatch(/no key "colour"/);
    expect(block({ slack: { label: 'S', kind: 'live', render: [] } })).toMatch(/render/);
    expect(block({ slack: { label: 'S', kind: 'live', render: ['sh', '-c', 'x'] } })).toMatch(/one of the piece's own bins/);
    expect(block({ slack: { label: 'S', kind: 'live', render: Array(17).fill('loom-slack') } })).toMatch(/render/);
    expect(block({ slack: { label: 'S', kind: 'live', render: ['loom-slack', 'x'.repeat(201)] } })).toMatch(/render/);
  });

  describe('the registry and renders', () => {
    let h: Household;
    let art: string;
    let conv: string;
    beforeEach(() => {
      h = household('loom-conv-venues-');
      process.env.LOOM_HOME = h.home;
      art = agentDir(h, 'art');
      piece(h.home, 'shuttle', { role: 'runtime', venues: SLACK });
      syncVenues(process.env);
      conv = writeTurn(h, { kind: 'runtime', piece: 'shuttle' }, { agent: 'art', ...msg('dm:U1', 0), label: 'Loren (DM)' }).conversation;
      writeTurn(h, { kind: 'runtime', piece: 'shuttle' }, { agent: 'art', ...reply('dm:U1', 30) });
      writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Loren asked about the WAF.', needs_owner: 'approve the exception' });
    });
    afterEach(() => { restoreEnv(); rmSync(h.home, { recursive: true, force: true }); });

    it('with a live render, conversation returns the venue\'s render, run with --conversation <id>', async () => {
      const v = await conversationView(art, 'art', conv);
      expect(v!.render.by).toBe('venue');
      expect(v!.render.feed).toEqual({ groups: [{ title: 'From the venue', items: [{ title: `args render --json --conversation ${conv}` }] }] });
      expect(v!.conversation).toMatchObject({ id: conv, venue_label: 'Slack', turns: 2 });
      expect(v!.digests).toHaveLength(1);
      expect(v!.findings).toEqual([]);
      // And through the MCP tool.
      const { call } = await mcp(art);
      const r = await call('conversation', { id: conv });
      expect((r.body.render as { by: string }).by).toBe('venue');
    });

    it('a render that fails or doesn\'t validate falls back to core\'s, saying why', async () => {
      piece(h.home, 'shuttle', { role: 'runtime', venues: SLACK }, "console.log(JSON.stringify({ groups: [{ title: 'x', items: [{ title: 'y', extra: 1 }] }] }));");
      const v = await conversationView(art, 'art', conv);
      expect(v!.render.by).toBe('core');
      expect(v!.render.error).toMatch(/shuttle: invalid: .*unknown key "extra"/);
    });

    it('removal orphans the rows (render dropped), and the conversation still renders generically; reinstalling clears the mark', async () => {
      rmSync(join(h.home, 'pieces', 'shuttle'), { recursive: true, force: true });
      rmSync(join(h.home, 'pieces', 'bin', 'loom-shuttle'), { force: true });
      expect(syncVenues(process.env)).toEqual(['slack']);
      const row = venueOf(h.home, 'slack')!;
      expect(row).toMatchObject({ name: 'slack', piece: 'shuttle', label: 'Slack', kind: 'live' });
      expect(row.orphaned).toBeTruthy();
      expect(row.render).toBeUndefined();

      const v = await conversationView(art, 'art', conv);
      expect(v!.render.by).toBe('core');
      expect(v!.render.error).toBeUndefined();
      const g = v!.render.feed.groups;
      expect(g.map((x) => x.title)).toEqual(['Conversation', 'Digests', 'Turns']);
      expect(g[0].items[0]).toMatchObject({ title: 'Loren (DM)', person: ['loren'], status: 'Slack', ref: conv, when: at(30) });
      expect(g[1].items[0]).toMatchObject({ body: 'Loren asked about the WAF.', status: 'needs you' });
      expect(g[2].items.map((i) => i.title)).toEqual(expect.arrayContaining(['message: 1', 'reply: 1', 'answered: 1']));
      // No new turns go to an orphaned venue; the record stays.
      expect(() => writeTurn(h, { kind: 'runtime', piece: 'shuttle' }, { agent: 'art', ...msg('dm:U1', 60) })).toThrow(/orphaned/);

      piece(h.home, 'shuttle', { role: 'runtime', venues: SLACK });
      expect(syncVenues(process.env)).toEqual(['slack']);
      expect(venueOf(h.home, 'slack')).toEqual({ name: 'slack', piece: 'shuttle', label: 'Slack', kind: 'live', render: SLACK.slack.render });
      expect((await conversationView(art, 'art', conv))!.render.by).toBe('venue');
    });

    it('update replaces the piece\'s rows; a venue it stops declaring is orphaned, not lost', () => {
      piece(h.home, 'shuttle', { role: 'runtime', venues: { discord: { label: 'Discord', kind: 'live' } } });
      expect(syncVenues(process.env).sort()).toEqual(['discord', 'slack']);
      expect(listVenues(h.home).map((v) => [v.name, v.label, !!v.orphaned])).toEqual([['discord', 'Discord', false], ['slack', 'Slack', true]]);
      // A sync with nothing changed changes nothing.
      expect(syncVenues(process.env)).toEqual([]);
    });

    it('core\'s generic render is in the section-feed schema', () => {
      const c = getConversation(art, conv)!;
      const feed = genericRender(c, digestsOf(art, conv), { counts: { message: 1 }, outcomes: {} }, 'Slack');
      expect(feed.groups[0].title).toBe('Conversation');
    });
  });
});

// ─── 11. Needs you ──────────────────────────────────────────────────────────

describe('criterion 11: Needs you', () => {
  let h: Household;
  beforeEach(() => { h = household('loom-conv-needs-'); process.env.LOOM_HOME = h.home; });
  afterEach(() => { restoreEnv(); rmSync(h.home, { recursive: true, force: true }); });

  it('a needs_owner digest makes an Inbox ask from core linking to the conversation; a later digest without one clears it', () => {
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { ...msg('dm:U1', 0), label: 'Loren (DM)' }, 'runtime:shuttle').conversation;
    const other = recordTurn(art, 'art', msg('dm:U2', 0, 'matt'), 'runtime:shuttle').conversation;
    writeDigest(art, { conversation: other, run: 'r1' }, { summary: 'Nothing for the owner.' });
    expect(conversationAsks(h)).toEqual([]);

    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Loren wants the WAF exception.', needs_owner: 'approve the WAF exception' }, new Date(T0));
    const asks = conversationAsks(h);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ text: 'art needs you: approve the WAF exception', page: `loom:conversation/${conv}`, agent: 'art', source: { id: 'loom' } });
    expect(asks[0].attention).not.toBe(false);
    expect(coreAsks(h).map((a) => a.page)).toContain(`loom:conversation/${conv}`);

    // The same run rewritten still needing the owner: still one ask.
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Still waiting.', needs_owner: 'approve the WAF exception' }, new Date(T0 + 1000));
    expect(conversationAsks(h)).toHaveLength(1);
    // A later run's digest with none clears it.
    writeDigest(art, { conversation: conv, run: 'r2' }, { summary: 'Approved; done.' }, new Date(T0 + 2000));
    expect(conversationAsks(h)).toEqual([]);
  });
});

// ─── 12. Projects ───────────────────────────────────────────────────────────

describe('criterion 12: the projects hub\'s conversations section', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loom-conv-hub-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('the 20 with the newest last whose projects include the project, newest first, each with its fields; since marks new, never filters', () => {
    // 25 pond conversations, last at 1..25 minutes; 3 hockey ones newer than all of them.
    for (let i = 1; i <= 25; i++) {
      const { conversation } = recordTurn(dir, 'art', { ...msg(`p${i}`, i * 60, `person-${i}`), label: `Pond ${i}` }, 'runtime:shuttle');
      writeDigest(dir, { conversation, run: 'old' }, { summary: `old ${i}`, projects: ['pond'] }, new Date(T0));
      writeDigest(dir, { conversation, run: 'new' }, { summary: `pond ${i}`, projects: ['pond'], ...(i === 25 ? { needs_owner: 'answer Loren' } : {}) }, new Date(T0 + 1000));
    }
    for (let i = 1; i <= 3; i++) {
      const { conversation } = recordTurn(dir, 'art', msg(`h${i}`, 9000 + i), 'runtime:shuttle');
      writeDigest(dir, { conversation, run: 'r' }, { summary: 'hockey', projects: ['hockey'] });
    }
    const since = at(20 * 60 - 1);   // after conversation 19's last, before 20's
    const s = conversationsSection(dir, 'pond', since);
    expect(s.key).toBe('conversations');
    expect(s.items).toHaveLength(20);
    expect(s.items.map((i) => i.label)).toEqual(Array.from({ length: 20 }, (_, k) => `Pond ${25 - k}`));
    expect(s.items[0]).toEqual({
      id: conversationId('art', 'slack', 'p25'), venue: 'slack', label: 'Pond 25', people: ['person-25'], last: at(25 * 60),
      summary: 'pond 25', needs_owner: 'answer Loren', new: true,
    });
    expect(s.items.filter((i) => i.new).map((i) => i.label)).toEqual(['Pond 25', 'Pond 24', 'Pond 23', 'Pond 22', 'Pond 21', 'Pond 20']);
    expect(s.items[1].needs_owner).toBeNull();
    expect(conversationsSection(dir, 'hockey', since).items).toHaveLength(3);
    expect(conversationsSection(dir, 'mud', since).items).toEqual([]);
  });
});

describe('criterion 12, end to end: project_hub carries the conversations core section after people', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loom-conv-hub-e2e-')); });
  afterEach(() => { closeAllBackends(); rmSync(dir, { recursive: true, force: true }); });

  it('real project cards: an alias resolves to the slug, links.venues is the fallback, the hub lists, orders, caps and marks new', async () => {
    // The memory store, migrated (the project and conversation tables with it), and a person store.
    await remember(dir, { category: 'project', title: 'unrelated', content: 'x', project: 'elsewhere' });
    openPeopleStore(dir)!.close();
    const store = openProjectsStore(dir)!;
    store.write({ slug: 'pond', name: 'Pond', links: { aliases: ['on-pond'], venues: ['slack:C0POND'] } });
    store.write({ slug: 'hockey', name: 'Hockey' });
    store.close();

    // 22 conversations named by the alias, one by the venue fallback, one in hockey, one in none.
    for (let i = 1; i <= 22; i++) {
      const { conversation } = recordTurn(dir, 'art', { ...msg(`p${i}`, i * 60, `person-${i}`), label: `Pond ${i}` }, 'runtime:shuttle');
      expect(writeDigest(dir, { conversation, run: 'r' }, { summary: `pond ${i}`, projects: ['on-pond'] }).projects).toEqual(['pond']);
    }
    const chan = recordTurn(dir, 'art', { ...msg('C0POND', 30 * 60), label: 'Pond channel' }, 'runtime:shuttle').conversation;
    expect(writeDigest(dir, { conversation: chan, run: 'r' }, { summary: 'standup', needs_owner: 'pick a date' }).projects).toEqual(['pond']);
    const hk = recordTurn(dir, 'art', msg('h1', 40 * 60), 'runtime:shuttle').conversation;
    writeDigest(dir, { conversation: hk, run: 'r' }, { summary: 'hockey', projects: ['hockey'] });
    const none = recordTurn(dir, 'art', msg('n1', 50 * 60), 'runtime:shuttle').conversation;
    writeDigest(dir, { conversation: none, run: 'r' }, { summary: 'nothing filed' });
    expect(() => writeDigest(dir, { conversation: none, run: 'r2' }, { summary: 'x', projects: ['mud'] })).toThrow(/no live project/);

    const since = at(20 * 60 - 1);
    const r = await projectHubOf(dir, { slug: 'on-pond', since });
    if (!('sections' in r)) throw new Error('no sections');
    expect(r.resolved_from).toBe('on-pond');
    const keys = r.sections.map((x) => x.key);
    expect(keys.indexOf('conversations')).toBe(keys.indexOf('people') + 1);
    const conv = r.sections.find((x) => x.key === 'conversations') as { items: Array<{ label: string | null; new: boolean; needs_owner: string | null; venue: string }> };
    expect(conv.items).toHaveLength(20);
    expect(conv.items.map((i) => i.label)).toEqual(['Pond channel', ...Array.from({ length: 19 }, (_, k) => `Pond ${22 - k}`)]);
    expect(conv.items[0]).toMatchObject({ needs_owner: 'pick a date', new: true, venue: 'slack' });
    expect(conv.items.filter((i) => i.new).length).toBe(4);   // the channel, 22, 21, 20
    const hockey = await projectHubOf(dir, { slug: 'hockey', since });
    expect(('sections' in hockey) && (hockey.sections.find((x) => x.key === 'conversations') as { items: unknown[] }).items).toHaveLength(1);
  });
});

// ─── 13. The boot tape ──────────────────────────────────────────────────────

describe('criterion 13: the boot tape interleaves digests in its window with episodes by time', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loom-conv-tape-')); writeFileSync(join(dir, 'IDENTITY.md'), '# art\n'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('digest · <venue> <label>: <summary>, in time order with the episodes, and none from outside the window', async () => {
    const now = Date.now();
    const ago = (h: number) => new Date(now - h * 3_600_000);
    await remember(dir, { title: 'shipped the fold', content: 'episode body', category: 'episode', metadata: { where: 'terminal' } });
    const db = new BetterSqlite3(join(dir, 'memories.db'));
    db.prepare("UPDATE memories SET created = ? WHERE category = 'episode'").run(ago(3).toISOString());
    db.close();
    const a = recordTurn(dir, 'art', { ...msg('dm:U1', 0), label: 'Loren (DM)' }, 'runtime:shuttle').conversation;
    const b = recordTurn(dir, 'art', { ...msg('C0POND', 0) }, 'runtime:shuttle').conversation;
    writeDigest(dir, { conversation: a, run: 'r1' }, { summary: 'Loren asked about the WAF.' }, ago(5));
    writeDigest(dir, { conversation: b, run: 'r1' }, { summary: 'Pond standup.' }, ago(1));
    writeDigest(dir, { conversation: b, run: 'r0' }, { summary: 'Too old for the tape.' }, ago(30));

    const tape = tapeForContext(dir, { nowMs: now, timeZone: 'UTC' })!;
    const lines = tape.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/\*\* digest · slack Loren \(DM\): Loren asked about the WAF\.$/);
    expect(lines[1]).toContain('shipped the fold');
    expect(lines[2]).toMatch(/\*\* digest · slack C0POND: Pond standup\.$/);
    expect(tape).not.toContain('Too old');
    // The episodes tool reads the same tape.
    const { call } = await mcp(dir);
    expect(String((await call('episodes', {})).body)).toContain('digest · slack Loren (DM)');
  });

  it('digests alone make a tape', () => {
    const a = recordTurn(dir, 'art', msg('dm:U1', 0), 'runtime:shuttle').conversation;
    writeDigest(dir, { conversation: a, run: 'r1' }, { summary: 'Only a digest.' });
    expect(tapeForContext(dir)).toContain('digest · slack dm:U1: Only a digest.');
  });
});

// ─── 14. Scoping ────────────────────────────────────────────────────────────

describe('criterion 14: scoping', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  let pondConv: string;
  let artConv: string;

  beforeAll(async () => {
    h = household('loom-conv-scope-');
    process.env.LOOM_HOME = h.home;
    artConv = recordTurn(agentDir(h, 'art'), 'art', { ...msg('dm:U1', 0), label: 'Art and Loren' }, 'runtime:shuttle').conversation;
    pondConv = recordTurn(agentDir(h, 'pond-bot'), 'pond-bot', { ...msg('C0POND', 10), label: 'Pond channel' }, 'runtime:shuttle').conversation;
    recordTurn(agentDir(h, 'mark'), 'mark', msg('dm:U7', 20, 'sam'), 'runtime:shuttle');
    tok.loren = createToken(h, { role: { kind: 'owner', member: 'loren' }, label: 'loren' }).token;
    tok.owner = createToken(h, { role: { kind: 'owner' }, label: 'owner' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    restoreEnv();
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });

  it('an agent\'s conversations lists only its own', async () => {
    const { call } = await mcp(agentDir(h, 'art'));
    const r = await call('conversations', {});
    expect((r.body.conversations as Array<{ id: string; agent: string }>).map((c) => [c.agent, c.id])).toEqual([['art', artConv]]);
    expect(householdConversations(h, { kind: 'agent', agent: 'art' }).map((c) => c.agent)).toEqual(['art']);
    expect(() => householdConversations(h, { kind: 'agent', agent: 'art' }, { agent: 'mark' })).toThrow(ScopeError);
  });

  it('a member whose agents is ["pond-bot"] sees only pond-bot\'s, and a request naming another agent is refused', () => {
    const loren = { kind: 'member' as const, member: memberOf(h, 'loren')! };
    expect(householdConversations(h, loren).map((c) => c.id)).toEqual([pondConv]);
    expect(householdConversations(h, loren, { agent: 'pond-bot' }).map((c) => c.id)).toEqual([pondConv]);
    expect(() => householdConversations(h, loren, { agent: 'art' })).toThrow(/art isn't one of loren's agents/);
    // A household owner sees every agent's, newest last first.
    const jonathan = { kind: 'member' as const, member: memberOf(h, 'jonathan')! };
    expect(householdConversations(h, jonathan).map((c) => c.agent)).toEqual(['mark', 'pond-bot', 'art']);
  });

  it('over HTTP: loren\'s token reaches pond-bot\'s MCP, not art\'s; the page shows her pond-bot\'s conversation and not art\'s', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
    const mcpPost = (path: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.loren}` }, body: JSON.stringify(init) });
    expect((await mcpPost('/agents/art/mcp')).status).toBe(403);
    expect((await mcpPost('/agents/pond-bot/mcp')).status).toBe(200);

    const page = (path: string, token: string) => fetch(`${base}${path}`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` } });
    const mine = await page(`/conversation/${pondConv}`, tok.loren);
    expect(mine.status).toBe(200);
    expect((await mine.json() as { page: { title: string } }).page.title).toBe('Pond channel');
    expect((await page(`/conversation/${artConv}`, tok.loren)).status).toBe(404);
    // The household owner opens either, at loom:conversation/<id> and under the agent.
    expect((await page(`/conversation/${artConv}`, tok.owner)).status).toBe(200);
    const under = await page(`/a/art/conversation/${artConv}`, tok.owner);
    expect(under.status).toBe(200);
    expect((await under.json() as { page: { title: string } }).page.title).toBe('Art and Loren');
    expect((await page(`/a/art/conversation/${pondConv}`, tok.owner)).status).toBe(404);
  });
});

// ─── 15. Latency ────────────────────────────────────────────────────────────

describe('criterion 15: latency', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loom-conv-latency-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a reply after two messages measures from the first; a reply with none before it has no latency_ms', () => {
    const w = (t: TurnInput) => recordTurn(dir, 'art', t, 'runtime:shuttle');
    expect(w(reply('dm:U1', 0, 'r0')).latency_ms).toBeUndefined();   // the agent spoke first
    w(msg('dm:U1', 10)); w(msg('dm:U1', 40));
    expect(w(reply('dm:U1', 70)).latency_ms).toBe(60_000);
    // A second reply with nothing new waiting: none.
    expect(w(reply('dm:U1', 80)).latency_ms).toBeUndefined();
    w(msg('dm:U1', 100));
    expect(w(reply('dm:U1', 105)).latency_ms).toBe(5_000);
    // An action or a note between doesn't end the wait; only a reply does.
    w(msg('dm:U1', 200)); w({ ...reply('dm:U1', 210), kind: 'action' });
    expect(w(reply('dm:U1', 260)).latency_ms).toBe(60_000);
    // A wake is no message: a reply after one has none.
    const wake: TurnInput = { venue: 'wake', place: 'lane:reflect', at: at(0), from: { kind: 'schedule' }, kind: 'wake' };
    w(wake);
    expect(w({ ...reply('lane:reflect', 30), venue: 'wake' }).latency_ms).toBeUndefined();
    expect(listConversations(dir).length).toBe(2);
  });

  it('due_to_progress_s groups by run: from the wake just before a run\'s first turn to its first progressed or answered turn', () => {
    const t = (seq: number, s: number, kind: TurnInput['kind'], run?: string, outcome?: TurnInput['outcome']) => ({ seq, at: at(s), kind, run, outcome });
    expect(dueToProgressSeconds([
      t(1, 0, 'wake'),
      t(2, 10, 'note', 'a', 'none'), t(3, 20, 'action', 'b', 'progressed'), t(4, 60, 'action', 'a', 'progressed'),
      t(5, 100, 'wake'),
      t(6, 130, 'reply', 'c', 'deferred'), t(7, 220, 'reply', 'c', 'answered'),
    ])).toBe(60);   // runs a: 60 s, b: 20 s, c: 120 s; the median is 60
    expect(dueToProgressSeconds([t(1, 0, 'note', 'a', 'progressed')])).toBeNull();   // no wake before it
  });
});

describe('the household store holds the registry, and a fresh home has none until something declares a venue', () => {
  it('syncVenues makes no household.db for a household with no venues', () => {
    const h = household('loom-conv-hhdb-');
    try {
      piece(h.home, 'notes', {});
      expect(syncVenues({ LOOM_HOME: h.home })).toEqual([]);
      expect(existsSync(join(h.home, 'household.db'))).toBe(false);
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  });
});
