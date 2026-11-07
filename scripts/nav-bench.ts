/**
 * Navigation timings for loom's app (t-1925 F, "Measure first"): a test server with a household's worth of data, and
 * the flows Jonathan named, timed in a real browser at 1280 and 390.
 *
 *   npx tsx scripts/nav-bench.ts [--out file.json] [--runs 3] [--tasks path/to/store.db] [--serve] [--server-only]
 *
 * Needs the built app (npm run build), Chrome (LOOM_TEST_CHROME or /usr/bin/google-chrome) and age. --tasks points the
 * Tasks piece (loom-tasks on PATH) at a copy of a real store; without it there is no Tasks app and its flow is skipped.
 * --serve starts the server, prints its address and token, and waits (to look at it by hand). --server-only times
 * GET /comms/<thread> for each 40-message thread, with no browser (and needs no Chrome), and stops: exit 1 when the
 * median is 300 ms or more (t-1926's target).
 *
 * For each flow: ms to the first visible change after the click, ms until it's complete (the page asked for is drawn
 * and nothing in it is busy), bytes fetched meanwhile, and whether what should have stayed (a tile, a list) was
 * remounted. The server is this process: one browser, one page at a time (loom's machine is production).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { startHttpServer } from '../src/transport/http-server.js';
import { agentDir, createToken, loadHousehold } from '../src/household.js';
import { createConversationTables, recordTurn, writeDigest } from '../src/backends/conversations.js';
import { adapterCall, addMemberMessage, openThread, recordDelivery } from '../src/comms.js';
import { closeAllBackends } from '../src/backends/index.js';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const RUNS = Number(arg('--runs') ?? 3);
const OUT = arg('--out');
const TASKS = arg('--tasks');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p));
const SERVER_ONLY = process.argv.includes('--server-only');
if (!chrome && !SERVER_ONLY) throw new Error('no Chrome');
if (spawnSync('sh', ['-c', 'command -v age'], { encoding: 'utf-8' }).status !== 0) throw new Error('no age');

// ---- the household -------------------------------------------------------------------------------
const home = mkdtempSync(join(tmpdir(), 'loom-nav-bench-'));
const bin = join(home, 'bin');
mkdirSync(bin);
for (const a of ['art', 'mark']) {
  mkdirSync(join(home, 'agents', a), { recursive: true });
  writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a === 'art' ? 'Art E Fish' : 'Mark'}\n\nCreed.\n`);
  const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
}
writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
// Only this run's pieces: never the machine's own (a bridge that posts to Slack).
const nodeDir = dirname(process.execPath);
// age by itself (its directory can hold the machine's pieces too).
for (const t of ['age', 'age-keygen']) symlinkSync(spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf-8' }).stdout.trim(), join(bin, t));
process.env.PATH = [bin, nodeDir, '/usr/bin', '/bin'].join(':');
process.env.LOOM_HOME = home;
process.env.XDG_CONFIG_HOME = join(home, 'xdg');
const h = loadHousehold(home)!;
const token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;

// 30 threads, 40 messages each, with code and lists in the replies (a Comms list as Jonathan's is).
const b32 = (n: number, len: number) => { const a = 'abcdefghijklmnopqrstuvwxyz234567'; let s = ''; for (let i = 0; i < len; i++) { s = a[n % 32] + s; n = Math.floor(n / 32); } return s; };
const words = (n: number, i: number) => Array.from({ length: n }, (_, k) => ['the', 'deploy', 'box', 'tile', 'loom', 'thread', 'agent', 'cache', 'page', 'route'][(i + k * 7) % 10]).join(' ');
const threads: string[] = [];
for (let t = 0; t < 30; t++) {
  const agent = t % 3 ? 'art' : 'mark';
  const id = b32(t, 4) + 'b'.repeat(12);
  const o = openThread(h, process.env, h.members[0], { agent, id, text: `Thread ${t + 1}: ${words(12, t)}` });
  recordDelivery(h, o.thread, o.seq, { delivered: true, body: 'started' });
  for (let m = 0; m < 20; m++) {
    adapterCall(h, process.env, { op: 'post', place: o.thread.id, agent, text: `Reply ${m + 1}. ${words(40, m)}\n\n- one ${words(6, m)}\n- two \`code ${m}\`\n\n\`\`\`ts\nconst x = ${m};\n\`\`\``, run: `run-${t}-${m}` });
    adapterCall(h, process.env, { op: 'status', place: o.thread.id, agent, status: 'done' });
    if (m < 19) { const r = addMemberMessage(h, process.env, o.thread, { id: b32(t, 4) + 'c'.repeat(8) + b32(m, 4), text: `Follow-up ${m + 1}: ${words(10, m + t)}` }); recordDelivery(h, o.thread, r.seq, { delivered: true, body: 'ok' }); }
  }
  threads.push(o.thread.id);
}
// The Inbox: 15 asks from agents' runs, and a piece's permissions.
const art = agentDir(h, 'art');
for (let i = 0; i < 15; i++) {
  const conv = recordTurn(art, 'art', { venue: 'wake', place: `lane:l${i}`, label: `t-${900 + i}: thing`, at: new Date(Date.now() - i * 3600_000).toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
  writeDigest(art, { conversation: conv, run: `r${i}` }, { summary: 'Checked.', needs_owner: { ask: `OK to restart the thing number ${i + 1} on the box tonight?`, why: 'It has been slow all day.', if_yes: 'I restart it at 2am.', if_no: 'I leave it and watch it.', refs: [`t-${900 + i}`] } } as never);
}
writeFileSync(join(bin, 'permit.json'), JSON.stringify({ v: 2, tab: { label: 'Permit', kind: 'setting' }, asks: Array.from({ length: 5 }, (_, i) => ({
  text: `OK to push change ${i + 1} to the lane prompts?`, why: 'The script changed.', if_yes: 'It goes live.', if_no: 'It waits.', kind: 'permission', tone: 'warn', at: new Date().toISOString(), page: '',
  actions: [{ action: 'allow', label: 'Allow once', tone: 'primary', fields: { id: `a-0000000${i}` } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id: `a-0000000${i}` } }] })) }));
writeFileSync(join(bin, 'loom-permit'), `#!/bin/sh\ncase "$1 $2" in "ui --json") cat "${join(bin, 'permit.json')}" ;; *) echo '{"title":"Permit","sections":[]}' ;; esac\n`);
chmodSync(join(bin, 'loom-permit'), 0o755);
// Tasks: the real piece, on a copy of a real store.
const hasTasks = !!TASKS && existsSync(TASKS);
if (hasTasks) {
  const which = [process.env.LOOM_BENCH_TASKS, `${process.env.HOME}/.config/loom/pieces/bin/loom-tasks`].find((x) => x && existsSync(x));
  if (which) {
    copyFileSync(TASKS!, join(home, 'tasks.db'));
    symlinkSync(which, join(bin, 'loom-tasks'));
    process.env.TASKSTORE_DB = join(home, 'tasks.db');
  }
}

const handle = await startHttpServer({ contextDir: art, host: '127.0.0.1', port: 0, household: h });
const base = `http://127.0.0.1:${handle.port}`;
if (SERVER_ONLY) {
  // The server alone (t-1926): GET /comms/<thread> as JSON for each 40-message thread, once, no browser. The list
  // first, untimed: the server's own first request (its routes, the stores opening) isn't a thread's cost.
  const get = (path: string) => fetch(`${base}${path}`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` } });
  await (await get('/comms')).arrayBuffer();
  const ms: number[] = [];
  for (const id of threads) {
    const t0 = performance.now();
    const r = await get(`/comms/${id}`);
    await r.arrayBuffer();
    if (!r.ok) throw new Error(`GET /comms/${id} answered ${r.status}`);
    ms.push(Math.round((performance.now() - t0) * 10) / 10);
  }
  const sorted = [...ms].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`GET /comms/<thread>, ${ms.length} threads of 40: median ${median} ms, p90 ${sorted[Math.floor(sorted.length * 0.9)]} ms, max ${sorted.at(-1)} ms (in order: ${ms.join(' ')})`);
  if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), commsThreadMs: ms }, null, 2));
  await handle.close();
  await closeAllBackends();
  rmSync(home, { recursive: true, force: true });
  // The target (t-1926): a 40-message thread answers in under 300 ms. Over it, the run fails.
  process.exit(median < 300 ? 0 : 1);
}
if (process.argv.includes('--serve')) {
  console.log(`${base}  token: ${token}  home: ${home}`);
  await new Promise(() => {});
}

// ---- measuring -----------------------------------------------------------------------------------
type Sample = { visibleMs: number; completeMs: number; bytes: number; requests: number; remounted: boolean | null };
type Flow = { name: string; width: number; samples: Sample[] };

async function screen(browser: Browser, width: number, path: string): Promise<{ ctx: BrowserContext; p: Page; cdp: CDPSession }> {
  const phone = width < 1024;
  const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 800 }, isMobile: phone, hasTouch: phone, reducedMotion: 'reduce', bypassCSP: true });
  await ctx.addInitScript(`window.__name = (f) => f; try { localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1'); } catch {}`);
  await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Network.enable');
  await p.goto(`${base}${path}`);
  await p.locator('.loom-dock-bar [data-part="item"]').first().waitFor({ timeout: 20_000 });
  if (!phone) await p.locator('.loom-tiles').waitFor({ timeout: 20_000 });
  await p.waitForTimeout(800);
  return { ctx, p, cdp };
}

/** When a step is done, as data (no code is built from strings): every `has` selector there, no `not` one, the address
 * holding `url` (and not `notUrl`), the path being `path`, the page holding `text`, a thread titled `title`, at least
 * `count[1]` of `count[0]`; or else `or`. */
