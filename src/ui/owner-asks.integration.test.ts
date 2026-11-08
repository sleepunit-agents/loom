/**
 * Owner-only actions asked on loom's page (t-1975, Jonathan 2026-11-08: "It needs to have the site ask me. I can't log
 * in to loom and run cli commands every time a random thing needs permissions."). The clock files a `vouch-wake` card
 * ("Count these 5 scheduled jobs as your work?"), the runtime a `principal-reset` ("Count this conversation as your work
 * from now on?"); the household owner's Allow has core read the approval back and post it, as him, to the piece that
 * applies it (the clock's `vouch-approved`, the runtime's `reset-approved`). Deny records no and asks nothing; a member
 * can't apply one; an ask that waits on it clears itself once it's answered.
 *
 * The approvals piece is the t-1970 test's stub, widened to these kinds; the clock and the runtime are stubs recording
 * each action they're posted (and the caller) in $LOOM_HOME, and spending it as the real ones do: allowed, exact target.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { clearPieceCache, pieceManifests } from './pieces.js';
import { applyOwnerApproval } from './handler.js';
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
    return console.log(JSON.stringify({ v: 2, tab: { label: 'Approvals', kind: 'setting' }, asks: Object.entries(s).filter(([, x]) => x.state === 'pending').map(([id, x]) => ({
      text: x.text, kind: 'permission', agent: x.agent, page: '', ...(x.details ? { details: x.details } : {}), ...(['grant', 'vouch-wake', 'principal-reset'].includes(x.kind) ? { lead: true, if_yes: 'They fire as your work.', if_no: 'Nothing changes.' } : {}),
      actions: [{ action: 'allow', label: 'Allow', tone: 'primary', fields: { id } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id } }] })) }));
  }
  if (a[0] === 'ui' && a[1] === 'act') {
    const req = JSON.parse(input);
    const x = s[req.fields.id];
    if (!x || x.state !== 'pending') return console.log(JSON.stringify({ ok: false, message: 'not pending' }));
    const c = req.caller || {};
    if (['grant', 'vouch-wake', 'principal-reset'].includes(x.kind) && !(c.kind === 'owner' && (c.agents === undefined || c.agents === '*'))) return console.log(JSON.stringify({ ok: false, message: 'Access to a piece is the household owner\\'s to give or refuse.' }));
    x.state = req.action === 'allow' ? 'allowed' : 'denied';
    fs.writeFileSync(f, JSON.stringify(s));
    return console.log(JSON.stringify({ ok: true, message: (req.action === 'allow' ? 'Allowed: ' : 'Denied: ') + x.text.replace(/\\?$/, '.') }));
  }
  if (a[0] === 'api') {
    const req = JSON.parse(input);
    if (fs.existsSync(process.env.LOOM_HOME + '/state-broken')) return console.log(JSON.stringify({ status: 503, body: { error: 'busy' } }));
    if (req.path !== 'state' || req.caller.kind !== 'owner') return console.log(JSON.stringify({ status: 403, body: { error: 'no' } }));
    const out = {};
    for (const id of req.body.ids) if (s[id]) out[id] = { state: s[id].state, agent: s[id].agent, kind: s[id].kind, ...(['grant', 'vouch-wake', 'principal-reset'].includes(s[id].kind) ? { target: s[id].target } : {}) };
    return console.log(JSON.stringify({ body: { approvals: out } }));
  }
  process.exit(2);
});
`;

/** A piece that applies an owner's Allow (the clock's vouch-approved, the runtime's reset-approved): recorded, and spent. */
const APPLIER_BIN = (name: string, ok: string) => `#!${process.execPath}
const fs = require('node:fs');
const home = process.env.LOOM_HOME;
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const a = process.argv.slice(2).filter((x) => x !== '--json');
  if (a[0] === 'grants') return console.log('{"allow":true}');
  if (a[0] === 'ui' && a.length === 1) return console.log(JSON.stringify({ v: 2, tab: { label: ${JSON.stringify(name)}, kind: 'setting' }, asks: [] }));
  if (a[0] === 'ui' && a[1] === 'act') {
    const req = JSON.parse(input);
    fs.appendFileSync(home + '/acts', JSON.stringify({ piece: ${JSON.stringify(name)}, action: req.action, fields: req.fields, caller: req.caller, scope: process.env.LOOM_SCOPE || '', grant: !!process.env.LOOM_STORE_GRANT }) + '\\n');
    if (fs.existsSync(home + '/refuses')) return console.log(JSON.stringify({ ok: false, message: 'Nothing changed: the approval could not be spent.' }));
    const c = req.caller || {};
    if (!(c.kind === 'owner' && (c.agents === undefined || c.agents === '*'))) return console.log(JSON.stringify({ ok: false, message: 'the household owner\\'s to say.' }));
    const s = JSON.parse(fs.readFileSync(home + '/approvals.json', 'utf-8'));
    const x = s[req.fields.id];
    if (!x || x.state !== 'allowed' || x.target !== req.fields.target) return console.log(JSON.stringify({ ok: false, message: 'Nothing changed: not allowed.' }));
    x.state = 'used';
    fs.writeFileSync(home + '/approvals.json', JSON.stringify(s));
    return console.log(JSON.stringify({ ok: true, message: ${JSON.stringify(ok)} }));
  }
  if (a[0] === 'ui' && a[1] === 'page') return console.log(JSON.stringify({ title: ${JSON.stringify(name)}, sections: [] }));
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

function household(): Household {
  const home = mkdtempSync(join(tmpdir(), 'loom-owner-asks-'));
  for (const a of ['art', 'mark']) {
    mkdirSync(join(home, 'agents', a), { recursive: true });
    writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), a === 'art' ? '# Art E Fish\n' : '# Visual Mark\n');
    const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
    createConversationTables(db);
    db.close();
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({
    v: 1, agents: ['art', 'mark'], default: 'art',
    members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['art'] }],
  }));
  piece(home, 'approvals', { role: 'approvals' }, APPROVALS_BIN);
  piece(home, 'clock', { role: 'clock' }, APPLIER_BIN('Clock', "5 of Art's scheduled jobs count as your work now."));
  // The delivery piece (role runtime) applies a reset; the grants authority is a different piece here, so a reset sent
  // to the grants authority would land on the wrong one.
  piece(home, 'runtime', { role: 'runtime', delivery: ['loom-runtime', 'deliver', '--json'] },
    APPLIER_BIN('Boxes', 'Daily planning counts as your work now: Art starts afresh there.'));
  piece(home, 'perms', { grants: ['loom-perms', 'grants', 'ask'] }, APPLIER_BIN('Perms', 'Granted.'));
  return loadHousehold(home)!;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = any;

const IDS = 'art:w-0f0cfb,w-3c68fa,w-55e1c0,w-59e199,w-840b4e';
let ART_CV = '';
const CARDS = {
  'a-0000beef': { state: 'pending', agent: 'art', kind: 'vouch-wake', target: IDS, text: 'Count these 5 scheduled jobs as your work?',
    details: '- w-0f0cfb, fires Tomorrow 6:26 AM: t-1382 nudge-watch round 20 · runs: check the PR' },
  'a-0000cafe': { state: 'pending', agent: 'art', kind: 'principal-reset', target: 'art:cv-0123456789ab', text: 'Count this conversation as your work from now on?',
    details: 'The conversation: “Daily planning” (cv-0123456789ab). Waiting there, and counted as yours if you allow: a wake with no word from the clock' },
};

describe('owner-only actions are asked on loom\'s page, and his Allow does them (t-1975)', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  let tok: Record<string, string>;
  const saved = process.env.LOOM_HOME;
  const approvals = (s: Record<string, unknown>) => writeFileSync(join(h.home, 'approvals.json'), JSON.stringify(s));
  const state = (id: string) => JSON.parse(readFileSync(join(h.home, 'approvals.json'), 'utf-8'))[id]?.state;
  const acts = (): Data[] => (existsSync(join(h.home, 'acts')) ? readFileSync(join(h.home, 'acts'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : []);

  beforeEach(async () => {
    h = household();
    process.env.LOOM_HOME = h.home;
    clearPieceCache();
    // The conversation the reset card is for: Art's, on record in Art's store (its id is Art's).
    ART_CV = recordTurn(agentDir(h, 'art'), 'art', { venue: 'wake', place: 'alert:disk', label: 'Daily planning', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:runtime').conversation;
    CARDS['a-0000cafe'].target = `art:${ART_CV}`;
    tok = {
      jonathan: createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token,
      sam: createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token,
    };
    approvals(CARDS);
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

  const login = async (who: string) => {
    const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(tok[who])}`, redirect: 'manual' });
    return (r.headers.get('set-cookie') ?? '').split(';')[0];
  };
  const inbox = async (cookie: string): Promise<Data> => (await fetch(`${base}/inbox`, { headers: { cookie, accept: 'application/json' } })).json();
  const press = async (cookie: string, d: Data, action: string, fields: Record<string, string>) => {
    const r = await fetch(`${base}/act/approvals`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' },
      body: new URLSearchParams({ _csrf: d.ctx.csrf, _action: action, _path: 'loom:inbox', ...fields }).toString(),
    });
    expect(r.status).toBe(200);
    return r.json() as Promise<{ ok: boolean; message: string }>;
  };

  it('the Inbox shows each card with Allow and Deny, in the piece\'s words, and what it covers', async () => {
    const d = await inbox(await login('jonathan'));
    for (const [text, covers] of [['Count these 5 scheduled jobs as your work?', /w-0f0cfb, fires Tomorrow 6:26 AM/],
      ['Count this conversation as your work from now on?', /“Daily planning”/]] as const) {
      const it = (d.items as Data[]).find((i) => i.text === text);
      expect(it, text).toBeDefined();
      expect(it.actions.map((b: Data) => b.label)).toEqual(['Allow', 'Deny']);
      expect(JSON.stringify(it)).toMatch(covers);
    }
  });

  it('an agent\'s own ask waiting on the card is headed by the card\'s words, never the agent\'s', async () => {
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { venue: 'wake', place: 'wake:w-000003', label: 'A check', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:runtime').conversation;
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'asked', needs_owner: { ask: 'May I tidy my wakes?', why: 'w',
      if_yes: 'I tidy them.', if_no: 'I leave them.', refs: ['a-0000beef'], waits_on: { approval: 'a-0000beef' } } });
    const d = await inbox(await login('jonathan'));
    const ask = (d.items as Data[]).find((i) => i.kind === 'alert' && i.source.id === 'loom');
    expect(ask.text).toBe('Count these 5 scheduled jobs as your work?');
    expect(ask.needs.why).toBe('May I tidy my wakes?');
    expect(ask.approval.actions.map((b: Data) => b.label)).toEqual(['Allow', 'Deny']);
  });

  it('Allow on the scheduled jobs has the clock vouch for exactly them, as the owner', async () => {
    const cookie = await login('jonathan');
    const r = await press(cookie, await inbox(cookie), 'allow', { id: 'a-0000beef', target: 'art:w-ffffff', agent: 'mark' });
    expect(r).toMatchObject({ ok: true, message: '5 of Art\'s scheduled jobs count as your work now.' });
    expect(acts()).toEqual([{ piece: 'Clock', action: 'vouch-approved', fields: { id: 'a-0000beef', agent: 'art', target: IDS },
      caller: { kind: 'owner', who: 'jonathan', agents: '*' }, scope: '', grant: true }]);
    expect(state('a-0000beef')).toBe('used');
  });

  it('Allow on the conversation has the runtime reset it, as the owner', async () => {
    const cookie = await login('jonathan');
    const r = await press(cookie, await inbox(cookie), 'allow', { id: 'a-0000cafe' });
    expect(r).toMatchObject({ ok: true, message: 'Daily planning counts as your work now: Art starts afresh there.' });
    expect(acts()).toMatchObject([{ piece: 'Boxes', action: 'reset-approved', fields: { id: 'a-0000cafe', agent: 'art', target: `art:${ART_CV}` } }]);
    expect(state('a-0000cafe')).toBe('used');
  });

  it('Deny records no and asks no piece anything', async () => {
    const cookie = await login('jonathan');
    const d = await inbox(cookie);
    expect(await press(cookie, d, 'deny', { id: 'a-0000beef' })).toMatchObject({ ok: true });
    expect(await press(cookie, d, 'deny', { id: 'a-0000cafe' })).toMatchObject({ ok: true });
    expect([state('a-0000beef'), state('a-0000cafe')]).toEqual(['denied', 'denied']);
    expect(acts()).toEqual([]);
  });

  it('a member who owns some agents can\'t apply one, through the page or core\'s own gate', async () => {
    const cookie = await login('sam');
    const d = await inbox(cookie);
    const r = await fetch(`${base}/act/approvals`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' },
      body: new URLSearchParams({ _csrf: d.ctx.csrf, _action: 'allow', _path: 'loom:inbox', id: 'a-0000beef' }).toString(),
    });
    const j = r.status === 200 ? await r.json() as { ok: boolean } : { ok: false };
    expect(j.ok).toBe(false);
    expect(state('a-0000beef')).toBe('pending');
    approvals({ ...CARDS, 'a-0000beef': { ...CARDS['a-0000beef'], state: 'allowed' } });
    const pieces = (await pieceManifests(process.env)).pieces;
    const m = await applyOwnerApproval(process.env, pieces, 'a-0000beef', { kind: 'owner', who: 'sam', agents: ['art'] }, { ok: true, message: 'Allowed.' }, h);
    expect(m).toMatchObject({ ok: false, message: expect.stringMatching(/It wasn't applied: only the household owner says whose work a wake is/) });
    expect(acts()).toEqual([]);
  });

  it('an ask that waits on the approval clears itself once it\'s answered', async () => {
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { venue: 'wake', place: 'wake:w-000001', label: 'A check', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:runtime').conversation;
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'asked', needs_owner: { ask: 'Count these 5 scheduled jobs as your work?', why: 'They were set before loom kept whom each was for.',
      if_yes: 'They fire as yours.', if_no: 'Nothing changes.', refs: ['a-0000beef'], waits_on: { approval: 'a-0000beef' } } });
    const cookie = await login('jonathan');
    const d = await inbox(cookie);
    const ask = (x: Data) => (x.items as Data[]).find((i) => i.kind === 'alert' && i.source.id === 'loom');
    expect(ask(d).approval.actions.map((b: Data) => b.label)).toEqual(['Allow', 'Deny']);
    await press(cookie, d, 'allow', { id: 'a-0000beef' });
    expect(ask(await inbox(cookie))).toBeUndefined();
  });

  it('only an allowed one is applied: a pending, denied or used one leaves the answer as it was', async () => {
    const pieces = (await pieceManifests(process.env)).pieces;
    const owner = { kind: 'owner' as const, who: 'jonathan', agents: '*' as const };
    for (const st of ['pending', 'denied', 'used']) {
      approvals({ ...CARDS, 'a-0000beef': { ...CARDS['a-0000beef'], state: st } });
      expect(await applyOwnerApproval(process.env, pieces, 'a-0000beef', owner, { ok: true, message: 'Said.' }, h)).toEqual({ ok: true, message: 'Said.' });
    }
    expect(acts()).toEqual([]);
  });

  it('a target naming another agent\'s wake or conversation, or a malformed id, is refused: no piece is asked', async () => {
    const pieces = (await pieceManifests(process.env)).pieces;
    const owner = { kind: 'owner' as const, who: 'jonathan', agents: '*' as const };
    for (const [kind, target] of [['vouch-wake', 'mark:w-0f0cfb'], ['vouch-wake', 'art:w-0F0CFB'], ['vouch-wake', 'art:w-3c68fa,w-0f0cfb'],
      ['vouch-wake', 'art:w-0f0cfb,*'], ['vouch-wake', 'art:'], ['principal-reset', 'mark:cv-0123456789ab'], ['principal-reset', 'art:cv-123'],
      ['principal-reset', 'art:cv-0123456789ab,cv-0123456789ac'], ['vouch-wake', 'art:w-0f0cfb0'], ['vouch-wake', 'art:w-0f0cf'],
      ['principal-reset', 'art:cv-0123456789abc'], ['vouch-wake', 'art:w-000000,w-000001,w-000002,w-000003,w-000004,w-000005,w-000006,w-000007,w-000008,w-000009,w-00000a,w-00000b,w-00000c'], ['vouch-wake', 'art:w-0f0cfb,w-0f0cfb']]) {
      approvals({ 'a-0000beef': { state: 'allowed', agent: 'art', kind, target, text: 'x' } });
      const r = await applyOwnerApproval(process.env, pieces, 'a-0000beef', owner, { ok: true, message: 'Allowed.' }, h);
      expect(r, `${kind} ${target}`).toMatchObject({ ok: false, message: expect.stringMatching(/isn't the asking agent's own/) });
    }
    expect(acts()).toEqual([]);
  });

  it('a piece that refuses says so, and nothing reads as done', async () => {
    writeFileSync(join(h.home, 'refuses'), '1');
    const cookie = await login('jonathan');
    const d = await inbox(cookie);
    for (const id of ['a-0000beef', 'a-0000cafe']) {
      const r = await press(cookie, d, 'allow', { id });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/It wasn't applied: Nothing changed: the approval could not be spent\.$/);
    }
  });

  it('an ask waiting on a card that was withdrawn (asked again with an up-to-date list) clears itself', async () => {
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { venue: 'wake', place: 'wake:w-000002', label: 'A check', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:runtime').conversation;
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'asked', needs_owner: { ask: 'Count these 5 scheduled jobs as your work?', why: 'w',
      if_yes: 'y', if_no: 'n', refs: ['a-0000beef'], waits_on: { approval: 'a-0000beef' } } });
    const cookie = await login('jonathan');
    const ask = (x: Data) => (x.items as Data[]).find((i) => i.kind === 'alert' && i.source.id === 'loom');
    expect(ask(await inbox(cookie))).toBeDefined();
    approvals({ ...CARDS, 'a-0000beef': { ...CARDS['a-0000beef'], state: 'withdrawn' } });
    const { resolveNeeds, pieceCheckers } = await import('../needs-resolve.js');
    const done = await resolveNeeds(h, pieceCheckers(process.env));
    expect(done.map((d) => d.reason)).toContain('the approval was withdrawn unanswered (asked again with an up-to-date list)');
    expect(ask(await inbox(cookie))).toBeUndefined();
  });

  it('a reset for a conversation core has as another agent\'s is refused', async () => {
    const mark = agentDir(h, 'mark');
    const cv = recordTurn(mark, 'mark', { venue: 'wake', place: 'alert:m', label: 'Mark alert', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:runtime').conversation;
    approvals({ 'a-0000cafe': { state: 'allowed', agent: 'art', kind: 'principal-reset', target: `art:${cv}`, text: 'x' } });
    const pieces = (await pieceManifests(process.env)).pieces;
    const r = await applyOwnerApproval(process.env, pieces, 'a-0000cafe', { kind: 'owner', who: 'jonathan', agents: '*' }, { ok: true, message: 'Allowed.' }, h);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/another agent's/) });
    expect(acts()).toEqual([]);
  });

  it('through the page too: an Allow on a reset for another agent\'s conversation applies nothing', async () => {
    const mark = agentDir(h, 'mark');
    const cv = recordTurn(mark, 'mark', { venue: 'wake', place: 'alert:p', label: 'Mark alert', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:runtime').conversation;
    approvals({ 'a-0000f00d': { state: 'pending', agent: 'art', kind: 'principal-reset', target: `art:${cv}`, text: 'Count this conversation as your work from now on?' } });
    const cookie = await login('jonathan');
    const r = await press(cookie, await inbox(cookie), 'allow', { id: 'a-0000f00d' });
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/another agent's/) });
    expect(acts()).toEqual([]);
  });

  it('every well-formed target is posted: 1 to 12 wakes, and a conversation Art has on record; one loom has nowhere is not', async () => {
    const pieces = (await pieceManifests(process.env)).pieces;
    const owner = { kind: 'owner' as const, who: 'jonathan', agents: '*' as const };
    const ids = Array.from({ length: 12 }, (_, i) => `w-${i.toString(16).padStart(6, '0')}`);
    for (const target of [`art:${ids[0]}`, `art:${ids.slice(0, 7).join(',')}`, `art:${ids.join(',')}`]) {
      approvals({ 'a-0000beef': { state: 'allowed', agent: 'art', kind: 'vouch-wake', target, text: 'x' } });
      await applyOwnerApproval(process.env, pieces, 'a-0000beef', owner, { ok: true, message: 'Allowed.' }, h);
    }
    expect(acts().map((x) => x.fields.target)).toEqual([`art:${ids[0]}`, `art:${ids.slice(0, 7).join(',')}`, `art:${ids.join(',')}`]);
    approvals({ 'a-0000cafe': { state: 'allowed', agent: 'art', kind: 'principal-reset', target: 'art:cv-0123456789ab', text: 'x' } });
    const r = await applyOwnerApproval(process.env, pieces, 'a-0000cafe', owner, { ok: true, message: 'Allowed.' }, h);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/no record of it/) });
    expect(acts()).toHaveLength(3);
  });
});
