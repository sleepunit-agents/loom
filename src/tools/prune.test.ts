import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock the backend factory to control prune results
vi.mock('../backends/index.js', () => ({
  createBackend: vi.fn(),
}));

import { prune } from './prune.js';
import { createBackend } from '../backends/index.js';

const mockCreateBackend = vi.mocked(createBackend);

describe('prune tool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns healthy message when nothing to prune', async () => {
    mockCreateBackend.mockReturnValue({
      prune: vi.fn().mockResolvedValue({ expired: [], stale: [] }),
    } as never);

    const result = await prune('/tmp/test');
    expect(result).toContain('healthy');
  });

  it('formats expired memories', async () => {
    mockCreateBackend.mockReturnValue({
      prune: vi.fn().mockResolvedValue({
        expired: ['project/2026-01-01-old.md', 'project/2026-01-02-ancient.md'],
        stale: [],
      }),
    } as never);

    const result = await prune('/tmp/test');
    expect(result).toContain('Archived 2 memories');
    expect(result).toContain('project/2026-01-01-old.md');
    expect(result).toContain('project/2026-01-02-ancient.md');
  });

  it('formats stale memories', async () => {
    mockCreateBackend.mockReturnValue({
      prune: vi.fn().mockResolvedValue({
        expired: [],
        stale: ['project/2025-06-01-forgotten.md'],
      }),
    } as never);

    const result = await prune('/tmp/test', { staleDays: 60 });
    expect(result).toContain('1 stale');
    expect(result).toContain('60+ days');
  });

  it('uses "Would archive" in dry run mode', async () => {
    mockCreateBackend.mockReturnValue({
      prune: vi.fn().mockResolvedValue({
        expired: ['project/2026-01-01-old.md'],
        stale: [],
      }),
    } as never);

    const result = await prune('/tmp/test', { dryRun: true });
    expect(result).toContain('Would archive');
  });

  it('passes options through to backend', async () => {
    const mockPrune = vi.fn().mockResolvedValue({ expired: [], stale: [] });
    mockCreateBackend.mockReturnValue({ prune: mockPrune } as never);

    await prune('/tmp/test', { dryRun: true, staleDays: 60 });
    expect(mockPrune).toHaveBeenCalledWith({ dryRun: true, staleDays: 60 });
  });
});
