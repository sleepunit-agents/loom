import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { request as httpRequest } from 'node:http';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { sessionStore } from './sessions.js';
import { createHash } from 'node:crypto';
import { remember } from '../tools/remember.js';
import { update } from '../tools/update.js';
import { listProposals, propose } from '../backends/proposals.js';
import { resolveSqliteDbPath } from '../config.js';
import { parseActResult, parseManifest, parsePage, splitPage, validPath } from './vocab.js';
import { clearPieceCache } from './pieces.js';
import { esc, pageHref, pieceSource } from './render.js';

const TOKEN = 'ui-test-token';

async function piece(dir: string, name: string, body: string) {
  const path = join(dir, `loom-${name}`);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

const manifest = JSON.stringify({
  v: 2,
  tab: { label: 'Bridges' },
  tile: { label: 'Bridges', value: '2 live', detail: '#pond, now', tone: 'ok', page: '' },
  asks: [{ text: 'Slack bridge is dark', meta: 'since 13:02', page: '', label: 'Look' }],
});
const legacy = JSON.stringify({
  sections: [{ id: 'bridges', title: 'Bridges', blocks: [{ type: 'stats', items: [{ label: 'up', value: 2, tone: 'ok' }] }] }],
});

/** A piece that answers all three verbs. `ui act` appends its stdin to a file so the test can see exactly what arrived. */
function fullPiece(seen: string): string {
  const page = JSON.stringify({
    title: 'Vault',
    intro: 'Write-only.',
    sections: [
      { id: 'add', blocks: [{ type: 'form', action: 'add', submit: 'Save', fields: [
        { name: 'name', label: 'Name', kind: 'text' },
        { name: 'value', label: 'Value', kind: 'secret', value: 'MUST-NOT-RENDER' },
      ] }] },
      { id: 'list', title: 'In the store', side: true, blocks: [
        { type: 'list', items: [{ text: 'alpha', page: 'item/alpha' }] },
        { type: 'buttons', items: [{ action: 'remove', label: 'Remove', tone: 'danger', fields: { name: 'alpha' } }] },
      ] },
    ],
  });
  return `
case "$1 $2" in
  "ui --json") echo '${JSON.stringify({ v: 2, tab: { label: 'Vault' }, tile: { label: 'Vault', value: '1', page: '' }, asks: [] })}' ;;
  "ui page") cat > /dev/null; echo '${page}' ;;
  "ui act") cat >> '${seen}'; echo '{"ok":true,"message":"Stored.","page":""}' ;;
  *) exit 2 ;;
esac`;
}

describe('the vocabulary pieces send', () => {
  it('accepts a v2 manifest and a first-version answer', () => {
    const m = parseManifest(JSON.parse(manifest));
    expect(m).toMatchObject({ tab: { label: 'Bridges' }, tile: { value: '2 live' }, asks: [{ text: 'Slack bridge is dark' }] });
    expect(parseManifest(JSON.parse(legacy))).toMatchObject({ legacy: [{ id: 'bridges' }], asks: [] });
  });

  it('accepts every block type on a page', () => {
    const r = parsePage({ title: 'T', sections: [{ id: 's', title: 'S', side: true, tone: 'warn', blocks: [
      { type: 'stats', items: [{ label: 'a', value: '1', detail: 'd', page: 'x' }] },
      { type: 'list', items: [{ text: 't', meta: 'm', badge: 'b', tone: 'warn', page: 'task/t-1' }, { text: 'out', href: 'https://example.com/' }] },
      { type: 'table', columns: ['a', 'b'], rows: [['1', { text: '2', page: 'loom:people/pat' }]] },
      { type: 'kv', items: [{ label: 'k', value: 'v' }] },
      { type: 'text', text: 'hello', tone: 'muted' },
      { type: 'callout', title: 'Note', text: 'boxed', tone: 'bad' },
      { type: 'link', text: 'docs', href: 'https://example.com/x' },
      { type: 'filters', param: 'tag', options: [{ value: '', label: 'All' }, { value: 'pond', label: 'pond' }] },
      { type: 'details', summary: 's', blocks: [{ type: 'text', text: 'inside' }] },
      { type: 'form', action: 'add', submit: 'Go', hidden: { id: 't-1' }, fields: [
        { name: 'a', label: 'A', kind: 'text' }, { name: 'b', label: 'B', kind: 'textarea' },
        { name: 'c', label: 'C', kind: 'choice', options: [{ value: 'x', label: 'X', detail: 'why' }] },
        { name: 'd', label: 'D', kind: 'secret' },
      ] },
      { type: 'buttons', items: [{ action: 'rm', label: 'Remove', tone: 'danger', fields: { id: 't-1' } }] },
    ] }] });
    expect(typeof r).not.toBe('string');
  });

  it('a secret field never carries a value, even if the piece sends one', () => {
    const r = parsePage({ title: 'T', sections: [{ id: 's', blocks: [{ type: 'form', action: 'a', submit: 'S', fields: [{ name: 'v', label: 'V', kind: 'secret', value: 'leak' }] }] }] });
    expect(JSON.stringify(r)).not.toContain('leak');
  });

  it.each([
    [{ title: 'T', sections: [{ id: 's', blocks: [{ type: 'link', text: 'x', href: 'javascript:alert(1)' }] }] }, /http\(s\)/],
    [{ title: 'T', sections: [{ id: 's', blocks: [{ type: 'link', text: 'x', href: '/relative' }] }] }, /absolute/],
    [{ title: 'T', sections: [{ id: 's', blocks: [{ type: 'link', text: 'x', page: '../../cli' }] }] }, /page link/],
    [{ title: 'T', sections: [{ id: 's', blocks: [{ type: 'link', text: 'x', page: '/act/loom' }] }] }, /page link/],
    [{ title: 'T', sections: [{ id: 's', blocks: [{ type: 'html', html: '<b>' }] }] }, /unknown block type/],
    [{ title: 'T', sections: [{ id: 'Bad Id', blocks: [] }] }, /section.id/],
    [{ title: 'T', sections: [{ id: 's', blocks: [{ type: 'text', text: 'x'.repeat(2001) }] }] }, /longer than/],
    [{ title: 'T', sections: [{ id: 's', blocks: [{ type: 'list', items: [{ text: 't', tone: 'red' }] }] }] }, /tone/],
    [{ title: 'T', sections: [{ id: 's', blocks: [{ type: 'table', columns: ['a'], rows: [['1', '2']] }] }] }, /table row/],
    [{ title: 'T', sections: [{ id: 's', blocks: [{ type: 'details', summary: 'a', blocks: [{ type: 'details', summary: 'b', blocks: [] }] }] }] }, /details/],
    [{ title: 'T', sections: [{ id: 's', blocks: [{ type: 'form', action: 'Bad Action', submit: 's', fields: [] }] }] }, /form.action/],
    [{ title: 'T', sections: [{ id: 's', blocks: [{ type: 'form', action: 'a', submit: 's', fields: [{ name: 'f', label: 'F', kind: 'file' }] }] }] }, /field.kind/],
    [{ nope: true }, /title must be a string/],
  ])('refuses %j', (v, why) => {
    const r = parsePage(v);
    expect(typeof r).toBe('string');
    expect(r).toMatch(why);
  });

  it('refuses a manifest of the wrong version, and act results without ok', () => {
    expect(parseManifest({ v: 3 })).toMatch(/v must be 2/);
    expect(parseActResult({ message: 'x' })).toMatch(/ok must be/);
    expect(parseActResult({ ok: true, message: 'x', page: '../x' })).toMatch(/page link/);
  });

  it('paths and page links stay inside their place', () => {
    for (const ok of ['', 'task/t-1', 'memory/user/a-b-1', 'a.b~c']) expect(validPath(ok)).toBe(true);
    for (const bad of ['..', 'a/../b', '/a', 'a/', 'a//b', 'A', 'a b', 'a?b', 'x'.repeat(201)]) expect(validPath(bad)).toBe(false);
    expect(splitPage('task/t-1?tab=x')).toEqual({ core: false, path: 'task/t-1', query: { tab: 'x' } });
    expect(splitPage('loom:people/pat')).toEqual({ core: true, path: 'people/pat', query: {} });
    expect(splitPage('?_flash=1')).toBeNull();
    // Into loom, only loom's own pages.
    for (const bad of ['loom:p/other/x', 'loom:act/loom', 'loom:login', 'loom:logout', 'loom:pieces.json']) expect(splitPage(bad)).toBeNull();
    for (const ok of ['loom:', 'loom:mind?category=user', 'loom:people', 'loom:people/pat', 'loom:memory/user/a-1']) expect(splitPage(ok)).not.toBeNull();
    expect(pageHref('task/t-1', pieceSource('tasks'))).toBe('/p/tasks/task/t-1');
    expect(pageHref('', pieceSource('tasks'))).toBe('/p/tasks');
    expect(pageHref('loom:people/pat', pieceSource('tasks'))).toBe('/people/pat');
    expect(pageHref('loom:', pieceSource('tasks'))).toBe('/');
  });

  it('esc() leaves nothing that can open a tag or an attribute', () => {
    expect(esc(`<script>"'&`)).toBe('&lt;script&gt;&quot;&#39;&amp;');
  });
});

describe('loom UI over HTTP', () => {
  let stack: string;
  let bin: string;
  let handle: HttpServeHandle;
  let base: string;
  let savedPath: string | undefined;
  let savedHome: Record<string, string | undefined> = {};

  beforeEach(async () => {
    clearPieceCache();
    stack = await mkdtemp(join(tmpdir(), 'loom-ui-stack-'));
    bin = await mkdtemp(join(tmpdir(), 'loom-ui-bin-'));
    await writeFile(join(stack, 'IDENTITY.md'), '# Test Agent\n\nCreed.');
    await remember(stack, { category: 'episode', title: 'shipped the ui', content: 'body', metadata: { where: 'terminal' } });
    await remember(stack, { category: 'episode', title: 'talked on discord', content: 'body', metadata: { where: 'discord:#pond' } });
    await remember(stack, { category: 'project', title: 'a hot memory', content: 'body' });
    savedPath = process.env.PATH;
    savedHome = { LOOM_HOME: process.env.LOOM_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    // Only this test's pieces: not whatever loom-* the host has installed, on
    // PATH or managed under its LOOM_HOME (or its systemd units).
    process.env.PATH = [bin, '/usr/bin', '/bin'].join(delimiter);
    process.env.LOOM_HOME = join(stack, 'loom-home');
    process.env.XDG_CONFIG_HOME = join(stack, 'xdg');
    handle = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0, token: TOKEN });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle.close();
    process.env.PATH = savedPath;
    for (const [k, v] of Object.entries(savedHome)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(stack, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const res = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(TOKEN)}`,
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toContain(TOKEN);
    return cookie.split(';')[0];
  }

  /** A browser's page load: the app's one HTML shell (or a redirect to sign in). */
  const get = (path: string, cookie: string) => fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
  /** What the app asks for at the same path: the page's data, with the page's status. */
  const getJson = (path: string, cookie: string) => fetch(`${base}${path}`, { headers: { cookie, accept: 'application/json' }, redirect: 'manual' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = async (path: string, cookie: string): Promise<any> => (await getJson(path, cookie)).json();
  /** The page's anti-forgery token, as the app gets it. */
  const csrfOf = (v: { chrome: { csrf: string } }) => v.chrome.csrf;
  /** Every section of a page view, by id. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const section = (v: any, id: string) => (v.page.sections as Array<{ id: string; title?: string; blocks: any[] }>).find((s) => s.id === id);

  async function post(path: string, cookie: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });
  }

  it('a restart signs nobody out: the session and its form token survive a new server', async () => {
    const cookie = await login();
    const csrf = csrfOf(await view('/', cookie));
    expect(csrf).toMatch(/^[0-9a-f]{64}$/);
    await handle.close();
    handle = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0, token: TOKEN });
    base = `http://127.0.0.1:${handle.port}`;
    const after = await getJson('/', cookie);
    expect(after.status).toBe(200);
    expect(csrfOf(await after.json())).toBe(csrf);
    // And logging out still ends it, after the restart too.
    expect((await post('/logout', cookie, { _csrf: csrf })).status).toBe(303);
    expect((await get('/', cookie)).status).toBe(303);
  });

  it('a one-time link signs in from its button, once; a preview\'s GET doesn\'t spend it', async () => {
    const code = sessionStore(stack).createLink(createHash('sha256').update(TOKEN).digest(), 600);
    for (let i = 0; i < 2; i++) {
      const page = await fetch(`${base}/login/${code}`, { redirect: 'manual' });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(`action="/login/${code}"`);
    }
    expect((await fetch(`${base}/login/${code}`, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    const signed = await fetch(`${base}/login/${code}`, { method: 'POST', redirect: 'manual' });
    expect(signed.status).toBe(303);
    const cookie = (signed.headers.get('set-cookie') ?? '').split(';')[0];
    expect((await get('/', cookie)).status).toBe(200);
    expect((await fetch(`${base}/login/${code}`, { method: 'POST', redirect: 'manual' })).status).toBe(401);
    // A link for a token that no longer logs in opens nothing.
    const dead = sessionStore(stack).createLink(createHash('sha256').update('not-a-token').digest(), 600);
    expect((await fetch(`${base}/login/${dead}`, { method: 'POST', redirect: 'manual' })).status).toBe(401);
  });

  it('sends a browser without a cookie to the login page', async () => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('refuses a wrong token at login', async () => {
    const res = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=wrong', redirect: 'manual',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('Home is the tape, with top of mind beside it, under a CSP that runs only loom\'s own script', async () => {
    const cookie = await login();
    const res = await get('/', cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const html = await res.text();
    // The shell carries no page data: that comes as JSON.
    expect(html).toContain('<div id="root">');
    expect(html).not.toContain('shipped the ui');
    // Script only by src, from loom: no inline script, and the CSP allows neither inline nor eval.
    // Each <script opening: its attributes name a src under /app/, and nothing comes before its end tag.
    const opens = html.toLowerCase().split('<script').slice(1);
    expect(opens.length).toBeGreaterThan(0);
    for (const rest of opens) {
      const gt = rest.indexOf('>');
      expect(rest.slice(0, gt)).toMatch(/\bsrc="\/app\//);
      expect(rest.slice(gt + 1).trimStart().startsWith('</script')).toBe(true);
    }
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'self';/);
    const j = await getJson('/', cookie);
    expect(j.status).toBe(200);
    expect(j.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const v = await j.json();
    expect(v.view).toBe('home');
    expect(v.chrome.agent).toBe('Test Agent');
    expect(section(v, 'tape')!.title).toBe('What\'s happening');
    expect(JSON.stringify(section(v, 'tape'))).toContain('shipped the ui');
    const mind = section(v, 'mind')!;
    expect(JSON.stringify(mind)).toContain('a hot memory');
    const why = mind.blocks.find((b) => b.type === 'link');
    expect(pageHref(why.page, v.ctx.source)).toBe('/mind');
    expect((await get('/app.js', cookie)).headers.get('content-type')).toMatch(/javascript/);
  });

  it('loom serves its own two fonts, and no other file by that route', async () => {
    const cookie = await login();
    for (const f of ['instrument-sans-latin-wght-normal', 'jetbrains-mono-latin-wght-normal']) {
      const r = await get(`/fonts/${f}.woff2`, cookie);
      expect([r.status, r.headers.get('content-type')]).toEqual([200, 'font/woff2']);
      expect(r.headers.get('cache-control')).toMatch(/immutable/);
      expect(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString()).toBe('wOF2');
    }
    for (const bad of ['/fonts/OFL-InstrumentSans.txt', '/fonts/..%2fpackage.json', '/fonts/other.woff2']) {
      expect((await get(bad, cookie)).headers.get('content-type')).not.toBe('font/woff2');
    }
    expect((await get('/', cookie)).headers.get('content-security-policy')).toMatch(/font-src 'self'/);
  });

  it('the tape filters by where it happened', async () => {
    const cookie = await login();
    const v = await view('/?where=discord', cookie);
    const json = JSON.stringify(v);
    expect(json).toContain('talked on discord');
    expect(json).not.toContain('shipped the ui');
    // The filter the page is on: the pill the app marks, from the page's own query.
    expect(v.ctx.query.where).toBe('discord');
    const filters = section(v, 'tape')!.blocks.find((b) => b.type === 'filters');
    expect(filters.param).toBe('where');
    expect(filters.options.map((o: { value: string }) => o.value)).toContain('discord');
  });

  it('Mind explains heat, and an aged memory sits below a fresh one with no recompute', async () => {
    await remember(stack, { category: 'project', title: 'an old memory', content: 'stale' });
    const db = new BetterSqlite3(resolveSqliteDbPath(stack));
    db.prepare('UPDATE memories SET created = ?, salience = 1 WHERE title = ?').run(new Date(Date.now() - 90 * 86_400_000).toISOString(), 'an old memory');
    db.close();
    const cookie = await login();
    // The board's Mind: top of mind, ranked, with every memory a link away.
    const top = await view('/mind', cookie);
    const ranked = section(top, 'top')!;
    const list = ranked.blocks.find((b) => b.type === 'list');
    expect(list.numbered).toBe(true);
    expect(list.items.length).toBeGreaterThan(0);
    const all = ranked.blocks.find((b) => b.type === 'link');
    expect(all.text).toMatch(/^All \d+ memories$/);
    expect(pageHref(all.page, top.ctx.source)).toBe('/mind?all=1');
    const v = await view('/mind?all=1', cookie);
    expect(v.page.sections.map((s: { title?: string }) => s.title)).toContain('At wake');
    const json = JSON.stringify(v);
    expect(json.indexOf('a hot memory')).toBeGreaterThan(-1);
    expect(json.indexOf('a hot memory')).toBeLessThan(json.indexOf('an old memory'));
    expect(json).toMatch(/Project memories cool by half every 10 days/);
  });

  it('archiving a memory offers Undo, which restores it: on the page and in the script\'s JSON', async () => {
    const cookie = await login();
    const db = new BetterSqlite3(resolveSqliteDbPath(stack), { readonly: true });
    const ref = (db.prepare("SELECT ref FROM memories WHERE title = 'a hot memory'").get() as { ref: string }).ref;
    db.close();
    const csrf = csrfOf(await view(`/memory/${ref}`, cookie));
    // The script's way: JSON with where to go, and what undoes it.
    const r = await post('/act/loom', cookie, { _csrf: csrf, _action: 'archive', _path: `memory/${ref}`, ref }, { 'x-loom-fetch': '1' });
    const body = await r.json() as { ok: boolean; go?: string; undo?: { act: string; path: string; action: string; fields: Record<string, string> } };
    expect(body).toMatchObject({ ok: true, undo: { act: '/act/loom', path: `memory/${ref}`, action: 'restore', fields: { ref } } });
    expect((await getJson(`/memory/${ref}`, cookie)).status).toBe(404);
    // The page's way: the message it lands on carries the Undo, with the same token to post it.
    const landed = await view(body.go!, cookie);
    expect(landed.chrome.csrf).toBe(csrf);
    const undo = landed.chrome.flash.undo as { act: string; path: string; action: string; fields: Record<string, string> };
    expect(undo).toMatchObject({ act: '/act/loom', path: `memory/${ref}`, action: 'restore', fields: { ref } });
    const undone = await post(undo.act, cookie, { _csrf: landed.chrome.csrf, _action: undo.action, _path: undo.path, ...undo.fields });
    expect(undone.status).toBe(303);
    expect(undone.headers.get('location')).toMatch(new RegExp(`^/memory/${ref.replace(/[/-]/g, (c) => `\\${c}`)}\\?_flash=`));
    expect((await getJson(`/memory/${ref}`, cookie)).status).toBe(200);
  });

  it('a piece\'s undo is parsed like a button, and dropped when the action failed', () => {
    expect(parseActResult({ ok: true, message: 'Muted.', undo: { action: 'unmute', fields: { id: '7' } } }))
      .toEqual({ ok: true, message: 'Muted.', page: undefined, undo: { action: 'unmute', label: undefined, fields: { id: '7' } } });
    expect(parseActResult({ ok: false, message: 'No.', undo: { action: 'unmute' } })).not.toHaveProperty('undo');
    expect(parseActResult({ ok: true, message: 'x', undo: { action: 'Bad Name' } })).toMatch(/undo.action/);
  });

  it('one memory and its record; a person card and what is newer than it', async () => {
    const cookie = await login();
    const db = new BetterSqlite3(resolveSqliteDbPath(stack), { readonly: true });
    const ref = (db.prepare("SELECT ref FROM memories WHERE title = 'a hot memory'").get() as { ref: string }).ref;
    db.close();
    const v = await view(`/memory/${ref}`, cookie);
    expect(v.page.title).toBe('a hot memory');
    const json = JSON.stringify(v);
    expect(json).toContain('half-life');
    // The board's summary, and the record behind Machine details.
    const summary = section(v, 'memory')!.blocks.find((b) => b.type === 'kv');
    for (const s of ['Learned from', 'First written', 'Recalled']) expect(summary.items.map((i: { label: string }) => i.label)).toContain(s);
    const details = section(v, 'record')!.blocks.find((b) => b.type === 'details');
    expect(details.summary).toBe('Machine details');
    expect(details.blocks.length).toBeGreaterThan(0);
    expect(section(v, 'history')).toBeUndefined();   // never edited: no history to show
    // Edited twice: now, then each earlier body back to the first.
    await update(stack, { ref, content: 'second take' });
    await update(stack, { ref, content: 'third take' });
    const edited = await view(`/memory/${ref}`, cookie);
    const hist = section(edited, 'history')!;
    expect(hist.title).toBe('History');
    const items = hist.blocks.find((b) => b.type === 'list').items as Array<{ text: string; meta: string }>;
    expect(items.map((i) => i.text)).toEqual(['third take', 'second take', 'body']);
    expect(items[0].meta).toMatch(/Now · edited/);
    expect(items[items.length - 1].meta).toMatch(/· first written/);
    expect((await getJson('/memory/nope/none', cookie)).status).toBe(404);
    expect((await getJson('/people', cookie)).status).toBe(200);
    // A piece may link to someone with no card: a page that says so, not an error.
    const nobody = await getJson('/people/no-such-person', cookie);
    expect(nobody.status).toBe(200);
    expect(JSON.stringify(await nobody.json())).toContain('no person card for no-such-person');
  });

  it('pending proposals show on Mind (not Home), and ratify / reject work from the page', async () => {
    propose(stack, { category: 'feedback', title: 'please ratify me', content: 'c', source: 'test' });
    propose(stack, { category: 'feedback', title: 'please reject me', content: 'c', source: 'test' });
    const cookie = await login();
    expect(JSON.stringify(await view('/', cookie))).not.toContain('please ratify me');
    const mind = await view('/mind', cookie);
    const call = section(mind, 'proposals')!;
    expect(call.title).toBe('Your call');
    expect(JSON.stringify(call)).toContain('“please ratify me”');
    const csrf = csrfOf(mind);
    const [a, b] = listProposals(stack);
    const r1 = await post('/act/loom', cookie, { _csrf: csrf, _action: 'ratify', _path: 'mind', id: String(a.id) });
    expect(r1.status).toBe(303);
    const r2 = await post('/act/loom', cookie, { _csrf: csrf, _action: 'reject', _path: 'mind', id: String(b.id) });
    expect(r2.headers.get('location')).toMatch(/^\/mind\?_flash=[0-9a-f]+$/);
    expect(listProposals(stack)).toHaveLength(0);
    const after = await view(r2.headers.get('location')!, cookie);
    expect(after.chrome.flash).toMatchObject({ ok: true, message: `Proposal #${b.id} rejected.` });
    // The message shows once.
    const again = await view(r2.headers.get('location')!, cookie);
    expect(again.chrome.flash).toBeUndefined();
    expect(JSON.stringify(again)).not.toContain('rejected.');
  });

  it('an action without the anti-forgery token, or from another site, is refused', async () => {
    propose(stack, { category: 'feedback', title: 'p', content: 'c', source: 'test' });
    const cookie = await login();
    const csrf = csrfOf(await view('/mind', cookie));
    expect(csrf).toMatch(/^[0-9a-f]{64}$/);   // a real token: the refusals below are for the reason named
    const id = String(listProposals(stack)[0].id);
    expect((await post('/act/loom', cookie, { _action: 'reject', id })).status).toBe(403);
    expect((await post('/act/loom', cookie, { _csrf: '0'.repeat(64), _action: 'reject', id })).status).toBe(403);
    expect((await post('/act/loom', cookie, { _csrf: csrf, _action: 'reject', id }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post('/act/loom', cookie, { _csrf: csrf, _action: 'reject', id }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(listProposals(stack)).toHaveLength(1);
    // A script with the bearer header has no ambient credential to forge, so it needs no token.
    const res = await fetch(`${base}/act/loom`, {
      method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _action: 'reject', id }).toString(),
    });
    expect(res.status).toBe(303);
    expect(listProposals(stack)).toHaveLength(0);
  });

  it('an installed piece gets a tab, a tile and its asks, with no configuration', async () => {
    await piece(bin, 'shuttle', `[ "$1 $2" = "ui --json" ] && echo '${manifest}'`);
    const body = await (await fetch(`${base}/pieces.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
      pieces: Array<{ piece: string; manifest: { tab: { label: string } } }>;
    };
    expect(body.pieces.map((p) => [p.piece, p.manifest.tab.label])).toEqual([['shuttle', 'Bridges']]);
    const cookie = await login();
    const v = await view('/', cookie);
    // Its tab is in the desktop rail's Pieces group and in the Places sheet, by the tab's label.
    expect(v.chrome.nav).toContainEqual(expect.objectContaining({ label: 'Bridges', href: '/p/shuttle', piece: true }));
    expect(v.chrome.shell.pieces).toContainEqual(expect.objectContaining({ label: 'Bridges', href: '/p/shuttle', kind: 'place' }));
    // Its tile, and its ask in Your call.
    expect(v.tiles).toContainEqual(expect.objectContaining({ label: 'Bridges', value: '2 live', source: pieceSource('shuttle') }));
    expect(v.asks).toContainEqual(expect.objectContaining({ text: 'Slack bridge is dark', source: pieceSource('shuttle') }));
  });

  it('a first-version piece still shows, as its own page', async () => {
    await piece(bin, 'old', `[ "$1 $2" = "ui --json" ] && echo '${legacy}'`);
    const cookie = await login();
    const v = await view('/p/old', cookie);
    expect(v.view).toBe('page');
    expect(section(v, 'bridges')!.title).toBe('Bridges');
    expect((await getJson('/p/old/deeper', cookie)).status).toBe(404);
  });

  it('a piece that says it\'s a setting goes under Setup, not Places; the catalog says for box, secrets, subscriptions', async () => {
    const m = (label: string, kind?: string) => JSON.stringify({ v: 2, tab: { label, ...(kind ? { kind } : {}) }, tile: { label, value: '1', page: '' }, asks: [] });
    await piece(bin, 'gizmo', `[ "$1 $2" = "ui --json" ] && echo '${m('Gizmo', 'setting')}'`);
    await piece(bin, 'secrets', `[ "$1 $2" = "ui --json" ] && echo '${m('Secrets')}'`);   // no kind: the catalog's
    await piece(bin, 'daily', `[ "$1 $2" = "ui --json" ] && echo '${m('Daily')}'`);
    const cookie = await login();
    // The Setup sheet is a page the app draws from the shell's pieces: settings there, places under Places.
    const res = await getJson('/setup', cookie);
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v).toMatchObject({ view: 'sheet', which: 'setup' });
    const kinds = Object.fromEntries((v.chrome.shell.pieces as Array<{ label: string; kind: string }>).map((p) => [p.label, p.kind]));
    expect(kinds).toEqual({ Daily: 'place', Gizmo: 'setting', Secrets: 'setting' });
    // A lone agent's owner is an admin: Setup keeps its own links (Pieces, Passkeys) beside the settings.
    expect(v.chrome.shell.admin).not.toBe(false);
    expect((await view('/places', cookie)).which).toBe('places');
    // A kind that isn't one is refused with the manifest.
    expect(parseManifest({ v: 2, tab: { label: 'x', kind: 'drawer' } })).toMatch(/tab.kind/);
  });

  it('a piece page renders its forms and buttons; an action reaches the piece on stdin only', async () => {
    const seen = join(bin, 'seen');
    await piece(bin, 'vault', fullPiece(seen));
    const cookie = await login();
    const v = await view('/p/vault', cookie);
    expect(v.page.title).toBe('Vault');
    const form = section(v, 'add')!.blocks.find((b) => b.type === 'form');
    expect(form.action).toBe('add');
    expect(form.fields.find((f: { name: string }) => f.name === 'value')).toMatchObject({ kind: 'secret' });
    expect(JSON.stringify(v)).not.toContain('MUST-NOT-RENDER');
    // Its forms post to the piece, its links stay under it.
    expect(v.ctx.source).toEqual(pieceSource('vault'));
    expect(v.ctx.source.act ?? `/act/${v.ctx.source.id}`).toBe('/act/vault');
    const item = section(v, 'list')!.blocks.find((b) => b.type === 'list').items[0];
    expect(pageHref(item.page, v.ctx.source)).toBe('/p/vault/item/alpha');
    const csrf = csrfOf(v);
    const res = await post('/act/vault', cookie, { _csrf: csrf, _action: 'add', _path: '', name: 'sentry-dsn', value: 'hunter2-secret' });
    expect(res.status).toBe(303);
    const to = res.headers.get('location')!;
    expect(to).toMatch(/^\/p\/vault\?_flash=/);
    expect(to).not.toContain('hunter2');
    expect(JSON.parse(await readFile(seen, 'utf-8'))).toEqual({ action: 'add', path: '', fields: { name: 'sentry-dsn', value: 'hunter2-secret' } });
    // The browser loads the app at that address first; that load must not spend the message the app then asks for.
    expect(await (await get(to, cookie)).text()).toContain('<div id="root">');
    expect((await view(to, cookie)).chrome.flash).toMatchObject({ ok: true, message: 'Stored.' });
  });

  it('pieces without a ui, with garbage, or too slow are left out, and the page still renders', async () => {
    await piece(bin, 'noui', 'exit 2');
    await piece(bin, 'garbage', 'echo "{not json"');
    await piece(bin, 'slow', `sleep 10; echo '${manifest}'`);
    const t0 = Date.now();
    const body = await (await fetch(`${base}/pieces.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
      pieces: unknown[]; skipped: Array<{ piece: string; reason: string }>;
    };
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(body.pieces).toEqual([]);
    expect(Object.fromEntries(body.skipped.map((s) => [s.piece, s.reason]))).toEqual({
      garbage: 'invalid: not JSON',
      noui: 'no ui',
      slow: 'timed out',
    });
    const cookie = await login();
    const res = await getJson('/', cookie);
    expect(res.status).toBe(200);
    expect((await res.json()).view).toBe('home');
  }, 15000);

  it('a piece can\'t inject markup: its strings are escaped', async () => {
    const evil = JSON.stringify({ v: 2, tab: { label: '<img src=x onerror=alert(1)>' }, tile: { label: 'x', value: '</a><script>alert(1)</script>' } });
    await piece(bin, 'evil', `echo '${evil}'`);
    const cookie = await login();
    // The page a browser renders carries none of a piece's strings...
    const html = await (await get('/', cookie)).text();
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('<img src=x');
    // ...they reach it as data, served as JSON the browser won't sniff into a page, for the app to draw as text.
    const res = await getJson('/', cookie);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const v = await res.json();
    expect(v.chrome.shell.pieces).toContainEqual(expect.objectContaining({ label: '<img src=x onerror=alert(1)>' }));
    expect(v.tiles).toContainEqual(expect.objectContaining({ value: '</a><script>alert(1)</script>' }));
  });

  it('a piece page path can\'t climb out', async () => {
    await piece(bin, 'vault', fullPiece(join(bin, 'seen')));
    const cookie = await login();
    // Raw request paths: fetch() would normalise the dots away before sending.
    const raw = (path: string) => new Promise<number>((resolve, reject) => {
      // As the app asks: a browser's page load is the app's shell at any path; the page itself is the JSON.
      const r = httpRequest({ host: '127.0.0.1', port: handle.port, path, headers: { cookie, accept: 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on('error', reject);
      r.end();
    });
    // Dot segments are resolved before routing, so they land on another route, which refuses
    // (the cookie is no bearer for /cli)...
    for (const p of ['/p/vault/..', '/p/vault/%2e%2e/%2e%2e/cli', '/memory/../../x', '/p/nope']) {
      expect([401, 404]).toContain(await raw(p));
    }
    // ...and an encoded slash that would smuggle a .. segment to the piece is refused.
    for (const p of ['/p/vault/a%2F..%2Fb', '/p/vault/a%2F%2E%2E%2Fb', '/memory/x%2F..%2F..%2Fy']) {
      expect(await raw(p)).toBe(404);
    }
  });

  it('logout clears the cookie, and only on a same-site POST', async () => {
    expect((await fetch(`${base}/logout`, { redirect: 'manual' })).status).toBe(405);
    expect((await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    const res = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('/ is the page for a browser, and MCP\'s for an MCP client', async () => {
    const cookie = await login();
    expect(await (await get('/', cookie)).text()).toContain('<div id="root">');
    const home = await view('/', cookie);
    expect(home.view).toBe('home');
    expect(section(home, 'tape')!.title).toBe('What\'s happening');
    // An MCP initialize posted to the root is MCP's, not the page's.
    const init = await fetch(`${base}/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeTruthy();
    // An event-stream GET to the root is MCP's too.
    const sse = await fetch(`${base}/`, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' }, redirect: 'manual' });
    expect(sse.headers.get('content-security-policy')).toBeNull();
    await sse.body?.cancel();
  });

  it('old /ui addresses redirect to the same page at the root', async () => {
    for (const [from, to] of [['/ui', '/'], ['/ui/', '/'], ['/ui/mind?category=user', '/mind?category=user'], ['/ui/p/tasks/task/t-1', '/p/tasks/task/t-1']]) {
      const res = await fetch(`${base}${from}`, { redirect: 'manual' });
      expect(res.status).toBe(308);
      expect(res.headers.get('location')).toBe(to);
    }
    // Never off-site: extra slashes or backslashes can't make a protocol-relative URL.
    const raw = (path: string) => new Promise<string>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port: handle.port, path }, (res) => { res.resume(); resolve(res.headers.location ?? ''); });
      r.on('error', reject);
      r.end();
    });
    for (const p of ['/ui//evil.example', '/ui///evil.example/x', '/ui/\\evil.example', '/ui/%2F%2Fevil.example']) {
      const loc = await raw(p);
      expect(loc.startsWith('/')).toBe(true);
      expect(loc.startsWith('//')).toBe(false);
      expect(loc.startsWith('/\\')).toBe(false);
    }
  });

  it('the page is served with Referrer-Policy same-origin, so its own form posts carry a real Origin', async () => {
    // Under no-referrer, Chrome sends `Origin: null` on the page's own form
    // posts and the cross-site guard refuses them: nobody could log in
    // (0.9.1, found in a real browser). fetch() here can't show that, so pin
    // the header, and refuse a null Origin as before.
    for (const p of ['/login', '/']) {
      expect((await fetch(`${base}${p}`, { redirect: 'manual' })).headers.get('referrer-policy')).toBe('same-origin');
    }
    const res = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' }, body: `token=${TOKEN}`, redirect: 'manual',
    });
    expect(res.status).toBe(403);
  });

  it('the session cookie is scoped to the whole site now', async () => {
    const res = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}`, redirect: 'manual',
    });
    expect(res.headers.get('set-cookie')).toMatch(/Path=\/;/);
  });

  it('the UI cookie is not a bearer: /cli still refuses it', async () => {
    const cookie = await login();
    const value = cookie.split('=')[1];
    const res = await fetch(`${base}/cli`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${value}` }, body: JSON.stringify({ argv: ['recall', 'x'] }),
    });
    expect(res.status).toBe(401);
  });

  it('a tampered or forged cookie is refused', async () => {
    const cookie = await login();
    const [name, value] = cookie.split('=');
    for (const bad of [value.slice(0, -1) + (value.endsWith('0') ? '1' : '0'), '0'.repeat(64), 'garbage', `${value}.x`]) {
      const res = await fetch(`${base}/pieces.json`, { headers: { cookie: `${name}=${bad}` } });
      expect(res.status).toBe(401);
    }
  });

  it('logout revokes the session server-side: a copy of the cookie stops working', async () => {
    const cookie = await login();
    expect((await get('/', cookie)).status).toBe(200);
    const res = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie } });
    expect(res.status).toBe(303);
    expect((await get('/', cookie)).headers.get('location')).toBe('/login');
  });

  it('another site (or another port here) can link to the page but not embed or fetch it', async () => {
    const cookie = await login();
    // Raw requests: fetch() sets its own sec-fetch-* headers.
    const as = (h: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port: handle.port, path: '/mind', headers: { cookie, ...h } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on('error', reject);
      r.end();
    });
    expect(await as({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' })).toBe(403);
    expect(await as({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).toBe(403);
    expect(await as({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).toBe(200);
    expect(await as({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).toBe(200);
    expect(await as({})).toBe(200);
  });

  it('a malformed escape in a path is a missing page, not a server error', async () => {
    await piece(bin, 'vault', fullPiece(join(bin, 'seen')));
    const cookie = await login();
    for (const p of ['/p/vault/%E0', '/memory/%E0%A4%A']) {
      const res = await getJson(p, cookie);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    }
  });

  it('every posted field arrives (hidden ones too, and one named constructor); too many is refused, not cut short', async () => {
    const seen = join(bin, 'seen');
    await piece(bin, 'vault', fullPiece(seen));
    const cookie = await login();
    const csrf = csrfOf(await view('/p/vault', cookie));
    const fields: Record<string, string> = { _csrf: csrf, _action: 'add', _path: '' };
    for (let i = 0; i < 20; i++) fields[`h${i}`] = 'hidden';
    for (let i = 0; i < 9; i++) fields[`f${i}`] = 'visible';
    fields.constructor = 'kept';
    fields.value = 'the-secret';
    expect((await post('/act/vault', cookie, fields)).status).toBe(303);
    const got = JSON.parse(await readFile(seen, 'utf-8')).fields as Record<string, string>;
    expect(Object.keys(got)).toHaveLength(31);
    expect(got.value).toBe('the-secret');
    expect(got.constructor).toBe('kept');
    for (let i = 0; i < 30; i++) fields[`x${i}`] = 'more';
    expect((await post('/act/vault', cookie, fields)).status).toBe(400);
  });

  it('a piece\'s result is labeled with the piece, and keeps the query of the page it names', async () => {
    const seen = join(bin, 'seen');
    const body = fullPiece(seen).replace(`'{"ok":true,"message":"Stored.","page":""}'`, `'{"ok":true,"message":"Stored.","page":"loom:mind?category=user"}'`);
    await piece(bin, 'vault', body);
    const cookie = await login();
    const csrf = csrfOf(await view('/p/vault', cookie));
    const res = await post('/act/vault', cookie, { _csrf: csrf, _action: 'add', _path: '', name: 'n', value: 'v' });
    const to = res.headers.get('location')!;
    expect(to).toMatch(/^\/mind\?category=user&_flash=/);
    const landed = await view(to, cookie);
    expect(landed.ctx.query).toMatchObject({ category: 'user' });
    expect(landed.chrome.flash).toMatchObject({ message: 'Stored.', from: 'vault' });
  });

  it('a piece leaves nothing running after it answers', async () => {
    const pidFile = join(bin, 'left.pid');
    await piece(bin, 'leaver', `sleep 30 & echo $! > '${pidFile}'; echo '${manifest}'`);
    await fetch(`${base}/pieces.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const pid = Number((await readFile(pidFile, 'utf-8')).trim());
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('a burst of page loads runs at most a few pieces at once', async () => {
    const log = join(bin, 'log');
    await piece(bin, 'busy', `case "$1 $2" in
  "ui --json") echo '${JSON.stringify({ v: 2, tab: { label: 'Busy' } })}' ;;
  "ui page") cat > /dev/null; echo "+ $(date +%s%N)" >> '${log}'; sleep 0.3; echo "- $(date +%s%N)" >> '${log}'; echo '{"title":"B","sections":[]}' ;;
esac`);
    const cookie = await login();
    await getJson('/p/busy', cookie);
    await writeFile(log, '');
    await Promise.all(Array.from({ length: 18 }, () => getJson('/p/busy', cookie).then((r) => r.text())));
    const events = (await readFile(log, 'utf-8')).trim().split('\n').map((l) => ({ d: l[0] === '+' ? 1 : -1, t: BigInt(l.slice(2)) }))
      .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.d - b.d));
    let now = 0; let peak = 0;
    for (const e of events) { now += e.d; peak = Math.max(peak, now); }
    expect(events.length).toBe(36);
    expect(peak).toBeLessThanOrEqual(6);
  }, 20000);

  it('the login page names no agent, and an oversized login is cut off', async () => {
    const page = await (await fetch(`${base}/login`)).text();
    expect(page).not.toContain('Test Agent');
    const res = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=' + 'x'.repeat(100_000),
    }).catch(() => undefined);
    if (res) expect([401, 413]).toContain(res.status);
  });

  it('concurrent page loads run each piece once', async () => {
    const count = join(bin, 'count');
    await piece(bin, 'counted', `echo x >> '${count}'; echo '${manifest}'`);
    await Promise.all(Array.from({ length: 10 }, () =>
      fetch(`${base}/pieces.json`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.text())));
    expect((await readFile(count, 'utf-8')).trim().split('\n')).toHaveLength(1);
  });

  it('a piece that leaves a helper holding stdout still answers in time', async () => {
    await piece(bin, 'helper', `(sleep 20 &); echo '${manifest}'`);
    const t0 = Date.now();
    const body = await (await fetch(`${base}/pieces.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
      pieces: Array<{ piece: string }>;
    };
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(body.pieces.map((p) => p.piece)).toEqual(['helper']);
  });

  it('a timeout kills the piece\'s whole process group', async () => {
    const pidFile = join(bin, 'child.pid');
    await piece(bin, 'hangs', `sleep 30 & echo $! > '${pidFile}'; wait`);
    await fetch(`${base}/pieces.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const pid = Number((await readFile(pidFile, 'utf-8')).trim());
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10000);

  it('pieces never see loom\'s bearer token; a piece named loom is ignored', async () => {
    const seen = join(bin, 'seen');
    await piece(bin, 'peek', `printf '%s' "$LOOM_BEARER_TOKEN" > '${seen}'; echo '${manifest}'`);
    await piece(bin, 'loom', `echo '${manifest}'`);
    process.env.LOOM_BEARER_TOKEN = TOKEN;
    try {
      const body = await (await fetch(`${base}/pieces.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
        pieces: Array<{ piece: string }>;
      };
      expect(body.pieces.map((p) => p.piece)).toEqual(['peek']);
      expect(await readFile(seen, 'utf-8')).toBe('');
    } finally {
      delete process.env.LOOM_BEARER_TOKEN;
    }
  });

  it('a bad TZ never breaks the page', async () => {
    const saved = process.env.TZ;
    process.env.TZ = ':/etc/localtime';
    try {
      const cookie = await login();
      expect((await getJson('/', cookie)).status).toBe(200);
      expect((await getJson('/mind', cookie)).status).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });
});

describe('loom UI: open and scoped daemons', () => {
  let stack: string;
  beforeEach(async () => { clearPieceCache(); stack = await mkdtemp(join(tmpdir(), 'loom-ui-open-')); });
  afterEach(async () => { await rm(stack, { recursive: true, force: true }); });

  it('a daemon with no token serves no page (an open page is DNS-rebindable; same rule as /cli)', async () => {
    const h = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0 });
    try {
      for (const path of ['/', '/pieces.json', '/login', '/mind']) {
        const res = await fetch(`http://127.0.0.1:${h.port}${path}`, { redirect: 'manual' });
        expect(res.status).toBe(403);
      }
    } finally { await h.close(); }
  });

  it('a scoped (knowledge-only) daemon has no UI', async () => {
    const h = await startHttpServer({
      contextDir: stack, host: '127.0.0.1', port: 0, tokens: { art: TOKEN }, createServer: () => { throw new Error('not reached'); },
    });
    try {
      expect((await fetch(`http://127.0.0.1:${h.port}/mind`)).status).toBe(404);
    } finally { await h.close(); }
  });
});
