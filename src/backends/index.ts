/**
 * Memory backend factory.
 *
 * loom ships a single opinionated stack: SqliteVecBackend
 * (sqlite + sqlite-vec virtual table) backed by FastEmbedProvider
 * (BGE-small-en-v1.5 ONNX, CPU-only). Zero external services. One DB
 * file per agent under the context dir.
 *
 * If you ever need a different stack — different embedding model,
 * remote vector DB, etc — implement the MemoryBackend / EmbeddingProvider
 * interfaces in types.ts and swap the concrete classes here. There is
 * deliberately no env-driven backend selector anymore: opinionated.
 */
import {
  resolveSqliteDbPath,
  resolveKnowledgeDbPath,
  assertKnowledgePathsNotCoLocated,
  resolveFastEmbedModel,
  resolveFastEmbedCacheDir,
} from '../config.js';
import { SqliteVecBackend } from './sqlite-vec.js';
import { appendRecallObservation } from './recall-log.js';
import { SqliteKnowledgeBackend } from './sqlite-knowledge.js';
import { FastEmbedProvider } from './fastembed.js';
import type { MemoryBackend, EmbeddingProvider, KnowledgeBackend } from './types.js';

/**
 * Process-lifetime caches (store-convergence §Lifecycle).
 *
 * Tools call createBackend on every invocation; before these caches that
 * meant a fresh better-sqlite3 handle (leaked — no tool closes) and a fresh
 * FastEmbedProvider (full ONNX model init) per call. Backends are now cached
 * per resolved db path and the embedding provider is a singleton per
 * model+cacheDir. close() on a cached backend evicts it, so explicit close
 * (e.g. eurorack-import) stays correct — the next createBackend reopens.
 */
const backendCache = new Map<string, MemoryBackend>();
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

export function createBackend(contextDir: string): MemoryBackend {
  const dbPath = resolveSqliteDbPath(contextDir);
  const cached = backendCache.get(dbPath);
  if (cached) return cached;

  const backend = new SqliteVecBackend(
    {
      dbPath,
      // Recall observation log: local-only, <contextDir>/telemetry/recall.jsonl.
      onRecall: (obs) => appendRecallObservation(contextDir, obs),
    },
    createEmbeddingProvider(),
  );

  // Evict on close so an explicitly closed backend is never handed out again.
  const originalClose = backend.close.bind(backend);
  backend.close = () => {
    backendCache.delete(dbPath);
    originalClose();
  };

  backendCache.set(dbPath, backend);
  return backend;
}

/**
 * A fresh, uncached, read-only handle on contextDir's memory store (t-1773).
 * Creates nothing and migrates nothing: throws if the store is missing or at an
 * older schema. The caller owns it and must close() it.
 */
export function openReadOnlyBackend(contextDir: string): SqliteVecBackend {
  return new SqliteVecBackend(
    { dbPath: resolveSqliteDbPath(contextDir), readonly: true },
    createEmbeddingProvider(),
  );
}

/** Close and evict every cached memory backend. For tests and shutdown. */
export function closeAllBackends(): void {
  for (const backend of [...backendCache.values()]) {
    try {
      backend.close(); // evicts itself via the wrapped close
    } catch {
      // best-effort shutdown
    }
  }
  backendCache.clear();
}

export function createKnowledgeBackend(contextDir: string): KnowledgeBackend {
  assertKnowledgePathsNotCoLocated(contextDir);
  return new SqliteKnowledgeBackend({
    dbPath: resolveKnowledgeDbPath(contextDir),
  });
}
