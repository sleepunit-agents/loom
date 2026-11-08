/**
 * Qdrant → SQLite+vec migration.
 *
 * Reads all points from the Qdrant collection, re-embeds content using
 * fastembed (BGE-small-v1.5, 384-dim), and inserts into a SQLite
 * database at the target path. Preserves refs exactly so any external
 * references stay valid.
 *
 * Env:
 *   LOOM_QDRANT_URL        — default http://localhost:6333
 *   LOOM_QDRANT_COLLECTION — default loom_memories
 *   LOOM_SQLITE_DB_PATH    — default ~/.config/loom/art/memories.db
 *
 * Usage:
 *   npx tsx scripts/migrate-qdrant-to-sqlite.ts [--dry-run]
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { FastEmbedProvider } from '../src/backends/fastembed.js';

interface QdrantPoint {
  id: string;
  payload: {
    ref?: string;
    title?: string;
    category?: string;
    project?: string | null;
    content?: string;
    created?: string;
    updated?: string;
    last_accessed?: string;
    ttl?: string | null;
    expires_at?: string | null;
    metadata?: Record<string, unknown>;
  };
}

interface QdrantScrollResponse {
  result: {
    points: QdrantPoint[];
    next_page_offset?: string | null;
  };
}

const QDRANT_URL = process.env.LOOM_QDRANT_URL ?? 'http://localhost:6333';
const COLLECTION = process.env.LOOM_QDRANT_COLLECTION ?? 'loom_memories';
const DB_PATH =
  process.env.LOOM_SQLITE_DB_PATH ??
  resolve(homedir(), '.config', 'loom', 'art', 'memories.db');
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`[migrate] Qdrant: ${QDRANT_URL}/collections/${COLLECTION}`);
  console.log(`[migrate] SQLite: ${DB_PATH}`);
  if (DRY_RUN) console.log(`[migrate] DRY RUN — no writes`);

  // 1. Read all Qdrant points
  const points = await scrollAll();
  console.log(`[migrate] Fetched ${points.length} points from Qdrant`);

  // 2. Set up embedder
  const embedder = new FastEmbedProvider({
    model: 'fast-bge-small-en-v1.5',
  });
  console.log(`[migrate] Initializing fastembed (first-run downloads ~33MB)...`);
  // Prime it
  await embedder.embed('prime');
  console.log(`[migrate] Embedder ready (${embedder.dimensions}-dim)`);

  // 3. Set up DB
  if (!DRY_RUN) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
  }
  const existed = existsSync(DB_PATH);
  if (existed && !DRY_RUN) {
    console.warn(`[migrate] SQLite DB already exists at ${DB_PATH}`);
    console.warn(`[migrate] Aborting to avoid clobbering. Delete or move it first.`);
    process.exit(1);
  }

  const db = DRY_RUN
    ? new BetterSqlite3(':memory:')
    : new BetterSqlite3(DB_PATH);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  initSchema(db, embedder.dimensions);

  // 4. Batch embed + insert
  const batchSize = 32;
  const insertMem = db.prepare(`
    INSERT INTO memories (
      uuid, ref, title, category, project, content, metadata,
      created, updated, last_accessed, ttl, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVec = db.prepare(
    'INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)',
  );

  let written = 0;
  let skipped = 0;

  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    const texts = batch.map((p) => {
      const title = String(p.payload.title ?? 'Untitled');
      const content = String(p.payload.content ?? '');
      return `${title}\n\n${content}`;
    });

    const vectors = await embedder.embedBatch(texts);

    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const p = batch[j];
        if (!p.payload.ref || !p.payload.title || !p.payload.category) {
          skipped++;
          continue;
        }
        const result = insertMem.run(
          p.id,
          p.payload.ref,
          p.payload.title,
          p.payload.category,
          p.payload.project ?? null,
          String(p.payload.content ?? ''),
          JSON.stringify(p.payload.metadata ?? {}),
          String(p.payload.created ?? new Date().toISOString()),
          p.payload.updated ?? null,
          p.payload.last_accessed ?? null,
          p.payload.ttl ?? null,
          p.payload.expires_at ?? null,
        );
        insertVec.run(
          BigInt(result.lastInsertRowid),
          Buffer.from(new Float32Array(vectors[j]).buffer),
        );
        written++;
      }
    });
    tx();

    const done = Math.min(i + batchSize, points.length);
    process.stdout.write(`\r[migrate] embedded ${done}/${points.length}`);
  }
  process.stdout.write('\n');

  console.log(`[migrate] Written: ${written} | Skipped (missing fields): ${skipped}`);

  // 5. Verify count
  const count = (
    db.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number }
  ).n;
  console.log(`[migrate] Final memories table count: ${count}`);

  const vecCount = (
    db.prepare('SELECT COUNT(*) as n FROM vec_memories').get() as { n: number }
  ).n;
  console.log(`[migrate] Final vec_memories count: ${vecCount}`);

  db.close();

  if (DRY_RUN) {
    console.log(`[migrate] DRY RUN complete. No file written.`);
  } else {
    console.log(`[migrate] Done → ${DB_PATH}`);
  }
}

async function scrollAll(): Promise<QdrantPoint[]> {
  const all: QdrantPoint[] = [];
  let offset: string | null = null;
  do {
    const body: Record<string, unknown> = {
      with_payload: true,
      with_vector: false,
      limit: 100,
    };
    if (offset) body.offset = offset;

    const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Qdrant scroll failed (${res.status}): ${txt}`);
    }
    const data = (await res.json()) as QdrantScrollResponse;
    all.push(...data.result.points);
    offset = data.result.next_page_offset ?? null;
  } while (offset);
  return all;
}

function initSchema(db: BetterSqlite3.Database, dimensions: number): void {
  const statements = [
    `CREATE TABLE IF NOT EXISTS memories (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid          TEXT NOT NULL UNIQUE,
      ref           TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL,
      category      TEXT NOT NULL,
      project       TEXT,
      content       TEXT NOT NULL,
      metadata      TEXT NOT NULL DEFAULT '{}',
      created       TEXT NOT NULL,
      updated       TEXT,
      last_accessed TEXT,
      ttl           TEXT,
      expires_at    TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_project  ON memories(project)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_ref      ON memories(ref)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      embedding float[${dimensions}] distance_metric=cosine
    )`,
  ];
  for (const sql of statements) {
    db.prepare(sql).run();
  }
}

main().catch((err) => {
  console.error(`[migrate] FAILED:`, err);
  process.exit(1);
});
