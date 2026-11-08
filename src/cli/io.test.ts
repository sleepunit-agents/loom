/**
 * Tests for src/cli/io.ts. The openEditor fallback order is spec'd as
 * $VISUAL ?? $EDITOR ?? 'vi' — we assert by mocking child_process.spawn
 * so we can observe the editor name without actually launching an editor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Capture spawn args per test so we can assert on which editor was picked.
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      // Fake child that fires `exit 0` on next tick so openEditor resolves
      // without actually launching a real editor.
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      child.kill = () => {};
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    },
  };
});

const { openEditor } = await import('./io.js');

describe('openEditor fallback order', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it('prefers $VISUAL when set', async () => {
    await openEditor({ VISUAL: 'visual-editor', EDITOR: 'other-editor' }, 'remember', 'seed');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe('visual-editor');
  });

  it('falls back to $EDITOR when $VISUAL is unset', async () => {
    await openEditor({ EDITOR: 'my-editor' }, 'remember', 'seed');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe('my-editor');
  });

  it("defaults to 'vi' when neither $VISUAL nor $EDITOR is set", async () => {
    await openEditor({}, 'remember', 'seed');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe('vi');
  });
});
