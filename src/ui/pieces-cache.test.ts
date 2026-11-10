import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_MS, PAGE_LIVE_MS, PAGE_STALE_MS, PIECE_TIMEOUT_MS, ROUND_MS, STALE_MAX_MS, clearPieceCache, forgetPiecePages, pieceAct, pieceManifests, piecePage, refreshPieceManifests, expirePieceManifests } from './pieces.js';

// t-1584: 'loom pieces install' points pieces/bin/loom-<name> at a new version; Home showed the old one's
// answer until the 45s cache ran out (or a restart). The cache keys on where the path resolves now.
describe('the manifest cache', () => {
  const dirs: string[] = [];
  afterEach(() => { clearPieceCache(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('an in-flight live refresh cannot restore an observation invalidated by the producer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loom-refresh-race-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(root, 'value'), 'old');
    writeFileSync(join(bin, 'loom-gizmo'), `#!${process.execPath}
const fs = require('node:fs');
const root = ${JSON.stringify(root)};
const value = fs.readFileSync(root + '/value', 'utf8');
fs.writeFileSync(root + '/started', 'yes');
const timer = setInterval(() => {
  if (!fs.existsSync(root + '/release')) return;
  clearInterval(timer);
  console.log(JSON.stringify({v:2,tile:{label:'Gizmo',value}}));
}, 10);
`);
    chmodSync(join(bin, 'loom-gizmo'), 0o755);
    const env = { PATH: `${bin}:/usr/bin:/bin`, LOOM_HOME: join(root, 'home') };
    const pending = refreshPieceManifests(env);
    await expect.poll(() => existsSync(join(root, 'started'))).toBe(true);
    expirePieceManifests();
    writeFileSync(join(root, 'value'), 'new');
    writeFileSync(join(root, 'release'), 'yes');
    await pending;
    const value = (await pieceManifests(env)).pieces.find(p => p.piece === 'gizmo')?.manifest.tile?.value;
    expect(value).toBe('new');
  });

  it('one piece\'s word that it moved asks it again, and no other (t-2065)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loom-only-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const name of ['runtime', 'tasks']) {
      writeFileSync(join(bin, `loom-${name}`), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(root, 'asked'))}, ${JSON.stringify(name)} + '\\n');
console.log(JSON.stringify({v:2,tile:{label:${JSON.stringify(name)},value:'x'}}));
`);
      chmodSync(join(bin, `loom-${name}`), 0o755);
    }
    const env = { PATH: `${bin}:/usr/bin:/bin`, LOOM_HOME: join(root, 'home') };
    const asked = () => (existsSync(join(root, 'asked')) ? readFileSync(join(root, 'asked'), 'utf8').trim().split('\n') : []);
    await pieceManifests(env);
    expect(asked().sort()).toEqual(['runtime', 'tasks']);
    expirePieceManifests(join(bin, 'loom-runtime'));
    await refreshPieceManifests(env, new Set([join(bin, 'loom-runtime')]));
    await pieceManifests(env);
    expect(asked().sort()).toEqual(['runtime', 'runtime', 'tasks']);
  });

  /** Pieces in `bin` under root, each logging its name and LOOM_SCOPE to `ran` when run, then answering `body`. */
  function piecesIn(bodies: Record<string, string>, opts: { slow?: string } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'loom-runs-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const [name, body] of Object.entries(bodies)) {
      writeFileSync(join(bin, `loom-${name}`), `#!/bin/sh\necho "${name} \${LOOM_SCOPE:-household}" >> ${join(root, 'ran')}\n`
        + `[ -f ${join(root, 'slow')} ] && sleep $(cat ${join(root, 'slow')})\necho '{"v":2,"asks":[],${body},"tile":{"label":"${name}","value":"'"$(cat ${join(root, 'value')} 2>/dev/null)"'"}}'\n`);
      chmodSync(join(bin, `loom-${name}`), 0o755);
    }
    if (opts.slow) writeFileSync(join(root, 'slow'), opts.slow);
    const env = { PATH: `${bin}:/usr/bin:/bin`, LOOM_HOME: join(root, 'home') };
    const ran = () => (existsSync(join(root, 'ran')) ? readFileSync(join(root, 'ran'), 'utf8').trim().split('\n') : []);
    return { root, bin, env, ran };
  }

  // t-2110: the runtime's manifest (owners: 2, no scope) ran once per open agent window, every round and every word.
  it('a piece that reads no scope runs once for every agent window; one that reads LOOM_SCOPE, once per agent', async () => {
    const { env, ran } = piecesIn({ runtime: '"owners":2,"tab":{"label":"Boxes"}', clock: '"scope":true,"tab":{"label":"Clock"}' });
    await pieceManifests(env);                                     // learns what each reads
    for (const agent of ['art', 'mark', 'gabe']) await refreshPieceManifests({ ...env, LOOM_SCOPE: agent });
    for (const agent of ['art', 'mark', 'gabe']) await pieceManifests({ ...env, LOOM_SCOPE: agent });
    expect(ran().filter((l) => l.startsWith('runtime'))).toEqual(['runtime household']);
    expect(ran().filter((l) => l.startsWith('clock')).sort()).toEqual(['clock art', 'clock gabe', 'clock household', 'clock mark']);
    // An agent owner's view stays its own for a piece that understands owners.
    await pieceManifests({ ...env, LOOM_OWNER_SCOPE: 'mark' });
    expect(ran().filter((l) => l.startsWith('runtime'))).toHaveLength(2);
  });

  it('a piece edited in place to read the owner scope never shares one owner\'s answer with another', async () => {
    const { root, env } = piecesIn({});
    writeFileSync(join(root, 'bin', 'loom-gizmo'), `#!/bin/sh\nif [ -f ${join(root, 'owners')} ]; then o=',"owners":2'; fi\n`
      + `echo '{"v":2,"asks":[],"tab":{"label":"Gizmo"}'"$o"',"tile":{"label":"Gizmo","value":"'"\${LOOM_OWNER_SCOPE:-all}"'"}}'\n`);
    chmodSync(join(root, 'bin', 'loom-gizmo'), 0o755);
    const value = async (owner?: string) => (await pieceManifests(owner ? { ...env, LOOM_OWNER_SCOPE: owner } : env)).pieces
      .find((p) => p.piece === 'gizmo')?.manifest.tile?.value;
    expect(await value()).toBe('all');                             // learned: reads no owner scope
    writeFileSync(join(root, 'owners'), '');                       // now it does, same file, same version
    expirePieceManifests();
    await value('mark');                                           // mark's run, under the shared key
    expect(await value('gabe')).not.toBe('mark');
    expect(await value('gabe')).toBe('gabe');
  });

  it('the round asks a piece that keeps answering the same less often, and at once again when its records move', async () => {
    const { bin, env, ran } = piecesIn({ tasks: '"tab":{"label":"Tasks"}' });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const runs = () => ran().length;
      await refreshPieceManifests(env);
      await refreshPieceManifests(env);                            // the same moment: the one run is shared
      expect(runs()).toBe(1);
      const round = async () => { vi.setSystemTime(Date.now() + ROUND_MS); await refreshPieceManifests(env); return runs(); };
      expect(await round()).toBe(2);                               // moved since its first look? asked
      expect(await round()).toBe(2);                               // the same once: it waits a round
      expect(await round()).toBe(3);
      expect(await round()).toBe(3);                               // the same twice: up to a minute
      expect(await round()).toBe(3);
      expect(await round()).toBe(3);
      expect(await round()).toBe(4);
      forgetPiecePages(join(bin, 'loom-tasks'));                  // its records moved: the next round asks it
      expect(await round()).toBe(5);
      expirePieceManifests(join(bin, 'loom-tasks'));              // its word: asked whatever the wait
      await refreshPieceManifests(env);
      expect(runs()).toBe(6);
    } finally { vi.useRealTimers(); }
  });

  // t-2064: under load the runtime's manifest took 3.3-10.7 s; at 3 s it timed out and dropped off the page.
  it('a piece said to have moved that runs past a page\'s wait still shows its last answer, and the late one is kept', async () => {
    const { root, bin, env } = piecesIn({ runtime: '"owners":2,"tab":{"label":"Boxes"}' });
    writeFileSync(join(root, 'value'), 'old');
    const value = async () => (await pieceManifests(env)).pieces.find((p) => p.piece === 'runtime')?.manifest.tile?.value;
    expect(await value()).toBe('old');
    writeFileSync(join(root, 'value'), 'new');
    writeFileSync(join(root, 'slow'), String((PIECE_TIMEOUT_MS + 1000) / 1000));
    expirePieceManifests(join(bin, 'loom-runtime'));
    const t = Date.now();
    expect(await value()).toBe('old');                             // not dropped: the last answer, after the page's wait
    expect(Date.now() - t).toBeLessThan(PIECE_TIMEOUT_MS + 800);
    await new Promise((r) => setTimeout(r, 1500));                 // the run outlived the wait, and landed
    expect(await value()).toBe('new');
  }, PIECE_TIMEOUT_MS + 8000);

  it('answers anew as soon as a piece points at a new version', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loom-cache-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const v of ['v1', 'v2']) {
      mkdirSync(join(root, v));
      writeFileSync(join(root, v, 'loom-gizmo'), `#!/bin/sh\necho '{"v":2,"tab":{"label":"Gizmo"},"tile":{"label":"Gizmo","value":"${v}"}}'\n`);
      chmodSync(join(root, v, 'loom-gizmo'), 0o755);
    }
    symlinkSync(join(root, 'v1', 'loom-gizmo'), join(bin, 'loom-gizmo'));
    const env = { PATH: `${bin}:/usr/bin:/bin`, LOOM_HOME: join(root, 'home') };
    const value = async () => (await pieceManifests(env)).pieces.find((p) => p.piece === 'gizmo')?.manifest.tile?.value;
    expect(await value()).toBe('v1');
    unlinkSync(join(bin, 'loom-gizmo'));
    symlinkSync(join(root, 'v2', 'loom-gizmo'), join(bin, 'loom-gizmo'));
    expect(await value()).toBe('v2');
  });

  it('past its window, a page gets the last answer at once while a fresh one runs behind it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loom-swr-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(root, 'value'), 'one');
    writeFileSync(join(bin, 'loom-gizmo'), `#!/bin/sh\nsleep 0.3\necho "{\\"v\\":2,\\"tile\\":{\\"label\\":\\"Gizmo\\",\\"value\\":\\"$(cat '${join(root, 'value')}')\\"}}"\n`);
    chmodSync(join(bin, 'loom-gizmo'), 0o755);
    const env = { PATH: `${bin}:/usr/bin:/bin`, LOOM_HOME: join(root, 'home') };
    const at = async (ms: number) => { const t = Date.now(); const v = (await pieceManifests(env, ms)).pieces.find((p) => p.piece === 'gizmo')?.manifest.tile?.value; return { v, took: Date.now() - t }; };
    const t0 = Date.now();
    expect((await at(t0)).v).toBe('one');                         // the first answer waits for the piece
    writeFileSync(join(root, 'value'), 'two');
    const stale = await at(t0 + CACHE_MS + 1);                    // expired: the last answer, without waiting
    expect(stale.v).toBe('one');
    expect(stale.took).toBeLessThan(150);
    await new Promise((r) => setTimeout(r, 900));                 // the refresh behind it lands
    expect((await at(t0 + CACHE_MS + 2)).v).toBe('two');
    writeFileSync(join(root, 'value'), 'three');
    expect((await at(Date.now() + STALE_MAX_MS + 1)).v).toBe('three');   // too old: waits for a fresh one
  });

  it('a piece\'s page is kept briefly: the same page again is the last copy, and an action on the piece drops it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loom-pages-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(root, 'n'), '1');
    // `ui page` answers the counter's value as its title; `ui act` bumps it.
    writeFileSync(join(bin, 'loom-gizmo'), `#!/bin/sh\nN=$(cat '${join(root, 'n')}')\ncase "$2" in\n page) echo "{\\"title\\":\\"n$N\\",\\"sections\\":[]}" ;;\n act) echo $((N+1)) > '${join(root, 'n')}'; echo '{"ok":true,"message":"ok"}' ;;\n *) echo '{"v":2,"tab":{"label":"Gizmo"}}' ;;\nesac\n`);
    chmodSync(join(bin, 'loom-gizmo'), 0o755);
    const env = { PATH: `${bin}:/usr/bin:/bin`, LOOM_HOME: join(root, 'home') };
    const info = (await pieceManifests(env)).pieces.find((p) => p.piece === 'gizmo')!;
    const title = async () => ((await piecePage(info, '', {}, env)) as { title: string }).title;
    expect(await title()).toBe('n1');
    writeFileSync(join(root, 'n'), '5');            // changed behind loom's back: within the window, the kept copy
    expect(await title()).toBe('n1');
    await pieceAct(info, { action: 'bump', path: '', fields: {} }, env);
    expect(await title()).toBe('n6');               // an action drops the piece's pages: the next look is fresh
  });

  // Jonathan, 2026-11-02: a sign-in page that reloads every 2 seconds while the box checks the code kept showing
  // "checking" for a stale copy's worth of reloads after the box said it worked.
  it('a page that asked to refresh is never shown stale: past a second, the next look asks the piece', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loom-livepage-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(root, 'n'), 'checking');
    writeFileSync(join(bin, 'loom-gizmo'), `#!/bin/sh\nN=$(cat '${join(root, 'n')}')\ncase "$2" in\n page) if [ "$N" = checking ]; then echo '{"title":"checking","refresh":2,"sections":[]}'; else echo "{\\"title\\":\\"$N\\",\\"sections\\":[]}"; fi ;;\n *) echo '{"v":2,"tab":{"label":"Gizmo"}}' ;;\nesac\n`);
    chmodSync(join(bin, 'loom-gizmo'), 0o755);
    const env = { PATH: `${bin}:/usr/bin:/bin`, LOOM_HOME: join(root, 'home') };
    const info = (await pieceManifests(env)).pieces.find((p) => p.piece === 'gizmo')!;
    const title = async (at: number) => ((await piecePage(info, '', {}, env, undefined, at)) as { title: string }).title;
    const t0 = Date.now();
    expect(await title(t0)).toBe('checking');
    writeFileSync(join(root, 'n'), 'logged-in');
    expect(await title(t0 + 10)).toBe('checking');                   // within a second: the same run, for every tab
    expect(await title(t0 + PAGE_LIVE_MS + 1)).toBe('logged-in');    // past it: the piece's state now, not a stale copy
    // Settled (no refresh any more): kept as any page is, stale while it revalidates.
    writeFileSync(join(root, 'n'), 'later');
    expect(await title(t0 + PAGE_LIVE_MS + 2000)).toBe('logged-in');
  });

  // Jonathan, 2026-10-29: "machine couldn't show this page, timed out, when it didn't wait very long".
  it('a page you opened waits past a manifest\'s limit, and a piece that fails later shows the last page it drew', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loom-slowpage-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(root, 'mode'), 'slow');
    // `ui page`: slower than a manifest may take, or broken; the manifest answers at once.
    writeFileSync(join(bin, 'loom-gizmo'), `#!/bin/sh\ncase "$2" in\n page) case "$(cat '${join(root, 'mode')}')" in slow) sleep ${(PIECE_TIMEOUT_MS + 700) / 1000}; echo '{"title":"Machine","sections":[]}' ;; *) exit 1 ;; esac ;;\n *) echo '{"v":2,"tab":{"label":"Gizmo"}}' ;;\nesac\n`);
    chmodSync(join(bin, 'loom-gizmo'), 0o755);
    const env = { PATH: `${bin}:/usr/bin:/bin`, LOOM_HOME: join(root, 'home') };
    const info = (await pieceManifests(env)).pieces.find((p) => p.piece === 'gizmo')!;
    expect(await piecePage(info, '', {}, env)).toMatchObject({ title: 'Machine' });
    writeFileSync(join(root, 'mode'), 'broken');
    // Past the window it asks again; the piece fails; the last page beats "couldn't show this page".
    expect(await piecePage(info, '', {}, env, undefined, Date.now() + PAGE_STALE_MS + 1)).toMatchObject({ title: 'Machine' });
  }, PIECE_TIMEOUT_MS + 8000);

  it('a piece with only answered items (no tab, tile or asks) still counts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loom-cache-'));
    dirs.push(root);
    writeFileSync(join(root, 'loom-gate'), `#!/bin/sh\necho '{"v":2,"answered":[{"text":"x","outcome":"Denied.","at":"2026-10-27T20:00:00Z"}]}'\n`);
    chmodSync(join(root, 'loom-gate'), 0o755);
    const r = await pieceManifests({ PATH: `${root}:/usr/bin:/bin`, LOOM_HOME: join(root, 'home') });
    expect(r.pieces.map((p) => p.piece)).toContain('gate');
    expect(r.skipped.map((p) => p.piece)).not.toContain('gate');
  });
});
