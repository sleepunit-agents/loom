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
  const get = async (path: string, cookie: string) => (await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' })).text();

  it('pieces are the household\'s on loom\'s pages; an old scope link or cookie changes nothing', async () => {
    const owner = await login();
    // Household: no scope, no line.
    expect(await get('/p/narrow', owner)).toContain('scope=</span>');
    expect(await get('/p/wide', owner)).not.toContain('class="unscoped"');
    // A piece's page says how fresh it is under its title (the script counts it up); loom's own pages don't.
    expect(await get('/p/wide', owner)).toContain('<p class="stamp" data-stamp>updated just now</p>');
    expect(await get('/people', owner)).not.toContain('data-stamp>');
    // There's no scope to pick any more (t-1625): an old link goes to the agent's own pages and clears the old cookie,
    // and a piece's page is the household's whatever cookie a browser still sends.
    const pick = await fetch(`${base}/scope/mark`, { headers: { cookie: owner }, redirect: 'manual' });
    expect(pick.headers.get('location')).toBe('/a/mark');
    expect(pick.headers.get('set-cookie')).toMatch(/^loom_scope=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
    const old = `${owner}; loom_scope=mark`;
    expect(await get('/p/narrow', old)).toContain('scope=</span>');
    expect(await get('/p/wide', old)).not.toContain('class="unscoped"');
    expect(await get('/places', old)).toContain('<span class="pl-stat">scope=</span>');
  });

  it('a list row naming an agent carries its mark; an unknown agent gets none', async () => {
    const html = await get('/p/wide', await login());
    expect(html).toMatch(/<li class=""><span class="mark"[^>]*background:#B8A6FF;color:#1D1240[^>]*>A<\/span><span class="body"><span class="text">Closed a task/);
    expect(html).toMatch(/<span class="mark"[^>]*background:#7A2E4F;color:#FFE3EE[^>]*>V<\/span><span class="body"><span class="text">Rendered props/);
    expect(html).toMatch(/<li class=""><span class="body"><span class="text">Nobody&#39;s/);
  });
});
