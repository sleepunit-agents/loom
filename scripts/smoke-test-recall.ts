/**
 * Smoke test: run a handful of recall queries against the freshly
 * migrated SQLite DB and print top results to eyeball relevance.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteVecBackend } from '../src/backends/sqlite-vec.js';
import { FastEmbedProvider } from '../src/backends/fastembed.js';

const DB_PATH = resolve(homedir(), '.config', 'loom', 'art', 'memories.db');

const QUERIES = [
  'earworm audio analysis',
  'loom identity substrate',
  'homelab woodpecker CI',
  'tadpole sensor pi',
  'memory backend migration',
  'secret word',
  'bat-phone screen',
  'iris camera',
  'discord channel',
  'qdrant vector search',
];

async function main() {
  const embedder = new FastEmbedProvider({ model: 'fast-bge-small-en-v1.5' });
  await embedder.embed('prime');
  const backend = new SqliteVecBackend({ dbPath: DB_PATH }, embedder);

  for (const q of QUERIES) {
    const hits = await backend.recall({ query: q, limit: 3 });
    console.log(`\n=== ${q} ===`);
    for (const h of hits) {
      console.log(`  [${h.relevance.toFixed(3)}] ${h.category}/${h.title}`);
    }
  }

  backend.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
