import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPieceCache, pieceManifests } from './pieces.js';

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
