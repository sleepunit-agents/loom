import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the vendored embedding runtime entirely — these tests must never
// download the real ONNX model. The provider only touches FlagEmbedding.init
// and the instance methods embed()/queryEmbed(). The runtime itself is
// exercised for real in embedding-runtime.parity.test.ts.
vi.mock('./embedding-runtime.js', () => ({
  FlagEmbedding: { init: vi.fn() },
  EmbeddingModel: {},
}));

import { FlagEmbedding } from './embedding-runtime.js';
import { FastEmbedProvider } from './fastembed.js';

const initMock = vi.mocked(FlagEmbedding.init);

async function* batchGen(batches: number[][][]) {
  for (const b of batches) yield b;
}

/** Minimal stand-in for a FlagEmbedding instance. */
function makeFakeEmbedder(opts?: {
  batches?: number[][][];
  queryVector?: number[];
}) {
  return {
    embed: vi.fn((texts: string[]) =>
      batchGen(opts?.batches ?? [texts.map(() => [0.1, 0.2, 0.3])]),
    ),
    queryEmbed: vi.fn(async () => opts?.queryVector ?? [0.1, 0.2, 0.3]),
  } as unknown as FlagEmbedding;
}

describe('FastEmbedProvider', () => {
  let cacheDir: string;

  const makeProvider = () =>
    new FastEmbedProvider({ model: 'fast-bge-small-en-v1.5', cacheDir });

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'loom-fastembed-'));
    initMock.mockReset();
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('throws on an unknown model name', () => {
    expect(
      () => new FastEmbedProvider({ model: 'fast-nonsense', cacheDir }),
    ).toThrow(/unknown fastembed model/i);
  });

  it('retries init after a failed first attempt', async () => {
    initMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(makeFakeEmbedder());

    const provider = makeProvider();

    await expect(provider.embed('hello')).rejects.toThrow(/network down/);
    // Pre-fix the rejected promise stayed cached and every later call
    // failed forever. The retry must call init again and succeed.
    await expect(provider.embed('hello')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(initMock).toHaveBeenCalledTimes(2);
  });

  it('initializes only once across calls after success', async () => {
    initMock.mockResolvedValue(makeFakeEmbedder());
    const provider = makeProvider();

    await provider.embed('one');
    await provider.embedQuery('two');
    await provider.embedBatch(['three']);

    expect(initMock).toHaveBeenCalledTimes(1);
  });

  it('throws a descriptive error when embed yields no vector', async () => {
    initMock.mockResolvedValue(makeFakeEmbedder({ batches: [] }));
    const provider = makeProvider();

    await expect(provider.embed('hello')).rejects.toThrow(
      /embed\(\) produced no vector.*fast-bge-small-en-v1\.5/,
    );
  });

  it('throws a descriptive error when embedQuery yields an empty vector', async () => {
    initMock.mockResolvedValue(makeFakeEmbedder({ queryVector: [] }));
    const provider = makeProvider();

    await expect(provider.embedQuery('hello')).rejects.toThrow(
      /embedQuery\(\) produced no vector/,
    );
  });

  it('throws after exhausting the fallback ladder when every rung fails', async () => {
    // Always yields zero vectors, at every batch size — batch, sequential,
    // and the per-text embed() calls of the one-by-one rung all come up
    // empty, so there is genuinely nothing to fall back to.
    initMock.mockResolvedValue(makeFakeEmbedder({ batches: [] }));
    const provider = makeProvider();

    await expect(provider.embedBatch(['a', 'b'])).rejects.toThrow(
      /embed\(\) produced no vector/,
    );
  });

  it('returns [] for an empty embedBatch without touching init', async () => {
    const provider = makeProvider();
    await expect(provider.embedBatch([])).resolves.toEqual([]);
    expect(initMock).not.toHaveBeenCalled();
  });

  describe('embedBatch fallback ladder (t-334)', () => {
    it('degrades batch -> sequential -> one-by-one when every multi-text call fails', async () => {
      const embed = vi.fn((texts: string[]) => {
        if (texts.length > 1) throw new Error('batch exploded');
        return batchGen([texts.map(() => [0.1, 0.2, 0.3])]);
      });
      initMock.mockResolvedValue({ embed, queryEmbed: vi.fn() } as unknown as FlagEmbedding);
      const provider = makeProvider();

      await expect(provider.embedBatch(['a', 'b', 'c'])).resolves.toEqual([
        [0.1, 0.2, 0.3],
        [0.1, 0.2, 0.3],
        [0.1, 0.2, 0.3],
      ]);
      // rung 1 (batch of 3) + rung 2 (sequential, still 3) both throw;
      // rung 3 makes one isolated call per text.
      expect(embed).toHaveBeenCalledTimes(2 + 3);
      expect(embed.mock.calls.filter(([texts]) => texts.length === 1)).toHaveLength(3);
    });

    it('recovers at the sequential rung without reaching one-by-one', async () => {
      const embed = vi.fn((texts: string[], batchSize: number) => {
        if (batchSize === 32) throw new Error('batch exploded');
        return batchGen([texts.map(() => [0.4, 0.5, 0.6])]);
      });
      initMock.mockResolvedValue({ embed, queryEmbed: vi.fn() } as unknown as FlagEmbedding);
      const provider = makeProvider();

      await expect(provider.embedBatch(['a', 'b'])).resolves.toEqual([
        [0.4, 0.5, 0.6],
        [0.4, 0.5, 0.6],
      ]);
      // One failed batch call, one successful sequential call — never
      // dropped to per-text calls.
      expect(embed).toHaveBeenCalledTimes(2);
    });

    it('does not degrade when the full batch call succeeds', async () => {
      const embed = vi.fn((texts: string[]) =>
        batchGen([texts.map(() => [0.7, 0.8, 0.9])]),
      );
      initMock.mockResolvedValue({ embed, queryEmbed: vi.fn() } as unknown as FlagEmbedding);
      const provider = makeProvider();

      await expect(provider.embedBatch(['a', 'b'])).resolves.toEqual([
        [0.7, 0.8, 0.9],
        [0.7, 0.8, 0.9],
      ]);
      expect(embed).toHaveBeenCalledTimes(1);
    });
  });
});
