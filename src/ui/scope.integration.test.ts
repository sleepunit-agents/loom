/**
 * Scope (Claude Design, 2026-10-26, requirement 10): pieces are run with
 * LOOM_SCOPE=<agent> when the owner has an agent selected. One that declares
 * `scope: true` narrows; one that doesn't gets a quiet line saying it shows the
 * whole household. A list row naming an agent carries that agent's mark.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { loadHousehold } from '../household.js';
import { clearPieceCache } from './pieces.js';

const TOKEN = 'scope-owner-token';

/** A stand-in piece: its answers are files, with LOOM_SCOPE put in by sed (no quoting to get wrong). */
function piece(dir: string, name: string, scoped: boolean) {
  writeFileSync(join(dir, `${name}.manifest.json`), JSON.stringify({ v: 2, ...(scoped ? { scope: true } : {}), tab: { label: name }, tile: { label: name, value: 'scope=@SCOPE@' } }));
  writeFileSync(join(dir, `${name}.page.json`), JSON.stringify({ title: name, sections: [{ id: 's', blocks: [
    { type: 'text', text: 'scope=@SCOPE@' },
    { type: 'list', items: [{ text: 'Closed a task', agent: 'art' }, { text: 'Rendered props', agent: 'mark' }, { text: "Nobody's", agent: 'nobody' }] },
  ] }] }));
  writeFileSync(join(dir, `loom-${name}`), `#!/bin/sh
d=$(dirname "$0")
case "$1 $2" in
"ui --json") sed "s/@SCOPE@/$LOOM_SCOPE/" "$d/${name}.manifest.json" ;;
"ui page") cat >/dev/null; sed "s/@SCOPE@/$LOOM_SCOPE/" "$d/${name}.page.json" ;;
*) exit 2 ;;
esac
`);
  chmodSync(join(dir, `loom-${name}`), 0o755);
}

/** A stand-in piece with tabs of its own: its manifest, page and act answers carry LOOM_SCOPE. */
function tabbed(dir: string, name: string, manifest: object) {
  writeFileSync(join(dir, `${name}.manifest.json`), JSON.stringify({ v: 2, scope: true, ...manifest }));
  writeFileSync(join(dir, `${name}.page.json`), JSON.stringify({ title: name, sections: [{ id: 's', blocks: [
    { type: 'text', text: 'scope=@SCOPE@' }, { type: 'link', text: 'next', page: 'next' },
    { type: 'form', action: 'poke', submit: 'Poke', fields: [] }] }] }));
  writeFileSync(join(dir, `${name}.act.json`), JSON.stringify({ ok: true, message: 'poked scope=@SCOPE@', page: 'done' }));
  writeFileSync(join(dir, `loom-${name}`), `#!/bin/sh
d=$(dirname "$0")
case "$1 $2" in
"ui --json") sed "s/@SCOPE@/$LOOM_SCOPE/" "$d/${name}.manifest.json" ;;
"ui page") cat >/dev/null; sed "s/@SCOPE@/$LOOM_SCOPE/" "$d/${name}.page.json" ;;
"ui act") cat >/dev/null; sed "s/@SCOPE@/$LOOM_SCOPE/" "$d/${name}.act.json" ;;
*) exit 2 ;;
esac
`);
  chmodSync(join(dir, `loom-${name}`), 0o755);
}

