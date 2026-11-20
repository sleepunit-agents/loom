import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeSession, openStream, piecesMoved } from './live.js';
const manifests = vi.hoisted(() => ({ refresh: vi.fn<() => Promise<Map<string, string>>>() }));
vi.mock('./pieces.js', () => ({ ROUND_MS: 15_000, clearPiecePages: vi.fn(), expirePieceManifests: vi.fn(), refreshPieceManifests: manifests.refresh }));

it('rechecks stream authority after a pending manifest refresh before sending page names', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-live-authority-'));
  const path = '/test/loom-private';
  let authorized = true, release!: (value: Map<string, string>) => void;
  const gate = new Promise<Map<string, string>>(resolve => { release = resolve; });
  manifests.refresh.mockResolvedValueOnce(new Map([[path, 'before']])).mockReturnValueOnce(gate);
  const response = new EventEmitter() as EventEmitter & { writeHead: () => void; write: (s: string) => boolean; end: () => void };
  const frames: string[] = [];
  response.writeHead = () => {}; response.write = s => { frames.push(s); return true; };
  response.end = vi.fn(() => { response.emit('close'); });
  try {
    openStream(response as unknown as ServerResponse, {}, home, {}, { sees: '*', session: 'authority', place: () => '*', authorized: () => authorized });
    await expect.poll(() => manifests.refresh.mock.calls.length).toBe(1);
    await new Promise(resolve => setImmediate(resolve));
    piecesMoved(home, path);
    await expect.poll(() => manifests.refresh.mock.calls.length).toBe(2);
    authorized = false;
    const before = frames.length;
    release(new Map([[path, 'after']]));
    await expect.poll(() => vi.mocked(response.end).mock.calls.length).toBe(1);
    expect(frames.slice(before).join('')).not.toContain('event: page');
  } finally { release(new Map()); closeSession('authority'); rmSync(home, { recursive: true, force: true }); }
});
