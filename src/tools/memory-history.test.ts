/**
 * memory_history / memory_revision_restore — shared-backend lifecycle.
 *
 * createBackend hands every tool the same process-cached SqliteVecBackend.
 * A tool that closes it kills any other call still in flight on that handle
 * ("The database connection is not open."). These tests hold an update()
 * mid-embedding, run the history tools against the same store, then let
 * the update finish on the handle they share.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Deterministic embedder with a gate: while `held` is set, the next embed()
// call parks until the test releases it.
const gate: { held: Promise<void> | null; entered: (() => void) | null } = {
  held: null,
  entered: null,
};

vi.mock('../backends/fastembed.js', () => ({
  FastEmbedProvider: class {
    readonly dimensions = 384;
    async embed(text: string): Promise<number[]> {
      if (gate.held) {
        const held = gate.held;
        gate.held = null;
        gate.entered?.();
        await held;
      }
      const v = new Array(384).fill(0);
      for (let i = 0; i < text.length; i++) v[i % 384] += text.charCodeAt(i) / 1000;
      return v;
    }
    async embedBatch(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map((t) => this.embed(t)));
    }
  },
}));

import { createBackend, closeAllBackends } from '../backends/index.js';
import { memoryHistory } from './memory-history.js';
import { memoryRevisionRestore } from './memory-revision-restore.js';

/** Arm the gate; resolves `entered` once an embed() call is parked on it. */
function holdNextEmbed(): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  gate.held = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (gate.entered = r));
  return { entered, release };
}

describe('memory history tools share the cached backend', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loom-memory-history-'));
  });
  afterEach(async () => {
    gate.held = null;
    gate.entered = null;
    closeAllBackends();
    await rm(dir, { recursive: true, force: true });
  });

  async function seed(): Promise<string> {
    const backend = createBackend(dir);
    const { ref } = await backend.remember({
      category: 'project',
      title: 'Overlap target',
      content: 'first body',
    });
    await backend.update({ ref, content: 'second body' }); // snapshot #1
    return ref;
  }

  it('memory_history does not close the handle under an in-flight update', async () => {
    const ref = await seed();
    const backend = createBackend(dir);

    const { entered, release } = holdNextEmbed();
    const pending = backend.update({ ref, content: 'third body' });
    await entered;

    const listed = await memoryHistory(dir, { ref });
    expect(listed).toContain('1 snapshot(s)');
    const read = await memoryHistory(dir, { ref, revision_id: 1 });
    expect(read).toContain('first body');

    release();
    await expect(pending).resolves.toMatchObject({ updated: true });
    expect(createBackend(dir)).toBe(backend);
  });

  it('memory_revision_restore does not close the handle under an in-flight update', async () => {
    const ref = await seed();
    const backend = createBackend(dir);

    const { entered, release } = holdNextEmbed();
    const pending = backend.update({ ref, content: 'third body' });
    await entered;

    const restored = await memoryRevisionRestore(dir, { ref, revision_id: 1 });
    expect(restored).toContain('Restored revision #1');

    release();
    await expect(pending).resolves.toMatchObject({ updated: true });
    expect(createBackend(dir)).toBe(backend);
    expect(await memoryHistory(dir, { ref })).toContain('snapshot(s)');
  });
});
