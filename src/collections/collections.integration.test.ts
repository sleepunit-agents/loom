/**
 * Shared collection queries through the real HTTP server (docs/specs/collections.md, "What the tests must pin":
 * bounds, hidden fields, viewer authority, counts, consumer capability, provider failure), with stub providers:
 *
 *  - `tasks` (role tasks, `owners: 2`): a leaky provider by default (it answers every record whoever asks), so every
 *    row a viewer gets is one core's own checks let through; `honest` mode answers by the viewer as a real one does.
 *  - `notes`: no `owners: 2`, so household owners only.
 *  - `broken`: always fails.
 *  - `authority`: the grants authority, answering from $LOOM_HOME/grants.json.
 *
 * Each provider writes $LOOM_HOME/<name>-ran for every run, so a refusal can be shown to come before it runs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
import { clearPieceCache } from '../ui/pieces.js';
import { clearGrantAnswers } from '../grants.js';
import { allThreads } from '../comms.js';

const NOW = Date.now();
const RECORDS = [
  { id: 't-1', agent: 'art', title: 'art one', status: 'open', cost: 5, description: 'long words', audience: { ownersOf: ['art'], agents: ['art'] } },
  { id: 't-2', agent: 'pond-bot', title: 'pond two', status: 'open', cost: 3, audience: { ownersOf: ['pond-bot'], agents: ['pond-bot'] } },
  { id: 't-3', agent: 'mark', title: 'mark three', status: 'closed', cost: 1, audience: { ownersOf: ['mark'], agents: ['mark'] } },
  { id: 't-4', title: 'household four', status: 'open', cost: 9, audience: { owners: true } },
  { id: 't-5', agent: 'pond-bot', title: 'sam\'s own five', status: 'open', cost: 2, audience: { members: ['sam'] } },
  { id: 't-6', agent: 'pond-bot', title: 'expired six', status: 'open', cost: 2, expires: NOW - 1000, audience: { ownersOf: ['pond-bot'] } },
  { id: 't-7', agent: 'pond-bot', title: 'no audience seven', status: 'open', cost: 2 },
  { id: 't-8', agent: 'pond-bot', title: 'pond eight', status: 'closed', cost: 4, audience: { ownersOf: ['pond-bot'], agents: ['pond-bot'] } },
];

// A provider in a few lines: where (eq/in), order by id, keyset after the last id, a total and a count by status.
const PROVIDER_BIN = (name: string) => `#!${process.execPath}
const fs = require('node:fs');
const home = process.env.LOOM_HOME;
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const ask = JSON.parse(s);
  fs.appendFileSync(home + '/${name}-ran', JSON.stringify({ viewer: ask.viewer, ids: ask.queries.map((q) => q.id), share: ask.share, scope: process.env.LOOM_OWNER_SCOPE || null }) + '\\n');
  const mode = fs.existsSync(home + '/${name}-mode') ? fs.readFileSync(home + '/${name}-mode', 'utf-8').trim() : '';
  if (mode === 'fail') process.exit(1);
  const all = JSON.parse(fs.readFileSync(home + '/records.json', 'utf-8'));
  const v = ask.viewer;
  const mine = (r) => mode !== 'honest' || v.kind === 'core' || (v.kind === 'member' && (v.agents === '*' || (r.agent && v.agents.includes(r.agent)))) || (v.kind === 'agent' && r.agent === v.agent);
  const answers = ask.queries.map((q) => {
    if (mode === 'big' && q.id === 'big') return { id: q.id, rows: [{ id: 'x', audience: { owners: true }, title: 'y'.repeat(q.limit * 20000) }], next: null };
    let rs = all.filter(mine).filter((r) => q.where.every(([f, op, val]) => op === 'eq' ? r[f] === val : op === 'in' ? val.includes(r[f]) : true));
    rs.sort((a, b) => a.id < b.id ? -1 : 1);
    const total = rs.length;
    const by = {}; for (const r of rs) by[r.status] = (by[r.status] || 0) + 1;
    if (q.after) rs = rs.filter((r) => r.id > JSON.parse(q.after)[0]);
    const page = rs.slice(0, q.limit);
    const more = rs.length > q.limit;
    return { id: q.id, rows: page.map((r) => { const o = { id: r.id, audience: r.audience }; if (r.expires) o.expires = r.expires; for (const f of q.fields) if (f in r) o[f] = r[f]; return o; }),
      next: more ? JSON.stringify([page[page.length - 1].id]) : null, total: { n: total, exact: true }, aggregates: q.aggregates.includes('count') ? { count: { n: total, exact: true, by } } : undefined };
  });
  console.log(JSON.stringify({ answers }));
});
`;

const AUTHORITY_BIN = `#!${process.execPath}
const fs = require('node:fs');
const home = process.env.LOOM_HOME;
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const ask = JSON.parse(s);
  fs.appendFileSync(home + '/asked', JSON.stringify(ask) + '\\n');
  const g = JSON.parse(fs.readFileSync(home + '/grants.json', 'utf-8'));
  const ok = (g[ask.agent] || []).includes(ask.piece + '/' + ask.path);
  console.log(JSON.stringify(ok ? { allow: true } : { allow: false, reason: ask.agent + ' has no grant for ' + ask.path }));
});
`;

const TASK = {
  version: '1.0', schema: { type: 'object' }, agent: 'agent',
  fields: {
    agent: { class: 'member', filter: ['eq', 'in'] },
    title: { class: 'member' },
    status: { class: 'member', filter: ['eq', 'in'], order: true },
    cost: { class: 'owner', filter: ['lt'] },
    description: { class: 'member', heavy: true },
  },
  default_fields: ['title', 'status'], max_page: 10, aggregates: { count: { by: ['status'] } }, houses: true,
};

function piece(home: string, name: string, raw: Record<string, unknown>, body: string): void {
  const loom = parseLoomBlock(raw, name, [`loom-${name}`]);
  if (typeof loom === 'string') throw new Error(`${name}: ${loom}`);
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
    bins: [`loom-${name}`], loom: { settings: [], services: [], ...loom } }));
  const bin = join(dir, 'current', 'cli');
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  rmSync(join(home, 'pieces', 'bin', `loom-${name}`), { force: true });
  symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
}

describe('shared collection queries: one bounded, permissioned interface', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;

  const runs = (name: string): Array<{ viewer: Record<string, unknown>; ids: string[]; share: number; scope: string | null }> => {
    const f = join(h.home, `${name}-ran`);
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const asked = (): Array<Record<string, unknown>> => {
    const f = join(h.home, 'asked');
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const query = async (token: string, queries: unknown[], path = '/api/loom/collections/query', headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ queries }) });
    const text = await r.text();
    let body: Record<string, unknown>;
    try { body = JSON.parse(text); } catch { body = { text }; }
    return { status: r.status, body: body as { answers: Array<Record<string, unknown>>; error?: string } };
  };
  const one = async (token: string, q: Record<string, unknown>) => (await query(token, [{ id: 'q', type: 'tasks/task@^1', ...q }])).body.answers[0] as Record<string, unknown>;
  const keys = (a: Record<string, unknown>) => (a.rows as Array<{ key: string }>).map((r) => r.key);
  const mode = (name: string, m: string) => writeFileSync(join(h.home, `${name}-mode`), m);
  const grants = (g: Record<string, string[]>) => writeFileSync(join(h.home, 'grants.json'), JSON.stringify(g));
  const authority = () => piece(h.home, 'authority', { grants: ['loom-authority'] }, AUTHORITY_BIN);

  beforeAll(async () => {
    h = loadHousehold((() => {
      const home = mkdtempSync(join(tmpdir(), 'loom-collections-'));
      for (const a of ['art', 'mark', 'pond-bot']) { mkdirSync(join(home, 'agents', a), { recursive: true }); writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`); }
      writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark', 'pond-bot'], default: 'art', members: [
        { person: 'jonathan', role: 'owner', agents: '*' }, { person: 'loren', role: 'owner', agents: ['pond-bot'] }, { person: 'sam', role: 'owner', agents: ['pond-bot', 'art'] },
      ] }));
      return home;
    })())!;
    process.env.LOOM_HOME = h.home;
    writeFileSync(join(h.home, 'records.json'), JSON.stringify(RECORDS));
    piece(h.home, 'taskstore', { role: 'tasks', collections: { owners: 2, query: ['loom-taskstore', 'q'], types: { task: TASK } } }, PROVIDER_BIN('tasks'));
    piece(h.home, 'notes', { collections: { query: ['loom-notes', 'q'], types: { task: TASK } } }, PROVIDER_BIN('notes'));
    piece(h.home, 'broken', { collections: { owners: 2, query: ['loom-broken', 'q'], types: { task: TASK } } }, PROVIDER_BIN('broken'));
    tok.jonathan = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    tok.loren = createToken(h, { role: { kind: 'owner', member: 'loren' }, label: 'loren' }).token;
    tok.sam = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    tok.art = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'art' }).token;
    tok.pond = createToken(h, { role: { kind: 'agent', agent: 'pond-bot' }, label: 'pond' }).token;
    tok.artHouse = createToken(h, { role: { kind: 'agent', agent: 'art', house: 'h-1' }, label: 'art house' }).token;
    tok.artService = createToken(h, { role: { kind: 'agent', agent: 'art', service: 'discord' }, label: 'art service' }).token;
    tok.piece = createToken(h, { role: { kind: 'piece', piece: 'taskstore', subject: 'svc' }, label: 'piece' }).token;
    // Comms threads: sam's and loren's, both with pond-bot (comms.md: a thread is its member's alone).
    allThreads(h.home);
    const db = new BetterSqlite3(join(h.home, 'household.db'));
    const ins = db.prepare(`INSERT INTO comms_threads (id, agent, member, conversation, title, opened, last, channel, first_id, first_hash, updated) VALUES (?, ?, ?, 'cv-000000000000', ?, '2026-11-01T00:00:00Z', ?, 1, ?, 'h', 0)`);
    ins.run('th-sam', 'pond-bot', 'sam', 'sam private', '2026-11-02T00:00:00Z', 'a');
    ins.run('th-loren', 'pond-bot', 'loren', 'loren private', '2026-11-03T00:00:00Z', 'b');
    ins.run('th-jon', 'art', 'jonathan', 'jonathan private', '2026-11-04T00:00:00Z', 'c');
    db.close();
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });
  beforeEach(() => {
    for (const f of ['tasks-ran', 'notes-ran', 'broken-ran', 'asked', 'tasks-mode', 'notes-mode']) rmSync(join(h.home, f), { force: true });
    mode('broken', 'fail');
    authority();
    grants({ art: ['loom/collections/tasks/task', 'loom/collections/loom/agent'], 'pond-bot': ['loom/collections/tasks/task'] });
    clearPieceCache();
    clearGrantAnswers();
  });

  describe('viewer authority: core checks every row, whatever the provider answers', () => {
    it('a household owner sees every record an audience admits them to, but not another member\'s own', async () => {
      const a = await one(tok.jonathan, { limit: 3, fields: ['title', 'status', 'cost'] });
      expect(keys(a)).toEqual(['tasks/task/t-1', 'tasks/task/t-2', 'tasks/task/t-3']);
      expect((a.rows as Array<Record<string, unknown>>)[0]).toEqual({ key: 'tasks/task/t-1', title: 'art one', status: 'open', cost: 5 });
      const all: string[] = [...keys(a)];
      let next = a.next;
      while (next) { const p = await one(tok.jonathan, { limit: 3, fields: ['title', 'status', 'cost'], after: next }); all.push(...keys(p)); next = p.next; }
      // t-5 is sam's alone (members), t-6 expired, t-7 has no audience: none reach a household owner.
      expect(all).toEqual(['tasks/task/t-1', 'tasks/task/t-2', 'tasks/task/t-3', 'tasks/task/t-4', 'tasks/task/t-8']);
    });

    it('an owner of some agents gets only their agents\' records from a provider that ignores who\'s asking, and core told it who they are', async () => {
      const all: string[] = [];
      let next: unknown = null;
      do { const p = await one(tok.loren, { limit: 3, after: next ?? undefined }); all.push(...keys(p)); next = p.next; } while (next);
      // Not art's or mark's, not the household's t-4, not sam's own t-5, not expired t-6 or audience-less t-7.
      expect(all).toEqual(['tasks/task/t-2', 'tasks/task/t-8']);
      expect(runs('tasks')[0]).toMatchObject({ viewer: { kind: 'member', who: 'loren', household: false, agents: ['pond-bot'] }, scope: 'pond-bot' });
    });

    it('two members sharing an agent: sam\'s own record is sam\'s, and the field it\'s withheld from is listed', async () => {
      const sam = await one(tok.sam, { where: [['agent', 'eq', 'pond-bot']], fields: ['title', 'cost', 'audience'] });
      expect(keys(sam)).toEqual(['tasks/task/t-2', 'tasks/task/t-5', 'tasks/task/t-8']);
      // cost is owner-class and audience household owners' only: absent, and said to be withheld.
      expect((sam.rows as Array<Record<string, unknown>>)[1]).toEqual({ key: 'tasks/task/t-5', title: 'sam\'s own five' });
      expect(sam.withheld).toEqual(['cost', 'audience']);
      const loren = await one(tok.loren, { where: [['agent', 'eq', 'pond-bot']] });
      expect(keys(loren)).not.toContain('tasks/task/t-5');
    });

    it('a record\'s audience goes to household owners only', async () => {
      const a = await one(tok.jonathan, { where: [['status', 'eq', 'closed']], fields: ['audience'] });
      expect(a.rows).toEqual([{ key: 'tasks/task/t-3', audience: { ownersOf: ['mark'], agents: ['mark'] } }, { key: 'tasks/task/t-8', audience: { ownersOf: ['pond-bot'], agents: ['pond-bot'] } }]);
    });

    it('a query on a hidden field is refused before the provider runs', async () => {
      for (const q of [{ where: [['cost', 'lt', 4]] }, { order: [['cost', 'asc']] }]) {
        expect(await one(tok.loren, q)).toMatchObject({ error: 'bad-query' });
      }
      expect(runs('tasks')).toEqual([]);
      // The same query is a household owner's to ask.
      expect(await one(tok.jonathan, { where: [['cost', 'lt', 4]] })).toHaveProperty('rows');
    });

    it('a provider without owners: 2 answers household owners only: anyone else is denied before it runs', async () => {
      const q = [{ id: 'n', type: 'notes/task@^1' }];
      expect((await query(tok.loren, q)).body.answers).toEqual([{ id: 'n', error: 'denied' }]);
      // And to them it's the same answer as a provider that isn't installed: only household owners learn what is.
      expect((await query(tok.loren, [{ id: 'n', type: 'nothing/task@^1' }])).body.answers).toEqual([{ id: 'n', error: 'denied' }]);
      expect((await query(tok.jonathan, [{ id: 'n', type: 'nothing/task@^1' }])).body.answers[0]).toMatchObject({ error: 'unsupported-version' });
      expect((await query(tok.art, q)).body.answers).toEqual([{ id: 'n', error: 'denied' }]);
      expect(runs('notes')).toEqual([]);
      expect((await query(tok.jonathan, q)).body.answers[0]).toHaveProperty('rows');
    });

    it('core\'s own types obey the same checks: a Comms thread is its member\'s alone, even from a household owner', async () => {
      const t = async (token: string) => keys((await query(token, [{ id: 't', type: 'loom/thread@^1' }])).body.answers[0]);
      expect(await t(tok.sam)).toEqual(['loom/thread/th-sam']);
      expect(await t(tok.loren)).toEqual(['loom/thread/th-loren']);
      expect(await t(tok.jonathan)).toEqual(['loom/thread/th-jon']);
      // The agents: their owners', each its own.
      const ag = async (token: string) => keys((await query(token, [{ id: 'a', type: 'loom/agent@^1' }])).body.answers[0]);
      expect(await ag(tok.loren)).toEqual(['loom/agent/pond-bot']);
      expect(await ag(tok.jonathan)).toEqual(['loom/agent/art', 'loom/agent/mark', 'loom/agent/pond-bot']);
      expect(await ag(tok.art)).toEqual(['loom/agent/art']);
    });
  });

  describe('counts', () => {
    it('a provider\'s totals and aggregates go to household owners only; core counts a complete answer itself', async () => {
      const jon = await one(tok.jonathan, { limit: 3, aggregates: ['count'] });
      expect(jon.coverage).toEqual({ complete: false, total: { n: 8, exact: true } });
      expect(jon.aggregates).toEqual({ count: { n: 8, exact: true, by: { open: 6, closed: 2 } } });
      // A page where core dropped a row the provider shouldn't have answered: its numbers aren't this viewer's either.
      const dropped = await one(tok.jonathan, { limit: 5, aggregates: ['count'] });
      expect(keys(dropped)).toEqual(['tasks/task/t-1', 'tasks/task/t-2', 'tasks/task/t-3', 'tasks/task/t-4']);
      expect(dropped.coverage).toEqual({ complete: false });
      expect(dropped).not.toHaveProperty('aggregates');
      // loren: the leaky provider's 8 (and its by-status counts) would reveal others' records. Partial: no number.
      const loren = await one(tok.loren, { limit: 1, aggregates: ['count'] });
      expect(loren.coverage).toEqual({ complete: false });
      expect(loren).not.toHaveProperty('aggregates');
      // Complete: core counted what it let through.
      // Complete (the provider's whole answer fit one page): core counts the rows it let through, never the provider's 5.
      const whole = await one(tok.loren, { where: [['agent', 'eq', 'pond-bot']], aggregates: ['count'] });
      expect(keys(whole)).toEqual(['tasks/task/t-2', 'tasks/task/t-8']);
      expect(whole.coverage).toEqual({ complete: true, total: { n: 2, exact: true } });
      mode('tasks', 'honest');
      const honest = await one(tok.loren, { where: [['status', 'eq', 'closed']], aggregates: ['count'] });
      expect(keys(honest)).toEqual(['tasks/task/t-8']);
      expect(honest.coverage).toEqual({ complete: true, total: { n: 1, exact: true } });
      // A count with a `by` is the provider's to give, so it isn't.
      expect(honest).not.toHaveProperty('aggregates');
    });
  });

  describe('bounds and cursors', () => {
    it('refuses unbounded queries as bad-query before the provider runs', async () => {
      const bad = [
        { where: Array.from({ length: 9 }, () => ['status', 'eq', 'open']) },
        { limit: 11 },
        { where: [['title', 'eq', 'x']] },
        { fields: ['description'], limit: 2 },
        { type: 'tasks/task' },
      ];
      for (const q of bad) expect(await one(tok.jonathan, q)).toMatchObject({ error: 'bad-query' });
      expect(runs('tasks')).toEqual([]);
      expect(await one(tok.jonathan, { type: 'tasks/task@^2' })).toMatchObject({ error: 'unsupported-version' });
      expect((await query(tok.jonathan, Array.from({ length: 33 }, (_, i) => ({ id: `q${i}`, type: 'tasks/task@^1' })))).status).toBe(400);
    });

    it('a cursor is sealed: another viewer, another query, or an edit is refused', async () => {
      const p1 = await one(tok.jonathan, { limit: 1 });
      expect(typeof p1.next).toBe('string');
      expect(p1.next).not.toContain('t-1');
      expect(keys(await one(tok.jonathan, { limit: 1, after: p1.next }))).toEqual(['tasks/task/t-2']);
      expect(await one(tok.sam, { limit: 1, after: p1.next })).toMatchObject({ error: 'bad-query' });
      expect(await one(tok.jonathan, { limit: 1, after: p1.next, where: [['status', 'eq', 'open']] })).toMatchObject({ error: 'bad-query' });
      const c = p1.next as string;
      const edited = c.slice(0, 20) + (c[20] === 'A' ? 'B' : 'A') + c.slice(21);
      expect(await one(tok.jonathan, { limit: 1, after: edited })).toMatchObject({ error: 'bad-query' });
    });

    it('one process per provider per batch; one provider failing leaves the others answered', async () => {
      const r = await query(tok.jonathan, [
        { id: 'a', type: 'tasks/task@^1', where: [['status', 'eq', 'open']] },
        { id: 'b', type: 'tasks/task@^1', where: [['status', 'eq', 'closed']] },
        { id: 'c', type: 'broken/task@^1' },
        { id: 'd', type: 'loom/agent@^1' },
      ]);
      expect(r.status).toBe(200);
      expect(r.body.answers.map((a) => a.error ?? 'ok')).toEqual(['ok', 'ok', 'unavailable', 'ok']);
      expect(runs('tasks')).toHaveLength(1);
      expect(runs('tasks')[0]).toMatchObject({ ids: ['a', 'b'], share: 512 * 1024 });
    });

    it('an expiry out of a date\'s range drops that row, and never fails the batch', async () => {
      writeFileSync(join(h.home, 'records.json'), JSON.stringify([...RECORDS, { id: 't-9', agent: 'art', title: 'far', status: 'open', expires: 1e300, audience: { owners: true } }]));
      try {
        const r = await query(tok.jonathan, [{ id: 'q', type: 'tasks/task@^1', where: [['status', 'eq', 'open']] }, { id: 'a', type: 'loom/agent@^1' }]);
        expect(r.status).toBe(200);
        expect(keys(r.body.answers[0])).not.toContain('tasks/task/t-9');
        expect(r.body.answers[1]).toHaveProperty('rows');
      } finally { writeFileSync(join(h.home, 'records.json'), JSON.stringify(RECORDS)); }
    });

    it('a query over its byte share answers too-big alone', async () => {
      mode('tasks', 'big');
      const r = await query(tok.jonathan, [{ id: 'big', type: 'tasks/task@^1', limit: 3, fields: ['title'] }, ...Array.from({ length: 31 }, (_, i) => ({ id: `s${i}`, type: 'tasks/task@^1', limit: 1 }))]);
      expect(r.body.answers[0]).toEqual({ id: 'big', error: 'too-big' });
      expect(r.body.answers.slice(1).every((a) => Array.isArray(a.rows))).toBe(true);
    });
  });

  describe('consumer capability: agent and house tokens', () => {
    it('an agent token reads only what it\'s granted, and only its own records; ungranted is denied before the provider runs', async () => {
      const a = await one(tok.art, {});
      expect(keys(a)).toEqual(['tasks/task/t-1']);
      expect(asked()).toEqual([{ agent: 'art', piece: 'loom', path: 'collections/tasks/task' }]);
      grants({});
      clearGrantAnswers();
      rmSync(join(h.home, 'tasks-ran'), { force: true });
      expect(await one(tok.art, {})).toEqual({ id: 'q', error: 'denied' });
      // Ungranted is denied whether or not the type exists, so a token can't probe what's installed.
      expect((await query(tok.art, [{ id: 'x', type: 'nope/thing@^1' }])).body.answers).toEqual([{ id: 'x', error: 'denied' }]);
      expect(runs('tasks')).toEqual([]);
    });

    it('with no grants authority installed, agent tokens are denied every collection, core\'s own included', async () => {
      rmSync(join(h.home, 'pieces', 'authority'), { recursive: true, force: true });
      clearPieceCache();
      expect(await one(tok.art, {})).toEqual({ id: 'q', error: 'denied' });
      expect((await query(tok.art, [{ id: 'a', type: 'loom/agent@^1' }])).body.answers).toEqual([{ id: 'a', error: 'denied' }]);
      expect(runs('tasks')).toEqual([]);
    });

    it('a house reads a type only where it allows houses, a service house only where it allows services too, whatever the grants', async () => {
      // tasks/task allows houses (not services); loom/agent allows neither.
      expect(keys(await one(tok.artHouse, {}))).toEqual(['tasks/task/t-1']);
      // The authority is told which house is asking.
      expect(asked()).toContainEqual({ agent: 'art', piece: 'loom', path: 'collections/tasks/task', house: 'h-1' });
      expect(await one(tok.artService, {})).toEqual({ id: 'q', error: 'denied' });
      expect((await query(tok.artHouse, [{ id: 'a', type: 'loom/agent@^1' }])).body.answers).toEqual([{ id: 'a', error: 'denied' }]);
    });

    it('piece and peer tokens are programs with their own seams: refused', async () => {
      const r = await query(tok.piece, [{ id: 'q', type: 'tasks/task@^1' }]);
      expect(r.status).toBe(403);
      expect(runs('tasks')).toEqual([]);
    });
  });

  describe('the page\'s route', () => {
    it('answers an owner\'s bearer like /api, and refuses a cross-site request', async () => {
      const ok = await query(tok.loren, [{ id: 'q', type: 'tasks/task@^1', where: [['agent', 'eq', 'pond-bot']] }], '/collections/query');
      expect(keys(ok.body.answers[0])).toEqual(['tasks/task/t-2', 'tasks/task/t-8']);
      const cross = await query(tok.jonathan, [{ id: 'q', type: 'tasks/task@^1' }], '/collections/query', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
      expect(cross.status).toBe(403);
      // /api never takes a browser's request.
      expect((await query(tok.jonathan, [{ id: 'q', type: 'tasks/task@^1' }], '/api/loom/collections/query', { origin: base })).status).toBe(403);
    });
  });
});
