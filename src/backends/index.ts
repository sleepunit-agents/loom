/**
 * The embedding provider the memory commands use unless startup gives them another.
 *
 * loom ships one stack: sqlite + sqlite-vec for storage and FastEmbedProvider (BGE-small-en-v1.5 ONNX,
 * CPU only) for vectors. There is deliberately no setting that selects another.
 */
import { resolveFastEmbedModel, resolveFastEmbedCacheDir } from '../config.js';
import { FastEmbedProvider } from './fastembed.js';
import type { EmbeddingProvider } from './types.js';

/** One provider per model and cache directory for the life of the process: starting one loads the whole model. */
const embedderCache = new Map<string, EmbeddingProvider>();

export function createEmbeddingProvider(): EmbeddingProvider {
  const model = resolveFastEmbedModel();
  const cacheDir = resolveFastEmbedCacheDir();
  const key = `${model}\u0000${cacheDir}`;
  let provider = embedderCache.get(key);
  if (!provider) {
    provider = new FastEmbedProvider({ model, cacheDir });
    embedderCache.set(key, provider);
  }
  return provider;
}
