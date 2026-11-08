/**
 * The one test in this suite that runs a real ONNX model.
 *
 * Everything else mocks the embedding runtime, which is exactly how loom
 * shipped a symlink bug (#84) and nearly shipped a tar override that could not
 * boot: a green suite over a binary that does not work. This test exists so
 * the vendored runtime cannot drift from `fastembed@2.1.0`, whose output every
 * vector in every existing loom database was produced by.
 *
 * The golden vectors in __fixtures__/embedding-golden.json were captured from
 * the upstream package on 2026-09-04, before it was removed. A failure here
 * means new embeddings are no longer comparable to stored ones — a silent
 * recall-quality regression, not a test to relax.
 *
 * Requires the ~130 MB BGE model. It downloads on first run; set
 * LOOM_TEST_REAL_EMBEDDINGS=0 to skip (CI caches the model and runs it).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import type { FlagEmbedding as FlagEmbeddingType } from './embedding-runtime.js';

const golden = JSON.parse(
  readFileSync(new URL('./__fixtures__/embedding-golden.json', import.meta.url), 'utf-8'),
) as { model: string; texts: string[]; embed: string[]; query: string[] };

const enabled = process.env.LOOM_TEST_REAL_EMBEDDINGS !== '0';
const cacheDir =
  process.env.LOOM_FASTEMBED_CACHE_DIR ?? join(homedir(), '.cache', 'loom', 'fastembed');

/** Golden vectors are little-endian float32, base64-encoded. */
function decode(b64: string): Float32Array {
  const bytes = Buffer.from(b64, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

async function collect(gen: AsyncGenerator<Float32Array[]>): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for await (const batch of gen) out.push(...batch);
  return out;
}

describe.skipIf(!enabled)('embedding runtime parity with fastembed@2.1.0', () => {
  let embedder: FlagEmbeddingType;

  beforeAll(async () => {
    // test-setup.ts mocks this module globally; parity needs the real one.
    const runtime = await vi.importActual<typeof import('./embedding-runtime.js')>(
      './embedding-runtime.js',
    );
    embedder = await runtime.FlagEmbedding.init({
      model: golden.model as never,
      cacheDir,
    });
  }, 300_000);

  it('reproduces the golden passage vectors bit for bit', async () => {
    const vectors = await collect(embedder.embed(golden.texts, 32));

    expect(vectors).toHaveLength(golden.texts.length);
    vectors.forEach((vector, i) => {
      expect(Array.from(vector)).toEqual(Array.from(decode(golden.embed[i]!)));
    });
  }, 120_000);

  it('reproduces the golden query vectors bit for bit', async () => {
    for (const [i, text] of golden.texts.entries()) {
      const vector = await embedder.queryEmbed(text);
      expect(Array.from(vector)).toEqual(Array.from(decode(golden.query[i]!)));
    }
  }, 120_000);

  it('produces the same vector regardless of batch size', async () => {
    const batched = await collect(embedder.embed(golden.texts, 32));
    const singly: Float32Array[] = [];
    for (const text of golden.texts) {
      singly.push(...(await collect(embedder.embed([text], 1))));
    }

    // Padding is fixed-length, so batching must not change any result. If this
    // ever fails, embed() and embedBatch() are writing incompatible vectors
    // into the same table.
    expect(singly.map((v) => Array.from(v))).toEqual(batched.map((v) => Array.from(v)));
  }, 120_000);

  it('returns unit vectors of the model dimension', async () => {
    const [vector] = await collect(embedder.embed(['normalisation check'], 1));

    expect(vector).toHaveLength(384);
    const norm = Math.sqrt(Array.from(vector!).reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  }, 120_000);
});
