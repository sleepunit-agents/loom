import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SqliteVecBackend } from './sqlite-vec.js';
import type { EmbeddingProvider } from './types.js';

/**
 * Concurrent remember() of the same content (PR120 review).
 *
 * remember() looks up the dedup key, then awaits the embedder, then inserts.
 * Two writers that both pass the lookup before either inserts used to store
 * two rows. The interleave is forced deterministically: every embed() call
 * parks on a shared gate, so all writers have finished their lookup before
 * any of them reaches the insert. The two-connection cases put the writers
 * on separate SqliteVecBackend instances over the same file — the shape of
 * loom-http and the CLI sharing memories.db.
 */
function gatedEmbedder(gate: Promise<void>): EmbeddingProvider & { calls: number } {
  const e = {
    dimensions: 4,
    calls: 0,
    embed: async () => {
      e.calls++;
      await gate;
      return [0.5, 0.5, 0.5, 0.5];
    },
    embedBatch: async (ts: string[]) => {
      await gate;
      return ts.map(() => [0.5, 0.5, 0.5, 0.5]);
    },
  };
  return e;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Resolve once every embedder has been entered `n` times in total. */
async function untilEmbedding(embedders: { calls: number }[], n: number): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (embedders.reduce((s, e) => s + e.calls, 0) >= n) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('writers never reached the embedder');
}

const INPUT = { category: 'project', title: 'Status', content: 'alpha' } as const;

describe('remember() dedup under concurrency (PR120 review)', () => {
  let tmpDir: string;
  let dbPath: string;
  const open: SqliteVecBackend[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-dedup-race-'));
    dbPath = join(tmpDir, 'memories.db');
  });

  afterEach(() => {
    for (const b of open.splice(0)) b.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function backend(embedder: EmbeddingProvider): SqliteVecBackend {
    const b = new SqliteVecBackend({ dbPath }, embedder);
    open.push(b);
    return b;
  }

  function activeRows(b: SqliteVecBackend): { ref: string; times_seen: number }[] {
    return b.getDatabase()
      .prepare('SELECT ref, times_seen FROM memories WHERE archived = 0 ORDER BY id')
      .all() as { ref: string; times_seen: number }[];
  }

  it('one backend: two overlapping remember() calls of the same content store one row', async () => {
    const gate = deferred();
    const emb = gatedEmbedder(gate.promise);
    const b = backend(emb);

    const p = Promise.all([b.remember(INPUT), b.remember(INPUT)]);
    await untilEmbedding([emb], 2);
    gate.resolve();
    const [r1, r2] = await p;

    expect(r2.ref).toBe(r1.ref);
    expect(activeRows(b)).toEqual([{ ref: r1.ref, times_seen: 2 }]);
  });

  it('two backends on the same file: overlapping remember() calls store one row', async () => {
    const gate = deferred();
    const embA = gatedEmbedder(gate.promise);
    const embB = gatedEmbedder(gate.promise);
    const a = backend(embA);
    const b = backend(embB);

    const p = Promise.all([a.remember(INPUT), b.remember(INPUT), a.remember(INPUT), b.remember(INPUT)]);
    await untilEmbedding([embA, embB], 4);
    gate.resolve();
    const refs = (await p).map((r) => r.ref);

    expect(new Set(refs).size).toBe(1);
    expect(activeRows(a)).toEqual([{ ref: refs[0], times_seen: 4 }]);
  });

  it('the database itself refuses a second ACTIVE row with the same key', async () => {
    const b = backend(gatedEmbedder(Promise.resolve()));
    await b.remember(INPUT);
    const db = b.getDatabase();
    const { uniq } = db.prepare('SELECT uniq FROM memories').get() as { uniq: string };

    // A writer that skipped the in-transaction recheck still can't land a dup.
    expect(() =>
      db.prepare(
        `INSERT INTO memories (uuid, ref, title, category, content, metadata, created, uniq)
         VALUES ('u-dup', 'project/dup', 'Status', 'project', 'alpha', '{}', ?, ?)`,
      ).run(new Date().toISOString(), uniq),
    ).toThrow(/UNIQUE/);

    // ...but archived rows and NULL keys are not constrained.
    db.prepare('UPDATE memories SET archived = 1').run();
    db.prepare(
      `INSERT INTO memories (uuid, ref, title, category, content, metadata, created, uniq)
       VALUES ('u-new', 'project/new', 'Status', 'project', 'alpha', '{}', ?, ?)`,
    ).run(new Date().toISOString(), uniq);
    for (const n of [1, 2]) {
      db.prepare(
        `INSERT INTO memories (uuid, ref, title, category, content, metadata, created, uniq)
         VALUES (?, ?, 'Status', 'project', 'alpha', '{}', ?, NULL)`,
      ).run(`u-null-${n}`, `project/null-${n}`, new Date().toISOString());
    }
  });

  it('separate OS processes on the same file: every write lands on one row per distinct body', async () => {
    // Real concurrency, not an interleaving in one event loop: several
    // processes each fire a burst of remember() calls (3 distinct bodies,
    // random embedder latency) starting at the same wall-clock instant.
    // Before the in-transaction recheck + unique index this stored ~95 rows.
    const PROCS = 4;
    const PER_PROC = 20;
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, '..', '..');
    const backendUrl = pathToFileURL(join(here, 'sqlite-vec.ts')).href;
    const worker = join(tmpDir, 'worker.mts');
    writeFileSync(worker, `
      import { SqliteVecBackend } from ${JSON.stringify(backendUrl)};
      const [dbPath, startAt] = process.argv.slice(2);
      const embedder = {
        dimensions: 4,
        embed: async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          return [0.5, 0.5, 0.5, 0.5];
        },
        embedBatch: async (ts) => ts.map(() => [0.5, 0.5, 0.5, 0.5]),
      };
      const b = new SqliteVecBackend({ dbPath }, embedder);
      while (Date.now() < Number(startAt)) await new Promise((r) => setTimeout(r, 1));
      await Promise.all(Array.from({ length: ${PER_PROC} }, (_, i) =>
        b.remember({ category: 'project', title: 'Status', content: 'alpha ' + (i % 3) })));
      b.close();
    `);

    // Create the schema once up front so the workers don't race migrations.
    backend(gatedEmbedder(Promise.resolve())).close();
    open.length = 0;

    const run = promisify(execFile);
    const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
    const startAt = String(Date.now() + 3000);
    await Promise.all(
      Array.from({ length: PROCS }, () => run(tsx, [worker, dbPath, startAt], { cwd: repoRoot })),
    );

    const b = backend(gatedEmbedder(Promise.resolve()));
    const rows = b.getDatabase()
      .prepare('SELECT content, times_seen FROM memories WHERE archived = 0 ORDER BY content')
      .all() as { content: string; times_seen: number }[];
    expect(rows.map((r) => r.content)).toEqual(['alpha 0', 'alpha 1', 'alpha 2']);
    expect(rows.reduce((sum, r) => sum + r.times_seen, 0)).toBe(PROCS * PER_PROC);
  }, 60_000);
});
