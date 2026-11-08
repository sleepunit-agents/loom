import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock the backend factory so we exercise just the tool's input
// validation and string formatting — the underlying delete behavior
// is covered in sqlite-vec.test.ts.
vi.mock('../backends/index.js', () => ({
  createBackend: vi.fn(),
}));

import { forget } from './forget.js';
import { createBackend } from '../backends/index.js';

const mockCreateBackend = vi.mocked(createBackend);

interface FakeEntry {
  ref: string;
  title: string;
  category: string;
  project?: string;
  created: string;
}

function entry(ref: string, title: string): FakeEntry {
  return { ref, title, category: ref.split('/')[0], created: '2026-01-01' };
}

function backendThatReturns(deleted: string[], listed: FakeEntry[] = []) {
  return {
    forget: vi.fn().mockResolvedValue({ deleted }),
    list: vi.fn().mockResolvedValue(listed),
  } as never;
}

describe('forget tool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('input validation', () => {
    it('returns guidance when no inputs provided', async () => {
      const result = await forget('/tmp/test', {});
      expect(result).toContain('Nothing to forget');
    });

    it('rejects title_pattern without scope guard', async () => {
      const result = await forget('/tmp/test', { title_pattern: 'Forgejo*' });
      expect(result).toContain('requires category or project');
    });
  });

  describe('single deletion', () => {
    it('formats success when ref deleted — no confirm needed', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns(['user/prefs-abc123']));
      const result = await forget('/tmp/test', { ref: 'user/prefs-abc123' });
      expect(result).toContain('Memory forgotten: user/prefs-abc123');
    });

    it('returns Memory not found when ref missing', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns([]));
      const result = await forget('/tmp/test', { ref: 'user/nope' });
      expect(result).toContain('Memory not found');
      expect(result).toContain('user/nope');
    });

    it('returns Memory not found when category+title missing', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns([]));
      const result = await forget('/tmp/test', {
        category: 'user',
        title: 'Style',
      });
      expect(result).toContain('Memory not found');
      expect(result).toContain('user/Style');
    });

    it('category+title deletes without confirm', async () => {
      const backend = backendThatReturns(['user/style-xyz']);
      mockCreateBackend.mockReturnValue(backend);
      const result = await forget('/tmp/test', {
        category: 'user',
        title: 'Style',
      });
      expect(result).toContain('Memory forgotten: user/style-xyz');
      expect((backend as { forget: ReturnType<typeof vi.fn> }).forget).toHaveBeenCalled();
    });
  });

  describe('bulk deletion confirm gate', () => {
    it('scope without confirm returns preview and deletes nothing', async () => {
      const backend = backendThatReturns(
        ['user/a', 'user/b'],
        [entry('user/a', 'Alpha note'), entry('user/b', 'Beta note')],
      );
      mockCreateBackend.mockReturnValue(backend);
      const result = await forget('/tmp/test', { category: 'user' });
      expect(result).toContain('requires confirm: true');
      expect(result).toContain('Nothing was deleted');
      expect(result).toContain('would delete 2 memories');
      expect(result).toContain('Alpha note');
      expect(result).toContain('Beta note');
      expect((backend as { forget: ReturnType<typeof vi.fn> }).forget).not.toHaveBeenCalled();
    });

    it('preview caps title list at 10 and reports the overflow', async () => {
      const entries = Array.from({ length: 13 }, (_, i) =>
        entry(`user/m${i}`, `Memory ${i}`),
      );
      mockCreateBackend.mockReturnValue(backendThatReturns([], entries));
      const result = await forget('/tmp/test', { category: 'user' });
      expect(result).toContain('would delete 13 memories');
      expect(result).toContain('Memory 9');
      expect(result).not.toContain('Memory 10');
      expect(result).toContain('and 3 more');
    });

    it('scope with confirm: true deletes', async () => {
      const backend = backendThatReturns(['user/a', 'user/b']);
      mockCreateBackend.mockReturnValue(backend);
      const result = await forget('/tmp/test', { category: 'user', confirm: true });
      expect(result).toContain('Forgot 2 memories');
      expect(result).toContain('- user/a');
      expect(result).toContain('- user/b');
    });

    it('confirm: false is treated as unconfirmed (preview)', async () => {
      const backend = backendThatReturns(
        ['user/a'],
        [entry('user/a', 'Alpha note')],
      );
      mockCreateBackend.mockReturnValue(backend);
      const result = await forget('/tmp/test', { category: 'user', confirm: false });
      expect(result).toContain('requires confirm: true');
      expect((backend as { forget: ReturnType<typeof vi.fn> }).forget).not.toHaveBeenCalled();
    });

    it('preview with empty scope reports no matches', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns([], []));
      const result = await forget('/tmp/test', { project: 'nonexistent' });
      expect(result).toContain('No memories matched');
    });
  });

  describe('bulk deletion', () => {
    it('formats success with count and ref list', async () => {
      mockCreateBackend.mockReturnValue(
        backendThatReturns(['user/a', 'user/b']),
      );
      const result = await forget('/tmp/test', { category: 'user', confirm: true });
      expect(result).toContain('Forgot 2 memories');
      expect(result).toContain('- user/a');
      expect(result).toContain('- user/b');
    });

    it('reports when confirmed scope matches nothing', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns([]));
      const result = await forget('/tmp/test', { project: 'nonexistent', confirm: true });
      expect(result).toContain('No memories matched');
    });
  });

  describe('pattern deletion', () => {
    it('reports pattern in no-match message (confirmed)', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns([]));
      const result = await forget('/tmp/test', {
        category: 'project',
        title_pattern: 'Forgejo sweep*',
        confirm: true,
      });
      expect(result).toContain('No memories matched pattern "Forgejo sweep*"');
    });

    it('reports pattern in no-match message (preview)', async () => {
      mockCreateBackend.mockReturnValue(
        backendThatReturns([], [entry('project/other', 'Unrelated title')]),
      );
      const result = await forget('/tmp/test', {
        category: 'project',
        title_pattern: 'Forgejo sweep*',
      });
      expect(result).toContain('No memories matched pattern "Forgejo sweep*"');
    });

    it('preview filters listed entries by the glob pattern', async () => {
      const backend = backendThatReturns([], [
        entry('project/sweep-1', 'Forgejo sweep — April'),
        entry('project/other', 'Unrelated title'),
      ]);
      mockCreateBackend.mockReturnValue(backend);
      const result = await forget('/tmp/test', {
        category: 'project',
        title_pattern: 'Forgejo sweep*',
      });
      expect(result).toContain('would delete 1 memory');
      expect(result).toContain('Forgejo sweep — April');
      expect(result).not.toContain('Unrelated title');
      expect((backend as { forget: ReturnType<typeof vi.fn> }).forget).not.toHaveBeenCalled();
    });

    it('formats success when pattern matches (confirmed)', async () => {
      mockCreateBackend.mockReturnValue(
        backendThatReturns(['project/sweep-1', 'project/sweep-2']),
      );
      const result = await forget('/tmp/test', {
        category: 'project',
        title_pattern: 'Forgejo sweep*',
        confirm: true,
      });
      expect(result).toContain('Forgot 2 memories');
    });
  });
});
