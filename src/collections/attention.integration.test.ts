/**
 * The attention records (t-2025): core's `attention` type is the Inbox's own items, made for each viewer by the
 * Inbox's own code, so a badge, Home, the Inbox and a thread's ask card read one set. Pinned here, through the real
 * HTTP server with a stub approvals piece:
 *
 *  - parity: for a household owner and an owner of one agent, the collection holds exactly the Inbox page's items
 *    (keys, folders, attention, unread, words), and its count is the Inbox's Needs you;
 *  - scope: an agent owner never gets another agent's item (a lead card of their agent's they get as their Inbox does:
 *    listed, its Allow the household owner's, which the piece itself refuses them);
 *  - read state is a change: a read in one window reaches that member's live subscription, and no one else's;
 *  - an Allow answered elsewhere reaches a live subscription as a leave, in one frame, before or just after the answer;
 *  - a GET of the Inbox with an item open never marks it read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { nudge } from './pull.js';
import { clearPieceCache } from '../ui/pieces.js';
import { closeAllBackends } from '../backends/index.js';
import { attentionBuilds } from '../ui/handler.js';

const APPROVALS_BIN = `#!${process.execPath}
const fs = require('node:fs');
const f = process.env.LOOM_HOME + '/approvals.json';
const read = () => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return {}; } };
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const a = process.argv.slice(2).filter((x) => x !== '--json');
  const s = read();
  if (a[0] === 'ui' && a.length === 1) {
    return console.log(JSON.stringify({ v: 2, owners: 2, tab: { label: 'Approvals', kind: 'setting' }, asks: Object.entries(s).filter(([, x]) => x.state === 'pending')
      .filter(([, x]) => !process.env.LOOM_OWNER_SCOPE || process.env.LOOM_OWNER_SCOPE.split(',').includes(x.agent))
      .map(([id, x]) => ({ text: x.text, kind: 'permission', agent: x.agent, page: '', at: x.at, ...(x.lead ? { lead: true } : {}),
        actions: [{ action: 'allow', label: 'Allow', tone: 'primary', fields: { id } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id } }] })) }));
  }
  if (a[0] === 'ui' && a[1] === 'act') {
    const req = JSON.parse(input);
    const x = s[req.fields.id];
    if (!x || x.state !== 'pending') return console.log(JSON.stringify({ ok: false, message: 'not pending' }));
    x.state = req.action === 'allow' ? 'allowed' : 'denied';
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

const CARDS = {
  'a-00000001': { state: 'pending', agent: 'art', text: 'Let Art read the shared calendar?', at: '2026-11-09T10:00:00Z' },
  'a-00000002': { state: 'pending', agent: 'mark', text: 'Let Mark post to the studio channel?', at: '2026-11-09T11:00:00Z' },
  'a-00000003': { state: 'pending', agent: 'art', lead: true, text: 'Give Art access to Tasks?', at: '2026-11-09T12:00:00Z' },
};

interface Frame { event: string; data: Record<string, unknown> }
async function openEvents(base: string, token: string): Promise<{ frames: Frame[]; stop: () => void; hello: Record<string, unknown> }> {
  const ac = new AbortController();
  const r = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ac.signal });
  if (r.status !== 200) throw new Error(`events: ${r.status}`);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = any;
const FIELDS = ['agent', 'kind', 'box', 'attention', 'unread', 'text', 'sort', 'actions'];

describe('attention records: the Inbox\'s items, one set for every view (t-2025)', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const streams: Array<{ stop: () => void }> = [];
  const saved = process.env.LOOM_HOME;

  beforeEach(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-attention-'));
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
    writeFileSync(join(home, 'approvals.json'), JSON.stringify(CARDS));
    h = loadHousehold(home)!;
    process.env.LOOM_HOME = h.home;
    clearPieceCache();
    tok.jonathan = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    tok.sam = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    for (const s of streams.splice(0)) s.stop();
    await handle.close();
    await closeAllBackends();
    clearPieceCache();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    rmSync(h.home, { recursive: true, force: true });
  });

  const page = async (who: string, path = '/inbox'): Promise<Data> => (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${tok[who]}`, accept: 'application/json' } })).json();
  const ask = async (who: string, q: Record<string, unknown>) => {
    const r = await fetch(`${base}/collections/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok[who]}` },
      body: JSON.stringify({ queries: [{ id: 'q', type: 'loom/attention@^1', fields: FIELDS, ...q }] }) });
    return ((await r.json()) as { answers: Data[] }).answers[0];
  };
  const read = async (who: string, key: string) => {
    const r = await fetch(`${base}/inbox/read`, { method: 'POST', headers: { authorization: `Bearer ${tok[who]}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `i=${key}` });
    expect(r.status).toBe(200);
  };
  const shape = (xs: Data[]) => xs.map((x) => ({ key: String(x.key).replace(/^loom\/attention\//, ''), box: x.box, kind: x.kind, attention: x.attention, unread: x.unread, text: x.text, agent: x.agent }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  // First in the file: live.ts keeps one file watcher a process, on the first household that opened a stream, and a
  // test process makes a household a test (loom serves one).
  it('a piece\'s own new ask (its manifest moving, said by pieces.tick) reaches a live window', async () => {
    const jon = await openEvents(base, tok.jonathan); streams.push(jon);
    await page('jonathan');
    await ask('jonathan', { subscribe: true, stream: jon.hello.stream });
    await new Promise((r) => setTimeout(r, 2_000));
    const t0 = Date.now();
    writeFileSync(join(h.home, 'approvals.json'), JSON.stringify({ ...CARDS, 'a-00000009': { state: 'pending', agent: 'art', text: 'Let Art book the van?', at: new Date().toISOString() } }));
    writeFileSync(join(h.home, 'pieces.tick'), String(Date.now()));
    expect(await until(() => jon.frames.some((f) => f.event === 'rows' && ((f.data.upserts as Data[]) ?? []).some((u) => u.text === 'Let Art book the van?')), 10_000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4_000);
  }, 30_000);

  it('answers unavailable, never "nothing", before loom has been asked for a page', async () => {
    // The machine route doesn't go through the page's handler, so nothing has registered the Inbox's code yet.
    const api = async () => ((await (await fetch(`${base}/api/loom/collections/query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.jonathan}` },
      body: JSON.stringify({ queries: [{ id: 'q', type: 'loom/attention@^1', fields: FIELDS }] }) })).json()) as { answers: Data[] }).answers[0];
    expect((await api()).error).toBe('unavailable');
    await page('jonathan');
    expect((await api()).rows.length).toBeGreaterThan(0);
  });

  it('holds exactly what each member\'s Inbox page holds, and counts its Needs you', async () => {
    for (const who of ['jonathan', 'sam']) {
      const p = await page(who);
      const a = await ask(who, {});
      expect(a.error, who).toBeUndefined();
      expect(a.coverage.complete).toBe(true);
      expect(shape(a.rows), who).toEqual(shape(p.items));
      const n = await ask(who, { where: [['attention', 'eq', true]], aggregates: ['count'] });
      expect(n.aggregates.count.n, who).toBe((p.items as Data[]).filter((i) => i.attention).length);
    }
  });

  it('left alone, a live subscription costs nothing: its own reads never read as news (the -wal echo)', async () => {
    const jon = await openEvents(base, tok.jonathan); streams.push(jon);
    await page('jonathan');
    await ask('jonathan', { subscribe: true, stream: jon.hello.stream });
    // Let the first pulls and their echoes settle, then count builds over twelve quiet seconds: at most the 15 s pull.
    await new Promise((r) => setTimeout(r, 3_000));
    const before = attentionBuilds(h.home);
    await new Promise((r) => setTimeout(r, 12_000));
    expect(attentionBuilds(h.home) - before).toBeLessThanOrEqual(2);
  }, 30_000);

  it('an agent\'s new ask (its digest, and the nudge its tool sends) reaches a live window', async () => {
    const jon = await openEvents(base, tok.jonathan); streams.push(jon);
    await page('jonathan');
    await ask('jonathan', { subscribe: true, stream: jon.hello.stream });
    const art = agentDir(h, 'art');
    const cv = recordTurn(art, 'art', { venue: 'wake', place: 'lane:x', label: 'x', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    const t0 = Date.now();
    writeDigest(art, { conversation: cv, run: 'r1' }, { summary: 'Checked.', needs_owner: { ask: 'OK to restart the backup now?', if_yes: 'I restart it.', if_no: 'I wait.' } } as never);
    nudge(h.home, 'loom/attention');
    expect(await until(() => jon.frames.some((f) => f.event === 'rows' && ((f.data.upserts as Data[]) ?? []).some((u) => u.text === 'OK to restart the backup now?')))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3_000);
  }, 30_000);

  it('however many subscriptions a viewer holds, a change costs them a build or two, not one each', async () => {
    const jon = await openEvents(base, tok.jonathan); streams.push(jon);
    await page('jonathan');
    for (let i = 0; i < 12; i++) await ask('jonathan', { id: `q${i}`, subscribe: true, stream: jon.hello.stream, limit: 100 + i });
    await new Promise((r) => setTimeout(r, 3_000));
    const before = attentionBuilds(h.home);
    const key = (await ask('jonathan', {})).rows[0].key.split('/')[2];
    const r = await fetch(`${base}/inbox/read`, { method: 'POST', headers: { authorization: `Bearer ${tok.jonathan}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `i=${key}` });
    expect(r.status).toBe(200);
    await new Promise((r2) => setTimeout(r2, 4_000));
    // The query just above (1), the snapshot (1, every member inside it), and Jonathan's re-asks (at most 2), not 12.
    expect(attentionBuilds(h.home) - before).toBeLessThanOrEqual(5);
  }, 30_000);

  it('an agent owner never gets another agent\'s item', async () => {
    const a = await ask('sam', {});
    const texts = (a.rows as Data[]).map((r) => r.text);
    expect(texts).toContain('Let Art read the shared calendar?');
    expect(texts).not.toContain('Let Mark post to the studio channel?');
    expect((await ask('jonathan', {})).rows.map((r: Data) => r.text)).toEqual(expect.arrayContaining(['Let Mark post to the studio channel?', 'Give Art access to Tasks?']));
  });

  it('a GET with an item open never marks it read; a read is a change for that member alone', async () => {
    const p = await page('jonathan');
    const it = (p.items as Data[]).find((i) => i.text === 'Let Art read the shared calendar?');
    expect(it.unread).toBe(true);
    await page('jonathan', `/inbox?i=${it.key}`);
    expect((await page('jonathan')).items.find((i: Data) => i.key === it.key).unread).toBe(true);

    const jon = await openEvents(base, tok.jonathan); streams.push(jon);
    const sam = await openEvents(base, tok.sam); streams.push(sam);
    const j = await ask('jonathan', { subscribe: true, stream: jon.hello.stream });
    const s = await ask('sam', { subscribe: true, stream: sam.hello.stream });
    expect(j.rows.find((r: Data) => r.key === `loom/attention/${it.key}`).unread).toBe(true);
    expect(s.rows.find((r: Data) => r.key === `loom/attention/${it.key}`).unread).toBe(true);
    const t0 = Date.now();
    await read('jonathan', it.key);
    const upserted = (ev: { frames: Frame[] }) => ev.frames.some((f) => f.event === 'rows' && ((f.data.upserts as Data[]) ?? []).some((u) => u.key === `loom/attention/${it.key}` && u.unread === false));
    expect(await until(() => upserted(jon))).toBe(true);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(5000);
    // Sam's own read state didn't move: nothing of Jonathan's read reaches his window as a change to that item.
    await new Promise((r) => setTimeout(r, 2500));
    expect(upserted(sam)).toBe(false);
    expect((await ask('sam', {})).rows.find((r: Data) => r.key === `loom/attention/${it.key}`).unread).toBe(true);
  }, 30_000);

  it('an Allow answered in one window leaves every live subscription that held it', async () => {
    const jon = await openEvents(base, tok.jonathan); streams.push(jon);
    const sam = await openEvents(base, tok.sam); streams.push(sam);
    const j = await ask('jonathan', { subscribe: true, stream: jon.hello.stream, where: [['attention', 'eq', true]], aggregates: ['count'] });
    await ask('sam', { subscribe: true, stream: sam.hello.stream, where: [['attention', 'eq', true]], aggregates: ['count'] });
    const key = (j.rows as Data[]).find((r) => r.text === 'Let Art read the shared calendar?').key;
    const csrf = (await page('jonathan')).ctx.csrf;
    const r = await fetch(`${base}/act/approvals`, { method: 'POST', headers: { authorization: `Bearer ${tok.jonathan}`, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' },
      body: new URLSearchParams({ _csrf: csrf, _action: 'allow', _path: 'loom:inbox', id: 'a-00000001' }).toString() });
    expect(r.status).toBe(200);
    const left = (ev: { frames: Frame[] }) => ev.frames.find((f) => f.event === 'rows' && ((f.data.leaves as string[]) ?? []).includes(key));
    expect(await until(() => !!left(jon) && !!left(sam))).toBe(true);
    // The count moves in the same frame as the row.
    expect((left(jon)!.data.aggregates as Data).count.n).toBe(j.aggregates.count.n - 1);
    // What core holds of each item says exactly whose Inbox has it: Jonathan's own outcome ("You did this") is his
    // alone, Mark's card only Jonathan's (Sam doesn't own Mark), Art's card both of theirs.
    const idx = () => {
      const db = new BetterSqlite3(join(h.home, 'collections', 'live.db'), { readonly: true });
      try { return db.prepare("SELECT key, audience, record FROM idx WHERE key LIKE 'loom/attention/%'").all() as Array<{ key: string; audience: string; record: string }>; } finally { db.close(); }
    };
    const mine = (r: Data) => r.kind === 'fyi' && r.meta === 'You did this';
    // The outcome is noted after the action answers: the next pull (soon, coalesced) brings it.
    expect(await until(() => idx().some((x) => mine(JSON.parse(x.record))))).toBe(true);
    const whose = (f: (r: Data) => boolean) => JSON.parse(idx().find((x) => f(JSON.parse(x.record)))!.audience);
    expect(whose(mine)).toEqual({ members: ['jonathan'] });
    expect(whose((r) => r.text === 'Let Mark post to the studio channel?')).toEqual({ members: ['jonathan'] });
    expect(whose((r) => r.text === 'Give Art access to Tasks?')).toEqual({ members: ['jonathan', 'sam'] });
  }, 30_000);
});
