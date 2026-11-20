/** Which embedding model reads memories, and where its files are cached. */
export function resolveFastEmbedModel(): string {
  return process.env.LOOM_FASTEMBED_MODEL ?? 'fast-bge-small-en-v1.5';
}

export function resolveFastEmbedCacheDir(): string | undefined {
  return process.env.LOOM_FASTEMBED_CACHE_DIR || undefined;
}
