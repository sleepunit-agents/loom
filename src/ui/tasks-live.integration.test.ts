/**
 * The Tasks pages read the tasks' shared records (t-2029; docs/specs/collections.md, "As built: tasks"), in a real
 * browser, against a stub tasks piece that publishes `tasks/task` as the real one does (a snapshot, no change log) and
 * draws its own page from the same store:
 *
 *  - a task closed through the piece's API (a house's `taskstore close`, which says `changed`) reaches an open Tasks
 *    page at once: core pulls the collection, the page's live records move, and the page is asked again (before: not
 *    until its 60 s timer);
 *  - while the records are live, the page isn't asked again on its own.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed.
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openThread, adapterCall } from '../comms.js';
import { stopCommsWatch } from './comms-live.js';
import { chromium, type Browser } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
import { clearPieceCache } from './pieces.js';

vi.setConfig({ testTimeout: 60_000 });
const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 8_000, ...o }) }) as typeof vexpect;

// The tasks piece, as far as these pages go: tasks.json is its store. `collections query` answers a batch the way
// taskstore's src/collections.ts does (household owners and loom only, filtered before it pages, keyset pages);
// `ui page` draws the work page from the same store; `api` runs `close <id>` and says it changed.
const TASKS_BIN = `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.LOOM_HOME + '/tasks.json';
const all = () => JSON.parse(fs.readFileSync(file, 'utf-8'));
const [verb, sub] = process.argv.slice(2);
const stdin = () => { try { return JSON.parse(fs.readFileSync(0, 'utf-8')); } catch { return {}; } };
if (verb === 'ui' && sub === '--json') { console.log(JSON.stringify({ v: 2, tab: { label: 'Tasks' } })); process.exit(0); }
if (verb === 'ui' && sub === 'page') {
  const open = all().filter((t) => t.status !== 'closed');
  console.log(JSON.stringify({ title: 'Tasks', sections: [{ id: 'open', title: 'Open · ' + open.length, blocks: [{ type: 'list', items: open.slice(0, 20).map((t) => ({ text: t.title })) }] }] }));
  process.exit(0);
}
if (verb === 'api') {
  const req = stdin();
  const [what, id] = (req.body && req.body.argv) || [];
  if (what !== 'close') { console.log(JSON.stringify({ status: 200, body: { exit: 0, stdout: '{}', stderr: '' } })); process.exit(0); }
  const ts = all();
  for (const t of ts) if (t.id === id) { t.status = 'closed'; t.closed = t.updated = new Date().toISOString(); }
  fs.writeFileSync(file, JSON.stringify(ts));
  console.log(JSON.stringify({ status: 200, changed: true, body: { exit: 0, stdout: '{}', stderr: '' } }));
  process.exit(0);
}
if (verb === 'collections' && sub === 'query') {
  const batch = stdin();
  const v = batch.viewer || {};
  const sees = v.kind === 'core' || (v.kind === 'member' && v.household === true);
  const rank = (x) => (x === undefined || x === null ? 0 : typeof x === 'boolean' ? 1 : typeof x === 'number' ? 2 : 3);
  const cmp = (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  const ok = (r, [f, op, val]) => op === 'eq' ? r[f] === val : op === 'in' ? val.includes(r[f]) : op === 'gte' ? rank(r[f]) === rank(val) && cmp(r[f], val) >= 0 : op === 'has' ? r[f] != null : false;
  const out = [];
  for (const q of batch.queries || []) {
    const key = (r) => [...q.order.map(([f]) => r[f] ?? null), r.id];
    const order = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) { const c = cmp(x[i], y[i]); if (c) return i < q.order.length && q.order[i][1] === 'desc' ? -c : c; } return 0; };
    let rs = (sees ? all() : []).map((t) => ({ ...t, audience: { owners: true } })).filter((r) => q.where.every((c) => ok(r, c))).sort(order);
    if (q.after) { const after = { id: q.after[q.after.length - 1] }; q.order.forEach(([f], i) => { after[f] = q.after[i]; }); rs = rs.filter((r) => order(r, after) > 0); }
    const page = rs.slice(0, q.limit);
    const send = new Set(['id', 'audience', ...q.fields, ...q.order.map(([f]) => f)]);
    for (const r of page) out.push(JSON.stringify({ id: q.id, row: Object.fromEntries(Object.entries(r).filter(([k]) => send.has(k))) }));
    out.push(JSON.stringify({ id: q.id, more: page.length === q.limit && rs.length > q.limit }));
  }
  fs.writeSync(1, out.join('\\n') + '\\n');   // whole before exit: a pipe write is async
  process.exit(0);
}
process.exit(2);
`;

// The changes piece, as far as its page goes: changes.json is its snapshot. `collections query` as loom-changes answers
// (lib/loom_changes/collections.py: owners and loom only, keyset pages); `ui page` lists each change with its checks.
const CHANGES_BIN = TASKS_BIN
  .replace("'/tasks.json'", "'/changes.json'")
  .replace("console.log(JSON.stringify({ v: 2, tab: { label: 'Tasks' } }))", "console.log(JSON.stringify({ v: 2, tab: { label: 'Changes' } }))")
  .replace("const open = all().filter((t) => t.status !== 'closed');", "const open = all().filter((t) => t.state === 'open');")
  .replace("console.log(JSON.stringify({ title: 'Tasks', sections: [{ id: 'open', title: 'Open · ' + open.length, blocks: [{ type: 'list', items: open.slice(0, 20).map((t) => ({ text: t.title })) }] }] }));",
    "console.log(JSON.stringify({ title: 'Changes', sections: [{ id: 'open', title: 'Open', blocks: [{ type: 'list', items: open.slice(0, 20).map((t) => ({ text: t.title + ' · checks ' + t.checks })) }] }] }));");
const STR_ = { class: 'household' } as const;
const CHANGE = {
  version: '1.0', schema: { type: 'object' },
  fields: {
    ref: { class: 'household', filter: ['eq', 'in'] }, title: STR_, state: { class: 'household', filter: ['eq', 'in'], order: true },
    draft: STR_, checks: STR_, review: STR_, mergeable: STR_, head: STR_,
    updated: { class: 'household', filter: ['gte'], order: true }, closed: STR_,
  },
  default_fields: ['ref', 'title', 'state'], max_page: 500,
};

const STR = { class: 'household' } as const;
const TASK = {
  version: '1.2', schema: { type: 'object' },
  fields: {
    refState: STR, title: STR, type: { class: 'household', filter: ['eq', 'in'] }, status: { class: 'household', filter: ['eq', 'in'], order: true },
    priority: { class: 'household', filter: ['eq', 'in', 'lte'], order: true }, assignee: { class: 'household', filter: ['eq', 'has'] },
    created: { class: 'household', filter: ['gte'], order: true }, updated: { class: 'household', filter: ['gte'], order: true },
    closed: { class: 'household', filter: ['has'] }, ask: STR, goal: STR, blocked: { class: 'household', filter: ['eq'] },
    ready: { class: 'household', filter: ['eq'] }, source: { class: 'household', filter: ['eq'] },
  },
  default_fields: ['title', 'status'], max_page: 500,
};

function piece(home: string, name: string, raw: Record<string, unknown>, body: string): void {
  const loom = parseLoomBlock(raw, name, [`loom-${name}`]);
  if (typeof loom === 'string') throw new Error(`${name}: ${loom}`);
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'sleepunit-agents/taskstore', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
    bins: [`loom-${name}`], loom: { settings: [], services: [], ...loom } }));
  const bin = join(dir, 'current', 'cli');
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
}

describe.runIf(built && chrome)('the Tasks pages, on the tasks\' live records', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = { home: process.env.LOOM_HOME, path: process.env.PATH };

  beforeAll(async () => {
    clearPieceCache();
    const home = mkdtempSync(join(tmpdir(), 'loom-tasks-live-'));
    for (const a of ['art', 'mark']) { mkdirSync(join(home, 'agents', a), { recursive: true }); writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`); }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [
      { person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['mark'] },
    ] }));
    const at = (d: number) => new Date(Date.now() - d * 3_600_000).toISOString();
    // 520 open tasks: more than one page of the set, so it reads every page before it's whole.
    const tasks = Array.from({ length: 520 }, (_, i) => ({ id: `t-${i + 1}`, title: i === 0 ? 'Fix the backup lock' : `Task ${i + 1}`, type: 'task', status: 'open', priority: 2,
      created: at(600 - i), updated: at(600 - i), closed: null, assignee: null, ask: null, goal: null, blocked: false, ready: true, source: null }));
    writeFileSync(join(home, 'tasks.json'), JSON.stringify(tasks));
    h = loadHousehold(home)!;
    process.env.LOOM_HOME = h.home;
    piece(h.home, 'tasks', { role: 'tasks', collections: { query: ['loom-tasks', 'collections', 'query', '--json'], types: { task: TASK } } }, TASKS_BIN);
    writeFileSync(join(home, 'changes.json'), JSON.stringify([
      { id: 'github:acme:app:3', ref: 'github:acme/app#3', title: 'app#3 Ship the fix', state: 'open', draft: false, checks: 'running', review: 'required', mergeable: 'yes', head: 'a'.repeat(40), updated: at(2), closed: null },
    ]));
    piece(h.home, 'changes', { role: 'changes', collections: { query: ['loom-changes', 'collections', 'query', '--json'], types: { change: CHANGE } } }, CHANGES_BIN);
    process.env.PATH = `${join(h.home, 'pieces', 'bin')}:${process.env.PATH}`;
    tok.jonathan = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    tok.sam = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  });
  afterAll(async () => {
    await browser?.close();
    stopCommsWatch();
    await handle?.close();
    if (saved.home === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved.home;
    process.env.PATH = saved.path;
    rmSync(h.home, { recursive: true, force: true });
  });

  async function open(who: string) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await ctx.request.post(`${base}/login`, { form: { token: tok[who] }, maxRedirects: 0 });
    const page = await ctx.newPage();
    const asked: number[] = [];
    const sets: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname === '/p/tasks' && r.method() === 'GET' && r.resourceType() === 'fetch') asked.push(Date.now());
      if (u.pathname === '/collections/query') sets.push(r.postData() ?? '');
    });
    await page.goto(`${base}/p/tasks`);
    await page.getByText('Fix the backup lock').waitFor();
    return { ctx, page, asked, sets };
  }

  it('a task closed through the API reaches an open Tasks page at once, and the page isn\'t asked again on its own', async () => {
    const { ctx, page, asked, sets } = await open('jonathan');
    // The tasks' set: asked for, read to its second page, then live (the page asked once more, as it went live).
    await expect.poll(() => sets.filter((s) => s.includes('tasks/task@^1')).length).toBeGreaterThanOrEqual(3);
    await expect.poll(() => asked.length).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 2_000));
    const before = asked.length;
    const t0 = Date.now();
    const r = await fetch(`${base}/api/tasks/run`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.jonathan}` }, body: JSON.stringify({ argv: ['close', 't-1'] }) });
    expect(r.status).toBe(200);
    const apiMs = Date.now() - t0;
    await page.getByText('Fix the backup lock').waitFor({ state: 'detached', timeout: 8_000 });
    const took = Date.now() - t0;
    console.log(`[tasks-live] closed through the API -> gone from the open page in ${took} ms; api answered in ${apiMs} ms; page asked at ${asked.slice(before).map((x) => x - t0).join(', ')} ms`);
    expect(took).toBeLessThan(5_000);
    expect(asked.length - before).toBeGreaterThanOrEqual(1);
    expect(asked.length - before).toBeLessThanOrEqual(2);
    // Live: nothing more asks for the page while nothing moves.
    const settled = asked.length;
    await new Promise((r) => setTimeout(r, 3_000));
    expect(asked.length).toBe(settled);
    await ctx.close();
  });

  it('a change whose checks pass reaches an open Changes page on the pull after (t-2029)', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await ctx.request.post(`${base}/login`, { form: { token: tok.jonathan }, maxRedirects: 0 });
    const page = await ctx.newPage();
    const sets: string[] = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/collections/query') sets.push(r.postData() ?? ''); });
    await page.goto(`${base}/p/changes`);
    await page.getByText('app#3 Ship the fix · checks running').waitFor();
    await expect.poll(() => sets.filter((x) => x.includes('changes/change@^1')).length).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 2_000));
    // The sync service's read: the snapshot moved, and loom's next pull (here at once, as its 15 s pull would) logs it.
    const file = join(h.home, 'changes.json');
    const cs = JSON.parse(readFileSync(file, 'utf-8'));
    cs[0].checks = 'passing'; cs[0].updated = new Date().toISOString();
    writeFileSync(file, JSON.stringify(cs));
    const t0 = Date.now();
    const { pullNow } = await import('../collections/subs.js');
    await pullNow(h.home, 'changes/change');
    await page.getByText('app#3 Ship the fix · checks passing').waitFor({ timeout: 8_000 });
    console.log(`[tasks-live] a change's checks moved -> on the open Changes page in ${Date.now() - t0} ms`);
    await ctx.close();
  });
  it.skipIf(spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status !== 0).each([1440, 390].flatMap((width) => ['neon', 'lowlight', 'daylight'].map((look) => ({ width, look }))))
    ('an open task chip follows shared records with no refs re-read: $width / $look', async ({ width, look }) => {
      const file = join(h.home, 'tasks.json');
      const ts = JSON.parse(readFileSync(file, 'utf-8'));
      const task = ts.find((t: { id: string }) => t.id === 't-2');
      task.refState = { status: 'Waiting on Jonathan', tone: 'warn', owner: 'jonathan', ownerStatus: 'Waiting on you' };
      task.title = 'Original task title'; task.status = 'open'; task.blocked = false; task.updated = new Date().toISOString();
      writeFileSync(file, JSON.stringify(ts));
      const { pullNow } = await import('../collections/subs.js');
      await pullNow(h.home, 'tasks/task');
      const thread = openThread(h, process.env, h.members[0], { agent: 'art', id: 'aaaaaaaaaaaaaa' + String.fromCharCode(97 + ['neon', 'lowlight', 'daylight'].indexOf(look)) + (width === 1440 ? 'a' : 'b'), text: 'Please check t-2 and t-3.' }).thread;
      adapterCall(h, process.env, { op: 'post', place: thread.id, agent: 'art', text: 'I am checking t-2 and t-3.' });
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      await ctx.request.post(`${base}/login`, { form: { token: tok.jonathan }, maxRedirects: 0 });
      await ctx.addInitScript((look) => { localStorage.setItem('loom-look', look); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1'); }, look);
      const page = await ctx.newPage();
      page.setDefaultTimeout(8000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      let refs = 0;
      // Isolate admission from presentation: t-2 is admitted, t-3 is refused even though its record is readable.
      await page.route(`**/comms/${thread.id}/refs?*`, async (route) => {
        refs++;
        await route.fulfill({ json: { refs: { 't-2': { kind: 'task', title: 'Original task title', status: 'Open', page: 'p/tasks/task/t-2' }, 't-3': null } } });
      });
      try {
        await page.goto(`${base}/comms/${thread.id}`);
        const chip = page.getByRole('button', { name: 'Task t-2: Original task title, Waiting on you', exact: true });
        await chip.click();
        await page.getByRole('dialog', { name: 'Task: Original task title' }).waitFor();
        const before = refs;
        task.refState = { status: 'Cancelled', tone: null, owner: 'jonathan', ownerStatus: 'Cancelled' };
        task.status = 'closed'; task.updated = new Date().toISOString();
        writeFileSync(file, JSON.stringify(ts));
        const start = Date.now();
        await pullNow(h.home, 'tasks/task');
        await page.getByRole('dialog', { name: 'Task: Original task title' }).getByText('Cancelled', { exact: true }).waitFor({ timeout: 8000 });
        await page.getByRole('button', { name: 'Task t-2: Original task title, Cancelled', exact: true }).waitFor();
        expect(await page.getByRole('dialog').getByRole('link', { name: 'Open', exact: true }).getAttribute('href')).toBe('/p/tasks/task/t-2');
        expect(await page.getByRole('dialog').locator('.loom-kit-status').getAttribute('data-tone')).toBeNull();
        expect(refs).toBe(before);
        expect(await page.getByRole('button', { name: /^Task t-3:/ }).count()).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect(errors).toEqual([]);
        console.log(`[task-chip] ${width}/${look}: updated in ${Date.now() - start}ms, extra refs reads=${refs - before}`);
      } catch (error) {
        console.log('[task-chip diagnostic]', page.url(), (await page.locator('body').innerText()).slice(0, 3000), errors);
        throw error;
      } finally { await ctx.close(); }
    });

});