describe('scope', () => {
  let home: string;
  let handle: HttpServeHandle;
  let base: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    clearPieceCache();
    home = mkdtempSync(join(tmpdir(), 'loom-scope-'));
    for (const [agent, creed] of [['art', 'Art E Fish'], ['mark', 'Visual Mark']]) {
      mkdirSync(join(home, 'agents', agent), { recursive: true });
      writeFileSync(join(home, 'agents', agent, 'IDENTITY.md'), `# ${creed}\n\nCreed.\n`);
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan' }));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    piece(bin, 'narrow', true);
    piece(bin, 'wide', false);
    // Both: the household's lanes on its tab, each agent's schedule on that agent's pages.
    tabbed(bin, 'clocky', { tab: { label: 'Clocky' }, agentTab: { label: 'Clocky' } });
    // Only each agent's.
    tabbed(bin, 'bridgy', { tab: { label: 'Bridgy', level: 'agent' } });
    for (const k of ['PATH', 'LOOM_HOME', 'XDG_CONFIG_HOME', 'LOOM_SCOPE']) saved[k] = process.env[k];
    process.env.PATH = [bin, '/usr/bin', '/bin'].join(delimiter);
    process.env.LOOM_HOME = join(home, 'managed');
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    delete process.env.LOOM_SCOPE;
    handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: loadHousehold(home)!, token: TOKEN });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}`, redirect: 'manual' });
    return (res.headers.get('set-cookie') ?? '').split(';')[0];
  }
  // A page's data, as the app asks for it (docs/specs/ui-app.md): the same path, as JSON.
  const view = async (path: string, cookie: string) =>
    (await fetch(`${base}${path}`, { headers: { cookie, accept: 'application/json' }, redirect: 'manual' })).json() as Promise<any>;

  it('pieces are the household\'s on loom\'s pages; an old scope link or cookie changes nothing', async () => {
    const owner = await login();
    // Household: no scope, no line.
    expect((await view('/p/narrow', owner)).page.sections[0].blocks[0].text).toBe('scope=');
    expect((await view('/p/wide', owner)).unscoped).toBeUndefined();
    // A piece's page is the piece's (the app says how fresh it is); loom's own pages are loom's.
    expect((await view('/p/wide', owner)).ctx.source).toEqual({ id: 'wide', base: '/p/wide/' });
    expect((await view('/people', owner)).ctx.source.base).not.toMatch(/^\/p\//);
    // There's no scope to pick any more (t-1625): an old link goes to the agent's own pages and clears the old cookie,
    // and a piece's page is the household's whatever cookie a browser still sends.
    const pick = await fetch(`${base}/scope/mark`, { headers: { cookie: owner }, redirect: 'manual' });
    expect(pick.headers.get('location')).toBe('/a/mark');
    expect(pick.headers.get('set-cookie')).toMatch(/^loom_scope=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
    const old = `${owner}; loom_scope=mark`;
    expect((await view('/p/narrow', old)).page.sections[0].blocks[0].text).toBe('scope=');
    expect((await view('/p/wide', old)).unscoped).toBeUndefined();
    const places = await view('/places', old);
    expect(places.chrome.shell.scope).toBe('household');
    expect(places.chrome.shell.pieces).toContainEqual(expect.objectContaining({ label: 'narrow', stat: 'scope=' }));
  });

  it("a piece's agent tab is on each agent's pages, called for that agent, its links and actions kept there", async () => {
    const owner = await login();
    const places = (await view('/places', owner)).chrome.shell.pieces.map((p: { href: string }) => p.href);
    expect(places).toContain('/p/clocky');
    expect(places).not.toContain('/p/bridgy');   // only each agent's: not the household's
    const today = await view('/a/mark', owner);
    const tabs = today.dashboard.agent.tabs.map((t: { href: string }) => t.href);
    expect(tabs).toContain('/a/mark/p/clocky');
    expect(tabs).toContain('/a/mark/p/bridgy');
    const page = await view('/a/mark/p/bridgy', owner);
    const blocks = page.page.sections[0].blocks;
    expect(blocks[0].text).toBe('scope=mark');
    // Its link and its form resolve under mark's pages: the page's source says where.
    expect(blocks).toContainEqual(expect.objectContaining({ type: 'link', page: 'next' }));
    expect(blocks).toContainEqual(expect.objectContaining({ type: 'form', action: 'poke' }));
    expect(page.ctx.source).toMatchObject({ base: '/a/mark/p/bridgy/', act: '/a/mark/act/bridgy' });
    const wide = await fetch(`${base}/a/mark/p/wide`, { headers: { cookie: owner, accept: 'application/json' } });
    expect(wide.status).toBe(404);   // no agent tab: not here
    expect(((await wide.json()) as { page: { title: string } }).page.title).toBe('Not found');
    // An action from mark's page: the piece is called for mark and lands back under mark.
    const form = page.ctx.csrf as string;
    const res = await fetch(`${base}/a/mark/act/bridgy`, { method: 'POST', redirect: 'manual',
      headers: { cookie: owner, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: form, _action: 'poke', _path: '' }).toString() });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/a\/mark\/p\/bridgy\/done\?_flash=/);
    expect((await fetch(`${base}/a/nobody/act/bridgy`, { method: 'POST', headers: { cookie: owner, origin: base } })).status).toBe(404);
  });

  it('every page answers as JSON too: the data it is drawn from, under the same rules (docs/specs/ui-app.md)', async () => {
    const owner = await login();
    const json = (path: string, extra: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { cookie: owner, accept: 'application/json', ...extra }, redirect: 'manual' });
    const views: Record<string, string> = { '/': 'house-home', '/a/mark': 'dashboard', '/a/mark/setup': 'page', '/a/mark/p/bridgy': 'page',
      '/p/narrow': 'page', '/people': 'page', '/inbox': 'inbox', '/places': 'sheet', '/p/nope': 'page' };
    for (const [path, kind] of Object.entries(views)) {
      const r = await json(path);
      expect(r.headers.get('content-type'), path).toMatch(/^application\/json/);
      const v = await r.json() as { view: string; chrome?: { csrf?: string } };
      expect(v.view, path).toBe(kind);
      if (kind !== 'sheet') expect(v.chrome?.csrf, path).toMatch(/^[0-9a-f]{64}$/);
    }
    // The same data the HTML is drawn from: a piece's page, scoped to the agent whose tab it is.
    const tab = await (await json('/a/mark/p/bridgy')).json() as { page: { sections: { blocks: { text?: string }[] }[] }; ctx: { source: { base: string; act: string } } };
    expect(tab.page.sections[0].blocks[0].text).toBe('scope=mark');
    expect(tab.ctx.source).toMatchObject({ base: '/a/mark/p/bridgy/', act: '/a/mark/act/bridgy' });
    expect((await json('/p/nope')).status).toBe(404);
    // A browser's ordinary request still gets the page.
    expect((await fetch(`${base}/a/mark/p/bridgy`, { headers: { cookie: owner } })).headers.get('content-type')).toMatch(/^text\/html/);
    // The same rules: no session, no data; another site can't read it.
    expect((await fetch(`${base}/a/mark`, { headers: { accept: 'application/json' }, redirect: 'manual' })).status).not.toBe(200);
    expect((await json('/a/mark', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })).status).toBe(403);
  });

  it('every page a browser opens is the app (Passkeys too), whatever it asks for; the sign-in is loom\'s; the app\'s files are public, never outside its folder', async () => {
    const owner = await login();
    const shell = await fetch(`${base}/app/index.html`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<div id="root">');
    const js = /src="\/app\/(assets\/[^"]+\.js)"/.exec(await (await fetch(`${base}/app/index.html`)).text())![1];
    const asset = await fetch(`${base}/app/${js}`);
    expect([asset.status, asset.headers.get('content-type'), asset.headers.get('cache-control')]).toEqual([200, 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable']);
    for (const bad of ['/app/../package.json', '/app/%2e%2e/package.json', '/app/assets/../../package.json', '/app/']) {
      expect((await fetch(`${base}${bad}`)).status, bad).toBe(404);
    }
    // Any GET that doesn't ask for JSON gets the app's one page: a navigation, a worker's re-sent one, a script.
    const safari = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    for (const headers of [{ cookie: owner, 'sec-fetch-dest': 'document' }, { cookie: owner, accept: safari }, { cookie: owner }, { cookie: owner, accept: '*/*' }]) {
      for (const path of ['/a/mark/p/bridgy', '/a/mark', '/passkeys', '/', '/people', '/places']) {
        const r = await fetch(`${base}${path}`, { headers, redirect: 'manual' });
        expect([r.status, r.headers.get('content-type')], `${path} ${JSON.stringify(headers)}`).toEqual([200, 'text/html; charset=utf-8']);
        expect(r.headers.get('content-security-policy'), path).toContain("script-src 'self'");
        expect(await r.text(), path).toContain('<div id="root">');
      }
    }
    // The app asks the same path for its data, and gets it: Passkeys included.
    const data = await fetch(`${base}/a/mark/p/bridgy`, { headers: { cookie: owner, 'sec-fetch-dest': 'empty', accept: 'application/json' } });
    expect(((await data.json()) as { view: string }).view).toBe('page');
    expect(((await (await fetch(`${base}/passkeys`, { headers: { cookie: owner, accept: 'application/json' } })).json()) as { view: string }).view).toBe('passkeys');
    // Signed out, the app is no way in: loom's sign-in, which is still loom's own HTML.
    for (const headers of [{ 'sec-fetch-dest': 'document' }, {}, { accept: 'application/json' }]) {
      const out = await fetch(`${base}/a/mark`, { headers, redirect: 'manual' });
      expect([out.status, out.headers.get('location')], JSON.stringify(headers)).toEqual([303, '/login']);
    }
    expect(await (await fetch(`${base}/login`, { headers: { 'sec-fetch-dest': 'document' } })).text()).not.toContain('<div id="root">');
  });

  it('a list row naming an agent carries it, and the page carries each agent\'s mark; an unknown agent gets none', async () => {
    const v = await view('/p/wide', await login());
    const rows = v.page.sections[0].blocks[1].items;
    expect(rows.map((r: { text: string; agent?: string }) => [r.text, r.agent])).toEqual([['Closed a task', 'art'], ['Rendered props', 'mark'], ["Nobody's", 'nobody']]);
    expect(v.ctx.agents.art).toMatchObject({ label: 'Art E Fish', bg: '#B8A6FF', fg: '#1D1240' });
    expect(v.ctx.agents.mark).toMatchObject({ label: 'Visual Mark', bg: '#7A2E4F', fg: '#FFE3EE' });
    expect(v.ctx.agents.nobody).toBeUndefined();
  });
});
