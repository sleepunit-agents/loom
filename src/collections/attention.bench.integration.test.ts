/**
 * A bench, not a test (skipped unless LOOM_BENCH names a file for its results): what needs you, the old way (each window's page, asked again on
 * loom's bare "something changed") against the live attention set (t-2025). Prints first-load and update times.
 *
 * Copied from attention.integration.test.ts's stubs:
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
import { createConversationTables } from '../backends/conversations.js';
import { clearPieceCache } from '../ui/pieces.js';
import { closeAllBackends } from '../backends/index.js';

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


// A viewer sees at most ten asks per piece; a manifest may carry more candidates before the member checks.
const N = Number(process.env.LOOM_BENCH_ASKS ?? 10);
// Between rounds: a person answering every few seconds. Closer than GAP_MS (1.5 s) apart, changes coalesce by design.
const SPACING = Number(process.env.LOOM_BENCH_SPACING ?? 3_500);
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe.skipIf(!process.env.LOOM_BENCH)('bench: what needs you, page refetch vs the live attention set', () => {
  it('first load and update latency', async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-attention-bench-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['art'] }] }));
    piece(home, 'approvals', { role: 'approvals' }, APPROVALS_BIN);
    const cards: Record<string, unknown> = {};
    for (let i = 0; i < N; i++) cards[`a-${String(i).padStart(8, '0')}`] = { state: 'pending', agent: i % 2 ? 'art' : 'mark', text: `Ask number ${i}: may I do the thing?`, at: new Date(Date.UTC(2026, 10, 9, 0, i)).toISOString() };
    writeFileSync(join(home, 'approvals.json'), JSON.stringify(cards));
    const h = loadHousehold(home)!;
    const saved = process.env.LOOM_HOME;
    process.env.LOOM_HOME = home;
    clearPieceCache();
    const token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    const handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    const base = `http://127.0.0.1:${handle.port}`;
    const auth = { authorization: `Bearer ${token}` };
    const get = async (path: string) => { const t = performance.now(); const r = await fetch(`${base}${path}`, { headers: { ...auth, accept: 'application/json' } }); const b = await r.text(); return { ms: performance.now() - t, bytes: b.length, json: JSON.parse(b) }; };
    const query = async (q: Record<string, unknown>) => { const t = performance.now(); const r = await fetch(`${base}/collections/query`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ queries: [{ id: 'q', type: 'loom/attention@^1', order: [['sort', 'desc']], limit: 500, ...q }] }) }); const b = await r.text(); return { ms: performance.now() - t, bytes: b.length, json: JSON.parse(b) }; };
    const out: Record<string, unknown> = {};
    // Warm the manifest cache once, as a running loom has it.
    await get('/inbox'); await query({});
    const R = 7;
    const inboxGet: number[] = [], homeGet: number[] = [], coll: number[] = [];
    let inboxBytes = 0, homeBytes = 0, collBytes = 0;
    for (let i = 0; i < R; i++) {
      const a = await get('/inbox'); inboxGet.push(a.ms); inboxBytes = a.bytes;
      const b = await get('/'); homeGet.push(b.ms); homeBytes = b.bytes;
      const c = await query({}); coll.push(c.ms); collBytes = c.bytes;
    }
    out.firstLoad = { inboxPageMs: med(inboxGet), inboxPageBytes: inboxBytes, homePageMs: med(homeGet), homePageBytes: homeBytes, attentionQueryMs: med(coll), attentionQueryBytes: collBytes };

    // Update: an Allow in one window. Old: the bare change, then each open window asks its page again (here: the
    // Inbox's and Home's). New: the leave arrives on the stream with the count moved, nothing asked again.
    const ev = await openEvents(base, token);
    const sub = await query({ subscribe: true, stream: ev.hello.stream });
    if (!sub.json.answers?.[0]?.rows) throw new Error(`subscribe: ${JSON.stringify(sub.json).slice(0, 300)}`);
    const csrf = (await get('/inbox')).json.ctx.csrf;
    const oldMs: number[] = [], newMs: number[] = [], actMs: number[] = [];
    // A piece's manifest carries its first 10 asks (src/ui/pieces.ts): those are the ones answered here.
    const held = (sub.json.answers[0].rows as Data[]).filter((r) => r.actions?.[0]?.fields?.id);
    if (held.length < 10) throw new Error(`held ${held.length}: ${JSON.stringify(sub.json.answers[0]).slice(0, 600)}`);
    for (let i = 0; i < R; i++) {
      const id = held[i].actions[0].fields.id as string;
      const key = held[i].key as string;
      const from = ev.frames.length;
      const t0 = performance.now();
      const act = fetch(`${base}/act/approvals`, { method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' },
        body: new URLSearchParams({ _csrf: csrf, _action: 'allow', _path: 'loom:inbox', id }).toString() }).then((r) => r.text()).then(() => actMs.push(performance.now() - t0));
      let tChange = 0, tRows = 0;
      await until(() => {
        for (const f of ev.frames.slice(from)) {
          if (!tChange && f.event === 'change') tChange = performance.now();
          if (!tRows && f.event === 'rows' && ((f.data.leaves as string[]) ?? []).includes(key)) tRows = performance.now();
        }
        return !!tChange && !!tRows;
      }, 10_000);
      await act;
      newMs.push(tRows - t0);
      // The old way: after the change, the Inbox and Home pages again, as the open windows did.
      const [x, y] = await Promise.all([get('/inbox'), get('/')]);
      oldMs.push(tChange - t0 + Math.max(x.ms, y.ms));
      await new Promise((r) => setTimeout(r, SPACING));
    }
    out.update = { actAnswerMs: med(actMs), oldChangeThenRefetchMs: med(oldMs), newRowsFrameMs: med(newMs) };

    // A read in one window. Old: no other window heard it until its next timed refetch (60 s with the stream open,
    // 20 s without). New: the member's subscription hears it.
    const readMs: number[] = [];
    for (let i = R; i < R + 3; i++) {
      const key = held[i].key as string;
      const from = ev.frames.length;
      const t0 = performance.now();
      await fetch(`${base}/inbox/read`, { method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, body: `i=${key.split('/')[2]}` });
      await until(() => ev.frames.slice(from).some((f) => f.event === 'rows' && ((f.data.upserts as Data[]) ?? []).some((u) => u.key === key && u.unread === false)), 10_000);
      readMs.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, SPACING));
    }
    out.read = { oldOtherWindowsMs: '20000 to 60000 (their next timed refetch)', newRowsFrameMs: med(readMs) };
    // Written where LOOM_BENCH says (the test runner keeps a passing test's console to itself).
    writeFileSync(process.env.LOOM_BENCH!, JSON.stringify({ asks: N, rounds: R, spacingMs: SPACING, ...out }, null, 2));
    ev.stop();
    await handle.close();
    await closeAllBackends();
    clearPieceCache();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }, 180_000);
});