type Done = { has?: string[]; not?: string[]; url?: string; notUrl?: string; path?: string; text?: string; title?: string; count?: [string, number]; or?: Done };

/** Times one step: `act` (a click) until `done` holds in the page; marks `keep` first, to see if it survived. */
async function step(p: Page, cdp: CDPSession, act: () => Promise<unknown>, done: Done, keep?: string, scope = 'body'): Promise<Sample | null> {
  let bytes = 0, requests = 0;
  const onReq = () => { requests++; };
  // What reached the page, decoded (a service worker's answer has no wire size of its own).
  const onDone = (e: { dataLength: number }) => { bytes += e.dataLength; };
  cdp.on('Network.requestWillBeSent', onReq);
  cdp.on('Network.dataReceived', onDone);
  await p.evaluate(([keep, scope]) => {
    const w = window as unknown as { __b: { t0: number; first: number | null; mo?: MutationObserver } };
    if (keep) { const el = document.querySelector(keep); if (el) (el as unknown as { __kept: boolean }).__kept = true; }
    w.__b = { t0: 0, first: null };
    const root = document.querySelector(scope!) ?? document.body;
    w.__b.mo = new MutationObserver(() => { if (w.__b.first === null && w.__b.t0) w.__b.first = performance.now(); });
    w.__b.mo.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-busy', 'data-state', 'aria-current', 'data-current', 'data-pending'] });
    w.__b.t0 = performance.now();
    // From the press itself: Playwright waits for a button to be ready before it presses it.
    addEventListener('pointerdown', () => { w.__b.t0 = performance.now(); w.__b.first = null; }, { capture: true, once: true });
  }, [keep ?? '', scope] as const);
  await act();
  const end = await p.waitForFunction((done: Done) => {
    const holds = (d: Done): boolean => (d.has ?? []).every((x) => !!document.querySelector(x)) && !(d.not ?? []).some((x) => !!document.querySelector(x))
      && (d.url === undefined || location.href.includes(d.url)) && (d.notUrl === undefined || !location.href.includes(d.notUrl))
      && (d.path === undefined || location.pathname === d.path) && (d.text === undefined || (document.body.textContent ?? '').includes(d.text))
      && (d.title === undefined || [...document.querySelectorAll('.comms-thread__title')].some((e) => (e.textContent ?? '').trim() === d.title))
      && (d.count === undefined || document.querySelectorAll(d.count[0]).length >= d.count[1]);
    const ok = holds(done) || (!!done.or && holds(done.or));
    return ok && !document.querySelector('[aria-busy="true"]') ? performance.now() : 0;
  }, done, { timeout: 45_000, polling: 100 }).then((h) => h.jsonValue() as Promise<number>).catch(async (e) => {
    console.error('not done:', done, await p.evaluate(() => ({ url: location.href, busy: [...document.querySelectorAll('[aria-busy="true"]')].map((e) => e.outerHTML.slice(0, 160)),
      titles: [...document.querySelectorAll('.comms-thread__title')].map((e) => e.textContent), msgs: document.querySelectorAll('.comms-msg--agent').length })));
    throw e;
  }).catch(() => null);
  if (end === null) { cdp.off('Network.requestWillBeSent', onReq); cdp.off('Network.dataReceived', onDone); return null; }
  await p.waitForTimeout(400);
  const r = await p.evaluate((keep) => {
    const w = window as unknown as { __b: { t0: number; first: number | null; mo?: MutationObserver } };
    w.__b.mo?.disconnect();
    const el = keep ? document.querySelector(keep) : null;
    return { t0: w.__b.t0, first: w.__b.first, remounted: keep ? !(el && (el as unknown as { __kept?: boolean }).__kept) : null };
  }, keep ?? '');
  cdp.off('Network.requestWillBeSent', onReq);
  cdp.off('Network.dataReceived', onDone);
  return { visibleMs: Math.round(((r.first ?? end) - r.t0) * 10) / 10, completeMs: Math.round((end - r.t0) * 10) / 10, bytes, requests, remounted: r.remounted };
}

