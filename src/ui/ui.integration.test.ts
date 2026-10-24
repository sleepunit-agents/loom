import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { remember } from '../tools/remember.js';
import { propose } from '../backends/proposals.js';
import { parseSections } from './sections.js';
import { clearPieceCache } from './piece-sections.js';
import { esc } from './render.js';

const TOKEN = 'ui-test-token';

async function piece(dir: string, name: string, body: string) {
  const path = join(dir, `loom-${name}`);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

const goodAnswer = JSON.stringify({
  sections: [{ id: 'bridges', title: 'Bridges', blocks: [{ type: 'stats', items: [{ label: 'up', value: 2, tone: 'ok' }] }] }],
});

describe('parseSections (the vocabulary pieces send)', () => {
  it('accepts every block type', () => {
    const r = parseSections({ sections: [{ id: 's', title: 'S', blocks: [
      { type: 'stats', items: [{ label: 'a', value: '1' }] },
      { type: 'list', items: [{ text: 't', meta: 'm', tone: 'warn' }] },
      { type: 'table', columns: ['a', 'b'], rows: [['1', '2']] },
      { type: 'text', text: 'hello' },
      { type: 'link', text: 'docs', href: 'https://example.com/x' },
    ] }] });
    expect(typeof r).not.toBe('string');
  });

  it.each([
    [{ sections: [{ id: 's', title: 'S', blocks: [{ type: 'link', text: 'x', href: 'javascript:alert(1)' }] }] }, /http\(s\)/],
    [{ sections: [{ id: 's', title: 'S', blocks: [{ type: 'link', text: 'x', href: '/relative' }] }] }, /absolute/],
    [{ sections: [{ id: 's', title: 'S', blocks: [{ type: 'html', html: '<b>' }] }] }, /unknown block type/],
    [{ sections: [{ id: 'Bad Id', title: 'S', blocks: [] }] }, /section.id/],
    [{ sections: [{ id: 's', title: 'S', blocks: [{ type: 'text', text: 'x'.repeat(2001) }] }] }, /longer than/],
    [{ sections: [{ id: 's', title: 'S', blocks: [{ type: 'list', items: [{ text: 't', tone: 'red' }] }] }] }, /tone/],
    [{ sections: [{ id: 's', title: 'S', blocks: [{ type: 'table', columns: ['a'], rows: [['1', '2']] }] }] }, /table row/],
    [{ nope: true }, /sections must be an array/],
  ])('refuses %j', (v, why) => {
    const r = parseSections(v);
    expect(typeof r).toBe('string');
    expect(r).toMatch(why);
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

  it('logged in: the page shows the agent, the tape and top of mind, under a no-script CSP', async () => {
    const cookie = await login();
    const res = await fetch(`${base}/ui`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const html = await res.text();
    expect(html).toContain('Test Agent');
    expect(html).toContain('shipped the ui');
    expect(html).toContain('terminal');
    expect(html).toContain('a hot memory');
    expect(html).not.toContain('<script');
  });

  it('the UI cookie is not a bearer: /cli still refuses it', async () => {
    const cookie = await login();
    const value = cookie.split('=')[1];
    const res = await fetch(`${base}/cli`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${value}` }, body: JSON.stringify({ argv: ['recall', 'x'] }),
    });
    expect(res.status).toBe(401);
  });

  it('a pending proposal shows up as waiting', async () => {
    propose(stack, { category: 'feedback', title: 'please ratify me', content: 'c', source: 'test' });
    const cookie = await login();
    const html = await (await fetch(`${base}/ui`, { headers: { cookie } })).text();
    expect(html).toContain('Proposals waiting');
    expect(html).toContain('please ratify me');
  });

  it('an installed piece with a ui shows up, with no configuration', async () => {
    await piece(bin, 'shuttle', `[ "$1 $2" = "ui --json" ] && echo '${goodAnswer}'`);
    const res = await fetch(`${base}/ui/sections.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { pieces: Array<{ piece: string; sections: Array<{ id: string }> }> };
    expect(body.pieces).toEqual([{ piece: 'shuttle', sections: [expect.objectContaining({ id: 'bridges' })] }]);
    const cookie = await login();
    const html = await (await fetch(`${base}/ui`, { headers: { cookie } })).text();
    expect(html).toContain('href="#g-shuttle"');
    expect(html).toContain('Bridges');
  });

  it('pieces without a ui, with garbage, or too slow are left out, and the page still renders', async () => {
    await piece(bin, 'noui', 'exit 2');
    await piece(bin, 'garbage', 'echo "{not json"');
    await piece(bin, 'slow', `sleep 10; echo '${goodAnswer}'`);
    const t0 = Date.now();
    const body = await (await fetch(`${base}/ui/sections.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
      pieces: unknown[]; skipped: Array<{ piece: string; reason: string }>;
    };
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(body.pieces).toEqual([]);
    expect(Object.fromEntries(body.skipped.map((s) => [s.piece, s.reason]))).toEqual({
      garbage: 'invalid: not JSON',
      noui: 'no ui',
      slow: 'timed out',
    });
  }, 15000);

  it('a piece can\'t inject markup: its strings are escaped', async () => {
    const evil = JSON.stringify({ sections: [{ id: 'x', title: '<img src=x onerror=alert(1)>', blocks: [{ type: 'text', text: '</p><script>alert(1)</script>' }] }] });
    await piece(bin, 'evil', `echo '${evil}'`);
    const cookie = await login();
    const html = await (await fetch(`${base}/ui`, { headers: { cookie } })).text();
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('logout clears the cookie, and only on POST (no cross-site GET logout)', async () => {
    expect((await fetch(`${base}/ui/logout`, { redirect: 'manual' })).status).toBe(405);
    const res = await fetch(`${base}/ui/logout`, { method: 'POST', redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('a tampered or forged cookie is refused', async () => {
    const cookie = await login();
    const [name, value] = cookie.split('=');
    const [iat, mac] = value.split('.');
    for (const bad of [`${Number(iat) - 1}.${mac}`, `${iat}.${'0'.repeat(64)}`, 'garbage', `${iat}`]) {
      const res = await fetch(`${base}/ui/sections.json`, { headers: { cookie: `${name}=${bad}` } });
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
    await piece(bin, 'counted', `echo x >> '${count}'; echo '${goodAnswer}'`);
    await Promise.all(Array.from({ length: 10 }, () =>
      fetch(`${base}/ui/sections.json`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.text())));
    expect((await readFile(count, 'utf-8')).trim().split('\n')).toHaveLength(1);
  });

  it('a piece that leaves a helper holding stdout still answers in time', async () => {
    await piece(bin, 'helper', `(sleep 20 &); echo '${goodAnswer}'`);
    const t0 = Date.now();
    const body = await (await fetch(`${base}/ui/sections.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
      pieces: Array<{ piece: string }>;
    };
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(body.pieces.map((p) => p.piece)).toEqual(['helper']);
  });

  it('a timeout kills the piece\'s whole process group', async () => {
    const pidFile = join(bin, 'child.pid');
    await piece(bin, 'hangs', `sleep 30 & echo $! > '${pidFile}'; wait`);
    await fetch(`${base}/ui/sections.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const pid = Number((await readFile(pidFile, 'utf-8')).trim());
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10000);

  it('pieces never see loom\'s bearer token; a piece named loom is ignored', async () => {
    const seen = join(bin, 'seen');
    await piece(bin, 'peek', `printf '%s' "$LOOM_BEARER_TOKEN" > '${seen}'; echo '${goodAnswer}'`);
    await piece(bin, 'loom', `echo '${goodAnswer}'`);
    process.env.LOOM_BEARER_TOKEN = TOKEN;
    try {
      const body = await (await fetch(`${base}/ui/sections.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as {
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
      expect((await fetch(`${base}/ui`, { headers: { cookie } })).status).toBe(200);
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
      for (const path of ['/ui', '/ui/sections.json', '/ui/login']) {
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
