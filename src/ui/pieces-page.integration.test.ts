/**
 * The Pieces page (docs/specs/pieces-install.md): installing from loom's
 * catalog and from GitHub, setting up, rolling back and removing, all from
 * loom's own page, behind its sign-in and form token.
 *
 * npm is a stand-in first on PATH; the catalog is loom's own (assets/pieces.json),
 * and the stand-in installs a fixture for its first entry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { remember } from '../tools/remember.js';
import { readCatalog } from '../cli/pieces-managed.js';
import { clearPieceCache } from './pieces.js';
import { settled } from './pieces-page.js';

const TOKEN = 'pieces-page-token';

const FAKE_NPM = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
const m = /^github:([^#]+)#(.+)$/.exec(args[args.length - 1]);
const fixture = path.join(process.env.FAKE_NPM_FIXTURES, m[1].replace('/', '__') + '@' + m[2]);
if (!fs.existsSync(fixture)) { console.error('npm error 404'); process.exit(1); }
const pkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf-8'));
const dir = path.join(prefix, 'node_modules', pkg.name);
fs.mkdirSync(dir, { recursive: true });
fs.cpSync(fixture, dir, { recursive: true });
fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ dependencies: { [pkg.name]: 'x' } }));
fs.mkdirSync(path.join(prefix, 'node_modules', '.bin'), { recursive: true });
for (const [b, rel] of Object.entries(pkg.bin)) {
  fs.chmodSync(path.join(dir, rel), 0o755);
  fs.symlinkSync(path.join('..', pkg.name, rel), path.join(prefix, 'node_modules', '.bin', b));
}
`;

describe('the Pieces page', () => {
  let tmp: string;
  let handle: HttpServeHandle;
  let base: string;
  const saved: Record<string, string | undefined> = {};
  const box = readCatalog()[0];

  async function fixture(repo: string, commit: string, pkg: Record<string, unknown>, bins: Record<string, string>) {
    const dir = join(tmp, 'fixtures', `${repo.replace('/', '__')}@${commit}`);
    await mkdir(join(dir, 'bin'), { recursive: true });
    const bin: Record<string, string> = {};
    for (const [n, body] of Object.entries(bins)) {
      await writeFile(join(dir, 'bin', n), `#!/bin/sh\n${body}\n`);
      bin[n] = `bin/${n}`;
    }
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0', ...pkg, bin }));
  }

  beforeEach(async () => {
    clearPieceCache();
    tmp = await mkdtemp(join(tmpdir(), 'loom-pieces-page-'));
    const stack = join(tmp, 'stack');
    await mkdir(join(tmp, 'npmbin'), { recursive: true });
    await mkdir(join(tmp, 'path'), { recursive: true });
    await mkdir(stack);
    await writeFile(join(stack, 'IDENTITY.md'), '# Test Agent\n\nCreed.');
    await remember(stack, { category: 'project', title: 'a memory', content: 'body' });
    await writeFile(join(tmp, 'npmbin', 'npm'), FAKE_NPM);
    await chmod(join(tmp, 'npmbin', 'npm'), 0o755);
    // The page's tab for the box: a manifest, so it shows in the nav once installed.
    const manifest = JSON.stringify({ v: 2, tab: { label: 'Boxes' } });
    await fixture(box.repo, box.commit, {
      name: 'loom-box',
      loom: { label: 'Boxes', settings: [{ name: 'LOOM_BOX_PUBLIC_URL', label: 'The URL a box joins', required: true }] },
    }, { 'loom-box': `case "$1 $2" in "ui --json") echo '${manifest}' ;; *) echo "url=$LOOM_BOX_PUBLIC_URL" ;; esac` });
    await writeFile(join(tmp, 'path', 'loom-handmade'), '#!/bin/sh\nexit 0\n');
    await chmod(join(tmp, 'path', 'loom-handmade'), 0o755);
    // XDG_CONFIG_HOME too: services are systemd units under it, and a test must never see this machine's.
    for (const k of ['PATH', 'LOOM_HOME', 'FAKE_NPM_FIXTURES', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.PATH = [join(tmp, 'npmbin'), join(tmp, 'path'), '/usr/bin', '/bin'].join(delimiter);
    process.env.LOOM_HOME = join(tmp, 'loom-home');
    process.env.FAKE_NPM_FIXTURES = join(tmp, 'fixtures');
    process.env.XDG_CONFIG_HOME = join(tmp, 'xdg');
    handle = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0, token: TOKEN });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await settled();
    await handle.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const res = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(TOKEN)}`, redirect: 'manual',
    });
    return (res.headers.get('set-cookie') ?? '').split(';')[0];
  }
  const page = async (path: string, cookie: string) => (await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' })).text();
  const csrfOf = (html: string) => /name="_csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? '';
  async function act(cookie: string, csrf: string, action: string, fields: Record<string, string>) {
    const res = await fetch(`${base}/act/loom`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, _action: action, _path: 'pieces', ...fields }).toString(), redirect: 'manual',
    });
    return { status: res.status, location: res.headers.get('location') ?? '' };
  }

  it('installs from the catalog in the background, asks for setup on Home, and takes settings, rollback-free removal', async () => {
    const cookie = await login();
    let html = await page('/pieces', cookie);
    expect(html).toContain('href="/pieces"');
    // The catalog: a row a piece, Install at its right.
    expect(html).toMatch(new RegExp(`<span class="text">${box.label}<\\/span>[\\s\\S]*?<button class="row-act" type="submit">Install<\\/button>`));
    expect(html).toContain('loom-handmade');
    // Pieces loom didn't install get their own section, beside the ones it manages.
    expect(html).toMatch(/Managed by hand · 1[\s\S]*?<span class="text">handmade<\/span><span class="meta">[^<]*loom-handmade<\/span>/);
    expect(html).toContain('<h2>Installed</h2>');
    const csrf = csrfOf(html);

    const started = await act(cookie, csrf, 'piece-install', { name: box.name });
    expect(started.status).toBe(303);
    expect(started.location).toMatch(/^\/pieces\?_flash=/);
    await settled();
    html = await page('/pieces', cookie);
    expect(html).toContain('Install Boxes');
    expect(html).toContain('done');
    expect(html).toContain('needs setup');
    // Its tab is in the nav, and Home asks for the setting it lacks.
    expect(html).toContain('href="/p/box"');
    const home = await page('/', cookie);
    expect(home).toContain('Finish setting up Boxes');
    expect(home).toContain('needs LOOM_BOX_PUBLIC_URL');

    expect((await act(cookie, csrf, 'piece-set', { name: 'box', s_loom_box_public_url: 'https://loom.example' })).status).toBe(303);
    expect(await page('/', cookie)).not.toContain('Finish setting up Boxes');
    expect(await page('/pieces', cookie)).toContain('value="https://loom.example"');

    await act(cookie, csrf, 'piece-remove', { name: 'box' });
    expect(existsSync(join(tmp, 'loom-home', 'pieces', 'bin', 'loom-box'))).toBe(false);
    expect(await page('/pieces', cookie)).toContain(`Install ${box.label}`);
  });

  it('from GitHub: a preview with the warning first, and only an install that carries the confirmation', async () => {
    const commit = 'a'.repeat(40);
    await fixture('someone/thing', commit, { name: 'thing' }, { 'loom-thing': 'exit 0' });
    const cookie = await login();
    const csrf = csrfOf(await page('/pieces', cookie));
    const preview = await act(cookie, csrf, 'piece-preview', { repo: 'https://github.com/someone/thing', commit });
    expect(preview.location).toContain('repo=someone%2Fthing');
    const html = await page(preview.location.replace(/&?_flash=[^&]*/, ''), cookie);
    expect(html).toContain("isn&#39;t in loom&#39;s catalog");
    expect(html).toContain('installing it is running it');
    expect(html).toContain('Install anyway');
    // Without the page's confirmation nothing installs.
    await act(cookie, csrf, 'piece-install', { repo: 'someone/thing', commit });
    await settled();
    expect(existsSync(join(tmp, 'loom-home', 'pieces', 'thing'))).toBe(false);
    await act(cookie, csrf, 'piece-install', { repo: 'someone/thing', commit, confirm: 'yes' });
    await settled();
    expect(existsSync(join(tmp, 'loom-home', 'pieces', 'bin', 'loom-thing'))).toBe(true);
    // A branch is refused on the page too.
    const bad = await page(`/pieces?repo=someone%2Fthing&commit=main`, cookie);
    expect(bad).toContain('full 40-character commit');
    expect(bad).not.toContain('Install anyway');
  });

  it('needs the sign-in and the form token, like every action', async () => {
    const res = await fetch(`${base}/act/loom`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _action: 'piece-install', name: box.name }).toString(), redirect: 'manual',
    });
    expect(res.status).toBe(401);
    const cookie = await login();
    expect((await act(cookie, '0'.repeat(64), 'piece-install', { name: box.name })).status).toBe(403);
    expect(existsSync(join(tmp, 'loom-home', 'pieces', 'box'))).toBe(false);
  });
});
