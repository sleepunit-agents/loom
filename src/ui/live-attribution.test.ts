import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeSession, onChanged, openStream, piecesMoved } from './live.js';
import { watchStalls } from '../transport/stall-watch.js';

vi.mock('./pieces.js', () => {
  let round = 0;
  return { ROUND_MS: 15_000, clearPiecePages: vi.fn(), expirePieceManifests: vi.fn(), refreshPieceManifests: async () => {
    await new Promise((r) => setTimeout(r, 30));
    return new Map([['/test/loom-gizmo', String(++round)]]);
  } };
});

it('names an actual live tick continuation after it awaited manifest refresh', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-live-attribution-'));
  const lines: string[] = [];
  const w = watchStalls({ thresholdMs: 100, tickMs: 20, log: (l) => lines.push(l) });
  const res = new EventEmitter() as EventEmitter & { writeHead: () => void; write: () => boolean; end: () => void };
  res.writeHead = () => undefined; res.write = () => true; res.end = () => { res.emit('close'); };
  try {
    openStream(res as unknown as ServerResponse, {}, home, {}, { sees: '*', session: 'attribution', place: () => '*' });
    await new Promise((r) => setTimeout(r, 80));
    onChanged(home, () => { const end = performance.now() + 220; while (performance.now() < end) { /* live tick's post-await work */ } });
    piecesMoved(home);
    await expect.poll(() => lines.some((l) => /slowest: live manifest tick 2\d\d ms/.test(l))).toBe(true);
  } finally { onChanged(home, () => {}); closeSession('attribution'); w.stop(); rmSync(home, { recursive: true, force: true }); }
});
