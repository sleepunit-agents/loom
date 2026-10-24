import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { request as httpRequest } from 'node:http';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { remember } from '../tools/remember.js';
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
    [{ title: 'T', sections: [{ id: 's', blocks: [{ type: 'link', text: 'x', page: '/ui/act/loom' }] }] }, /page link/],
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
    expect(pageHref('task/t-1', pieceSource('tasks'))).toBe('/ui/p/tasks/task/t-1');
    expect(pageHref('', pieceSource('tasks'))).toBe('/ui/p/tasks');
    expect(pageHref('loom:people/pat', pieceSource('tasks'))).toBe('/ui/people/pat');
    expect(pageHref('loom:', pieceSource('tasks'))).toBe('/ui');
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

  beforeEach(async () => {
    clearPieceCache();
    stack = await mkdtemp(join(tmpdir(), 'loom-ui-stack-'));
    bin = await mkdtemp(join(tmpdir(), 'loom-ui-bin-'));
    await writeFile(join(stack, 'IDENTITY.md'), '# Test Agent\n\nCreed.');
    await remember(stack, { category: 'episode', title: 'shipped the ui', content: 'body', metadata: { where: 'terminal' } });
    await remember(stack, { category: 'episode', title: 'talked on discord', content: 'body', metadata: { where: 'discord:#pond' } });
    await remember(stack, { category: 'project', title: 'a hot memory', content: 'body' });
    savedPath = process.env.PATH;
    // Only this test's pieces: not whatever loom-* the host has installed.
    process.env.PATH = [bin, '/usr/bin', '/bin'].join(delimiter);
    handle = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0, token: TOKEN });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle.close();
    process.env.PATH = savedPath;
    await rm(stack, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const res = await fetch(`${base}/ui/login`, {
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

  const get = (path: string, cookie: string) => fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
  const csrfOf = (html: string) => /name="_csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? '';

  async function post(path: string, cookie: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });
  }

  it('sends a browser without a cookie to the login page', async () => {
    const res = await fetch(`${base}/ui`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/ui/login');
  });

  it('refuses a wrong token at login', async () => {
    const res = await fetch(`${base}/ui/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=wrong', redirect: 'manual',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('Home is the tape, with top of mind beside it, under a no-script CSP', async () => {
    const cookie = await login();
    const res = await get('/ui', cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const html = await res.text();
    expect(html).toContain('Test Agent');
    expect(html).toContain('What&#39;s happening');
    expect(html).toContain('shipped the ui');
    expect(html).toContain('a hot memory');
    expect(html).toContain('href="/ui/mind"');
    expect(html).not.toContain('<script');
  });

  it('the tape filters by where it happened', async () => {
    const cookie = await login();
    const html = await (await get('/ui?where=discord', cookie)).text();
    expect(html).toContain('talked on discord');
    expect(html).not.toContain('shipped the ui');
    expect(html).toContain('class="pill on" href="/ui?where=discord"');
  });

  it('Mind explains heat, and an aged memory sits below a fresh one with no recompute', async () => {
    await remember(stack, { category: 'project', title: 'an old memory', content: 'stale' });
    const db = new BetterSqlite3(resolveSqliteDbPath(stack));
    db.prepare('UPDATE memories SET created = ?, salience = 1 WHERE title = ?').run(new Date(Date.now() - 90 * 86_400_000).toISOString(), 'an old memory');
    db.close();
    const cookie = await login();
    const html = await (await get('/ui/mind', cookie)).text();
    expect(html).toContain('What I wake up holding');
    expect(html.indexOf('a hot memory')).toBeLessThan(html.indexOf('an old memory'));
    expect(html).toMatch(/Project memories cool by half every 10 days/);
  });

  it('one memory and its record; a person card and what is newer than it', async () => {
    const cookie = await login();
    const db = new BetterSqlite3(resolveSqliteDbPath(stack), { readonly: true });
    const ref = (db.prepare("SELECT ref FROM memories WHERE title = 'a hot memory'").get() as { ref: string }).ref;
    db.close();
    const html = await (await get(`/ui/memory/${ref}`, cookie)).text();
    expect(html).toContain('<h1>a hot memory</h1>');
    expect(html).toContain('half-life');
    expect((await get('/ui/memory/nope/none', cookie)).status).toBe(404);
    expect((await get('/ui/people', cookie)).status).toBe(200);
    expect((await get('/ui/people/no-such-person', cookie)).status).toBe(404);
  });

  it('pending proposals show on Mind (not Home), and ratify / reject work from the page', async () => {
    propose(stack, { category: 'feedback', title: 'please ratify me', content: 'c', source: 'test' });
    propose(stack, { category: 'feedback', title: 'please reject me', content: 'c', source: 'test' });
    const cookie = await login();
    expect(await (await get('/ui', cookie)).text()).not.toContain('please ratify me');
    const mind = await (await get('/ui/mind', cookie)).text();
    expect(mind).toContain('2 proposals waiting');
    const csrf = csrfOf(mind);
    const [a, b] = listProposals(stack);
    const r1 = await post('/ui/act/loom', cookie, { _csrf: csrf, _action: 'ratify', _path: 'mind', id: String(a.id) });
    expect(r1.status).toBe(303);
    const r2 = await post('/ui/act/loom', cookie, { _csrf: csrf, _action: 'reject', _path: 'mind', id: String(b.id) });
    expect(r2.headers.get('location')).toMatch(/^\/ui\/mind\?_flash=[0-9a-f]+$/);
    expect(listProposals(stack)).toHaveLength(0);
    const after = await (await get(r2.headers.get('location')!, cookie)).text();
    expect(after).toContain(`Proposal #${b.id} rejected.`);
    // The message shows once.
    expect(await (await get(r2.headers.get('location')!, cookie)).text()).not.toContain('rejected.');
  });

  it('an action without the anti-forgery token, or from another site, is refused', async () => {
    propose(stack, { category: 'feedback', title: 'p', content: 'c', source: 'test' });
    const cookie = await login();
    const csrf = csrfOf(await (await get('/ui/mind', cookie)).text());
    const id = String(listProposals(stack)[0].id);
    expect((await post('/ui/act/loom', cookie, { _action: 'reject', id })).status).toBe(403);
    expect((await post('/ui/act/loom', cookie, { _csrf: '0'.repeat(64), _action: 'reject', id })).status).toBe(403);
    expect((await post('/ui/act/loom', cookie, { _csrf: csrf, _action: 'reject', id }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post('/ui/act/loom', cookie, { _csrf: csrf, _action: 'reject', id }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(listProposals(stack)).toHaveLength(1);
    // A script with the bearer header has no ambient credential to forge, so it needs no token.
    const res = await fetch(`${base}/ui/act/loom`, {
      method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _action: 'reject', id }).toString(),
    });
    expect(res.status).toBe(303);
    expect(listProposals(stack)).toHaveLength(0);
  });

  it('an installed piece gets a tab, a tile and its asks, with no configuration', async () => {
    await piece(bin, 'shuttle', `[ "$1 $2" = "ui --json" ] && echo '${manifest}'`);
    const body = await (await fetch(`${base}/ui/pieces.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
      pieces: Array<{ piece: string; manifest: { tab: { label: string } } }>;
    };
    expect(body.pieces.map((p) => [p.piece, p.manifest.tab.label])).toEqual([['shuttle', 'Bridges']]);
    const cookie = await login();
    const html = await (await get('/ui', cookie)).text();
    expect(html).toContain('<a href="/ui/p/shuttle">Bridges</a>');
    expect(html).toContain('2 live');
    expect(html).toContain('Your call');
    expect(html).toContain('Slack bridge is dark');
  });

  it('a first-version piece still shows, as its own page', async () => {
    await piece(bin, 'old', `[ "$1 $2" = "ui --json" ] && echo '${legacy}'`);
    const cookie = await login();
    const html = await (await get('/ui/p/old', cookie)).text();
    expect(html).toContain('<h2>Bridges</h2>');
    expect((await get('/ui/p/old/deeper', cookie)).status).toBe(404);
  });

  it('a piece page renders its forms and buttons; an action reaches the piece on stdin only', async () => {
    const seen = join(bin, 'seen');
    await piece(bin, 'vault', fullPiece(seen));
    const cookie = await login();
    const html = await (await get('/ui/p/vault', cookie)).text();
    expect(html).toContain('<h1>Vault</h1>');
    expect(html).toContain('type="password" autocomplete="new-password"');
    expect(html).not.toContain('MUST-NOT-RENDER');
    expect(html).toContain('action="/ui/act/vault"');
    expect(html).toContain('href="/ui/p/vault/item/alpha"');
    const csrf = csrfOf(html);
    const res = await post('/ui/act/vault', cookie, { _csrf: csrf, _action: 'add', _path: '', name: 'sentry-dsn', value: 'hunter2-secret' });
    expect(res.status).toBe(303);
    const to = res.headers.get('location')!;
    expect(to).toMatch(/^\/ui\/p\/vault\?_flash=/);
    expect(to).not.toContain('hunter2');
    expect(JSON.parse(await readFile(seen, 'utf-8'))).toEqual({ action: 'add', path: '', fields: { name: 'sentry-dsn', value: 'hunter2-secret' } });
    expect(await (await get(to, cookie)).text()).toContain('Stored.');
  });

  it('pieces without a ui, with garbage, or too slow are left out, and the page still renders', async () => {
    await piece(bin, 'noui', 'exit 2');
    await piece(bin, 'garbage', 'echo "{not json"');
    await piece(bin, 'slow', `sleep 10; echo '${manifest}'`);
    const t0 = Date.now();
    const body = await (await fetch(`${base}/ui/pieces.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
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
    expect((await get('/ui', cookie)).status).toBe(200);
  }, 15000);

  it('a piece can\'t inject markup: its strings are escaped', async () => {
    const evil = JSON.stringify({ v: 2, tab: { label: '<img src=x onerror=alert(1)>' }, tile: { label: 'x', value: '</a><script>alert(1)</script>' } });
    await piece(bin, 'evil', `echo '${evil}'`);
    const cookie = await login();
    const html = await (await get('/ui', cookie)).text();
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('a piece page path can\'t climb out', async () => {
    await piece(bin, 'vault', fullPiece(join(bin, 'seen')));
    const cookie = await login();
    // Raw request paths: fetch() would normalise the dots away before sending.
    const raw = (path: string) => new Promise<number>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port: handle.port, path, headers: { cookie } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on('error', reject);
      r.end();
    });
    // Dot segments are resolved before routing, so they land on another route, which refuses
    // (the cookie is no bearer for /cli)...
    for (const p of ['/ui/p/vault/..', '/ui/p/vault/%2e%2e/%2e%2e/cli', '/ui/memory/../../x', '/ui/p/nope']) {
      expect([401, 404]).toContain(await raw(p));
    }
    // ...and an encoded slash that would smuggle a .. segment to the piece is refused.
    for (const p of ['/ui/p/vault/a%2F..%2Fb', '/ui/p/vault/a%2F%2E%2E%2Fb', '/ui/memory/x%2F..%2F..%2Fy']) {
      expect(await raw(p)).toBe(404);
    }
  });

  it('logout clears the cookie, and only on a same-site POST', async () => {
    expect((await fetch(`${base}/ui/logout`, { redirect: 'manual' })).status).toBe(405);
    expect((await fetch(`${base}/ui/logout`, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    const res = await fetch(`${base}/ui/logout`, { method: 'POST', redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
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
    const [iat, mac] = value.split('.');
    for (const bad of [`${Number(iat) - 1}.${mac}`, `${iat}.${'0'.repeat(64)}`, 'garbage', `${iat}`]) {
      const res = await fetch(`${base}/ui/pieces.json`, { headers: { cookie: `${name}=${bad}` } });
      expect(res.status).toBe(401);
    }
  });

  it('the login page names no agent, and an oversized login is cut off', async () => {
    const page = await (await fetch(`${base}/ui/login`)).text();
    expect(page).not.toContain('Test Agent');
    const res = await fetch(`${base}/ui/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=' + 'x'.repeat(100_000),
    }).catch(() => undefined);
    if (res) expect([401, 413]).toContain(res.status);
  });

  it('concurrent page loads run each piece once', async () => {
    const count = join(bin, 'count');
    await piece(bin, 'counted', `echo x >> '${count}'; echo '${manifest}'`);
    await Promise.all(Array.from({ length: 10 }, () =>
      fetch(`${base}/ui/pieces.json`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.text())));
    expect((await readFile(count, 'utf-8')).trim().split('\n')).toHaveLength(1);
  });

  it('a piece that leaves a helper holding stdout still answers in time', async () => {
    await piece(bin, 'helper', `(sleep 20 &); echo '${manifest}'`);
    const t0 = Date.now();
    const body = await (await fetch(`${base}/ui/pieces.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
      pieces: Array<{ piece: string }>;
    };
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(body.pieces.map((p) => p.piece)).toEqual(['helper']);
  });

  it('a timeout kills the piece\'s whole process group', async () => {
    const pidFile = join(bin, 'child.pid');
    await piece(bin, 'hangs', `sleep 30 & echo $! > '${pidFile}'; wait`);
    await fetch(`${base}/ui/pieces.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
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
      const body = await (await fetch(`${base}/ui/pieces.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
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
      expect((await get('/ui', cookie)).status).toBe(200);
      expect((await get('/ui/mind', cookie)).status).toBe(200);
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
      for (const path of ['/ui', '/ui/pieces.json', '/ui/login', '/ui/mind']) {
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
      expect((await fetch(`http://127.0.0.1:${h.port}/ui`)).status).toBe(404);
    } finally { await h.close(); }
  });
});
