import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCoreSource } from '../collections/core-types.js';
import { Puller } from '../collections/pull.js';
import type { pullDomain } from '../collections/pull.js';
import { clearPieceCache, refreshPieceManifests } from '../ui/pieces.js';
import { watchStalls, type StallWatch } from './stall-watch.js';

vi.mock('../ui/piece-socket.js', () => ({
  socketManifest: async () => {
    await new Promise((r) => setTimeout(r, 30));
    return { ok: true, get stdout() {
      const end = performance.now() + 220;
      while (performance.now() < end) { /* parsing a slow service response, after await */ }
      return JSON.stringify({ v: 2, tile: { label: 'Gizmo', value: 'test' } });
    } };
  },
}));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let w: StallWatch | undefined;
let home: string | undefined;
afterEach(() => { w?.stop(); clearPieceCache(); if (home) rmSync(home, { recursive: true, force: true }); });

it('names a real collection refresh after its core provider awaited I/O', async () => {
  const lines: string[] = [];
  home = mkdtempSync(join(tmpdir(), 'loom-pull-attribution-'));
  const dir = home;
  registerCoreSource(dir, 'attention', async () => {
    await wait(30);
    const end = performance.now() + 220;
    while (performance.now() < end) { /* the source's slow continuation */ }
    return [];
  });
  w = watchStalls({ thresholdMs: 100, tickMs: 20, log: (l) => lines.push(l) });
  const puller = new Puller(() => ({ household: { home: dir }, env: { LOOM_HOME: dir, PATH: '' } } as Parameters<typeof pullDomain>[0]), () => new Set());
  await puller.now('loom/attention');
  await wait(60);
  expect(lines.find((l) => l.startsWith('loom: event loop stalled'))).toMatch(/slowest: collection refresh loom\/attention 2\d\d ms/);
});

it('names an installed piece manifest continuation instead of its outer round', async () => {
  const lines: string[] = [];
  home = mkdtempSync(join(tmpdir(), 'loom-piece-attribution-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const path = join(bin, 'loom-gizmo');
  writeFileSync(path, '#!/bin/sh\nexit 1\n');
  chmodSync(path, 0o755);
  w = watchStalls({ thresholdMs: 100, tickMs: 20, log: (l) => lines.push(l) });
  await refreshPieceManifests({ LOOM_HOME: home, PATH: bin });
  await wait(60);
  expect(lines.find((l) => l.startsWith('loom: event loop stalled'))).toMatch(/slowest: piece manifest gizmo 2\d\d ms/);
});
