/**
 * A Yes on a permission ask applies it (t-1970). Jonathan said Yes to "Will you add him on loom's Permissions page?",
 * believing that did it, and nothing happened. Now an agent asks for a piece with a `grant` approval, its Needs you waits
 * on it, and the household owner's Allow (on the ask, or on Approvals) has core hand the approval to the grants
 * authority (the runtime) as that owner, which spends it and adds the agent. Deny records no and nothing else; a member
 * who owns some agents can't apply one; any other approval's Allow is only an Allow.
 *
 * The approvals piece is a stub with its role and the verbs core uses (ui, ui act, api state, its kind and target), and
 * refuses a grant's answer from anyone but the household owner, as the real one does. The runtime is a stub grants
 * authority with a page, recording each `grant-approved` it's posted (and the caller) in $LOOM_HOME.
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
import { clearPieceCache } from './pieces.js';
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
      text: x.text, kind: 'permission', agent: x.agent, page: '',
      actions: [{ action: 'allow', label: 'Allow', tone: 'primary', fields: { id } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id } }] })) }));
  }
  if (a[0] === 'ui' && a[1] === 'act') {
    const req = JSON.parse(input);
    const x = s[req.fields.id];
    if (!x || x.state !== 'pending') return console.log(JSON.stringify({ ok: false, message: 'not pending' }));
    const c = req.caller || {};
    if (x.kind === 'grant' && !(c.kind === 'owner' && (c.agents === undefined || c.agents === '*'))) return console.log(JSON.stringify({ ok: false, message: 'Access to a piece is the household owner\\'s to give or refuse.' }));
    x.state = req.action === 'allow' ? 'allowed' : 'denied';
    fs.writeFileSync(f, JSON.stringify(s));
    return console.log(JSON.stringify({ ok: true, message: (req.action === 'allow' ? 'Allowed: ' : 'Denied: ') + x.text.replace(/\\?$/, '.') }));
  }
  if (a[0] === 'api') {
    const req = JSON.parse(input);
    if (fs.existsSync(process.env.LOOM_HOME + '/state-broken')) return console.log(JSON.stringify({ status: 503, body: { error: 'busy' } }));
    if (req.path !== 'state' || req.caller.kind !== 'owner') return console.log(JSON.stringify({ status: 403, body: { error: 'no' } }));
    const out = {};
    for (const id of req.body.ids) if (s[id]) out[id] = { state: s[id].state, agent: s[id].agent, kind: s[id].kind, ...(s[id].kind === 'grant' ? { target: s[id].target } : {}) };
    return console.log(JSON.stringify({ body: { approvals: out } }));
  }
  process.exit(2);
});
`;

/** The runtime as the grants authority: a page, its asks allowed, and grant-approved recorded (and spent) as posted. */
const RUNTIME_BIN = `#!${process.execPath}
const fs = require('node:fs');
const home = process.env.LOOM_HOME;
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const a = process.argv.slice(2).filter((x) => x !== '--json');
  if (a[0] === 'grants') return console.log('{"allow":true}');
  if (a[0] === 'ui' && a.length === 1) return console.log(JSON.stringify({ v: 2, tab: { label: 'Boxes', kind: 'setting' }, asks: [] }));
  if (a[0] === 'ui' && a[1] === 'act') {
    const req = JSON.parse(input);
    fs.appendFileSync(home + '/runtime-acts', JSON.stringify({ action: req.action, fields: req.fields, caller: req.caller, scope: process.env.LOOM_SCOPE || '', grant: !!process.env.LOOM_STORE_GRANT }) + '\\n');
    const s = JSON.parse(fs.readFileSync(home + '/approvals.json', 'utf-8'));
    const x = s[req.fields.id];
    if (!x || x.state !== 'allowed' || x.target !== req.fields.target) return console.log(JSON.stringify({ ok: false, message: 'Not granted: not allowed.' }));
    x.state = 'used';
    fs.writeFileSync(home + '/approvals.json', JSON.stringify(s));
    return console.log(JSON.stringify({ ok: true, message: 'Mark may use Tasks now.', page: 'permissions/mark' }));
  }
  if (a[0] === 'ui' && a[1] === 'page') return console.log(JSON.stringify({ title: 'Boxes', sections: [] }));
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
  const home = mkdtempSync(join(tmpdir(), 'loom-grant-approval-'));
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
  piece(home, 'runtime', { role: 'runtime', grants: ['loom-runtime', 'grants', 'ask'] }, RUNTIME_BIN);
  return loadHousehold(home)!;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = any;

const GRANT = { 'a-0000beef': { state: 'pending', agent: 'art', kind: 'grant', target: 'tasks:mark', text: 'Give Mark access to Tasks?' } };
const ASK = { ask: 'Give Mark access to Tasks?', why: 'Mark asked to keep his own work list.', if_yes: 'Mark can use Tasks from now on.', if_no: 'Mark keeps asking me to file them.',
  refs: ['a-0000beef'], waits_on: { approval: 'a-0000beef' } };

describe('a Yes on a grant ask applies the grant (t-1970)', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  let tok: Record<string, string>;
  const saved = process.env.LOOM_HOME;
  const approvals = (s: Record<string, unknown>) => writeFileSync(join(h.home, 'approvals.json'), JSON.stringify(s));
  const state = (id: string) => JSON.parse(readFileSync(join(h.home, 'approvals.json'), 'utf-8'))[id]?.state;
  const runtimeActs = (): Data[] => (existsSync(join(h.home, 'runtime-acts')) ? readFileSync(join(h.home, 'runtime-acts'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : []);

  beforeEach(async () => {
    h = household();
    process.env.LOOM_HOME = h.home;
    clearPieceCache();
    tok = {
      jonathan: createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token,
      sam: createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token,
    };
    approvals(GRANT);
    // Mark's request, relayed to Art: Art's relay conversation from Mark, whose digest asks the owner.
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { venue: 'relay', place: 'mark', label: 'Relay from Mark', at: new Date().toISOString(), from: { kind: 'agent', id: 'mark' }, kind: 'message' }, 'runtime:runtime').conversation;
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Mark asked for Tasks; asked Jonathan.', needs_owner: ASK });
    handle = await startHttpServer({ contextDir: art, host: '127.0.0.1', port: 0, household: h });
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
  const askOf = (d: Data): Data => (d.items as Data[]).find((i) => i.kind === 'alert' && i.source.id === 'loom');
  const press = async (cookie: string, d: Data, action: string, fields: Record<string, string>) => {
    const r = await fetch(`${base}/act/approvals`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' },
      body: new URLSearchParams({ _csrf: d.ctx.csrf, _action: action, _path: 'loom:inbox', ...fields }).toString(),
    });
    expect(r.status).toBe(200);
    return r.json() as Promise<{ ok: boolean; message: string }>;
  };

  it('the ask holds Allow and Deny; Allow has the runtime apply it, as the owner, and the ask clears', async () => {
    const cookie = await login('jonathan');
    const d = await inbox(cookie);
    const a = askOf(d);
    expect(a.approval.actions.map((b: Data) => b.label)).toEqual(['Allow', 'Deny']);
    const r = await press(cookie, d, 'allow', { id: 'a-0000beef' });
    expect(r).toMatchObject({ ok: true, message: 'Mark may use Tasks now.' });
    const acts = runtimeActs();
    expect(acts).toHaveLength(1);
    // From the approval's own record (its agent and target), never the form; as Jonathan, the household's owner, with
    // the store grant loom mints for an owner's action, and not as an agent's tab.
    expect(acts[0]).toMatchObject({ action: 'grant-approved', fields: { id: 'a-0000beef', agent: 'art', target: 'tasks:mark' },
      caller: { kind: 'owner', who: 'jonathan', agents: '*' }, scope: '', grant: true });
    expect(state('a-0000beef')).toBe('used');
    expect(askOf(await inbox(cookie))).toBeUndefined();
  });

  it('a form can\'t name another target: core reads it from the approval', async () => {
    const cookie = await login('jonathan');
    const d = await inbox(cookie);
    await press(cookie, d, 'allow', { id: 'a-0000beef', target: 'secrets:mark', agent: 'mark' });
    expect(runtimeActs()[0].fields).toEqual({ id: 'a-0000beef', agent: 'art', target: 'tasks:mark' });
  });

  it('Deny records no and asks the runtime nothing', async () => {
    const cookie = await login('jonathan');
    const d = await inbox(cookie);
    expect(await press(cookie, d, 'deny', { id: 'a-0000beef' })).toMatchObject({ ok: true });
    expect(state('a-0000beef')).toBe('denied');
    expect(runtimeActs()).toEqual([]);
  });

  it('a member who owns some agents can\'t apply one: refused, nothing allowed or applied', async () => {
    const cookie = await login('sam');
    const d = await inbox(cookie);
    const r = await fetch(`${base}/act/approvals`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' },
      body: new URLSearchParams({ _csrf: d.ctx.csrf, _action: 'allow', _path: 'loom:inbox', id: 'a-0000beef' }).toString(),
    });
    const j = r.status === 200 ? await r.json() as { ok: boolean } : { ok: false };
    expect(j.ok).toBe(false);
    expect(state('a-0000beef')).toBe('pending');
    expect(runtimeActs()).toEqual([]);
  });

  it('any other approval\'s Allow is only an Allow: the runtime isn\'t asked', async () => {
    approvals({ 'a-0000cafe': { state: 'pending', agent: 'art', kind: 'relay', target: 'art->mark', text: 'Relay to Mark?' } });
    const cookie = await login('jonathan');
    const d = await inbox(cookie);
    expect(await press(cookie, d, 'allow', { id: 'a-0000cafe' })).toMatchObject({ ok: true });
    expect(state('a-0000cafe')).toBe('allowed');
    expect(runtimeActs()).toEqual([]);
  });

  it('Permissions is findable: the shell names its page for the launcher, and each agent\'s window links its own', async () => {
    const cookie = await login('jonathan');
    const d = await inbox(cookie);
    expect(d.chrome.shell.permissions).toBe('/p/runtime/permissions');
    const m: Data = await (await fetch(`${base}/a/mark`, { headers: { cookie, accept: 'application/json' } })).json();
    expect(JSON.stringify(m)).toContain('"permissions":"/p/runtime/permissions/mark"');
    // A member who owns some agents doesn't get the household's Permissions.
    const sam = await inbox(await login('sam'));
    expect(sam.chrome.shell.permissions).toBeUndefined();
  });

  it('an Allow whose approval can\'t be read back never reads as done', async () => {
    writeFileSync(join(h.home, 'state-broken'), '1');
    const cookie = await login('jonathan');
    const d = await inbox(cookie);
    const r = await press(cookie, d, 'allow', { id: 'a-0000beef' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/couldn't read that approval back.*may not be applied/);
    expect(runtimeActs()).toEqual([]);
  });

  it('a relayed request says whose it is: Mark asks, via Art', async () => {
    const a = askOf(await inbox(await login('jonathan')));
    expect(a).toMatchObject({ agent: 'art', relayedFrom: 'mark' });
  });
});
