/**
 * Needs you in plain words (t-1778, after "I don't know wtf that wants from me"): an ask written as the object reads
 * as its ask (row and sheet), with why, what happens either way, its links and details apart; one that waits on an
 * approval holds that approval's own Allow and Deny (the card isn't a second item); and one whose wait is resolved
 * clears itself, leaving a quiet FYI. The stale one of 2026-11-03 (a plain string naming an approval already allowed
 * and spent) clears the same way.
 *
 * The approvals and tasks pieces are stubs with their roles (`approvals`, `tasks`) and the verbs core uses: the
 * approvals piece's card (`ui --json`), its Allow (`ui act`) and its owner-only `state` (`api`); the tasks piece's
 * `run show`. Their state is a JSON file in $LOOM_HOME, which a test sets as the piece's world.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
import { createConversationTables, openNeeds, recordTurn, writeDigest } from '../backends/conversations.js';
import { clearPieceCache } from './pieces.js';
import { closeAllBackends } from '../backends/index.js';
import { pieceCheckers, resolveNeeds, type WaitCheckers } from '../needs-resolve.js';

/** The approvals piece, as core sees it: its pending cards, Allow and Deny, and the owner's `state`. */
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
      text: x.agent[0].toUpperCase() + x.agent.slice(1) + ' asks: ' + x.what, meta: 'A wake on loom\\'s machine · “' + x.why + '”', kind: 'permission', agent: x.agent, page: '',
      actions: [{ action: 'allow', label: 'Allow once', tone: 'primary', fields: { id } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id } }] })) }));
  }
  if (a[0] === 'ui' && a[1] === 'act') {
    const req = JSON.parse(input);
    const x = s[req.fields.id];
    if (!x || x.state !== 'pending') return console.log(JSON.stringify({ ok: false, message: 'not pending' }));
    x.state = req.action === 'allow' ? 'allowed' : 'denied';
    fs.writeFileSync(f, JSON.stringify(s));
    return console.log(JSON.stringify({ ok: true, message: 'Allowed once: ' + x.what }));
  }
  if (a[0] === 'api') {
    const req = JSON.parse(input);
    if (req.path !== 'state' || req.caller.kind !== 'owner') return console.log(JSON.stringify({ status: 403, body: { error: 'no' } }));
    const out = {};
    for (const id of req.body.ids) if (s[id]) out[id] = { state: s[id].state, agent: s[id].agent };
    return console.log(JSON.stringify({ body: { approvals: out } }));
  }
  process.exit(2);
});
`;

/** The tasks piece's API, as taskstore answers it: run show <id>. */
const TASKS_BIN = `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.argv[2] !== 'api') process.exit(2);
  const req = JSON.parse(input);
  const tasks = JSON.parse(fs.readFileSync(process.env.LOOM_HOME + '/tasks.json', 'utf-8'));
  const id = req.body.argv[1];
  const out = tasks[id] ? { ok: true, task: { id, status: tasks[id] } } : { ok: false, errors: ['E_UNKNOWN_ID'], task: null };
  console.log(JSON.stringify({ body: { exit: out.ok ? 0 : 1, stdout: JSON.stringify(out), stderr: '' } }));
});
`;

function piece(home: string, name: string, role: string, src: string): void {
  const loom = parseLoomBlock({ role }, name, [`loom-${name}`]);
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
  const home = mkdtempSync(join(tmpdir(), 'loom-needs-plain-'));
  for (const a of ['art', 'mark']) {
    mkdirSync(join(home, 'agents', a), { recursive: true });
    writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), a === 'art' ? '# Art E Fish\n' : '# Visual Mark\n');
    const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
    createConversationTables(db);
    db.close();
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({
    v: 1, agents: ['art', 'mark'], default: 'art', github: 'sleepunit-agents', members: [{ person: 'jonathan', role: 'owner', agents: '*' }],
  }));
  piece(home, 'approvals', 'approvals', APPROVALS_BIN);
  piece(home, 'tasks', 'tasks', TASKS_BIN);
  writeFileSync(join(home, 'tasks.json'), JSON.stringify({ 't-40': 'in_progress' }));
  return loadHousehold(home)!;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = any;

const STALE = "Allow local-wake card a-7693c00e on loom's Home so Art can set up the rclone→Drive backup for t-40 (round 9)";
const ASK = {
  ask: "OK to install rclone and restic on loom's machine to set up the Google Drive backup?",
  why: 'The nightly backup has no offsite copy yet.',
  if_yes: 'I install both and run the first backup tonight.',
  if_no: 'Backups stay on this machine only.',
  refs: ['t-40', 'a-1234abcd'],
};

describe('a Needs you in plain words', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  let owner: string;
  let art: string;
  let conv: string;
  const saved = process.env.LOOM_HOME;
  const approvals = (s: Record<string, { state: string; agent: string; what?: string; why?: string }>) => writeFileSync(join(h.home, 'approvals.json'), JSON.stringify(s));

  beforeEach(async () => {
    h = household();
    process.env.LOOM_HOME = h.home;
    clearPieceCache();
    owner = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    art = agentDir(h, 'art');
    conv = recordTurn(art, 'art', { venue: 'wake', place: 'wake:w-6d5807', label: 't-40 nudge-watch auto-recovery chain-check', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    approvals({ 'a-1234abcd': { state: 'pending', agent: 'art', what: 'run on loom\'s machine: install rclone and restic', why: 'offsite backup' } });
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

  const login = async () => {
    const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(owner)}`, redirect: 'manual' });
    return (r.headers.get('set-cookie') ?? '').split(';')[0];
  };
  const inbox = async (cookie: string): Promise<Data> => (await fetch(`${base}/inbox`, { headers: { cookie, accept: 'application/json' } })).json();
  const home = async (cookie: string): Promise<Data> => (await fetch(`${base}/`, { headers: { cookie, accept: 'application/json' } })).json();
  const alertOf = (d: Data): Data => (d.items as Data[]).find((i) => i.kind === 'alert' && i.source.id === 'loom');
  const press = async (cookie: string, d: Data, source: Data, action: string, fields: Record<string, string>) => {
    const r = await fetch(`${base}${source.act ?? `/act/${source.id}`}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1' },
      body: new URLSearchParams({ _csrf: d.ctx.csrf, _action: action, _path: 'loom:inbox', ...fields }).toString(),
    });
    expect(r.status).toBe(200);
    return r.json() as Promise<{ ok: boolean; message: string }>;
  };

  it('the old way still shows as it did: "<agent> needs you: …", the conversation as its details', async () => {
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Opened art#68.', needs_owner: 'Review/merge art#68', needs_owner_href: 'https://github.com/sleepunit-agents/art/pull/68' });
    const a = alertOf(await inbox(await login()));
    expect(a).toMatchObject({ text: 'Art E Fish needs you: Review/merge art#68', meta: 't-40 nudge-watch auto-recovery chain-check · Wake',
      needs: { refs: ['art#68'], details: 't-40 nudge-watch auto-recovery chain-check · Wake' } });
    expect(a.needs.why).toBeUndefined();
  });

  it('the new way reads as its ask: the row and Home say it, the sheet has why, yes and no, links and details', async () => {
    approvals({});
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Backup set up, waiting on the install.', needs_owner: { ...ASK, refs: ['t-40'] } });
    const cookie = await login();
    const a = alertOf(await inbox(cookie));
    expect(a).toMatchObject({
      kind: 'alert', attention: true, agent: 'art', text: ASK.ask, meta: ASK.why,
      needs: { why: ASK.why, if_yes: ASK.if_yes, if_no: ASK.if_no, refs: ['t-40'], details: 't-40 nudge-watch auto-recovery chain-check · Wake' },
    });
    expect(a.text).not.toMatch(/needs you|t-40|round|a-[0-9a-f]/);
    // Home's banner is that row.
    expect((await home(cookie)).home.need).toMatchObject({ text: ASK.ask, meta: ASK.why });
  });

  it('one that waits on an approval holds its Allow and Deny; the approval\'s own card isn\'t a second item', async () => {
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Waiting on the install.', needs_owner: ASK });
    const cookie = await login();
    const d = await inbox(cookie);
    const a = alertOf(d);
    expect(a.approval).toMatchObject({ text: "Art asks: run on loom's machine: install rclone and restic", source: { id: 'approvals' } });
    expect(a.approval.actions.map((b: Data) => [b.label, b.fields.id])).toEqual([['Allow once', 'a-1234abcd'], ['Deny', 'a-1234abcd']]);
    expect((d.items as Data[]).filter((i) => i.source.id === 'approvals' && i.attention)).toEqual([]);
    expect((d.items as Data[]).filter((i) => i.attention)).toHaveLength(1);
    // And counted once: the Inbox's badge and the agent's.
    expect(d.chrome.shell.asks).toBe(1);
    expect(d.chrome.shell.agents.find((x: Data) => x.id === 'art').asks).toBe(1);
    // Allow, as the sheet posts it: to the approvals piece. The ask clears itself at once, leaving a quiet FYI.
    const allow = a.approval.actions[0];
    expect(await press(cookie, d, a.approval.source, allow.action, allow.fields)).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(h.home, 'approvals.json'), 'utf-8'))['a-1234abcd'].state).toBe('allowed');
    const after = await inbox(cookie);
    expect(alertOf(after)).toBeUndefined();
    expect((after.items as Data[]).find((i) => i.kind === 'fyi' && i.text === ASK.ask)).toMatchObject({ attention: false, meta: 'Cleared itself: the approval was allowed' });
  });

  it('another agent\'s approval stays its own card: an ask can\'t take it under its words', async () => {
    approvals({ 'a-1234abcd': { state: 'pending', agent: 'mark', what: 'something of Mark\'s', why: 'his' } });
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 's', needs_owner: ASK });
    const d = await inbox(await login());
    expect(alertOf(d).approval).toBeUndefined();
    expect((d.items as Data[]).filter((i) => i.source.id === 'approvals' && i.attention)).toHaveLength(1);
  });

  it('clears itself on the pass once what it waits on is resolved, through the pieces\' own APIs', async () => {
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 's', needs_owner: ASK });
    const check = pieceCheckers(process.env);
    expect(await resolveNeeds(h, check)).toEqual([]);
    expect(openNeeds(art)).toHaveLength(1);
    approvals({ 'a-1234abcd': { state: 'used', agent: 'art' } });
    expect(await resolveNeeds(h, check)).toEqual([{ agent: 'art', conversation: conv, digest: expect.stringMatching(/^dg-/), reason: 'the approval was allowed and used' }]);
    expect(openNeeds(art)).toEqual([]);
    // Once: a second pass (another listener) finds nothing to clear.
    expect(await resolveNeeds(h, check)).toEqual([]);
  });

  it('a task it waits on clears it when closed; a gone one too', async () => {
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 's', needs_owner: { ask: 'Can you check the backup restored?', waits_on: { task: 't-40' } } });
    const check = pieceCheckers(process.env);
    expect(await resolveNeeds(h, check)).toEqual([]);
    writeFileSync(join(h.home, 'tasks.json'), JSON.stringify({ 't-40': 'closed' }));
    expect((await resolveNeeds(h, check)).map((r) => r.reason)).toEqual(['t-40 is closed']);
    const later = recordTurn(art, 'art', { venue: 'wake', place: 'wake:w-000001', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    writeDigest(art, { conversation: later, run: 'r1' }, { summary: 's', needs_owner: { ask: 'Can you look at the other one?', waits_on: { task: 't-41' } } });
    expect((await resolveNeeds(h, check)).map((r) => r.reason)).toEqual(['t-41 is gone']);
  });

  it('a task it waits on clears it once the owner answers that same ask on the task (t-2098), never another', async () => {
    const at = new Date().toISOString();
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 's', needs_owner: { ask: 'Can you check the backup restored?', waits_on: { task: 't-40' } } });
    const asked: [string, string, string][] = [];
    let answered: boolean | undefined = false;
    const check: WaitCheckers = { approvals: async () => ({}), task: async () => 'open', taskAnswered: async (id, ask, since) => { asked.push([id, ask, since]); return answered; } };
    expect(await resolveNeeds(h, check)).toEqual([]);
    expect(asked[0][0]).toBe('t-40');
    expect(asked[0][1]).toBe('Can you check the backup restored?');
    expect(asked[0][2] >= at.slice(0, 16)).toBe(true);
    answered = undefined;
    expect(await resolveNeeds(h, check)).toEqual([]);
    answered = true;
    expect((await resolveNeeds(h, check)).map((r) => r.reason)).toEqual(['you answered it on t-40']);
  });

  it('the stale one of 2026-11-03, a plain string naming an approval already spent, clears the same way', async () => {
    // Written before the lint, as it is in the live store: straight into the table.
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Asked for the wake approval.', needs_owner: 'Allow the wake card on Home' });
    const db = new BetterSqlite3(join(art, 'memories.db'));
    db.prepare('UPDATE conversation_digests SET needs_owner = ? WHERE conversation = ?').run(STALE, conv);
    db.close();
    approvals({ 'a-7693c00e': { state: 'used', agent: 'art' } });
    expect(openNeeds(art)[0].digest.needs?.waits_on).toEqual({ approval: 'a-7693c00e' });
    expect((await resolveNeeds(h, pieceCheckers(process.env))).map((r) => r.reason)).toEqual(['the approval was allowed and used']);
    const after = await inbox(await login());
    expect(alertOf(after)).toBeUndefined();
    expect((after.items as Data[]).find((i) => i.kind === 'fyi' && i.source.id === 'loom')).toMatchObject({ text: `Art E Fish needs you: ${STALE}`, meta: 'Cleared itself: the approval was allowed and used' });
  });

  it('a piece that can\'t tell clears nothing', async () => {
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 's', needs_owner: ASK });
    const blind: WaitCheckers = { approvals: async () => undefined, task: async () => undefined };
    const failing: WaitCheckers = { approvals: async () => { throw new Error('down'); }, task: async () => { throw new Error('down'); } };
    expect(await resolveNeeds(h, blind)).toEqual([]);
    expect(await resolveNeeds(h, failing)).toEqual([]);
    expect(openNeeds(art)).toHaveLength(1);
  });

  it('the digest tool refuses an ask Jonathan couldn\'t read, and says why', async () => {
    expect(() => writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 's', needs_owner: STALE })).toThrow(/can't name "a-7693c00e", "round 9", "local-wake"/);
    expect(() => writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 's', needs_owner: { ask: 'Allow a-7693c00e for t-40?' } })).toThrow(/Put ids in needs_owner.refs/);
    expect(openNeeds(art)).toEqual([]);
  });
});