const flows: Flow[] = [];
const record = (name: string, width: number, s: Sample | null) => {
  if (!s) { console.error(`skipped a sample of ${name} at ${width}: it never finished`); return; }
  let f = flows.find((x) => x.name === name && x.width === width);
  if (!f) flows.push(f = { name, width, samples: [] });
  f.samples.push(s);
};
const tileSel = (label: string) => `.loom-tile[aria-label$=", ${label}"]`;

const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
try {
  for (const width of [1280, 390]) {
    const desk = width >= 1024;
    for (let run = 0; run < RUNS; run++) {
      // 1. A Comms thread from the list (a different one each time: the first open of each, then one seen before).
      {
        const { ctx, p, cdp } = await screen(browser, width, '/comms');
        const listSel = desk ? `${tileSel('Comms')} .comms-list` : '.comms-list';
        await p.locator('.comms-row__btn').first().waitFor({ timeout: 20_000 });
        for (const [i, [k, n]] of ([['new', 2 + run * 2], ['new', 3 + run * 2], ['seen', 2 + run * 2]] as const).entries()) {
          if (!desk && i > 0) { await p.goBack(); await p.locator('.comms-row__btn').first().waitFor(); await p.waitForTimeout(300); }
          const title = (await p.locator('.comms-row__title').nth(n).textContent())!.trim();
          const s = await step(p, cdp, () => p.locator('.comms-row__btn').nth(n).click(),
            { title, count: ['.comms-msg--agent', 4] },
            desk ? listSel : undefined);
          record(`Comms: open a thread (${k})`, width, s);
        }
        // As a person does on a desktop: the pointer rests on the row a moment (400 ms) before the press.
        if (desk) {
          const n = 12 + run;
          const title = (await p.locator('.comms-row__title').nth(n).textContent())!.trim();
          await p.locator('.comms-row__btn').nth(n).hover();
          await p.waitForTimeout(400);
          const s = await step(p, cdp, () => p.locator('.comms-row__btn').nth(n).click(),
            { title, count: ['.comms-msg--agent', 4] }, listSel);
          record('Comms: open a thread (pointer rested 400 ms)', width, s);
        }
        await ctx.close();
      }
      // 2. Inbox item → its page.
      {
        const { ctx, p, cdp } = await screen(browser, width, '/inbox');
        const rows = p.locator(`${desk ? tileSel('Inbox') : 'main'} ul.divide-y > li > button`);
        await rows.first().waitFor({ timeout: 20_000 }).catch(() => {});
        const count = await rows.count();
        if (count > 2) {
          const s = await step(p, cdp, () => rows.nth(1 + run).click(), { has: ['[role="dialog"][data-state="open"]'], or: { url: 'i=' } }, desk ? tileSel('Inbox') : undefined);
          record('Inbox: open an item', width, s);
        }
        await ctx.close();
      }
      // 3. Tasks: list → task → back.
      if (hasTasks) {
        const { ctx, p, cdp } = await screen(browser, width, '/p/tasks');
        const link = p.locator(`${desk ? tileSel('Tasks') : 'main'} a[href*="/p/tasks/task/"]:visible`);
        await link.first().waitFor({ timeout: 20_000 });
        const href = await link.nth(run).getAttribute('href');
        const id = /task\/(t-\d+)/.exec(href ?? '')?.[1] ?? '';
        const words = ((await link.nth(run).textContent()) ?? '').trim().slice(0, 24);
        const s1 = await step(p, cdp, () => link.nth(run).click(), { url: `task/${id}`, not: ['[aria-busy="true"]'], text: words }, desk ? tileSel('Tasks') : undefined);
        record('Tasks: list → task', width, s1);
        if (desk) {
          // And a second, the pointer resting on it 400 ms first.
          await p.locator(`${tileSel('Tasks')} .loom-tile__btn[aria-label^="Back"]`).click();
          await link.nth(run + 5).waitFor();
          const h2 = await link.nth(run + 5).getAttribute('href');
          const id2 = /task\/(t-\d+)/.exec(h2 ?? '')?.[1] ?? '';
          const words2 = ((await link.nth(run + 5).textContent()) ?? '').trim().slice(0, 24);
          await link.nth(run + 5).hover();
          await p.waitForTimeout(400);
          const s3 = await step(p, cdp, () => link.nth(run + 5).click(), { url: `task/${id2}`, not: [`${tileSel('Tasks')} [aria-busy="true"]`], text: words2 }, tileSel('Tasks'));
          record('Tasks: list → task (pointer rested 400 ms)', width, s3);
        }
        const back = desk ? () => p.locator(`${tileSel('Tasks')} .loom-tile__btn[aria-label^="Back"]`).click() : () => p.goBack();
        const s2 = await step(p, cdp, back, { notUrl: `task/${id}`, has: ['a[href*="/p/tasks/task/"]'] }, desk ? tileSel('Tasks') : undefined);
        record('Tasks: task → back to list', width, s2);
        await ctx.close();
      }
      // 4. Switching dock apps (desktop: a tile per app, focus moves; phone: the page swaps).
      {
        const { ctx, p, cdp } = await screen(browser, width, '/inbox');
        const key = (l: string) => p.locator(`.loom-dock-bar [data-part="item"][aria-label="${l}"]`);
        // A phone's dock holds Home, the Inbox and Places (Comms and Tasks are under Places).
        const PHONE: Record<string, string> = { Places: '/places', Inbox: '/inbox', Home: '/' };
        const apps = desk ? ['Comms', 'Inbox', ...(hasTasks ? ['Tasks'] : []), 'Comms'] : ['Places', 'Inbox', 'Home', 'Places'];
        for (const [i, app] of apps.entries()) {
          if (!(await key(app).count())) { console.error(`no dock key ${app} at ${width}`); continue; }
          const done: Done = desk ? { has: [`${tileSel(app)}[data-focused]`, `${tileSel(app)} .loom-tile__page > *`] } : { path: PHONE[app], not: ['.loom-skel'] };
          const s = await step(p, cdp, () => key(app).click(), done, desk && i > 0 ? tileSel(apps[i - 1]) : undefined);
          record(`Dock: switch to ${app}${apps.slice(0, i).includes(app) ? ' (again)' : ''}`, width, s);
        }
        await ctx.close();
      }
      // 5. Opening a tile (desktop only): from the desktop, an app's key.
      if (desk) {
        const { ctx, p, cdp } = await screen(browser, width, '/');
        const s = await step(p, cdp, () => p.locator('.loom-dock-bar [data-part="item"][aria-label="Comms"]').click(),
          { has: [`${tileSel('Comms')} .comms-row__btn`] }, '.loom-dock-bar');
        record('Desktop: open a tile', width, s);
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  await handle.close();
  await closeAllBackends();
  rmSync(home, { recursive: true, force: true });
}

const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const summary = flows.map((f) => ({ flow: f.name, width: f.width, n: f.samples.length,
  visibleMs: med(f.samples.map((s) => s.visibleMs)), completeMs: med(f.samples.map((s) => s.completeMs)),
  bytes: med(f.samples.map((s) => s.bytes)), requests: med(f.samples.map((s) => s.requests)),
  remounted: f.samples.some((s) => s.remounted === null) ? '-' : `${f.samples.filter((s) => s.remounted).length}/${f.samples.length}` }));
console.table(summary);
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), flows, summary }, null, 2));
process.exit(0);
