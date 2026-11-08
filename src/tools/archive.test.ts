import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../backends/index.js', () => ({
  createBackend: vi.fn(),
}));

import { archive } from './archive.js';
import { createBackend } from '../backends/index.js';

const mockCreateBackend = vi.mocked(createBackend);

function backendThatReturns(archived: string[]) {
  return {
    archive: vi.fn().mockResolvedValue({ archived }),
  } as never;
}

describe('archive tool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('input validation', () => {
    it('returns guidance when no inputs provided', async () => {
      const result = await archive('/tmp/test', {});
      expect(result).toContain('Nothing to archive');
    });
  });

  describe('single archive', () => {
    it('formats success when ref archived', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns(['user/prefs-abc123']));
      const result = await archive('/tmp/test', { ref: 'user/prefs-abc123' });
      expect(result).toContain('Memory archived: user/prefs-abc123');
    });

    it('returns not found when ref missing or already archived', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns([]));
      const result = await archive('/tmp/test', { ref: 'user/nope' });
      expect(result).toContain('not found');
      expect(result).toContain('user/nope');
    });

    it('formats success when category+title archived', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns(['feedback/style-abc123']));
      const result = await archive('/tmp/test', {
        category: 'feedback',
        title: 'Style',
      });
      expect(result).toContain('Memory archived: feedback/style-abc123');
    });

    it('returns not found when category+title not found', async () => {
      mockCreateBackend.mockReturnValue(backendThatReturns([]));
      const result = await archive('/tmp/test', {
        category: 'user',
        title: 'Missing',
      });
      expect(result).toContain('not found');
      expect(result).toContain('user/Missing');
    });

    it('passes note to the backend', async () => {
      const backend = backendThatReturns(['project/old-abc123']);
      mockCreateBackend.mockReturnValue(backend);
      await archive('/tmp/test', { ref: 'project/old-abc123', note: 'superseded by newer entry' });
      expect(backend.archive).toHaveBeenCalledWith(
        expect.objectContaining({ note: 'superseded by newer entry' }),
      );
    });
  });
});
