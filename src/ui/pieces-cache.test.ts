import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_MS, STALE_MAX_MS, clearPieceCache, pieceAct, pieceManifests, piecePage } from './pieces.js';

// t-1584: 'loom pieces install' points pieces/bin/loom-<name> at a new version; Home showed the old one's
// answer until the 45s cache ran out (or a restart). The cache keys on where the path resolves now.
describe('the manifest cache', () => {
  const dirs: string[] = [];
  afterEach(() => { clearPieceCache(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

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
