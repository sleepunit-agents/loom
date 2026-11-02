/**
 * The audit log, review tokens, redaction, the sweep, scores and findings
 * (docs/specs/conversations.md, "The audit log", "Review" and acceptance criteria 6-10; t-1742).
 * Each describe names its criterion. Criterion 2's HTTP half (the audit write's order and
 * writer checks) is here too: slice 1 pinned only the store's half.
 * Needs the `age` and `age-keygen` programs (CI installs age).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { createLoomServer } from './server.js';
import { agentDir, commonsDir, createToken, loadHousehold, mintReviewToken, type Household } from './household.js';
import { runtimePieces } from './cli/pieces-managed.js';
import { createConversationTables, findingsOf, foldConversations, getConversation, recordTurn, turnsOf, type TurnInput } from './backends/conversations.js';
import { writeTurn } from './conversations.js';
import { PeopleStore } from './backends/people.js';
import { HOUSEHOLD_DB, syncVenues, venueOf } from './household-store.js';
import { AUDIT_DB, REVIEW_KEY, REVIEW_PUB, auditCount, openAuditDb, sweepAudit } from './audit.js';
import { redactor, takeAudit, vocabularyOf } from './audit-take.js';
import { commonsPeoplePath } from './backends/people-household.js';
import { computeMeasures, familyOf, recentDays, scorecards, withNonOwner } from './review.js';
import { exportBundle } from './bundle.js';
import { runExport } from './cli/bundle.js';
import { ROLE_ROUTES, AGENT_ROUTES, GET_ROUTES } from './transport/role-routes.js';

const which = (name: string) => (spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf-8' }).stdout || '').trim();
const AGE = which('age');
const AGE_KEYGEN = which('age-keygen');
const hasAge = AGE !== '' && AGE_KEYGEN !== '';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** art and pond-bot; jonathan owns all. Loren has a person card but isn't a member. */
function household(prefix: string): Household {
  const home = mkdtempSync(join(tmpdir(), prefix));
  for (const a of ['art', 'pond-bot']) {
    mkdirSync(join(home, 'agents', a), { recursive: true });
    writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
    createConversationTables(db);
    db.close();
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({
    v: 1, agents: ['art', 'pond-bot'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }],
  }));
  const h = loadHousehold(home)!;
  mkdirSync(commonsDir(h), { recursive: true });
  const people = new PeopleStore({ dbPath: join(commonsDir(h), 'people.db'), actor: 'art' });
  people.write({ slug: 'loren', name: 'Loren Ipsum' });
  people.write({ slug: 'jonathan', name: 'Jonathan Barket' });
  people.close();
  return h;
}

/** A managed piece record and its bin, as an install leaves them. */
function piece(home: string, name: string, loom: Record<string, unknown>): void {
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
    bins: [`loom-${name}`], loom: { settings: [], services: [], ...loom } }));
  const bin = join(dir, 'current', 'cli');
  writeFileSync(bin, `#!${process.execPath}\nprocess.exit(3);\n`);
  chmodSync(bin, 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  rmSync(join(home, 'pieces', 'bin', `loom-${name}`), { force: true });
  symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
}

const VENUES = { slack: { label: 'Slack', kind: 'live' }, relay: { label: 'Relay', kind: 'agent' } };

