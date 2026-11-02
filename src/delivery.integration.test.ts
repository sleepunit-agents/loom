/**
 * Delivery, core's half (docs/specs/agent-runtime.md, "5. Delivery"; "Seams this needs from
 * core", 2; t-1744): POST /api/loom/deliver through the real HTTP server, with a stub runtime
 * piece (role runtime, offering `delivery`, declaring `relay`) and stub sources (a venue
 * adapter declaring `slack`, a clock declaring nothing, since `wake` is core's).
 *
 * The stub runtime appends every stdin it gets to $LOOM_HOME/runtime-calls.jsonl, so a test
 * can see whether core called it, and how often. $LOOM_HOME/runtime-mode picks its answer:
 * ok (the default), fail (exit 1, nothing said), said (exit 1 with {status: 503, error}),
 * bad (an answer that isn't the contract's), slow.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from './household.js';
import { runtimePieces } from './cli/pieces-managed.js';
import { createConversationTables } from './backends/conversations.js';
import { DELIVERY_REPLAY_MS, keepAnswer, parseDeliver, replayOf, sweepDeliveries } from './delivery.js';
import { clearPieceCache } from './ui/pieces.js';

function household(prefix: string): Household {
  const home = mkdtempSync(join(tmpdir(), prefix));
  for (const a of ['art', 'mark']) {
    mkdirSync(join(home, 'agents', a), { recursive: true });
    writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
    createConversationTables(db);
    db.close();
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({
    v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }],
  }));
  return loadHousehold(home)!;
}

const RUNTIME_BIN = `#!${process.execPath}
const fs = require('node:fs');
const home = process.env.LOOM_HOME;
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(home + '/runtime-calls.jsonl', JSON.stringify({ argv: process.argv.slice(2), stdin: JSON.parse(input) }) + '\\n');
  const n = fs.readFileSync(home + '/runtime-calls.jsonl', 'utf-8').trim().split('\\n').length;
  const mode = fs.existsSync(home + '/runtime-mode') ? fs.readFileSync(home + '/runtime-mode', 'utf-8').trim() : 'ok';
  if (mode === 'fail') { process.exit(1); }
  if (mode === 'said') { console.log(JSON.stringify({ status: 503, error: 'no house free for art' })); process.exit(1); }
  if (mode === 'said-badly') { console.log(JSON.stringify({ status: 404, error: 'not a 5xx' })); process.exit(1); }
  if (mode === 'bad') { console.log(JSON.stringify({ conversation: 'nope', seq: 0, body: 'eaten' })); return; }
  const answer = () => console.log(JSON.stringify({ conversation: 'cv-0123456789ab', seq: n, body: 'started' }));
  if (mode === 'slow') setTimeout(answer, 400); else answer();
});
`;

/** A managed piece record and its bin, as an install leaves them: `loom` is the checked block. */
function piece(home: string, name: string, loom: Record<string, unknown>, body = '#!/bin/sh\nexit 3\n'): void {
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

const RUNTIME_LOOM = { role: 'runtime', delivery: ['loom-runtime', 'deliver', '--json'], venues: { relay: { label: 'Relay', kind: 'agent', send: ['loom-runtime', 'relay-send'] } } };
const SLACK_LOOM = { venues: { slack: { label: 'Slack', kind: 'live', send: ['loom-slack', 'send'] }, 'slack-huddle': { label: 'Huddle', kind: 'live' } } };

const AT = '2026-11-02T12:00:00.000Z';
/** A person's Slack message to art: the venue adapter's delivery. */
const slackMsg = (id: string, extra: Record<string, unknown> = {}) => ({
  id, agent: 'art', venue: 'slack', place: 'dm:U1', label: 'Loren (DM)', from: { kind: 'person', slug: 'loren' }, kind: 'message', at: AT, text: 'hi art', ...extra,
});
const wake = (id: string, extra: Record<string, unknown> = {}) => ({
  id, agent: 'art', venue: 'wake', place: 'lane:knowledge', from: { kind: 'schedule' }, kind: 'wake', at: AT, text: "it's 03:13, run the knowledge lane", ...extra,
});
const relay = (id: string, extra: Record<string, unknown> = {}) => ({
  id, agent: 'mark', venue: 'relay', place: 'art>mark', from: { kind: 'agent', id: 'art' }, kind: 'message', at: AT, text: 'can you look at t-1', ...extra,
});

describe('POST /api/loom/deliver', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;

  const calls = (): Array<{ argv: string[]; stdin: Record<string, unknown> }> => {
    const f = join(h.home, 'runtime-calls.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const mode = (m: 'ok' | 'fail' | 'said' | 'said-badly' | 'bad' | 'slow') => writeFileSync(join(h.home, 'runtime-mode'), m);
  const kept = (): number => {
    const db = new BetterSqlite3(join(h.home, 'household.db'));
    try {
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get();
      return has ? (db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as { n: number }).n : 0;
    } finally { db.close(); }
  };
  const post = async (token: string | undefined, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/api/loom/deliver`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };

  beforeAll(async () => {
    h = household('loom-deliver-');
    process.env.LOOM_HOME = h.home;
    piece(h.home, 'runtime', RUNTIME_LOOM, RUNTIME_BIN);
    piece(h.home, 'slack', SLACK_LOOM);
    piece(h.home, 'clock', {});
    tok.owner = createToken(h, { role: { kind: 'owner' }, label: 'owner' }).token;
    tok.art = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'art' }).token;
    tok.peer = createToken(h, { role: { kind: 'peer', name: 'pal' }, label: 'pal' }).token;
    tok.slack = createToken(h, { role: { kind: 'piece', piece: 'slack', subject: 'bot' }, label: 'slack' }).token;
    tok.clock = createToken(h, { role: { kind: 'piece', piece: 'clock', subject: 'tick' }, label: 'clock' }).token;
    tok.ghost = createToken(h, { role: { kind: 'piece', piece: 'ghost', subject: 'x' }, label: 'not installed' }).token;
    tok.runtimePiece = createToken(h, { role: { kind: 'piece', piece: 'runtime', subject: 'relay' }, label: 'runtime piece' }).token;
    tok.runtime = createToken(h, { role: { kind: 'runtime', piece: 'runtime' }, label: 'runtime', runtimePieces: runtimePieces(process.env) }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });
  beforeEach(() => {
    rmSync(join(h.home, 'runtime-calls.jsonl'), { force: true });
    mode('ok');
    piece(h.home, 'runtime', RUNTIME_LOOM, RUNTIME_BIN);
    clearPieceCache();
  });

  describe('forwards to the delivery piece, and passes its answer back', () => {
    it('a venue adapter delivers a person\'s message: core runs the delivery argv with the body (and its source) on stdin', async () => {
      const r = await post(tok.slack, slackMsg('m-1'));
      expect(r).toEqual({ status: 200, body: { conversation: 'cv-0123456789ab', seq: 1, body: 'started' } });
      expect(calls()).toEqual([{ argv: ['deliver', '--json'], stdin: { source: 'slack', ...slackMsg('m-1') } }]);
    });

    it('the clock knocks on core\'s wake venue; the runtime relays as an agent with its piece token or its runtime token', async () => {
      expect((await post(tok.clock, wake('w-1'))).status).toBe(200);
      expect((await post(tok.runtimePiece, relay('r-1'))).status).toBe(200);
      expect((await post(tok.runtime, relay('r-2'))).status).toBe(200);
      expect(calls().map((c) => c.stdin.source)).toEqual(['clock', 'runtime', 'runtime']);
    });

    it('a label-less message is a delivery too', async () => {
      const { label: _l, ...noLabel } = slackMsg('m-nolabel');
      expect((await post(tok.slack, noLabel)).status).toBe(200);
    });
  });

  describe('idempotent on (calling piece, id) for 24 hours', () => {
    it('a repeat returns the first answer verbatim and calls the runtime once', async () => {
      const first = await post(tok.slack, slackMsg('m-dup'));
      const again = await post(tok.slack, slackMsg('m-dup', { text: 'a different text, same id' }));
      expect(first.status).toBe(200);
      expect(again).toEqual(first);
      expect(calls()).toHaveLength(1);
    });

    it('the same id from another piece is another delivery', async () => {
      await post(tok.slack, slackMsg('shared-id'));
      await post(tok.clock, wake('shared-id'));
      expect(calls()).toHaveLength(2);
    });

    it('concurrent repeats share the one forward', async () => {
      mode('slow');
      const rs = await Promise.all([1, 2, 3].map(() => post(tok.slack, slackMsg('m-race'))));
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(new Set(rs.map((r) => JSON.stringify(r.body))).size).toBe(1);
      expect(calls()).toHaveLength(1);
    });

    it('a failed forward is a 5xx and isn\'t kept: the retry reaches the runtime', async () => {
      mode('fail');
      const failed = await post(tok.slack, slackMsg('m-retry'));
      expect(failed.status).toBe(502);
      expect(failed.body.error).toMatch(/the delivery piece \(runtime\) failed \(exit 1\)/);
      mode('bad');
      const bad = await post(tok.slack, slackMsg('m-retry'));
      expect(bad.status).toBe(502);
      expect(bad.body.error).toMatch(/invalid: conversation is a conversation id/);
      mode('ok');
      const ok = await post(tok.slack, slackMsg('m-retry'));
      expect(ok).toEqual({ status: 200, body: { conversation: 'cv-0123456789ab', seq: 3, body: 'started' } });
      expect(calls()).toHaveLength(3);
      expect(await post(tok.slack, slackMsg('m-retry'))).toEqual(ok);
      expect(calls()).toHaveLength(3);
    });

    it('a runtime that says it failed (exit 1, {status: 5xx, error}) is that status, and isn\'t kept', async () => {
      mode('said');
      expect(await post(tok.slack, slackMsg('m-said'))).toEqual({ status: 503, body: { error: 'no house free for art' } });
      // Saying a status outside 5xx is no contract answer: core's 502.
      mode('said-badly');
      const r = await post(tok.slack, slackMsg('m-said'));
      expect(r.status).toBe(502);
      expect(r.body.error).toMatch(/failed \(exit 1\)/);
      mode('ok');
      expect((await post(tok.slack, slackMsg('m-said'))).status).toBe(200);
      expect(calls()).toHaveLength(3);
    });

    it('the table is in household.db; an answer over 24 hours old is neither replayed nor kept', () => {
      const t0 = Date.parse(AT);
      keepAnswer(h.home, 'slack', 'old', { conversation: 'cv-0123456789ab', seq: 9, body: 'fed' }, t0);
      expect(replayOf(h.home, 'slack', 'old', t0 + DELIVERY_REPLAY_MS - 1)).toEqual({ conversation: 'cv-0123456789ab', seq: 9, body: 'fed' });
      expect(replayOf(h.home, 'slack', 'old', t0 + DELIVERY_REPLAY_MS)).toBeUndefined();
      const before = kept();
      expect(sweepDeliveries(h.home, t0 + DELIVERY_REPLAY_MS)).toBeGreaterThanOrEqual(1);
      expect(kept()).toBeLessThan(before);
      // A write sweeps too.
      keepAnswer(h.home, 'slack', 'old2', { conversation: 'cv-0123456789ab', seq: 1, body: 'fed' }, t0);
      keepAnswer(h.home, 'slack', 'new', { conversation: 'cv-0123456789ab', seq: 2, body: 'fed' }, t0 + DELIVERY_REPLAY_MS + 1);
      expect(replayOf(h.home, 'slack', 'old2', t0)).toBeUndefined();
    });
  });

  describe('who may deliver what: each refusal is a 403 with the reason, and writes nothing', () => {
    const refused = async (token: string, body: unknown, re: RegExp) => {
      const before = kept();
      const r = await post(token, body);
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(re);
      expect(calls()).toHaveLength(0);
      expect(kept()).toBe(before);
    };

    it('a venue the calling piece doesn\'t declare', async () => {
      await refused(tok.clock, slackMsg('x-1'), /clock doesn't declare venue slack/);
      await refused(tok.slack, relay('x-2'), /slack doesn't declare venue relay/);
      await refused(tok.slack, slackMsg('x-3', { venue: 'discord' }), /slack doesn't declare venue discord/);
    });

    it('a venue named after an inherited key (constructor, toString…) is no declared venue', async () => {
      // slack declares venues, so a prototype lookup on its map would find Object's members.
      for (const venue of ['constructor', 'tostring', 'hasownproperty', 'valueof']) {
        await refused(tok.slack, slackMsg(`p-${venue}`, { venue }), new RegExp(`slack doesn't declare venue ${venue}`));
      }
      // Not a venue name at all: refused at the body, and nothing runs either.
      for (const venue of ['__proto__', 'toString']) {
        const r = await post(tok.slack, slackMsg(`p-${venue}`, { venue }));
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/venue is a venue name/);
      }
      expect(calls()).toHaveLength(0);
    });

    it('session is no one\'s to deliver into; wake carries only a schedule\'s knock', async () => {
      await refused(tok.runtime, slackMsg('x-4', { venue: 'session' }), /venue session is a harness's own/);
      await refused(tok.slack, wake('x-5', { from: { kind: 'person', slug: 'loren' } }), /on venue wake, from is \{kind: schedule\}/);
    });

    it('an agent the calling piece isn\'t granted: not one of the household\'s', async () => {
      await refused(tok.slack, slackMsg('x-6', { agent: 'zed' }), /zed isn't one of this household's agents/);
    });

    it('from a person only from a venue adapter on its own venue', async () => {
      await refused(tok.runtime, relay('x-7', { from: { kind: 'person', slug: 'loren' } }), /from \{kind: person\} comes only from a venue adapter/);
    });

    it('from an agent only from the runtime', async () => {
      await refused(tok.slack, slackMsg('x-8', { from: { kind: 'agent', id: 'mark' } }), /from \{kind: agent\} comes only from the runtime/);
    });

    it('a piece token for a piece that isn\'t installed', async () => {
      await refused(tok.ghost, wake('x-9'), /ghost isn't an installed managed piece/);
    });

    it('owner, agent and peer tokens don\'t deliver; no token at all is a 401', async () => {
      for (const t of [tok.owner, tok.art]) await refused(t, slackMsg('x-10'), /takes a piece's own token/);
      expect((await post(tok.peer, slackMsg('x-11'))).status).toBe(403);
      expect((await post(undefined, slackMsg('x-12'))).status).toBe(401);
      expect(calls()).toHaveLength(0);
    });
  });

  describe('the body is the contract\'s, or a 400', () => {
    it.each<[string, Record<string, unknown>, RegExp]>([
      ['no id', { id: undefined }, /id is required/],
      ['an id over 200', { id: 'i'.repeat(201) }, /id is required/],
      ['text over 40,000', { text: 't'.repeat(40_001) }, /text is required: the message, 1-40000/],
      ['no text', { text: undefined }, /text is required/],
      ['a reply (the runtime records those, not a source)', { kind: 'reply' }, /kind is one of message, wake/],
      ['a note (the agent\'s own turn)', { kind: 'note' }, /a note is the agent's own turn/],
      ['an unknown key', { extra: 1 }, /no key "extra"/],
      ['a place over 200', { place: 'p'.repeat(201) }, /place is 1-200/],
      ['a local time', { at: '2026-11-02T12:00:00' }, /at is an ISO-8601 UTC time/],
      ['a label over 80', { label: 'l'.repeat(81) }, /label/],
      ['a from of no kind', { from: { slug: 'loren' } }, /from/],
    ])('%s', async (_w, extra, re) => {
      const body: Record<string, unknown> = slackMsg('b-1', extra);
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      expect(typeof parseDeliver(body) === 'string' ? parseDeliver(body) : 'parsed').toMatch(re);
      const r = await post(tok.slack, body);
      expect(r.status).toBe(400);
      expect(calls()).toHaveLength(0);
    });

    it('40,000 characters of text is fine', async () => {
      expect((await post(tok.slack, slackMsg('b-big', { text: 'é'.repeat(40_000) }))).status).toBe(200);
    });

    it('a browser request is refused', async () => {
      expect((await post(tok.slack, slackMsg('b-2'), { origin: 'https://evil.example' })).status).toBe(403);
    });
  });

  describe('GET /api/loom/venues (the runtime\'s view of every venue)', () => {
    const get = async (token: string | undefined, method = 'GET') => {
      const r = await fetch(`${base}/api/loom/venues`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
      return { status: r.status, body: await r.json() as Record<string, unknown> };
    };

    it('answers core\'s venues and each declared one with its kind, piece and send argv', async () => {
      const r = await get(tok.runtime);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ venues: [
        { name: 'session', label: 'Session', kind: 'live', piece: 'loom' },
        { name: 'wake', label: 'Wake', kind: 'scheduled', piece: 'loom' },
        { name: 'relay', label: 'Relay', kind: 'agent', piece: 'runtime', send: ['loom-runtime', 'relay-send'] },
        { name: 'slack', label: 'Slack', kind: 'live', piece: 'slack', send: ['loom-slack', 'send'] },
        { name: 'slack-huddle', label: 'Huddle', kind: 'live', piece: 'slack' },
      ] });
    });

    it('only the runtime\'s token, and only GET', async () => {
      for (const t of [tok.owner, tok.art, tok.slack, tok.runtimePiece, tok.peer]) expect((await get(t)).status).toBe(403);
      expect((await get(undefined)).status).toBe(401);
      expect((await get(tok.runtime, 'POST')).status).toBe(405);
    });
  });

  describe('503s', () => {
    it('no delivery piece installed: refused with the reason, nothing kept', async () => {
      piece(h.home, 'runtime', { role: 'runtime', venues: RUNTIME_LOOM.venues }, RUNTIME_BIN);
      const r = await post(tok.slack, slackMsg('n-1'));
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/no installed piece offers delivery/);
      expect(calls()).toHaveLength(0);
      // Not kept: once a runtime is there, the same id is delivered.
      piece(h.home, 'runtime', RUNTIME_LOOM, RUNTIME_BIN);
      expect((await post(tok.slack, slackMsg('n-1'))).status).toBe(200);
    });

    it('a grants authority core can\'t ask yet fails closed for other pieces; its own calls pass', async () => {
      piece(h.home, 'runtime', { ...RUNTIME_LOOM, grants: true }, RUNTIME_BIN);
      const r = await post(tok.slack, slackMsg('g-1'));
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/grants authority \(runtime\) can't be asked yet/);
      expect(calls()).toHaveLength(0);
      expect((await post(tok.runtime, relay('g-2'))).status).toBe(200);
    });
  });
});
