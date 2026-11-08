import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../backends/index.js', () => ({
  createBackend: vi.fn(),
}));

import { restore } from './restore.js';
import { createBackend } from '../backends/index.js';

const mockCreateBackend = vi.mocked(createBackend);

function backendThatReturns(restored: string[]) {
  return {
    restore: vi.fn().mockResolvedValue({ restored }),
  } as never;
}

describe('restore tool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('input validation', () => {
    it('returns guidance when no inputs provided', async () => {
      const result = await restore('/tmp/test', {});
      expect(result).toContain('Nothing to restore');
    });
  });

  describe('single restore', () => {
    it('formats success when ref restored', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns(['user/prefs-abc123']));
      const result = await restore('/tmp/test', { ref: 'user/prefs-abc123' });
      expect(result).toContain('Memory restored: user/prefs-abc123');
    });

    it('returns not found when ref not in archive', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns([]));
      const result = await restore('/tmp/test', { ref: 'user/nope' });
      expect(result).toContain('not found');
      expect(result).toContain('user/nope');
    });

    it('formats success when category+title restored', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns(['feedback/style-abc123']));
      const result = await restore('/tmp/test', {
        category: 'feedback',
        title: 'Style',
      });
      expect(result).toContain('Memory restored: feedback/style-abc123');
    });

    it('returns not found when category+title not in archive', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns([]));
      const result = await restore('/tmp/test', {
        category: 'user',
        title: 'Missing',
      });
      expect(result).toContain('not found');
      expect(result).toContain('user/Missing');
    });
  });
});
