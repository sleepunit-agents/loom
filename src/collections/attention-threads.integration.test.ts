/**
 * A Comms thread's asks are its member's alone (t-2084; docs/specs/comms.md, rule 2). With two owners of one agent
 * (Jonathan, a household owner; Sam, an owner of Art), through the real HTTP server and a stub approvals piece:
 *
 *  - a Needs you raised in Sam's thread is in Sam's Inbox page, attention set, Home and badges, and in none of
 *    Jonathan's; one in Jonathan's thread is never Sam's; a bridge conversation's is both of theirs, as it always was;
 *  - what core holds for the core viewer says so: the record's audience is the thread's member alone;
 *  - an approval asked from Sam's thread is Sam's; a lead card asked from it (only a household owner may give it) is
 *    Jonathan's too, as the one who answers it, and nobody else's thread's card reaches either through /pieces.json;
 *  - Jonathan can't answer Sam's thread's ask through the Inbox's actions (needs-done, needs-reply), even knowing its ids;
 *  - the push watch sends a thread's ask to its member's devices only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
import { createConversationTables, openNeeds, recordTurn, writeDigest } from '../backends/conversations.js';
import { openProjectsStore } from '../backends/projects.js';
import { adapterCall, deleteThread, openThread, threadFor } from '../comms.js';
import { clearPieceCache } from '../ui/pieces.js';
import { closeAllBackends } from '../backends/index.js';
import { pushWatch } from '../ui/handler.js';
import { forgetProjectCounts } from '../ui/projects-pages.js';
import { nudge } from './pull.js';
import { sessionStore } from '../ui/sessions.js';

const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;

const APPROVALS_BIN = `#!${process.execPath}
const fs = require('node:fs');
const f = process.env.LOOM_HOME + '/approvals.json';
const read = () => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return {}; } };
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const a = process.argv.slice(2).filter((x) => x !== '--json');
  const s = read();
  const mine = Object.entries(s).filter(([, x]) => !process.env.LOOM_OWNER_SCOPE || process.env.LOOM_OWNER_SCOPE.split(',').includes(x.agent));
  const cv = (x) => (x.conversation ? { conversation: x.conversation } : {});
  if (a[0] === 'ui' && a.length === 1) {
    return console.log(JSON.stringify({ v: 2, owners: 2, tab: { label: 'Approvals', kind: 'setting' },
      asks: mine.filter(([, x]) => !x.state && !x.unlisted).map(([id, x]) => ({ text: x.text, kind: 'permission', agent: x.agent, page: '', at: x.at, ...(x.lead ? { lead: true } : {}), ...cv(x),
        actions: [{ action: 'allow', label: 'Allow', tone: 'primary', fields: { id } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id } }] })),
      answered: mine.filter(([, x]) => x.state).map(([, x]) => ({ text: x.text, outcome: x.state, at: x.at, agent: x.agent, ...cv(x) })) }));
  }
  if (a[0] === 'api') {
    const req = JSON.parse(input);
    if (req.path !== 'state' || process.env.APPROVALS_NO_STATE) return console.log(JSON.stringify({ status: 404, body: { error: 'no' } }));
    return console.log(JSON.stringify({ status: 200, body: { approvals: Object.fromEntries(req.body.ids.filter((id) => s[id]).map((id) => [id, {
      state: s[id].state ? 'allowed' : 'pending', agent: s[id].agent, kind: s[id].kind ?? 'merge', ...(s[id].old ? {} : { conversation: s[id].conversation ?? null }) }])) } }));
  }
  if (a[0] === 'ui' && a[1] === 'act') {
    const req = JSON.parse(input);
    const x = s[req.fields.id];
    if (!x || x.state) return console.log(JSON.stringify({ ok: false, message: 'not pending' }));
    x.state = req.action === 'allow' ? 'Allowed' : 'Denied';
    fs.writeFileSync(f, JSON.stringify(s));
    return console.log(JSON.stringify({ ok: true, message: 'Allowed.' }));
  }
  process.exit(2);
});
`;

function piece(home: string, name: string, raw: Record<string, unknown>, src: string): void {
  const loom = parseLoomBlock(raw, name, [`loom-${name}`]);
  if (typeof loom === 'string') throw new Error(loom);
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
    bins: [`loom-${name}`], loom: { settings: [], services: [], ...loom } }));
  writeFileSync(join(dir, 'current', 'cli'), src);
  chmodSync(join(dir, 'current', 'cli'), 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  symlinkSync(join(dir, 'current', 'cli'), join(home, 'pieces', 'bin', `loom-${name}`));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = any;
const FIELDS = ['agent', 'kind', 'box', 'attention', 'unread', 'text', 'sort', 'actions'];
const until = async (f: () => boolean, ms = 8000) => { for (let t = 0; t < ms / 25 && !f(); t++) await new Promise((r) => setTimeout(r, 25)); return f(); };

describe.skipIf(!hasAge)('a Comms thread\'s asks are its member\'s alone (t-2084)', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;
  let n = 0;

  beforeEach(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-attention-threads-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
      createConversationTables(db);
      db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['art'] }] }));
    piece(home, 'approvals', { role: 'approvals' }, APPROVALS_BIN);
    writeFileSync(join(home, 'approvals.json'), '{}');
    h = loadHousehold(home)!;
    process.env.LOOM_HOME = h.home;
    clearPieceCache();
    tok.jonathan = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    tok.sam = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle.close();
    await closeAllBackends();
    clearPieceCache();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    rmSync(h.home, { recursive: true, force: true });
  });

  const member = (who: string) => h.members.find((m) => m.person === who)!;
  /** A thread `who` opened with Art, and its conversation in Art's store (as the runtime's first delivery records it). */
  const thread = (who: string) => {
    const t = openThread(h, process.env, member(who), { agent: 'art', id: `${'abcdefghijklmnop'.slice(0, 15)}${'abcdefgh'[n++ % 8]}`, text: 'hello' }).thread;
    const cv = recordTurn(agentDir(h, 'art'), 'art', { venue: 'loom', place: t.id, label: 'thread', at: new Date().toISOString(), from: { kind: 'person', slug: who }, kind: 'message' } as never, 'runtime:runtime').conversation;
    expect(cv).toBe(t.conversation);
    return t;
  };
  const bridge = () => recordTurn(agentDir(h, 'art'), 'art', { venue: 'slack', place: 'dm:U1', label: 'Loren (DM)', at: new Date().toISOString(), from: { kind: 'person', slug: 'loren' }, kind: 'message' } as never, 'runtime:shuttle').conversation;
  const needs = (cv: string, ask: string) => writeDigest(agentDir(h, 'art'), { conversation: cv, run: `r-${ask.length}` }, { summary: 'Asked.', needs_owner: { ask, why: 'Because.', if_yes: 'I do it.', if_no: 'I wait.' } } as never);
  const cards = (c: Record<string, unknown>) => { writeFileSync(join(h.home, 'approvals.json'), JSON.stringify(c)); clearPieceCache(); };

  const get = async (who: string, path: string): Promise<Data> => (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${tok[who]}`, accept: 'application/json' } })).json();
  const texts = (xs: Data[]) => xs.map((x) => x.text as string);
  const live = async (who: string, q: Record<string, unknown> = {}) => {
    const r = await fetch(`${base}/collections/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok[who]}` },
      body: JSON.stringify({ queries: [{ id: 'q', type: 'loom/attention@^1', fields: FIELDS, ...q }] }) });
    return ((await r.json()) as { answers: Data[] }).answers[0];
  };

  it('a Needs you in one member\'s thread reaches only that member: Inbox, live set, Home and badges', async () => {
    needs(thread('sam').conversation, 'Sam: OK to ship the comm screen?');
    needs(thread('jonathan').conversation, 'Jonathan: OK to rename the band?');
    needs(bridge(), 'Loren wants the WAF exception: OK?');

    const sam = await get('sam', '/inbox');
    const jon = await get('jonathan', '/inbox');
    expect(texts(sam.items)).toEqual(expect.arrayContaining(['Sam: OK to ship the comm screen?', 'Loren wants the WAF exception: OK?']));
    expect(texts(sam.items)).not.toContain('Jonathan: OK to rename the band?');
    expect(texts(jon.items)).toEqual(expect.arrayContaining(['Jonathan: OK to rename the band?', 'Loren wants the WAF exception: OK?']));
    expect(texts(jon.items)).not.toContain('Sam: OK to ship the comm screen?');
    // Nothing of it anywhere in Jonathan's answer: not its words, nor its why, nor its thread.
    expect(JSON.stringify(jon)).not.toMatch(/ship the comm screen/);

    // The live set is the same items, and its count the same Needs you.
    for (const [who, page] of [['sam', sam], ['jonathan', jon]] as const) {
      const a = await live(who);
      expect(a.error, who).toBeUndefined();
      expect(texts(a.rows).sort(), who).toEqual(texts(page.items).sort());
      const c = await live(who, { where: [['attention', 'eq', true]], aggregates: ['count'] });
      expect(c.aggregates.count.n, who).toBe((page.items as Data[]).filter((i) => i.attention).length);
    }

    // Home's Needs you and the badges count the same, per member: two asks each (their own thread's and the bridge's).
    for (const who of ['sam', 'jonathan']) {
      const home = await get(who, '/');
      expect(home.home.needs, who).toBe(2);
      expect(JSON.stringify(home.home.stack)).not.toMatch(who === 'sam' ? /rename the band/ : /ship the comm screen/);
      expect(home.chrome.shell.asks, who).toBe(2);
      expect(home.chrome.shell.agents.find((a: Data) => a.id === 'art').asks, who).toBe(2);
      const today = await get(who, '/a/art');
      expect(today.dashboard.agent.waiting, who).toBe(2);
      expect(texts(today.dashboard.asks), who).not.toContain(who === 'sam' ? 'Jonathan: OK to rename the band?' : 'Sam: OK to ship the comm screen?');
    }

    // Asked by its key, Sam's ask is open for Sam and "not open" for Jonathan, who can't learn it's there.
    const key = (sam.items as Data[]).find((i) => i.text === 'Sam: OK to ship the comm screen?').key;
    expect(await get('sam', `/inbox/open?k=${key}`)).toEqual({ open: true });
    expect(await get('jonathan', `/inbox/open?k=${key}`)).toEqual({ open: false });
    expect((await get('jonathan', `/inbox?i=${key}`)).open ?? null).toBeNull();
  }, 30_000);

  it('what core holds for the core viewer names the thread\'s member alone', async () => {
    needs(thread('sam').conversation, 'Sam: OK to ship the comm screen?');
    needs(bridge(), 'Loren wants the WAF exception: OK?');
    const ev = new AbortController();
    try {
      const r = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${tok.sam}`, accept: 'text/event-stream' }, signal: ev.signal });
      const reader = r.body!.getReader();
      let buf = '';
      while (!/event: hello/.test(buf)) buf += new TextDecoder().decode((await reader.read()).value);
      const stream = JSON.parse(/event: hello\ndata: (.*)/.exec(buf)![1]).stream;
      await get('sam', '/inbox');
      await fetch(`${base}/collections/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.sam}` },
        body: JSON.stringify({ queries: [{ id: 'q', type: 'loom/attention@^1', fields: FIELDS, subscribe: true, stream }] }) });
      nudge(h.home, 'loom/attention');
      const idx = () => {
        try {
          const db = new BetterSqlite3(join(h.home, 'collections', 'live.db'), { readonly: true });
          try { return db.prepare("SELECT audience, record FROM idx WHERE key LIKE 'loom/attention/%'").all() as Array<{ audience: string; record: string }>; } finally { db.close(); }
        } catch { return []; }
      };
      const whose = (text: string) => { const x = idx().find((r2) => JSON.parse(r2.record).text === text); return x ? JSON.parse(x.audience) : undefined; };
      expect(await until(() => !!whose('Sam: OK to ship the comm screen?'))).toBe(true);
      expect(whose('Sam: OK to ship the comm screen?')).toEqual({ members: ['sam'] });
      expect(whose('Loren wants the WAF exception: OK?')).toEqual({ members: ['jonathan', 'sam'] });
    } finally { ev.abort(); }
  }, 30_000);

  it('an approval asked from Sam\'s thread is Sam\'s; a lead card from it is the household owner\'s too', async () => {
    const t = thread('sam');
    cards({
      'a-00000001': { agent: 'art', text: 'OK to merge the comm screen PR?', at: '2026-11-10T10:00:00Z', conversation: t.conversation },
      'a-00000002': { agent: 'art', text: 'Give Art the relay piece?', at: '2026-11-10T10:01:00Z', conversation: t.conversation, lead: true },
      'a-00000003': { agent: 'art', text: 'Let Art read the shared calendar?', at: '2026-11-10T10:02:00Z' },
    });
    const sam = texts((await get('sam', '/inbox')).items);
    const jon = texts((await get('jonathan', '/inbox')).items);
    expect(sam).toEqual(expect.arrayContaining(['OK to merge the comm screen PR?', 'Give Art the relay piece?', 'Let Art read the shared calendar?']));
    expect(jon).toEqual(expect.arrayContaining(['Give Art the relay piece?', 'Let Art read the shared calendar?']));
    expect(jon).not.toContain('OK to merge the comm screen PR?');
    expect(texts((await live('jonathan')).rows)).not.toContain('OK to merge the comm screen PR?');
    // The pieces' manifests as the app reads them carry none of it either.
    const pj = await fetch(`${base}/pieces.json`, { headers: { authorization: `Bearer ${tok.jonathan}` } });
    expect(pj.status).toBe(200);
    const pjText = await pj.text();
    expect(pjText).toMatch(/Give Art the relay piece/);
    expect(pjText).not.toMatch(/merge the comm screen/);
    expect((await get('jonathan', '/')).chrome.shell.asks).toBe(2);
  }, 30_000);

  it('Jonathan can\'t answer Sam\'s thread\'s ask, even naming it exactly', async () => {
    const t = thread('sam');
    needs(t.conversation, 'Sam: OK to ship the comm screen?');
    const item = ((await get('sam', '/inbox')).items as Data[]).find((i) => i.text === 'Sam: OK to ship the comm screen?');
    const fields = item.reply.fields as { conversation: string; digest: string };
    const csrf = (await get('jonathan', '/inbox')).ctx.csrf;
    for (const [action, more] of [['needs-done', {}], ['needs-dismiss', {}], ['needs-reply', { text: 'Ship it.' }]] as const) {
      const r = await fetch(`${base}/a/art/act/loom`, { method: 'POST', headers: { authorization: `Bearer ${tok.jonathan}`, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' },
        body: new URLSearchParams({ _csrf: csrf, _action: action, _path: 'loom:inbox', ...fields, ...more }).toString() });
      const body = (await r.json()) as { ok: boolean; message: string };
      expect(body.ok, action).toBe(false);
      expect(body.message).toBe('That conversation isn\'t one of this agent\'s.');
    }
    expect(openNeeds(agentDir(h, 'art')).map((x) => x.conversation.id)).toEqual([t.conversation]);
    // Its own member can.
    const samCsrf = (await get('sam', '/inbox')).ctx.csrf;
    const r = await fetch(`${base}/a/art/act/loom`, { method: 'POST', headers: { authorization: `Bearer ${tok.sam}`, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' },
      body: new URLSearchParams({ _csrf: samCsrf, _action: 'needs-done', _path: 'loom:inbox', ...fields }).toString() });
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    expect(openNeeds(agentDir(h, 'art'))).toEqual([]);
  }, 30_000);

  it('the push watch sends a thread\'s ask to its member\'s devices only', async () => {
    const store = sessionStore(h.home);
    const sub = (path: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${path}`, keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } });
    store.addPushSub(store.create(Buffer.alloc(32, 1)), sub('jon'));                       // the first owner's: no member
    store.addPushSub(store.create(Buffer.alloc(32, 2)), sub('sam'), undefined, 'sam');
    const sent: Array<{ to: string; tag: string }> = [];
    const minute = async () => {
      const f = join(h.home, 'ui-sessions.json');
      try { const j = JSON.parse(readFileSync(f, 'utf8')); if (j.push) { delete j.push.tickAt; writeFileSync(f, JSON.stringify(j)); } } catch { /* first */ }
      const send = async (s: { endpoint: string }, payload: string) => { sent.push({ to: s.endpoint, tag: JSON.parse(payload).tag }); return {} as never; };
      return pushWatch({ contextDir: agentDir(h, 'art'), auth: { enabled: true, check: () => null, live: () => false }, env: process.env, household: () => h } as never, send as never);
    };
    await minute();                                                                          // the first watch records only
    needs(thread('sam').conversation, 'Sam: OK to ship the comm screen?');
    needs(thread('jonathan').conversation, 'Jonathan: OK to rename the band?');
    needs(bridge(), 'Loren wants the WAF exception: OK?');
    await minute();
    const to = (who: string) => sent.filter((x) => x.to.endsWith(who)).length;
    // Sam: his thread's and the bridge's; Jonathan: his thread's and the bridge's. Never the other's thread.
    expect(to('sam')).toBe(2);
    expect(to('jon')).toBe(2);
    const tags = (who: string) => new Set(sent.filter((x) => x.to.endsWith(who)).map((x) => x.tag));
    expect([...tags('sam')].filter((t) => tags('jon').has(t))).toHaveLength(1);
  }, 30_000);

  const act = async (who: string, path: string, fields: Record<string, string>) => {
    const csrf = (await get(who, '/inbox')).ctx.csrf;
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${tok[who]}`, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' },
      body: new URLSearchParams({ _csrf: csrf, _path: 'loom:inbox', ...fields }).toString() });
    return (await r.json()) as { ok: boolean; message: string };
  };

  it('Jonathan can\'t Allow an approval asked from Sam\'s thread, even naming its id; a lead card from it he can; Sam can his own', async () => {
    const t = thread('sam');
    cards({
      'a-00000001': { agent: 'art', text: 'OK to merge the comm screen PR?', at: '2026-11-10T10:00:00Z', conversation: t.conversation },
      'a-00000002': { agent: 'art', text: 'Give Art the relay piece?', at: '2026-11-10T10:01:00Z', conversation: t.conversation, lead: true },
    });
    for (const path of ['/act/approvals']) {
      const r = await act('jonathan', path, { _action: 'allow', id: 'a-00000001' });
      expect(r.ok, path).toBe(false);
      expect(JSON.parse(readFileSync(join(h.home, 'approvals.json'), 'utf8'))['a-00000001'].state).toBeUndefined();
    }
    const lead = await act('jonathan', '/act/approvals', { _action: 'allow', id: 'a-00000002' });
    expect(lead.message).not.toBe('That ask isn\'t open any more.');
    expect(JSON.parse(readFileSync(join(h.home, 'approvals.json'), 'utf8'))['a-00000002'].state).toBe('Allowed');
    expect((await act('sam', '/act/approvals', { _action: 'deny', id: 'a-00000001' })).ok).toBe(true);
    // Once answered, its history (the piece's answered entry, naming the thread's conversation) is Sam's alone too.
    clearPieceCache();
    const done = (who: string) => get(who, '/inbox?f=done').then((p) => texts(p.items));
    expect(await done('sam')).toContain('OK to merge the comm screen PR?');
    expect(await done('jonathan')).not.toContain('OK to merge the comm screen PR?');
  }, 30_000);

  it('a deleted thread\'s ask stays its member\'s; a loom conversation with no thread is no one\'s', async () => {
    const t = thread('sam');
    needs(t.conversation, 'Sam: OK to ship the comm screen?');
    deleteThread(h, threadFor(h, member('sam'), t.id));
    expect(texts((await get('jonathan', '/inbox')).items)).not.toContain('Sam: OK to ship the comm screen?');
    expect(texts((await get('sam', '/inbox')).items)).toContain('Sam: OK to ship the comm screen?');
    const stray = recordTurn(agentDir(h, 'art'), 'art', { venue: 'loom', place: 'th:zzzzzzzzzz', label: 'x', at: new Date().toISOString(), from: { kind: 'person', slug: 'sam' }, kind: 'message' } as never, 'runtime:runtime').conversation;
    needs(stray, 'Stray: OK to do the stray thing?');
    for (const who of ['sam', 'jonathan']) expect(texts((await get(who, '/inbox')).items), who).not.toContain('Stray: OK to do the stray thing?');
  }, 30_000);

  it('a spawned job\'s ask follows its thread\'s member, deleted or not; one with no thread is no one\'s, then the household owners\'', async () => {
    const parent = thread('sam');
    const job = recordTurn(agentDir(h, 'art'), 'art', { venue: 'spawn', place: 'sp-1', label: 'job', at: new Date().toISOString(), from: { kind: 'agent', id: 'art' }, kind: 'message' } as never, 'runtime:runtime').conversation;
    needs(job, 'Job: OK to restart the build?');
    // Before the runtime opened its thread (it may yet): no one's.
    for (const who of ['sam', 'jonathan']) expect(texts((await get(who, '/inbox')).items), who).not.toContain('Job: OK to restart the build?');
    const r = adapterCall(h, process.env, { op: 'spawn', agent: 'art', conversation: job, parent: parent.conversation, text: 'Restart the build' }) as { id: string };
    expect(texts((await get('sam', '/inbox')).items)).toContain('Job: OK to restart the build?');
    expect(texts((await get('jonathan', '/inbox')).items)).not.toContain('Job: OK to restart the build?');
    // Its thread deleted: still Sam's, never the household owner's.
    deleteThread(h, threadFor(h, member('sam'), r.id));
    expect(texts((await get('sam', '/inbox')).items)).toContain('Job: OK to restart the build?');
    expect(texts((await get('jonathan', '/inbox')).items)).not.toContain('Job: OK to restart the build?');
    // A job whose thread never opened (long past the runtime's step): the household owners'.
    const old = recordTurn(agentDir(h, 'art'), 'art', { venue: 'spawn', place: 'sp-2', label: 'job', at: new Date(Date.now() - 3_600_000).toISOString(), from: { kind: 'agent', id: 'art' }, kind: 'message' } as never, 'runtime:runtime').conversation;
    needs(old, 'Old job: OK to rerun it?');
    expect(texts((await get('sam', '/inbox')).items)).not.toContain('Old job: OK to rerun it?');
    expect(texts((await get('jonathan', '/inbox')).items)).toContain('Old job: OK to rerun it?');
  }, 30_000);

  it('an approval on no card (the piece lists only so many) is answered by its own record: refused unless it\'s theirs, or the piece can\'t say', async () => {
    const t = thread('sam');
    cards({
      'a-00000011': { agent: 'art', text: 'Sam\'s unlisted one?', at: '2026-11-10T10:00:00Z', conversation: t.conversation, unlisted: true },
      'a-00000012': { agent: 'art', text: 'A bridge\'s unlisted one?', at: '2026-11-10T10:00:00Z', unlisted: true },
      'a-00000013': { agent: 'art', text: 'An old piece\'s unlisted one?', at: '2026-11-10T10:00:00Z', unlisted: true, old: true },
      'a-00000014': { agent: 'art', text: 'A grant from Sam\'s thread?', at: '2026-11-10T10:00:00Z', conversation: t.conversation, unlisted: true, kind: 'grant' },
    });
    const state = (id: string) => JSON.parse(readFileSync(join(h.home, 'approvals.json'), 'utf8'))[id].state;
    expect((await act('jonathan', '/act/approvals', { _action: 'deny', id: 'a-00000011' })).message).toBe('That ask isn\'t open any more.');
    expect(state('a-00000011')).toBeUndefined();
    expect((await act('jonathan', '/act/approvals', { _action: 'deny', id: 'a-00000013' })).message).toBe('That ask isn\'t open any more.');
    expect(state('a-00000013')).toBeUndefined();
    expect((await act('jonathan', '/act/approvals', { _action: 'deny', id: 'a-00000012' })).ok).toBe(true);
    expect((await act('jonathan', '/act/approvals', { _action: 'deny', id: 'a-00000014' })).ok).toBe(true);
    expect((await act('sam', '/act/approvals', { _action: 'deny', id: 'a-00000011' })).ok).toBe(true);
  }, 30_000);

  it('a thread whose member no longer owns its agent: its ask goes to household owners, never lost', async () => {
    needs(thread('sam').conversation, 'Sam: OK to ship the comm screen?');
    expect(texts((await get('jonathan', '/inbox')).items)).not.toContain('Sam: OK to ship the comm screen?');
    writeFileSync(join(h.home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['mark'] }] }));
    h = loadHousehold(h.home)!;
    clearPieceCache();
    expect(texts((await get('jonathan', '/inbox')).items)).toContain('Sam: OK to ship the comm screen?');
  }, 30_000);

  it('the Projects hub and index count only the viewer\'s own thread asks', async () => {
    writeFileSync(join(h.home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: '*' }] }));
    h = loadHousehold(h.home)!;
    { const ps = openProjectsStore(agentDir(h, 'art'))!; try { ps.write({ slug: 'pond', name: 'pond', summary: 'Ship the pond.' } as never); } finally { ps.close(); } }
    const t = thread('sam');
    writeDigest(agentDir(h, 'art'), { conversation: t.conversation, run: 'r-p' }, { summary: 'Asked.', projects: ['pond'], needs_owner: { ask: 'Sam: OK to ship the pond?' } } as never);
    forgetProjectCounts();
    const hub = async (who: string) => JSON.stringify(await get(who, '/projects/pond'));
    expect(await hub('sam')).toMatch(/Sam: OK to ship the pond\?/);
    expect(await hub('jonathan')).not.toMatch(/OK to ship the pond/);
    const ix = async (who: string) => JSON.stringify(await get(who, '/projects'));
    expect(await ix('sam')).toMatch(/1 waiting on you/);
    expect(await ix('jonathan')).not.toMatch(/waiting on you|OK to ship the pond/);
  }, 30_000);

  it('a lead card absorbed by a member\'s Needs you is still pushed to household owners', async () => {
    const store = sessionStore(h.home);
    const sub = (path: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${path}`, keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } });
    store.addPushSub(store.create(Buffer.alloc(32, 1)), sub('jon'));
    store.addPushSub(store.create(Buffer.alloc(32, 2)), sub('sam'), undefined, 'sam');
    const sent: Array<{ to: string; tag: string; url: string }> = [];
    const minute = async () => {
      const f = join(h.home, 'ui-sessions.json');
      try { const j = JSON.parse(readFileSync(f, 'utf8')); if (j.push) { delete j.push.tickAt; writeFileSync(f, JSON.stringify(j)); } } catch { /* first */ }
      const send = async (s2: { endpoint: string }, payload: string) => { const p = JSON.parse(payload); sent.push({ to: s2.endpoint, tag: p.tag, url: p.url }); return {} as never; };
      return pushWatch({ contextDir: agentDir(h, 'art'), auth: { enabled: true, check: () => null, live: () => false }, env: process.env, household: () => h } as never, send as never);
    };
    await minute();
    const t = thread('sam');
    cards({ 'a-00000002': { agent: 'art', text: 'Give Art the relay piece?', at: new Date().toISOString(), conversation: t.conversation, lead: true } });
    writeDigest(agentDir(h, 'art'), { conversation: t.conversation, run: 'r-l' }, { summary: 'Asked.', needs_owner: { ask: 'Sam: can Art have the relay piece?', waits_on: { approval: 'a-00000002' } } } as never);
    await minute();
    const jonKeys = new Set(((await get('jonathan', '/inbox')).items as Data[]).map((i) => `/inbox?i=${i.key}`));
    const samKeys = new Set(((await get('sam', '/inbox')).items as Data[]).map((i) => `/inbox?i=${i.key}`));
    const jon = sent.filter((x) => x.to.endsWith('jon'));
    const sam = sent.filter((x) => x.to.endsWith('sam'));
    expect(jon).toHaveLength(1);
    expect(sam).toHaveLength(1);
    // Each opens an item that's in that member's own Inbox.
    expect(jonKeys.has(jon[0].url)).toBe(true);
    expect(samKeys.has(sam[0].url)).toBe(true);
  }, 30_000);
});