/** Recent times: entries are only kept for 7 days after their turn. */
const T0 = Date.now() - 60 * 60 * 1000;
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const saved = { home: process.env.LOOM_HOME, path: process.env.PATH, age: process.env.LOOM_AGE };
const restoreEnv = () => {
  for (const [k, v] of [['LOOM_HOME', saved.home], ['PATH', saved.path], ['LOOM_AGE', saved.age]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

describe.skipIf(!hasAge)('the audit log and review over HTTP', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};

  beforeAll(async () => {
    h = household('loom-audit-');
    piece(h.home, 'shuttle', { role: 'runtime', venues: VENUES });
    process.env.LOOM_HOME = h.home;
    tok.owner = createToken(h, { role: { kind: 'owner' }, label: 'owner' }).token;
    tok.art = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'art' }).token;
    tok.pond = createToken(h, { role: { kind: 'agent', agent: 'pond-bot' }, label: 'pond-bot' }).token;
    tok.box = createToken(h, { role: { kind: 'piece', piece: 'shuttle', subject: 'thor' }, label: 'shuttle · thor' }).token;
    tok.runtime = createToken(h, { role: { kind: 'runtime', piece: 'shuttle' }, label: 'runtime', runtimePieces: runtimePieces(process.env) }).token;
    // One minted two hours and a minute ago: expired a minute ago.
    tok.expired = mintReviewToken(h, 'shuttle', new Date(Date.now() - 2 * 60 * 60 * 1000 - 60_000)).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    const r = await post('review/token', tok.runtime, {});
    tok.review = (await r.json() as { token: string }).token;
    const r2 = await post('review/token', tok.runtime, {});
    tok.review2 = (await r2.json() as { token: string }).token;
  });
  afterAll(async () => {
    restoreEnv();
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });

  const post = (path: string, token: string | undefined, body: unknown) => fetch(`${base}/api/loom/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const turn = async (token: string, body: Record<string, unknown>) => {
    const r = await post('conversations/turn', token, body);
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    return await r.json() as { conversation: string; seq: number };
  };
  const audit = (token: string, conversation: string, seq: number, text: string) => post('audit', token, { conversation, seq, text });
  const take = async (token: string, limit = 500) => {
    const r = await post('audit/take', token, { limit });
    expect(r.status).toBe(200);
    return (await r.json() as { entries: Array<Record<string, unknown>> }).entries;
  };
  const entryRow = (conversation: string, seq: number) => {
    const db = new BetterSqlite3(join(h.home, AUDIT_DB), { readonly: true });
    try { return db.prepare('SELECT * FROM audit_entries WHERE conversation = ? AND seq = ?').get(conversation, seq) as Record<string, unknown> | undefined; } finally { db.close(); }
  };

  const readsCount = () => {
    if (!existsSync(join(h.home, HOUSEHOLD_DB))) return 0;
    const db = new BetterSqlite3(join(h.home, HOUSEHOLD_DB), { readonly: true });
    try { return (db.prepare('SELECT COUNT(*) AS n FROM audit_reads').get() as { n: number }).n; } finally { db.close(); }
  };

  // ─── 6. Encryption ──────────────────────────────────────────────────────

  describe('criterion 6: encryption', () => {
    it('an entry\'s text is an age file to review.pub, decrypts with review.key, and fails with another identity', async () => {
      const t = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:ENC', at: at(0), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      const secret = 'the zebra kiln runs at cone 6';
      expect((await audit(tok.runtime, t.conversation, t.seq, secret)).status).toBe(200);
      const row = entryRow(t.conversation, t.seq)!;
      // Exactly the spec's fields, nothing else.
      expect(Object.keys(row).sort()).toEqual(['agent', 'at', 'conversation', 'kind', 'seq', 'text', 'venue']);
      expect(row).toMatchObject({ agent: 'art', venue: 'slack', kind: 'message', seq: t.seq });
      const blob = row.text as Buffer;
      expect(blob.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
      // No plaintext anywhere in the file.
      expect(readFileSync(join(h.home, AUDIT_DB)).includes(Buffer.from('zebra kiln'))).toBe(false);
      // The key pair: made at first use, 0600.
      for (const f of [REVIEW_KEY, REVIEW_PUB]) expect(statSync(join(h.home, f)).mode & 0o777, f).toBe(0o600);
      expect(readFileSync(join(h.home, REVIEW_PUB), 'utf-8')).toMatch(/^age1[0-9a-z]+\n$/);
      const good = spawnSync(AGE, ['-d', '-i', join(h.home, REVIEW_KEY)], { input: blob });
      expect(good.status).toBe(0);
      expect(good.stdout.toString()).toBe(secret);
      const other = join(h.home, 'other.key');
      spawnSync(AGE_KEYGEN, ['-o', other]);
      const bad = spawnSync(AGE, ['-d', '-i', other], { input: blob });
      expect(bad.status).not.toBe(0);
      expect(bad.stdout.toString()).not.toContain('zebra');
      rmSync(other);
    });

    it('a foreign recipient in review.pub is ignored: the entry decrypts with review.key, and review.pub is rewritten', async () => {
      const pub = join(h.home, REVIEW_PUB);
      const real = readFileSync(pub, 'utf-8');
      const other = join(h.home, 'foreign.key');
      const kg = spawnSync(AGE_KEYGEN, ['-o', other], { encoding: 'utf-8' });
      const foreign = (kg.stderr + kg.stdout).match(/age1[0-9a-z]+/)![0];
      writeFileSync(pub, `${foreign}\n`);
      try {
        const t = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:FOREIGN', at: at(0.5), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
        expect((await audit(tok.runtime, t.conversation, t.seq, 'for the review key only')).status).toBe(200);
        const blob = entryRow(t.conversation, t.seq)!.text as Buffer;
        expect(spawnSync(AGE, ['-d', '-i', join(h.home, REVIEW_KEY)], { input: blob }).stdout.toString()).toBe('for the review key only');
        expect(spawnSync(AGE, ['-d', '-i', other], { input: blob }).status).not.toBe(0);
        expect(readFileSync(pub, 'utf-8')).toBe(real);
      } finally {
        rmSync(other, { force: true });
      }
    });

    it('audit.db is not WAL, and its connections delete securely', () => {
      const raw = new BetterSqlite3(join(h.home, AUDIT_DB), { readonly: true });
      try { expect(String(raw.pragma('journal_mode', { simple: true })).toLowerCase()).not.toBe('wal'); } finally { raw.close(); }
      const db = openAuditDb(h.home);
      try {
        expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('delete');
        expect(db.pragma('secure_delete', { simple: true })).toBe(1);
      } finally { db.close(); }
    });

    it('with no age program, audit writes answer 503 and turns still record', async () => {
      const waiting = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:NOAGE', at: at(1), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      expect((await audit(tok.runtime, waiting.conversation, waiting.seq, 'waits for a take')).status).toBe(200);
      const empty = mkdtempSync(join(tmpdir(), 'loom-noage-'));
      process.env.PATH = empty;
      delete process.env.LOOM_AGE;
      try {
        const t = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:NOAGE', at: at(1), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
        expect(t.seq).toBe(2);
        const r = await audit(tok.runtime, t.conversation, t.seq, 'no age here');
        expect(r.status).toBe(503);
        expect(entryRow(t.conversation, t.seq)).toBeUndefined();
        // A take claims nothing it couldn't decrypt: no audit_reads rows, the log untouched.
        const count = auditCount(h.home);
        const reads = readsCount();
        expect((await post('audit/take', tok.review, { limit: 1 })).status).toBe(503);
        expect(readsCount()).toBe(reads);
        expect(auditCount(h.home)).toBe(count);
      } finally {
        process.env.PATH = saved.path;
        if (saved.age !== undefined) process.env.LOOM_AGE = saved.age;
        rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  // ─── 2. The audit order (HTTP half) ─────────────────────────────────────

  describe('criterion 2: the audit order', () => {
    it('a venue named like a prototype key (constructor, toString, __proto__) is no venue', async () => {
      for (const venue of ['constructor', 'tostring', 'hasownproperty']) {
        const r = await post('conversations/turn', tok.runtime, { agent: 'art', venue, place: 'x', at: at(2), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
        expect(r.status, venue).toBe(400);
      }
      expect(venueOf(h.home, 'constructor')).toBeUndefined();
      expect(venueOf(h.home, 'toString')).toBeUndefined();
    });

    it('a missing (conversation, seq), or a different writer, is refused; the turn\'s writer is accepted once', async () => {
      const t = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:ORDER', at: at(2), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      expect((await audit(tok.runtime, t.conversation, t.seq + 1, 'x')).status).toBe(404);
      expect((await audit(tok.runtime, 'cv-000000000000', 1, 'x')).status).toBe(404);
      // art's own token didn't write that turn (the runtime did).
      expect((await audit(tok.art, t.conversation, t.seq, 'x')).status).toBe(403);
      const s = await turn(tok.art, { venue: 'session', place: 'claude-code:s1', at: at(3), from: { kind: 'agent', id: 'art' }, kind: 'note', run: 'r-s1', outcome: 'none' });
      // The runtime didn't write the session's turn, and pond-bot's token can't reach art's.
      expect((await audit(tok.runtime, s.conversation, s.seq, 'x')).status).toBe(403);
      expect((await audit(tok.pond, s.conversation, s.seq, 'x')).status).toBe(404);
      expect((await audit(tok.art, s.conversation, s.seq, 'a note')).status).toBe(200);
      expect((await audit(tok.art, s.conversation, s.seq, 'again')).status).toBe(409);
      // Other roles never reach the route; unknown keys are refused.
      for (const k of ['owner', 'box', 'review'] as const) expect((await audit(tok[k], t.conversation, t.seq, 'x')).status, k).toBe(403);
      expect((await post('audit', tok.runtime, { conversation: t.conversation, seq: t.seq, text: 'x', model: 'y' })).status).toBe(400);
      expect((await audit(tok.runtime, t.conversation, t.seq, 'the runtime wrote it')).status).toBe(200);
    });
  });

  // ─── 7. Reading the audit log ───────────────────────────────────────────

  describe('criterion 7: reading the audit log', () => {
    it('the routes: review takes, finishes, scores and finds; runtime writes audit and reads scorecards', () => {
      expect(ROLE_ROUTES.review).toEqual(['audit/take', 'audit/done', 'scores', 'findings']);
      expect(ROLE_ROUTES.runtime).toEqual(['review/token', 'conversations/turn', 'audit', 'scorecards', 'review/config']);
      expect(AGENT_ROUTES).toEqual(['conversations/turn', 'audit']);
      expect(GET_ROUTES).toEqual(['scorecards', 'review/config']);
    });

    it('GET /api/loom/review/config answers the household\'s review setting and time zone, to the runtime only', async () => {
      const get = (token: string) => fetch(`${base}/api/loom/review/config`, { headers: { authorization: `Bearer ${token}` } });
      const r = await get(tok.runtime);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ review: 'on', tz: 'UTC' });
      for (const k of ['review', 'owner', 'art', 'box'] as const) expect((await get(tok[k])).status, k).toBe(403);
      expect((await post('review/config', tok.runtime, {})).status).toBe(405);
    });

    it('only an unexpired review token can take: an expired one, and agent, owner, piece and runtime tokens, are refused', async () => {
      expect((await post('audit/take', tok.expired, { limit: 1 })).status).toBe(401);
      for (const k of ['art', 'owner', 'box', 'runtime'] as const) expect((await post('audit/take', tok[k], { limit: 1 })).status, k).toBe(403);
      expect((await post('audit/take', undefined, { limit: 1 })).status).toBe(401);
      // A review token reaches nothing else of core's.
      for (const p of ['audit', 'conversations/turn', 'review/token']) expect((await post(p, tok.review, {})).status, p).toBe(403);
      expect((await post('audit/take', tok.review, { limit: 501 })).status).toBe(400);
    });

    it('each take writes audit_reads rows with no text, hands an entry out once, and done deletes', async () => {
      const t = await turn(tok.runtime, { agent: 'pond-bot', venue: 'slack', place: 'dm:READS', at: at(4), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      expect((await audit(tok.runtime, t.conversation, t.seq, 'quokka marmalade')).status).toBe(200);
      const before = auditCount(h.home);
      const entries = await take(tok.review);
      const mine = entries.find((e) => e.text === 'quokka marmalade')!;
      expect(mine).toBeDefined();
      expect(Object.keys(mine).sort()).toEqual(['agent', 'family', 'kind', 'ref', 'text', 'venue']);
      expect(mine.ref).toMatch(/^ar-[0-9a-f]{18}$/);
      const db = new BetterSqlite3(join(h.home, HOUSEHOLD_DB), { readonly: true });
      const reads = db.prepare('SELECT * FROM audit_reads').all() as Array<Record<string, unknown>>;
      db.close();
      expect(reads.length).toBeGreaterThanOrEqual(entries.length);
      expect(Object.keys(reads[0]).sort()).toEqual(['agent', 'at', 'conversation', 'ref', 'run', 'seq']);
      expect(JSON.stringify(reads)).not.toContain('quokka');
      expect(reads.find((r) => r.ref === mine.ref)).toMatchObject({ agent: 'pond-bot', conversation: t.conversation, seq: t.seq });
      // Taken once: the next take (any run) doesn't see it again.
      expect((await take(tok.review)).some((e) => e.text === 'quokka marmalade')).toBe(false);
      expect((await take(tok.review2)).some((e) => e.text === 'quokka marmalade')).toBe(false);
      // Taken entries can't be written again.
      expect((await audit(tok.runtime, t.conversation, t.seq, 'again')).status).toBe(409);
      // Done from another run deletes nothing; from this run, it deletes.
      expect(await (await post('audit/done', tok.review2, { refs: [mine.ref] })).json()).toEqual({ deleted: 0 });
      expect(await (await post('audit/done', tok.review, { refs: [mine.ref] })).json()).toEqual({ deleted: 1 });
      expect(auditCount(h.home)).toBe(before - 1);
    });

    it('past 7 days, entries are gone after the sweep, taken or not', async () => {
      const t = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:SWEEP', at: at(5), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      expect((await audit(tok.runtime, t.conversation, t.seq, 'old news')).status).toBe(200);
      expect(entryRow(t.conversation, t.seq)).toBeDefined();
      sweepAudit(h.home, new Date(T0 + 6 * 86_400_000));
      expect(entryRow(t.conversation, t.seq)).toBeDefined();
      const n = auditCount(h.home);
      expect(sweepAudit(h.home, new Date(T0 + 8 * 86_400_000))).toBe(n);
      expect(auditCount(h.home)).toBe(0);
      // A turn already older than 7 days takes no entry, and nor does one in the future.
      const old = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:SWEEP', at: new Date(Date.now() - 8 * 86_400_000).toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      expect((await audit(tok.runtime, old.conversation, old.seq, 'x')).status).toBe(409);
      const future = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:SWEEP', at: new Date(Date.now() + 86_400_000).toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      expect((await audit(tok.runtime, future.conversation, future.seq, 'x')).status).toBe(409);
    });

    it('the sweep goes by the turn\'s time, not the write\'s: a turn 6.9 days old is gone 0.2 days later', async () => {
      const now = Date.now();
      const t = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:SWEEP2', at: new Date(now - 6.9 * 86_400_000).toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      expect((await audit(tok.runtime, t.conversation, t.seq, 'nearly a week old')).status).toBe(200);
      sweepAudit(h.home, new Date(now + 0.2 * 86_400_000));
      expect(entryRow(t.conversation, t.seq)).toBeUndefined();
    });

    it('a missing or non-regular review key is a 503 before anything is claimed', async () => {
      const t = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:NOKEY', at: at(8), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      expect((await audit(tok.runtime, t.conversation, t.seq, 'key trouble')).status).toBe(200);
      const key = join(h.home, REVIEW_KEY);
      const aside = `${key}.aside`;
      renameSync(key, aside);
      try {
        const reads = readsCount();
        expect((await post('audit/take', tok.review, { limit: 500 })).status).toBe(503);
        symlinkSync(aside, key);
        expect((await post('audit/take', tok.review, { limit: 500 })).status).toBe(503);
        expect(readsCount()).toBe(reads);
      } finally {
        rmSync(key, { force: true });
        renameSync(aside, key);
      }
      const e = (await take(tok.review)).find((x) => x.text === 'key trouble')!;
      expect(e).toBeDefined();
      await post('audit/done', tok.review, { refs: [e.ref] });
    });

    it('age failing mid-take releases this take\'s claims and answers 503; only a blob age rejects stays claimed', async () => {
      const t1 = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:MID', at: at(8.1), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      const t2 = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:MID', at: at(8.2), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      const t3 = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:MID', at: at(8.3), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      for (const [t, k] of [[t1, 'one'], [t2, 'two'], [t3, 'three']] as const) expect((await audit(tok.runtime, t.conversation, t.seq, `mid ${k}`)).status).toBe(200);
      // An age that decrypts once, then breaks (not a bad blob: age itself failing).
      const dir = mkdtempSync(join(tmpdir(), 'loom-flaky-age-'));
      const counter = join(dir, 'n');
      const flaky = join(dir, 'age');
      writeFileSync(flaky, `#!/bin/sh\nn=$(cat '${counter}' 2>/dev/null || echo 0)\necho $((n+1)) > '${counter}'\nif [ "$1" = "-d" ] && [ "$n" -ge 1 ]; then echo 'age: error: out of memory' >&2; exit 1; fi\nexec '${AGE}' "$@"\n`);
      chmodSync(flaky, 0o755);
      const reads = readsCount();
      process.env.LOOM_AGE = flaky;
      try {
        expect((await post('audit/take', tok.review, { limit: 500 })).status).toBe(503);
      } finally {
        if (saved.age === undefined) delete process.env.LOOM_AGE; else process.env.LOOM_AGE = saved.age;
        rmSync(dir, { recursive: true, force: true });
      }
      // Nothing of that take stayed claimed: all three come back.
      expect(readsCount()).toBe(reads);
      // Now a blob age rejects: t2's entry, corrupted. It stays claimed; the others are handed out.
      const db = new BetterSqlite3(join(h.home, AUDIT_DB));
      db.prepare('UPDATE audit_entries SET text = ? WHERE conversation = ? AND seq = ?').run(Buffer.from('age-encryption.org/v1\n-> X25519 nonsense\n--- garbage\n'), t2.conversation, t2.seq);
      db.close();
      const got = (await take(tok.review)).filter((x) => /^mid /.test(x.text as string)).map((x) => x.text).sort();
      expect(got).toEqual(['mid one', 'mid three']);
      expect(readsCount()).toBe(reads + 3);
      expect((await take(tok.review)).some((x) => x.text === 'mid two')).toBe(false);
    });

    it('no plaintext at rest: after writes and takes, the secret is in no file under the home', async () => {
      const secret = 'periwinkle-axolotl-7731';
      // Whatever a write or a take might spill to temp goes here, and is walked too.
      const tmp = mkdtempSync(join(tmpdir(), 'loom-rest-tmp-'));
      const savedTmp = process.env.TMPDIR;
      process.env.TMPDIR = tmp;
      try {
      const t = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:REST', at: at(8.5), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      const s2 = await turn(tok.art, { venue: 'session', place: 'claude-code:rest', at: at(8.6), from: { kind: 'agent', id: 'art' }, kind: 'note', run: 'r-rest', outcome: 'none' });
      expect((await audit(tok.runtime, t.conversation, t.seq, `the word is ${secret}`)).status).toBe(200);
      expect((await audit(tok.art, s2.conversation, s2.seq, `again ${secret}`)).status).toBe(200);
      const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
      });
      const holding = () => [...walk(h.home), ...walk(tmp)].filter((f) => readFileSync(f).includes(Buffer.from(secret))).map((f) => relative(h.home, f));
      expect(holding()).toEqual([]);
      const es = (await take(tok.review)).filter((x) => (x.text as string).includes(secret));
      expect(es).toHaveLength(2);
      expect(holding()).toEqual([]);
      await post('audit/done', tok.review, { refs: es.map((x) => x.ref) });
      expect(holding()).toEqual([]);
      } finally {
        if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('the daemon\'s start sweep computes the metadata measures', async () => {
      await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:MEASURE', at: new Date(Date.now() - 120_000).toISOString(), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:MEASURE', at: new Date(Date.now() - 60_000).toISOString(), from: { kind: 'agent', id: 'art' }, kind: 'reply', run: 'r-m', outcome: 'answered', model: 'claude-opus-4', harness: 'claude-code' });
      const db = new BetterSqlite3(join(h.home, HOUSEHOLD_DB));
      db.prepare("DELETE FROM scorecards WHERE measure != 'graded'").run();
      db.close();
      const second = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
      await second.close();
      const today = new Date().toISOString().slice(0, 10);
      const rows = scorecards(h.home, today).filter((r) => r.day === today && r.measure === 'first_reply_s' && r.model === 'claude-opus-4');
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBeGreaterThan(0);
    });

    it('the daemon sweeps at start', async () => {
      const t = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:START', at: at(6), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      expect((await audit(tok.runtime, t.conversation, t.seq, 'stale')).status).toBe(200);
      // Age the entry past 7 days, then start a second daemon on the same home.
      const db = new BetterSqlite3(join(h.home, AUDIT_DB));
      db.prepare('UPDATE audit_entries SET at = ? WHERE conversation = ?').run(new Date(Date.now() - 8 * 86_400_000).toISOString(), t.conversation);
      db.close();
      const second = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
      await second.close();
      expect(entryRow(t.conversation, t.seq)).toBeUndefined();
    });

    it('a bundle and loom export contain no audit.db and no review key', async () => {
      const t = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:BUNDLE', at: at(7), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      expect((await audit(tok.runtime, t.conversation, t.seq, 'never in a bundle')).status).toBe(200);
      for (const f of [AUDIT_DB, REVIEW_KEY, REVIEW_PUB, HOUSEHOLD_DB]) expect(existsSync(join(h.home, f)), f).toBe(true);
      const work = mkdtempSync(join(tmpdir(), 'loom-audit-bundle-'));
      try {
        const owner = join(work, 'owner.key');
        const kg = spawnSync(AGE_KEYGEN, ['-o', owner], { encoding: 'utf-8' });
        const recipient = (kg.stderr + kg.stdout).match(/age1[0-9a-z]+/)![0];
        const { LOOM_HOME: _h, LOOM_CONTEXT_DIR: _c, ...rest } = process.env;
        const env = { ...rest, HOME: work, LOOM_AGE: AGE, PATH: [dirname(AGE), '/usr/bin', '/bin'].join(delimiter) };
        const listing = (file: string) => {
          const plain = join(work, `${relative(work, file).replace(/\W/g, '_')}.tgz`);
          expect(spawnSync(AGE, ['-d', '-i', owner, '-o', plain, file]).status).toBe(0);
          return spawnSync('tar', ['-tzf', plain], { encoding: 'utf-8' }).stdout.split('\n').filter(Boolean);
        };
        const check = (names: string[]) => {
          expect(names.some((n) => n.endsWith(HOUSEHOLD_DB))).toBe(true);
          for (const n of names) for (const f of [AUDIT_DB, REVIEW_KEY, REVIEW_PUB]) expect(n.split('/').pop(), n).not.toBe(f);
        };
        await exportBundle({ contextDir: agentDir(h, 'art'), to: join(work, 'a.loom'), recipients: [recipient], env });
        check(listing(join(work, 'a.loom')));
        const out: string[] = [];
        const code = await runExport(['--to', join(work, 'b.loom'), '--recipient', recipient], { env: { ...env, LOOM_CONTEXT_DIR: agentDir(h, 'art') }, stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s) } as never);
        expect(code, out.join('')).toBe(0);
        check(listing(join(work, 'b.loom')));
        // And if one were ever staged (an agent's directory holding one), the export refuses.
        writeFileSync(join(agentDir(h, 'art'), REVIEW_KEY), 'AGE-SECRET-KEY-1NOPE\n');
        await expect(exportBundle({ contextDir: agentDir(h, 'art'), to: join(work, 'c.loom'), recipients: [recipient], env })).rejects.toThrow(/never leave this machine/);
        expect(existsSync(join(work, 'c.loom'))).toBe(false);
      } finally {
        rmSync(join(agentDir(h, 'art'), REVIEW_KEY), { force: true });
        rmSync(work, { recursive: true, force: true });
      }
    }, 30_000);
  });

  // ─── 8. Redaction ───────────────────────────────────────────────────────

  describe('criterion 8: redaction', () => {
    it('a take returns every person name and slug, agent id, model and harness as its placeholder, consistently within the take', async () => {
      const place = 'dm:REDACT';
      const m = await turn(tok.runtime, { agent: 'art', venue: 'slack', place, at: at(10), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      const r = await turn(tok.runtime, { agent: 'art', venue: 'slack', place, at: at(11), from: { kind: 'agent', id: 'art' }, kind: 'reply', run: 'r-red', outcome: 'answered', model: 'claude-opus-4', harness: 'claude-code' });
      const p = await turn(tok.runtime, { agent: 'pond-bot', venue: 'slack', place, at: at(12), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      await audit(tok.runtime, m.conversation, m.seq, 'Loren Ipsum told loren and JONATHAN that Art asked pond-bot, via claude-opus-4 on claude-code.');
      await audit(tok.runtime, r.conversation, r.seq, 'Sure, Jonathan Barket: loren is on it. (art, Claude-Opus-4, start, artful)');
      // pond-bot's store has never seen art's model or harness: the vocabulary is household-wide.
      await audit(tok.runtime, p.conversation, p.seq, 'pond-bot hears Loren, on claude-opus-4 via claude-code.');
      const entries = (await take(tok.review)).filter((e) => [m.conversation, p.conversation].length && /told|Sure|hears/.test(e.text as string));
      expect(entries.map((e) => [e.agent, e.text])).toEqual([
        ['A1', 'P1 told P1 and P2 that A1 asked A2, via M1 on H1.'],
        ['A1', 'Sure, P2: P1 is on it. (A1, M1, start, artful)'],
        ['A2', 'A2 hears P1, on M1 via H1.'],
      ]);
      // The reply's family, never its model; someone's message has none.
      expect(entries.map((e) => e.family)).toEqual([null, 'anthropic', null]);
      expect(JSON.stringify(entries)).not.toMatch(/claude|loren|jonathan|pond-bot/i);
      await post('audit/done', tok.review, { refs: entries.map((e) => e.ref) });
    });

    it('an entry whose agent has left the household is never handed out (its names aren\'t in the vocabulary); it stays claimed for the sweep', async () => {
      const t = await turn(tok.runtime, { agent: 'pond-bot', venue: 'slack', place: 'dm:LEFT', at: at(14), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      expect((await audit(tok.runtime, t.conversation, t.seq, 'pond-bot secret words')).status).toBe(200);
      const gone = { ...h, agents: ['art'] };
      const reads = readsCount();
      const out = takeAudit(gone, 'rv-leftagent00000', { limit: 500 });
      expect(JSON.stringify(out)).not.toContain('secret words');
      expect(readsCount()).toBeGreaterThan(reads);
      expect(entryRow(t.conversation, t.seq)).toBeDefined();
      expect((await take(tok.review)).some((e) => /secret words/.test(e.text as string))).toBe(false);
    });

    it('a people store that exists but can\'t be read fails the take (503) and claims nothing', async () => {
      const t = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:BROKEN', at: at(15), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      expect((await audit(tok.runtime, t.conversation, t.seq, 'names would go out')).status).toBe(200);
      const path = commonsPeoplePath(h);
      const db = new BetterSqlite3(path);
      db.exec('ALTER TABLE people RENAME TO people_moved');
      db.close();
      try {
        const reads = readsCount();
        expect((await post('audit/take', tok.review, { limit: 500 })).status).toBe(503);
        expect(readsCount()).toBe(reads);
      } finally {
        const db2 = new BetterSqlite3(path);
        db2.exec('ALTER TABLE people_moved RENAME TO people');
        db2.close();
      }
      const e = (await take(tok.review)).find((x) => x.text === 'names would go out')!;
      expect(e).toBeDefined();
      await post('audit/done', tok.review, { refs: [e.ref] });
    });

    it('a person with no card is redacted by slug, whether seen in a conversation\'s people or only as a turn\'s from', async () => {
      const place = 'dm:NOCARD';
      const m = await turn(tok.runtime, { agent: 'art', venue: 'slack', place, at: at(13), from: { kind: 'person', slug: 'zephyr-quill' }, kind: 'message' });
      await audit(tok.runtime, m.conversation, m.seq, 'zephyr-quill here; Zephyr says Quill is fine. Ask Zephyr.');
      const e = (await take(tok.review)).find((x) => /here;/.test(x.text as string))!;
      expect(e.text).toBe('P1 here; P1 says P1 is fine. Ask P1.');
      expect(JSON.stringify(e)).not.toMatch(/zephyr|quill/i);
      await post('audit/done', tok.review, { refs: [e.ref] });
    });

    it('hyphenated and apostrophe names are redacted whole and by part; parts under 3 letters are not', () => {
      const r = redactor({ agents: [], people: [{ slug: 'mary-kate', name: 'Mary-Kate Al-Fayed' }, { slug: 'obrien', name: "Siobhan O'Brien" }], models: [], harnesses: [] });
      expect(r.text("Mary-Kate Al-Fayed met Siobhan O'Brien (O\u2019Brien), then Mary, Kate, Fayed and Brien. Al and O stay, as does Jo.")).toBe(
        'P1 met P2 (P2), then P1, P1, P1 and P2. Al and O stay, as does Jo.');
      expect(r.text('mary-kate and obrien')).toBe('P1 and P2');
    });

    it('the redactor: longest match first, whole words only, whitespace inside a name, numbering by first appearance', () => {
      const r = redactor({ agents: ['art'], people: [{ slug: 'mary-ann', name: 'Mary Ann Lee' }, { slug: 'art', name: 'Art' }], models: ['gpt-5.1'], harnesses: ['codex'] });
      expect(r.text('Mary\nAnn  Lee said gpt-5.1, not gpt-5.12 or codexes; mary-ann and ART agree. Lee too.')).toBe('P1 said M1, not gpt-5.12 or codexes; P1 and A1 agree. P1 too.');
      expect(r.agent('art')).toBe('A1');
      expect(r.text('codex')).toBe('H1');
    });
  });

  // ─── 10. Findings and scorecards ────────────────────────────────────────

  describe('criterion 10: findings and scorecards', () => {
    let owner: { conversation: string; seq: number };
    let ownerMsg: { conversation: string; seq: number };
    let stranger: { conversation: string; seq: number };
    let refs: Record<string, string> = {};

    beforeAll(async () => {
      // With the owner: a message, and art's reply by gpt-5 on codex-cli.
      ownerMsg = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:OWNER', at: at(20), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
      owner = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:OWNER', at: at(21), from: { kind: 'agent', id: 'art' }, kind: 'reply', run: 'r-own', outcome: 'answered', model: 'gpt-5', harness: 'codex-cli' });
      // With Loren, who isn't a member: processed by an anthropic model only.
      await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:LOREN', at: at(22), from: { kind: 'person', slug: 'loren' }, kind: 'message' });
      // pond-bot runs google and mistral models: the household has four families.
      for (const [i, model] of [[0, 'gemini-2.5-pro'], [1, 'mistral-large']] as const) {
        await turn(tok.runtime, { agent: 'pond-bot', venue: 'slack', place: 'dm:POND', at: at(19 + i / 10), from: { kind: 'agent', id: 'pond-bot' }, kind: 'note', run: `r-p${i}`, outcome: 'none', model, harness: 'opencode' });
      }
      stranger = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:LOREN', at: at(23), from: { kind: 'agent', id: 'art' }, kind: 'reply', run: 'r-lor', outcome: 'answered', model: 'claude-sonnet-4', harness: 'claude-code' });
      for (const [k, t] of [['ownerMsg', ownerMsg], ['owner', owner], ['stranger', stranger]] as const) await audit(tok.runtime, t.conversation, t.seq, `text of ${k}`);
      const entries = await take(tok.review);
      refs = Object.fromEntries(entries.filter((e) => /^text of /.test(e.text as string)).map((e) => [(e.text as string).slice(8), e.ref as string]));
      const s = entries.find((e) => e.ref === refs.stranger)!;
      // The runtime is told, before it sends a word anywhere, which families may grade it.
      expect(s.only_families).toEqual(['anthropic']);
      expect(entries.find((e) => e.ref === refs.owner)).toMatchObject({ family: 'openai' });
      expect(entries.find((e) => e.ref === refs.owner)!.only_families).toBeUndefined();
      expect(JSON.stringify(entries)).not.toMatch(/gpt-5|codex-cli|claude-sonnet/);
    });

    it('scores are posted by ref; the rows carry the producer\'s model, family and harness, which the grader never received', async () => {
      // The household's families: art runs anthropic and openai models, pond-bot google and mistral ones.
      // google and mistral also grade the gpt-5 (openai) turn: two scores at most per ref.
      expect((await post('scores', tok.review, { ref: refs.owner, grader_family: 'anthropic', score: 4 })).status).toBe(200);
      expect((await post('scores', tok.review, { ref: refs.owner, grader_family: 'google', score: 2 })).status).toBe(200);
      expect((await post('scores', tok.review, { ref: refs.owner, grader_family: 'mistral', score: 5 })).status).toBe(409);
      // Once per family; only a model's turn; this run's refs; the shape.
      expect((await post('scores', tok.review, { ref: refs.owner, grader_family: 'google', score: 5 })).status).toBe(409);
      expect((await post('scores', tok.review, { ref: refs.ownerMsg, grader_family: 'anthropic', score: 3 })).status).toBe(409);
      expect((await post('scores', tok.review2, { ref: refs.owner, grader_family: 'mistral', score: 3 })).status).toBe(404);
      for (const bad of [{ ref: refs.owner, grader_family: 'mistral', score: 6 }, { ref: refs.owner, grader_family: 'mistral', score: 2.5 }, { ref: refs.owner, grader_family: 'Mistral', score: 3 }, { ref: refs.owner, grader_family: 'mistral', score: 3, model: 'x' }]) {
        expect((await post('scores', tok.review, bad)).status, JSON.stringify(bad)).toBe(400);
      }
      expect((await post('scores', tok.runtime, { ref: refs.owner, grader_family: 'mistral', score: 3 })).status).toBe(403);
      const day = at(21).slice(0, 10);
      const r = await fetch(`${base}/api/loom/scorecards?since=${day}`, { headers: { authorization: `Bearer ${tok.runtime}` } });
      expect(r.status).toBe(200);
      const rows = (await r.json() as { rows: Array<Record<string, unknown>> }).rows.filter((x) => x.measure === 'graded');
      expect(rows).toContainEqual({ day, model: 'gpt-5', family: 'openai', harness: 'codex-cli', kind: 'live', measure: 'graded', value: 3, n: 2, same_family: false });
      // The scorecards are the runtime's to read: GET only, and no other role.
      for (const k of ['review', 'owner', 'art', 'box'] as const) {
        expect((await fetch(`${base}/api/loom/scorecards`, { headers: { authorization: `Bearer ${tok[k]}` } })).status, k).toBe(403);
      }
      expect((await post('scorecards', tok.runtime, {})).status).toBe(405);
    });

    it('a grader family must be one the household runs, and never the producer\'s own', async () => {
      // A fresh sample: the gpt-5 turn's two scores are spent.
      const t = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:OWNER', at: at(24), from: { kind: 'agent', id: 'art' }, kind: 'reply', run: 'r-own2', outcome: 'answered', model: 'gpt-5', harness: 'codex-cli' });
      await audit(tok.runtime, t.conversation, t.seq, 'text of fresh');
      const e = (await take(tok.review)).find((x) => x.text === 'text of fresh')!;
      // meta and xai: no model on any household turn resolves to them, so a made-up or absent
      // family is refused. (Families come from the models the runtime wrote on turns; the runtime is trusted.)
      for (const f of ['meta', 'xai', 'zzz', 'made-up']) expect((await post('scores', tok.review, { ref: e.ref, grader_family: f, score: 5 })).status, f).toBe(403);
      // openai produced it.
      expect((await post('scores', tok.review, { ref: e.ref, grader_family: 'openai', score: 5 })).status).toBe(403);
      expect((await post('scores', tok.review, { ref: e.ref, grader_family: 'mistral', score: 1 })).status).toBe(200);
    });

    it('a score from a family that didn\'t process a non-owner conversation is rejected', async () => {
      expect((await post('scores', tok.review, { ref: refs.stranger, grader_family: 'openai', score: 5 })).status).toBe(403);
      expect((await post('scores', tok.review, { ref: refs.stranger, grader_family: 'anthropic', score: 5 })).status).toBe(200);
      const rows = scorecards(h.home, at(23).slice(0, 10)).filter((x) => x.measure === 'graded' && x.model === 'claude-sonnet-4');
      expect(rows).toEqual([{ day: at(23).slice(0, 10), model: 'claude-sonnet-4', family: 'anthropic', harness: 'claude-code', kind: 'live', measure: 'graded', value: 5, n: 1, same_family: true }]);
    });

    it('a second finding for the same conversation and UTC day is rejected; an accepted one lands in the turn\'s agent\'s findings', async () => {
      // Someone else's words (a message, no model) take no finding: the same rule as a score.
      const msgOnly = await post('findings', tok.review, { ref: refs.ownerMsg, text: 'on a message' });
      expect(msgOnly.status).toBe(409);
      expect((await msgOnly.json() as { error: string }).error).toMatch(/agent's own turns/);
      const r = await post('findings', tok.review, { ref: refs.owner, text: 'P1 asked twice before A1 answered.' });
      expect(r.status).toBe(200);
      // Another agent turn in the same conversation and UTC day: the day cap.
      const again = await turn(tok.runtime, { agent: 'art', venue: 'slack', place: 'dm:OWNER', at: at(25), from: { kind: 'agent', id: 'art' }, kind: 'reply', run: 'r-own3', outcome: 'answered', model: 'gpt-5', harness: 'codex-cli' });
      await audit(tok.runtime, again.conversation, again.seq, 'text of again');
      const e = (await take(tok.review)).find((x) => x.text === 'text of again')!;
      const capped = await post('findings', tok.review, { ref: e.ref, text: 'a second one, same conversation and day' });
      expect(capped.status).toBe(409);
      expect((await capped.json() as { error: string }).error).toMatch(/one per conversation per UTC day/);
      expect((await post('findings', tok.review, { ref: refs.stranger, text: 'x'.repeat(201) })).status).toBe(400);
      expect((await post('findings', tok.review, { ref: refs.stranger, text: 'two\nlines' })).status).toBe(400);
      expect((await post('findings', tok.review2, { ref: refs.stranger, text: 'not this run' })).status).toBe(404);
      const f = findingsOf(agentDir(h, 'art'));
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ conversation: owner.conversation, seq: owner.seq, measure: 'graded', score: 3, text: 'P1 asked twice before A1 answered.' });
      expect(findingsOf(agentDir(h, 'pond-bot'))).toEqual([]);
    });

    it('an agent\'s conversation_findings returns only its own', async () => {
      const call = async (agent: string) => {
        const { server } = createLoomServer({ contextDir: agentDir(h, agent) });
        const client = new Client({ name: 'audit-test', version: '1' });
        const [c, s] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(s), client.connect(c)]);
        const r = await client.callTool({ name: 'conversation_findings', arguments: {} }) as { content: Array<{ text: string }> };
        await client.close();
        return (JSON.parse(r.content[0].text) as { findings: Array<Record<string, unknown>> }).findings;
      };
      expect((await call('art')).map((x) => x.text)).toEqual(['P1 asked twice before A1 answered.']);
      expect(await call('pond-bot')).toEqual([]);
    });

    it('two findings for one conversation on different UTC days (the turns\' days) both land; a second the same day doesn\'t', async () => {
      const now = Date.now();
      const day1 = new Date(now - 2 * 86_400_000).toISOString();
      const day2 = new Date(now - 1 * 86_400_000).toISOString();
      const reply = (when: string) => ({ agent: 'pond-bot', venue: 'slack', place: 'dm:DAYS', at: when, from: { kind: 'agent', id: 'pond-bot' }, kind: 'reply', run: `r-${when}`, outcome: 'answered', model: 'gemini-2.5-pro', harness: 'opencode' });
      const a = await turn(tok.runtime, reply(day1));
      const b = await turn(tok.runtime, reply(day2));
      const c = await turn(tok.runtime, reply(new Date(Date.parse(day2) + 1000).toISOString()));
      for (const [t, k] of [[a, 'one'], [b, 'two'], [c, 'three']] as const) await audit(tok.runtime, t.conversation, t.seq, `day text ${k}`);
      const es = (await take(tok.review)).filter((x) => /^day text /.test(x.text as string));
      const ref = (k: string) => es.find((x) => x.text === `day text ${k}`)!.ref;
      expect((await post('findings', tok.review, { ref: ref('one'), text: 'first day' })).status).toBe(200);
      expect((await post('findings', tok.review, { ref: ref('two'), text: 'second day' })).status).toBe(200);
      expect((await post('findings', tok.review, { ref: ref('three'), text: 'second day again' })).status).toBe(409);
      expect(findingsOf(agentDir(h, 'pond-bot')).filter((f) => f.conversation === a.conversation).map((f) => f.text).sort()).toEqual(['first day', 'second day']);
    });
  });
});

// ─── 9. One decrypt path ────────────────────────────────────────────────────

describe('criterion 9: one decrypt path', () => {
  const srcDir = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = join(srcDir, '..');
  const SHIPPED = /\.(ts|mts|cts|js|mjs|cjs)$/;
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : SHIPPED.test(e.name) && !/\.test\.[a-z]+$/.test(e.name) && !e.name.endsWith('.d.ts') ? [join(dir, e.name)] : []);
  /**
   * Every script the repo ships or runs, outside web/ (the page's own build) and what's built or
   * installed: src/, scripts/, widgets/, and any other top-level directory or file of code.
   */
  const everything = (): string[] => readdirSync(repoRoot, { withFileTypes: true }).flatMap((e) => {
    if (['web', 'node_modules', 'dist', '.git'].includes(e.name) || e.name.startsWith('.')) return [];
    const p = join(repoRoot, e.name);
    return e.isDirectory() ? files(p) : SHIPPED.test(e.name) && !/\.test\.[a-z]+$/.test(e.name) ? [p] : [];
  });
  /** The source without comments (so a doc comment naming the function doesn't count, and can't hide a call). */
  const code = (path: string) => readFileSync(path, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const NAME = 'decryptAuditText';

  it('the scan covers every shipped script outside web/, not only src/', () => {
    const rel = everything().map((f) => relative(repoRoot, f));
    for (const f of ['scripts/build-widgets.mjs', 'scripts/smoke-test-mcp.ts', 'widgets/hello.widget.ts', 'vitest.config.ts', 'src/audit.ts']) expect(rel, f).toContain(f);
    expect(rel.some((f) => f.startsWith('web/') || f.startsWith('node_modules/') || f.startsWith('dist/'))).toBe(false);
  });

  it('the audit module\'s decrypt function is called only from the take handler', () => {
    const all = everything();
    expect(all.length).toBeGreaterThan(50);
    const naming = all.filter((f) => code(f).includes(NAME)).map((f) => relative(srcDir, f)).sort();
    // Defined in audit.ts, named in audit-take.ts, and nowhere else.
    expect(naming).toEqual(['audit-take.ts', 'audit.ts']);
    const audit = code(join(srcDir, 'audit.ts'));
    expect(audit.match(new RegExp(`\\b${NAME}\\b`, 'g'))).toHaveLength(1);
    expect(audit).toMatch(new RegExp(`export function ${NAME}\\(`));
    // In audit-take.ts: one import and one call, and the call is inside takeAudit.
    const take = code(join(srcDir, 'audit-take.ts'));
    const uses = [...take.matchAll(new RegExp(`\\b${NAME}\\b`, 'g'))].map((m) => m.index!);
    expect(uses).toHaveLength(2);
    expect(take.slice(0, uses[0])).toMatch(/import \{[^}]*$/);
    const start = take.indexOf('export function takeAudit(');
    expect(start).toBeGreaterThan(0);
    // takeAudit is top level: it ends where the next top-level declaration (or the file) begins.
    const next = take.slice(start + 1).search(/\n(?:export |function |const |let |class |interface |type )/);
    const end = next === -1 ? take.length : start + 1 + next;
    expect(uses[1]).toBeGreaterThan(start);
    expect(uses[1]).toBeLessThan(end);
    expect(take.slice(uses[1], uses[1] + NAME.length + 1)).toBe(`${NAME}(`);
    // Nothing reaches the audit module wholesale (a namespace or a re-export could call it by another name).
    for (const f of all) {
      const c = code(f);
      expect(c, relative(srcDir, f)).not.toMatch(/import\s*\*\s*as\s+\w+\s+from\s+['"][./]*audit\.js['"]/);
      expect(c, relative(srcDir, f)).not.toMatch(/export\s*\*\s*from\s+['"][./]*audit\.js['"]/);
      expect(c, relative(srcDir, f)).not.toMatch(/import\(\s*['"][./]*audit\.js['"]\s*\)/);
    }
  });

  it('the review key, and decrypting with it, appear only in the audit module', () => {
    const all = everything();
    // The key's name, as a constant or a string, is the audit module's alone.
    const keyed = all.filter((f) => /\bREVIEW_KEY\b|review\.key/.test(code(f))).map((f) => relative(srcDir, f)).sort();
    expect(keyed).toEqual(['audit.ts']);
    // An age decrypt (-d / --decrypt) runs in two places: the bundle's, of a bundle with the owner's
    // key, which never names the review key; and the audit module's, inside decryptAuditText only.
    const decrypting = all.filter((f) => /['"](?:-d|--decrypt)['"]/.test(code(f))).map((f) => relative(srcDir, f)).sort();
    expect(decrypting).toEqual(['audit.ts', 'bundle.ts']);
    expect(code(join(srcDir, 'bundle.ts'))).not.toMatch(/\bREVIEW_KEY\b|review\.key|AUDIT_FILES\s*\[/);
    const audit = code(join(srcDir, 'audit.ts'));
    const spawns = [...audit.matchAll(/['"](?:-d|--decrypt)['"]/g)].map((m) => m.index!);
    expect(spawns).toHaveLength(1);
    const start = audit.indexOf(`export function ${NAME}(`);
    const next = audit.slice(start + 1).search(/\n(?:export |function |const |let |class |interface |type )/);
    expect(spawns[0]).toBeGreaterThan(start);
    expect(spawns[0]).toBeLessThan(start + 1 + next);
  });
});

// ─── Families and the metadata measures ─────────────────────────────────────

describe('model families (the mapping core reads)', () => {
  it('built-in prefixes, a provider prefix, and household.json\'s families', () => {
    expect(familyOf('claude-opus-4')).toBe('anthropic');
    expect(familyOf('opus')).toBe('anthropic');
    expect(familyOf('anthropic/claude-3')).toBe('anthropic');
    expect(familyOf('gpt-5')).toBe('openai');
    expect(familyOf('o3-mini')).toBe('openai');
    expect(familyOf('openrouter/gemini-2.5-pro')).toBe('google');
    expect(familyOf('olmo-2')).toBeNull();
    expect(familyOf('opusx')).toBeNull();
    expect(familyOf(undefined)).toBeNull();
    // Prototype keys are no family, with or without household.json's families.
    for (const m of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'constructor/x', '__proto__:y']) {
      expect(familyOf(m), m).toBeNull();
      expect(familyOf(m, { families: { 'my-model': 'acme' } }), m).toBeNull();
    }
    const h = { families: { 'my-model': 'acme', 'loc-*': 'local', 'loc-big-*': 'bigco', 'claude-x': 'imitator' } };
    expect(familyOf('My-Model', h)).toBe('acme');
    expect(familyOf('loc-7b', h)).toBe('local');
    expect(familyOf('loc-big-1', h)).toBe('bigco');
    expect(familyOf('claude-x', h)).toBe('imitator');
  });

  it('household.json\'s families is checked when the household loads', () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-families-'));
    try {
      mkdirSync(join(home, 'agents', 'art'), { recursive: true });
      const write = (families: unknown) => writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], families }));
      write({ 'local-llm': 'local' });
      expect(loadHousehold(home)!.families).toEqual({ 'local-llm': 'local' });
      // A __proto__ key is a model name like any other, never the map's prototype.
      writeFileSync(join(home, 'household.json'), '{"v":1,"agents":["art"],"families":{"__proto__":"acme"}}');
      const hh = loadHousehold(home)!;
      expect(familyOf('__proto__', hh)).toBe('acme');
      expect(familyOf('constructor', hh)).toBeNull();
      expect(familyOf('x', hh)).toBeNull();
      for (const bad of [[], { x: 'Bad Name' }, { x: 'unknown' }, { x: 3 }]) {
        write(bad);
        expect(() => loadHousehold(home), JSON.stringify(bad)).toThrow(/families/);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the metadata measures (computeMeasures)', () => {
  it('computes each kind\'s measures for one UTC day, attributed to the measured turn\'s model', () => {
    const h = household('loom-measures-');
    piece(h.home, 'shuttle', { role: 'runtime', venues: VENUES });
    try {
        // The registry, as the daemon's start or an install syncs it.
        syncVenues({ ...process.env, LOOM_HOME: h.home });
        const art = agentDir(h, 'art');
        const d = '2026-10-01';
        const t = (s: number) => new Date(Date.parse(`${d}T08:00:00.000Z`) + s * 1000).toISOString();
        const w = (turn: TurnInput) => recordTurn(art, 'art', turn, 'runtime:shuttle');
        const own = { from: { kind: 'agent' as const, id: 'art' }, model: 'opus', harness: 'claude-code' };
        // live: one answered in 30 s, one never answered.
        w({ venue: 'slack', place: 'a', at: t(0), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
        w({ venue: 'slack', place: 'a', at: t(30), kind: 'reply', run: 'r1', outcome: 'answered', ...own });
        w({ venue: 'slack', place: 'b', at: t(0), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
        // scheduled: a wake, then a run that progresses 120 s later; a second run that fails.
        w({ venue: 'wake', place: 'nightly', at: t(0), from: { kind: 'schedule' }, kind: 'wake' });
        w({ venue: 'wake', place: 'nightly', at: t(60), kind: 'action', run: 'w1', outcome: 'none', ...own });
        w({ venue: 'wake', place: 'nightly', at: t(120), kind: 'action', run: 'w1', outcome: 'progressed', ...own });
        w({ venue: 'wake', place: 'nightly', at: t(500), from: { kind: 'schedule' }, kind: 'wake' });
        w({ venue: 'wake', place: 'nightly', at: t(560), kind: 'action', run: 'w2', outcome: 'failed', ...own });
        // agent: a relay answered on the third turn after its message, and one refused repeat.
        w({ venue: 'relay', place: 'pond-bot', at: t(0), from: { kind: 'agent', id: 'pond-bot' }, kind: 'message' });
        w({ venue: 'relay', place: 'pond-bot', at: t(10), kind: 'reply', run: 'x1', outcome: 'deferred', ...own });
        w({ venue: 'relay', place: 'pond-bot', at: t(20), from: { kind: 'agent', id: 'pond-bot' }, kind: 'message' });
        w({ venue: 'relay', place: 'pond-bot', at: t(30), kind: 'reply', run: 'x1', outcome: 'answered', ...own });
        w({ venue: 'relay', place: 'pond-bot', at: t(40), from: { kind: 'agent', id: 'pond-bot' }, kind: 'refused' });
        // A model named like a prototype key is just an unknown family: the pass doesn't fall over.
        w({ venue: 'slack', place: 'c', at: t(0), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
        w({ venue: 'slack', place: 'c', at: t(5), kind: 'reply', run: 'r9', outcome: 'answered', ...own, model: 'constructor' });
        // Another day's turns don't count.
        w({ venue: 'slack', place: 'a', at: '2026-10-02T08:00:00.000Z', from: { kind: 'person', slug: 'jonathan' }, kind: 'message' });
        expect(computeMeasures(h, d)).toBeGreaterThan(0);
        const rows = scorecards(h.home, d).filter((r) => r.day === d);
        const v = (measure: string) => rows.filter((r) => r.measure === measure && r.model !== 'constructor').map((r) => ({ model: r.model, family: r.family, harness: r.harness, kind: r.kind, value: r.value, n: r.n, same_family: r.same_family }));
        const opus = { model: 'opus', family: 'anthropic', harness: 'claude-code', same_family: false };
        expect(v('first_reply_s')).toEqual([{ ...opus, kind: 'live', value: 30, n: 1 }]);
        expect(rows.filter((r) => r.model === 'constructor').map((r) => [r.measure, r.family])).toEqual([['abandoned', 'unknown'], ['first_reply_s', 'unknown']]);
        // b had no agent turn at all: it's the unknown model's.
        expect(v('abandoned').sort((a, b) => a.model.localeCompare(b.model))).toEqual([
          { ...opus, kind: 'live', value: 0, n: 1 },
          { model: 'unknown', family: 'unknown', harness: 'unknown', same_family: false, kind: 'live', value: 1, n: 1 },
        ]);
        expect(v('due_to_progress_s')).toEqual([{ ...opus, kind: 'scheduled', value: 120, n: 1 }]);
        expect(v('done_rate')).toEqual([{ ...opus, kind: 'scheduled', value: 0.5, n: 2 }]);
        expect(v('round_trips')).toEqual([{ ...opus, kind: 'agent', value: 3, n: 1 }]);
        expect(v('loops_refused')).toEqual([{ ...opus, kind: 'agent', value: 1, n: 1 }]);
        // Recomputing replaces, never adds.
        computeMeasures(h, d);
        expect(scorecards(h.home, d).filter((r) => r.day === d)).toHaveLength(rows.length);
    } finally {
      rmSync(h.home, { recursive: true, force: true });
    }
  });
});

// ─── Who a conversation is with: sticky (criterion 10's non-owner rule) ─────

describe('a conversation with a non-owner stays one', () => {
  const asArt = { kind: 'agent' as const, agent: 'art' };
  const msg = (place: string, at: string, from: Record<string, unknown>) => ({ venue: 'session', place, at, from, kind: 'message' });

  it('the 33rd person, past the people cap, still makes it a non-owner conversation', () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-strangers-cap-'));
    try {
      mkdirSync(join(home, 'agents', 'art'), { recursive: true });
      const members = Array.from({ length: 32 }, (_, i) => ({ person: `m${i}`, role: 'owner', agents: '*' }));
      writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], members }));
      const h = loadHousehold(home)!;
      const base = Date.now() - 3600_000;
      let conv = '';
      for (let i = 0; i < 32; i++) conv = writeTurn(h, asArt, msg('claude-code:cap', new Date(base + i * 1000).toISOString(), { kind: 'person', slug: `m${i}` })).conversation;
      expect(withNonOwner(h, 'art', conv)).toBe(false);
      writeTurn(h, asArt, msg('claude-code:cap', new Date(base + 40_000).toISOString(), { kind: 'person', slug: 'outsider' }));
      // The people list is full: the outsider isn't in it, but the conversation is theirs too.
      expect(getConversation(agentDir(h, 'art'), conv)!.people).not.toContain('outsider');
      expect(withNonOwner(h, 'art', conv)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a conversation from before the mark (no conversation_strangers row) is judged by its people and turns', () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-strangers-old-'));
    try {
      mkdirSync(join(home, 'agents', 'art'), { recursive: true });
      writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
      const h = loadHousehold(home)!;
      const dir = agentDir(h, 'art');
      // Written straight to the store, as slice 1 did: no mark.
      const now = Date.now();
      const iso = (s: number) => new Date(now - 3600_000 + s * 1000).toISOString();
      const viaPeople = recordTurn(dir, 'art', { venue: 'session', place: 'h:1', at: iso(0), from: { kind: 'person', slug: 'loren' }, kind: 'message' }, 'agent:art').conversation;
      const viaUnknown = recordTurn(dir, 'art', { venue: 'session', place: 'h:2', at: iso(1), from: { kind: 'unknown' }, kind: 'message' }, 'agent:art').conversation;
      const owners = recordTurn(dir, 'art', { venue: 'session', place: 'h:3', at: iso(2), from: { kind: 'person', slug: 'jonathan' }, kind: 'message' }, 'agent:art').conversation;
      expect(existsSync(join(home, HOUSEHOLD_DB))).toBe(false);
      expect(withNonOwner(h, 'art', viaPeople)).toBe(true);
      expect(withNonOwner(h, 'art', viaUnknown)).toBe(true);
      expect(withNonOwner(h, 'art', owners)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a harness and model whose turns were all folded are still redacted', () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-vocab-fold-'));
    try {
      mkdirSync(join(home, 'agents', 'art'), { recursive: true });
      writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
      const h = loadHousehold(home)!;
      const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
      writeTurn(h, asArt, { venue: 'session', place: 'claude-code:old', at: old, from: { kind: 'agent', id: 'art' }, kind: 'note', run: 'r-old', outcome: 'none', model: 'quokka-7b', harness: 'zebra-harness' });
      expect(foldConversations(agentDir(h, 'art')).turns).toBe(1);
      const v = vocabularyOf(h);
      expect(v.harnesses).toContain('zebra-harness');
      expect(v.models).toContain('quokka-7b');
      expect(redactor(v).text('zebra-harness ran quokka-7b')).toBe('H1 ran M1');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('an unknown sender\'s turn, folded away after 90 days, still marks it', () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-strangers-fold-'));
    try {
      mkdirSync(join(home, 'agents', 'art'), { recursive: true });
      writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
      const h = loadHousehold(home)!;
      const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
      const { conversation } = writeTurn(h, asArt, msg('claude-code:fold', old, { kind: 'unknown' }));
      writeTurn(h, asArt, msg('claude-code:fold', new Date().toISOString(), { kind: 'person', slug: 'jonathan' }));
      expect(withNonOwner(h, 'art', conversation)).toBe(true);
      expect(foldConversations(agentDir(h, 'art')).turns).toBe(1);
      expect(turnsOf(agentDir(h, 'art'), conversation).some((t) => t.from.kind === 'unknown')).toBe(false);
      expect(withNonOwner(h, 'art', conversation)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─── The review's settings (conversations.md, "Review") ─────────────────────

describe('household.json tz and review', () => {
  it('parses tz (IANA, default UTC) and review ("on" default, "off", or a 1-16 string command)', () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-review-settings-'));
    try {
      mkdirSync(join(home, 'agents', 'art'), { recursive: true });
      const write = (extra: Record<string, unknown>) => writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], ...extra }));
      write({});
      expect(loadHousehold(home)).toMatchObject({ tz: 'UTC', review: 'on' });
      write({ tz: 'America/Chicago', review: 'off' });
      expect(loadHousehold(home)).toMatchObject({ tz: 'America/Chicago', review: 'off' });
      write({ review: ['my-review', '--json'] });
      expect(loadHousehold(home)!.review).toEqual(['my-review', '--json']);
      for (const bad of [{ tz: 'Mars/Olympus' }, { tz: 3 }, { review: 'maybe' }, { review: [] }, { review: Array(17).fill('x') }, { review: ['x'.repeat(201)] }, { review: [3] }]) {
        write(bad);
        expect(() => loadHousehold(home), JSON.stringify(bad)).toThrow(/tz|review/);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the scorecard pass\'s days', () => {
  it('recentDays includes today', () => {
    expect(recentDays(new Date('2026-11-02T05:00:00Z'))).toEqual(['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30']);
  });
});
