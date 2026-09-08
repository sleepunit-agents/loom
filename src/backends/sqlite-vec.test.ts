import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteVecBackend } from './sqlite-vec.js';
import type { EmbeddingProvider } from './types.js';

/**
 * Deterministic "embedder" for tests: maps each input to a unit vector
 * in a fixed 4-dim space by keyword presence. Avoids loading a real
 * ONNX model while still exercising cosine-distance ranking.
 */
function makeKeywordEmbedder(): EmbeddingProvider {
  const axes = ['loom', 'alpha', 'beta', 'gamma'];

  const encode = (text: string): number[] => {
    const lower = text.toLowerCase();
    const vec = axes.map((axis) => (lower.includes(axis) ? 1 : 0));
    // Always nonzero so sqlite-vec doesn't choke on a zero vector
    if (vec.every((v) => v === 0)) vec[0] = 0.01;
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / norm);
  };

  return {
    dimensions: 4,
    embed: vi.fn(async (t: string) => encode(t)),
    embedBatch: vi.fn(async (ts: string[]) => ts.map(encode)),
  };
}

describe('SqliteVecBackend', () => {
  let tmpDir: string;
  let backend: SqliteVecBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-sqlite-vec-'));
    backend = new SqliteVecBackend(
      { dbPath: join(tmpDir, 'test.db') },
      makeKeywordEmbedder(),
    );
  });

  afterEach(() => {
    backend.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('remembers and recalls a memory', async () => {
    const ref = await backend.remember({
      category: 'project',
      title: 'Loom rescue plan',
      content: 'Migrate from Qdrant to sqlite-vec',
    });
    expect(ref.ref).toMatch(/^project\/loom-rescue-plan-/);
    expect(ref.category).toBe('project');

    const results = await backend.recall({ query: 'loom rescue' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Loom rescue plan');
    expect(results[0].relevance).toBeGreaterThan(0);
  });

  it('ranks by semantic similarity', async () => {
    await backend.remember({
      category: 'project',
      title: 'Alpha release',
      content: 'alpha phase 5 shipped',
    });
    await backend.remember({
      category: 'project',
      title: 'Loom migration',
      content: 'loom to sqlite',
    });

    const results = await backend.recall({ query: 'loom', limit: 5 });
    expect(results[0].title).toBe('Loom migration');
  });

  it('filters by category', async () => {
    await backend.remember({
      category: 'project',
      title: 'Loom A',
      content: 'loom work',
    });
    await backend.remember({
      category: 'reference',
      title: 'Loom B',
      content: 'loom docs',
    });

    const proj = await backend.recall({ query: 'loom', category: 'project' });
    expect(proj).toHaveLength(1);
    expect(proj[0].category).toBe('project');

    const ref = await backend.recall({ query: 'loom', category: 'reference' });
    expect(ref).toHaveLength(1);
    expect(ref[0].category).toBe('reference');
  });

  it('filters by project', async () => {
    await backend.remember({
      category: 'project',
      title: 'Loom on alpha-proj',
      content: 'loom integration',
      project: 'alpha',
    });
    await backend.remember({
      category: 'project',
      title: 'Loom on beta-proj',
      content: 'loom support',
      project: 'beta',
    });

    const alpha = await backend.recall({ query: 'loom', project: 'alpha' });
    expect(alpha).toHaveLength(1);
    expect(alpha[0].project).toBe('alpha');
  });

  it('forgets by ref', async () => {
    const { ref } = await backend.remember({
      category: 'project',
      title: 'Gamma import',
      content: 'gamma work',
    });
    const result = await backend.forget({ ref });
    expect(result.deleted).toEqual([ref]);

    const after = await backend.recall({ query: 'gamma' });
    expect(after).toHaveLength(0);
  });

  it('forgets bulk by project', async () => {
    await backend.remember({
      category: 'project',
      title: 'A',
      content: 'loom a',
      project: 'alpha',
    });
    await backend.remember({
      category: 'project',
      title: 'B',
      content: 'loom b',
      project: 'alpha',
    });
    await backend.remember({
      category: 'project',
      title: 'C',
      content: 'loom c',
      project: 'beta',
    });

    const result = await backend.forget({ project: 'alpha' });
    expect(result.deleted).toHaveLength(2);

    const remaining = await backend.recall({ query: 'loom' });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].project).toBe('beta');
  });

  it('updates content and re-embeds', async () => {
    const { ref } = await backend.remember({
      category: 'project',
      title: 'Migration',
      content: 'gamma import',
    });
    const result = await backend.update({
      ref,
      content: 'loom migration complete',
    });
    expect(result.updated).toBe(true);

    const hits = await backend.recall({ query: 'loom', limit: 5 });
    expect(hits[0].content).toBe('loom migration complete');
  });

  it('preserves metadata through update', async () => {
    const { ref } = await backend.remember({
      category: 'project',
      title: 'Meta test',
      content: 'loom',
      metadata: { tier: 1 },
    });
    await backend.update({ ref, metadata: { tier: 2, extra: 'x' } });

    // Read raw row to inspect stored metadata
    const db = backend.getDatabase();
    const row = db
      .prepare('SELECT metadata FROM memories WHERE ref = ?')
      .get(ref) as { metadata: string };
    const meta = JSON.parse(row.metadata);
    expect(meta).toEqual({ tier: 2, extra: 'x' });
  });

  // ── Revision snapshots (t-327) ─────────────────────────────────────────────

  it('snapshots content before update and returns snapshotId', async () => {
    const { ref } = await backend.remember({
      category: 'project',
      title: 'Revisable',
      content: 'original content',
    });
    const result = await backend.update({ ref, content: 'updated content' });
    expect(result.updated).toBe(true);
    expect(result.snapshotId).toBeGreaterThan(0);

    const revisions = await backend.listRevisions(ref);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].op).toBe('update');

    const full = await backend.getRevision(revisions[0].id);
    expect(full?.content).toBe('original content');
  });

  it('does not snapshot when content is unchanged on update', async () => {
    const { ref } = await backend.remember({
      category: 'project',
      title: 'Stable',
      content: 'same content',
    });
    // Update metadata only — content not passed, so no snapshot.
    const result = await backend.update({ ref, metadata: { tag: 'x' } });
    expect(result.updated).toBe(true);
    expect(result.snapshotId).toBeUndefined();

    const revisions = await backend.listRevisions(ref);
    expect(revisions).toHaveLength(0);
  });

  it('can restore a revision and snapshots the displaced body', async () => {
    const { ref } = await backend.remember({
      category: 'project',
      title: 'Rollback target',
      content: 'v1 content',
    });
    await backend.update({ ref, content: 'v2 content' });
    const revisions = await backend.listRevisions(ref);
    expect(revisions).toHaveLength(1);
    const revId = revisions[0].id;

    const restored = await backend.restoreRevision({ ref, revision_id: revId });
    expect(restored.restored).toBe(true);
    expect(restored.snapshot_id).toBeGreaterThan(0);

    // Two snapshots now: 'update' (v1→v2) and 'revision-restore' (v2→v1).
    const after = await backend.listRevisions(ref);
    expect(after).toHaveLength(2);
    const ops = after.map((r) => r.op);
    expect(ops).toContain('update');
    expect(ops).toContain('revision-restore');

    // The live content rolled back to v1.
    const hits = await backend.recall({ query: 'rollback target' });
    const hit = hits.find((h) => h.title === 'Rollback target');
    expect(hit?.content).toBe('v1 content');
  });

  it('prunes revisions beyond the 10-per-memory cap', async () => {
    const { ref } = await backend.remember({
      category: 'project',
      title: 'Capped',
      content: 'v0',
    });
    // Produce 12 updates → 12 snapshots, cap at 10.
    for (let i = 1; i <= 12; i++) {
      await backend.update({ ref, content: `v${i}` });
    }
    const revisions = await backend.listRevisions(ref);
    expect(revisions.length).toBeLessThanOrEqual(10);
  });

  // ── Supersession edge (t-327) ──────────────────────────────────────────────

  it('supersedes an old memory and records the edge', async () => {
    const { ref: oldRef } = await backend.remember({
      category: 'project',
      title: 'Old version',
      content: 'stale content',
    });
    const { ref: newRef } = await backend.remember({
      category: 'project',
      title: 'New version',
      content: 'canonical content',
    });

    const result = await backend.supersede({ old_ref: oldRef, new_ref: newRef, note: 'corrected' });
    expect(result.archived).toBe(true);
    expect(result.old_ref).toBe(oldRef);
    expect(result.new_ref).toBe(newRef);

    // old_ref should no longer appear in recall.
    const hits = await backend.recall({ query: 'stale content' });
    expect(hits.some((h) => h.title === 'Old version')).toBe(false);

    // Supersession edge persists in the DB.
    const db = backend.getDatabase();
    const edge = db
      .prepare('SELECT * FROM memory_supersessions WHERE old_ref = ?')
      .get(oldRef) as { old_ref: string; new_ref: string; note: string } | undefined;
    expect(edge?.new_ref).toBe(newRef);
    expect(edge?.note).toBe('corrected');
  });

  it('supersede on already-archived memory still writes the edge but archived=false', async () => {
    const { ref: oldRef } = await backend.remember({
      category: 'project',
      title: 'Already gone',
      content: 'archived already',
    });
    const { ref: newRef } = await backend.remember({
      category: 'project',
      title: 'New canonical',
      content: 'canonical',
    });
    await backend.archive({ ref: oldRef, note: 'retired' });

    const result = await backend.supersede({ old_ref: oldRef, new_ref: newRef });
    expect(result.archived).toBe(false); // was already archived

    const db = backend.getDatabase();
    const edge = db
      .prepare('SELECT new_ref FROM memory_supersessions WHERE old_ref = ?')
      .get(oldRef) as { new_ref: string } | undefined;
    expect(edge?.new_ref).toBe(newRef);
  });

  it('lists memories', async () => {
    await backend.remember({
      category: 'project',
      title: 'A',
      content: 'loom',
    });
    await backend.remember({
      category: 'reference',
      title: 'B',
      content: 'loom',
    });

    const all = await backend.list({});
    expect(all).toHaveLength(2);

    const projects = await backend.list({ category: 'project' });
    expect(projects).toHaveLength(1);
    expect(projects[0].category).toBe('project');
  });

  it('prunes expired memories by archiving them (not hard-deleting)', async () => {
    // Memory with past expires_at
    const { ref: staleRef } = await backend.remember({
      category: 'reference',
      title: 'Stale',
      content: 'loom',
      ttl: '1h',
    });
    // Manually set expires_at to the past
    const db = backend.getDatabase();
    db.prepare(
      "UPDATE memories SET expires_at = '2020-01-01T00:00:00.000Z' WHERE title = 'Stale'",
    ).run();

    await backend.remember({
      category: 'reference',
      title: 'Fresh',
      content: 'loom',
      ttl: 'permanent',
    });

    const result = await backend.prune();
    expect(result.expired).toHaveLength(1);
    expect(result.expired[0]).toBe(staleRef);

    // Expired memory is excluded from recall — archive hides it from search.
    const remaining = await backend.recall({ query: 'loom' });
    expect(remaining.map((r) => r.title)).toEqual(['Fresh']);

    // But the row must still exist in the DB (archived, not deleted).
    const row = db
      .prepare('SELECT archived, archive_note FROM memories WHERE ref = ?')
      .get(staleRef) as { archived: number; archive_note: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.archived).toBe(1);
    const parsed = JSON.parse(row!.archive_note);
    expect(parsed.note).toBe('TTL elapsed');
    expect(parsed.archived_at).toBeTruthy();

    // Vector slot must be gone (no KNN pollution).
    const memRow = db
      .prepare('SELECT id FROM memories WHERE ref = ?')
      .get(staleRef) as { id: number };
    const vec = db
      .prepare('SELECT rowid FROM vec_memories WHERE rowid = ?')
      .get(BigInt(memRow.id));
    expect(vec).toBeUndefined();
  });

  it('prune dry-run does not archive anything', async () => {
    const { ref } = await backend.remember({
      category: 'reference',
      title: 'DryRunTarget',
      content: 'loom',
      ttl: '1h',
    });
    const db = backend.getDatabase();
    db.prepare(
      "UPDATE memories SET expires_at = '2020-01-01T00:00:00.000Z' WHERE ref = ?",
    ).run(ref);

    const result = await backend.prune({ dryRun: true });
    expect(result.expired).toHaveLength(1);

    // Row must remain active — dry run must not archive.
    const row = db
      .prepare('SELECT archived FROM memories WHERE ref = ?')
      .get(ref) as { archived: number };
    expect(row.archived).toBe(0);
  });

  it('stamps last_accessed on recall', async () => {
    const { ref } = await backend.remember({
      category: 'project',
      title: 'Stamp',
      content: 'loom',
    });

    const db = backend.getDatabase();
    const before = (
      db.prepare('SELECT last_accessed FROM memories WHERE ref = ?').get(ref) as {
        last_accessed: string | null;
      }
    ).last_accessed;
    expect(before).toBeNull();

    await backend.recall({ query: 'loom' });

    const after = (
      db.prepare('SELECT last_accessed FROM memories WHERE ref = ?').get(ref) as {
        last_accessed: string | null;
      }
    ).last_accessed;
    expect(after).not.toBeNull();
  });

  describe('findSimilar', () => {
    it('returns neighbours of a given ref, excluding the ref itself', async () => {
      const { ref: anchor } = await backend.remember({
        category: 'project',
        title: 'Loom rescue',
        content: 'loom migration plan',
      });
      await backend.remember({
        category: 'project',
        title: 'Loom adapter',
        content: 'loom integration',
      });
      await backend.remember({
        category: 'project',
        title: 'Alpha phase 5',
        content: 'alpha shipped',
      });

      const results = await backend.findSimilar({ ref: anchor, limit: 5 });

      expect(results.map((r) => r.title)).not.toContain('Loom rescue');
      expect(results[0].title).toBe('Loom adapter');
    });

    it('returns neighbours of free-form text when no ref is given', async () => {
      await backend.remember({ category: 'project', title: 'A', content: 'loom' });
      await backend.remember({ category: 'project', title: 'B', content: 'alpha' });

      const results = await backend.findSimilar({ text: 'loom work', limit: 5 });
      expect(results[0].title).toBe('A');
    });

    it('honours category + project + minRelevance filters', async () => {
      const { ref: anchor } = await backend.remember({
        category: 'project',
        title: 'Loom anchor',
        content: 'loom',
        project: 'loom',
      });
      await backend.remember({
        category: 'project',
        title: 'Loom sibling',
        content: 'loom',
        project: 'loom',
      });
      await backend.remember({
        category: 'reference',
        title: 'Loom ref',
        content: 'loom',
      });

      const scoped = await backend.findSimilar({
        ref: anchor,
        category: 'project',
        project: 'loom',
        minRelevance: 0.5,
      });
      expect(scoped).toHaveLength(1);
      expect(scoped[0].title).toBe('Loom sibling');
      expect(scoped[0].relevance).toBeGreaterThanOrEqual(0.5);
    });

    it('throws when neither ref nor text is supplied', async () => {
      await expect(backend.findSimilar({})).rejects.toThrow(/ref or text/i);
    });

    it('throws when ref is supplied but the memory is missing', async () => {
      await expect(
        backend.findSimilar({ ref: 'project/does-not-exist' }),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('growing-k recall', () => {
    /** Archive via raw SQL so the vector row survives — simulates legacy
     *  rows archived before delete-on-archive landed. */
    const rawArchive = (ref: string) => {
      backend
        .getDatabase()
        .prepare('UPDATE memories SET archived = 1 WHERE ref = ?')
        .run(ref);
    };

    it('finds live memories buried behind many legacy-archived vectors', async () => {
      // 10 exact-match memories (distance 0) that get archived with their
      // vectors left in place, plus 2 live partial matches ranked deeper.
      for (let i = 0; i < 10; i++) {
        const { ref } = await backend.remember({
          category: 'project',
          title: `Dead ${i}`,
          content: 'loom',
        });
        rawArchive(ref);
      }
      await backend.remember({
        category: 'project',
        title: 'Live A',
        content: 'loom alpha',
      });
      await backend.remember({
        category: 'project',
        title: 'Live B',
        content: 'loom alpha',
      });

      // limit 2 → first round fetches k=8, all archived. The loop must
      // grow k until the live rows surface.
      const hits = await backend.recall({ query: 'loom', limit: 2 });
      expect(hits.map((h) => h.title).sort()).toEqual(['Live A', 'Live B']);
    });

    it('finds narrow-category memories ranked below a wall of other-category rows', async () => {
      for (let i = 0; i < 20; i++) {
        await backend.remember({
          category: 'reference',
          title: `Ref ${i}`,
          content: 'loom',
        });
      }
      await backend.remember({
        category: 'project',
        title: 'Proj A',
        content: 'loom alpha',
      });
      await backend.remember({
        category: 'project',
        title: 'Proj B',
        content: 'loom alpha',
      });

      const hits = await backend.recall({
        query: 'loom',
        category: 'project',
        limit: 2,
      });
      expect(hits.map((h) => h.title).sort()).toEqual(['Proj A', 'Proj B']);
    });

    it('returns fewer than limit without looping forever when matches are exhausted', async () => {
      for (let i = 0; i < 5; i++) {
        const { ref } = await backend.remember({
          category: 'project',
          title: `Gone ${i}`,
          content: 'loom',
        });
        rawArchive(ref);
      }
      await backend.remember({
        category: 'project',
        title: 'Only one',
        content: 'loom alpha',
      });

      const hits = await backend.recall({ query: 'loom', limit: 3 });
      expect(hits).toHaveLength(1);
      expect(hits[0].title).toBe('Only one');
    });

    it('findSimilar grows k past filtered-out candidates', async () => {
      for (let i = 0; i < 20; i++) {
        await backend.remember({
          category: 'reference',
          title: `Ref ${i}`,
          content: 'loom',
        });
      }
      await backend.remember({
        category: 'project',
        title: 'Proj A',
        content: 'loom alpha',
      });
      await backend.remember({
        category: 'project',
        title: 'Proj B',
        content: 'loom alpha',
      });

      // startK = max((2+1)*4, 16) = 16 < 20 reference rows: pre-fix this
      // returned nothing for the project category.
      const hits = await backend.findSimilar({
        text: 'loom',
        category: 'project',
        limit: 2,
      });
      expect(hits.map((h) => h.title).sort()).toEqual(['Proj A', 'Proj B']);
    });

    it('findSimilar by ref grows k past legacy-archived vectors', async () => {
      const { ref: anchor } = await backend.remember({
        category: 'project',
        title: 'Anchor',
        content: 'loom',
      });
      for (let i = 0; i < 16; i++) {
        const { ref } = await backend.remember({
          category: 'project',
          title: `Dead ${i}`,
          content: 'loom',
        });
        rawArchive(ref);
      }
      await backend.remember({
        category: 'project',
        title: 'Live sibling',
        content: 'loom alpha',
      });

      const hits = await backend.findSimilar({ ref: anchor, limit: 2 });
      expect(hits.map((h) => h.title)).toEqual(['Live sibling']);
    });
  });

  describe('audit', () => {
    it('reports counts, category breakdown, stale, duplicates, and expired', async () => {
      const { ref: anchorRef } = await backend.remember({
        category: 'project',
        title: 'Loom anchor',
        content: 'loom work',
      });
      await backend.remember({
        category: 'project',
        title: 'Loom duplicate',
        content: 'loom work',
      });
      await backend.remember({
        category: 'reference',
        title: 'Solo',
        content: 'alpha',
      });
      await backend.remember({
        category: 'reference',
        title: 'Expired',
        content: 'beta',
        ttl: '1h',
      });

      const db = backend.getDatabase();
      // Force one memory to be both stale (old last_accessed) and another expired.
      db.prepare(
        "UPDATE memories SET last_accessed = '2020-01-01T00:00:00.000Z' WHERE ref = ?",
      ).run(anchorRef);
      db.prepare(
        "UPDATE memories SET expires_at = '2020-01-01T00:00:00.000Z' WHERE title = 'Expired'",
      ).run();

      const report = await backend.audit({
        staleDays: 30,
        similarityThreshold: 0.8,
      });

      expect(report.totalMemories).toBe(4);
      expect(report.byCategory).toEqual({ project: 2, reference: 2 });
      expect(report.stale.map((s) => s.title)).toContain('Loom anchor');
      expect(report.expired).toHaveLength(1);
      const dupTitles = report.duplicates.flatMap((p) => [p.a.title, p.b.title]);
      expect(dupTitles).toContain('Loom anchor');
      expect(dupTitles).toContain('Loom duplicate');
    });

    it('excludes TTL=permanent memories from the stale list', async () => {
      const { ref } = await backend.remember({
        category: 'reference',
        title: 'Forever',
        content: 'loom',
        ttl: 'permanent',
      });
      const db = backend.getDatabase();
      db.prepare(
        "UPDATE memories SET last_accessed = '2020-01-01T00:00:00.000Z' WHERE ref = ?",
      ).run(ref);

      const report = await backend.audit({ staleDays: 30 });
      expect(report.stale.map((s) => s.ref)).not.toContain(ref);
    });

    it('caps duplicate pairs at maxDuplicates', async () => {
      for (let i = 0; i < 5; i++) {
        await backend.remember({
          category: 'project',
          title: `dup ${i}`,
          content: 'loom loom loom',
        });
      }
      const report = await backend.audit({
        similarityThreshold: 0.5,
        maxDuplicates: 2,
      });
      expect(report.duplicates.length).toBeLessThanOrEqual(2);
    });

    it('dedupes (a,b) vs (b,a) duplicate pairs', async () => {
      await backend.remember({ category: 'project', title: 'X', content: 'loom' });
      await backend.remember({ category: 'project', title: 'Y', content: 'loom' });

      const report = await backend.audit({ similarityThreshold: 0.5 });
      expect(report.duplicates.length).toBeLessThanOrEqual(1);
    });
  });

  describe('archive and restore', () => {
    it('archives a memory by ref', async () => {
      const { ref } = await backend.remember({
        category: 'project',
        title: 'Loom archive test',
        content: 'loom work',
      });
      const result = await backend.archive({ ref, note: 'superseded' });
      expect(result.archived).toEqual([ref]);
    });

    it('archived memory is excluded from recall', async () => {
      const { ref } = await backend.remember({
        category: 'project',
        title: 'Loom invisible',
        content: 'loom hidden',
      });
      await backend.archive({ ref });

      const hits = await backend.recall({ query: 'loom hidden' });
      expect(hits.map((h) => h.path)).not.toContain(ref);
    });

    it('archived memory is excluded from list', async () => {
      const { ref } = await backend.remember({
        category: 'project',
        title: 'Loom list test',
        content: 'loom',
      });
      await backend.archive({ ref });

      const entries = await backend.list({});
      expect(entries.map((e) => e.ref)).not.toContain(ref);
    });

    it('archived memory is excluded from audit', async () => {
      const { ref } = await backend.remember({
        category: 'project',
        title: 'Loom audit test',
        content: 'loom',
      });
      await backend.archive({ ref });

      const report = await backend.audit();
      const allRefs = [
        ...report.stale.map((s) => s.ref),
        ...report.expired,
        ...report.duplicates.flatMap((d) => [d.a.ref, d.b.ref]),
      ];
      expect(allRefs).not.toContain(ref);
      expect(report.totalMemories).toBe(0);
    });

    it('archives by category+title', async () => {
      await backend.remember({
        category: 'reference',
        title: 'Old reference',
        content: 'hermes',
      });
      const result = await backend.archive({ category: 'reference', title: 'Old reference' });
      expect(result.archived).toHaveLength(1);
      expect(result.archived[0]).toMatch(/^reference\//);
    });

    it('returns empty archived when memory not found', async () => {
      const result = await backend.archive({ ref: 'project/does-not-exist' });
      expect(result.archived).toHaveLength(0);
    });

    it('returns empty archived when memory already archived', async () => {
      const { ref } = await backend.remember({
        category: 'project',
        title: 'Double archive',
        content: 'loom',
      });
      await backend.archive({ ref });
      const second = await backend.archive({ ref });
      expect(second.archived).toHaveLength(0);
    });

    it('persists tombstone note with archived_at timestamp', async () => {
      const { ref } = await backend.remember({
        category: 'project',
        title: 'Tombstone test',
        content: 'loom',
      });
      await backend.archive({ ref, note: 'why retired' });

      const db = backend.getDatabase();
      const row = db
        .prepare('SELECT archived, archive_note FROM memories WHERE ref = ?')
        .get(ref) as { archived: number; archive_note: string };
      expect(row.archived).toBe(1);
      const parsed = JSON.parse(row.archive_note);
      expect(parsed.note).toBe('why retired');
      expect(parsed.archived_at).toBeTruthy();
    });

    it('restores an archived memory by ref', async () => {
      const { ref } = await backend.remember({
        category: 'project',
        title: 'Loom restore test',
        content: 'loom',
      });
      await backend.archive({ ref });

      const result = await backend.restore({ ref });
      expect(result.restored).toEqual([ref]);
    });

    it('restored memory is visible to recall again', async () => {
      const { ref } = await backend.remember({
        category: 'project',
        title: 'Loom resurface',
        content: 'loom restored',
      });
      await backend.archive({ ref });
      await backend.restore({ ref });

      const hits = await backend.recall({ query: 'loom restored' });
      expect(hits.map((h) => h.path)).toContain(ref);
    });

    it('restored memory clears archive_note', async () => {
      const { ref } = await backend.remember({
        category: 'project',
        title: 'Note cleared',
        content: 'loom',
      });
      await backend.archive({ ref, note: 'temp retire' });
      await backend.restore({ ref });

      const db = backend.getDatabase();
      const row = db
        .prepare('SELECT archived, archive_note FROM memories WHERE ref = ?')
        .get(ref) as { archived: number; archive_note: string | null };
      expect(row.archived).toBe(0);
      expect(row.archive_note).toBeNull();
    });

    const vecCount = () =>
      (
        backend
          .getDatabase()
          .prepare('SELECT COUNT(*) AS c FROM vec_memories')
          .get() as { c: number }
      ).c;

    it('archive deletes the vector row but keeps the memory content', async () => {
      const { ref } = await backend.remember({
        category: 'project',
        title: 'Vector hygiene',
        content: 'loom content survives',
      });
      expect(vecCount()).toBe(1);

      await backend.archive({ ref });

      expect(vecCount()).toBe(0);
      const row = backend
        .getDatabase()
        .prepare('SELECT content, archived FROM memories WHERE ref = ?')
        .get(ref) as { content: string; archived: number };
      expect(row.archived).toBe(1);
      expect(row.content).toBe('loom content survives');
    });

    it('restore re-embeds and brings the memory back into recall', async () => {
      const { ref } = await backend.remember({
        category: 'project',
        title: 'Round trip',
        content: 'loom round trip',
      });
      await backend.archive({ ref });
      expect(vecCount()).toBe(0);

      await backend.restore({ ref });

      expect(vecCount()).toBe(1);
      const hits = await backend.recall({ query: 'loom round trip' });
      expect(hits.map((h) => h.path)).toContain(ref);
    });

    it('restore tolerates legacy rows whose vector was never deleted', async () => {
      const { ref } = await backend.remember({
        category: 'project',
        title: 'Legacy archived',
        content: 'loom legacy',
      });
      // Simulate a pre-delete-on-archive row: flag flipped, vector intact.
      backend
        .getDatabase()
        .prepare('UPDATE memories SET archived = 1 WHERE ref = ?')
        .run(ref);
      expect(vecCount()).toBe(1);

      const result = await backend.restore({ ref });
      expect(result.restored).toEqual([ref]);
      expect(vecCount()).toBe(1); // no duplicate rowid, no crash

      const hits = await backend.recall({ query: 'loom legacy' });
      expect(hits.map((h) => h.path)).toContain(ref);
    });

    it('returns empty restored when memory not in archive', async () => {
      const { ref } = await backend.remember({
        category: 'project',
        title: 'Active memory',
        content: 'loom',
      });
      const result = await backend.restore({ ref });
      expect(result.restored).toHaveLength(0);
    });
  });

  describe('MMR diversity re-ranking', () => {
    // Two exact duplicates on "loom alpha" and one memory on "gamma". The query
    // "loom alpha gamma" ranks the duplicates first (0.816) and gamma third
    // (0.577); with the default diversity MMR swaps the second duplicate for gamma.
    async function seed(b: SqliteVecBackend): Promise<void> {
      await b.remember({ category: 'project', title: 'Loom alpha plan', content: 'loom alpha' });
      await b.remember({ category: 'project', title: 'Loom alpha plan (dup)', content: 'loom alpha' });
      await b.remember({ category: 'project', title: 'Gamma note', content: 'gamma' });
    }

    it('displaces a near-duplicate with a less-relevant but different memory', async () => {
      await seed(backend);
      const results = await backend.recall({ query: 'loom alpha gamma', limit: 2 });
      expect(results).toHaveLength(2);
      expect(results[0].title).toMatch(/^Loom alpha plan/);
      expect(results[1].title).toBe('Gamma note');
      expect(results[0].relevance).toBeGreaterThan(results[1].relevance);
    });

    it('diversity: 0 reproduces the pure relevance ranking', async () => {
      await seed(backend);
      const results = await backend.recall({ query: 'loom alpha gamma', limit: 2, diversity: 0 });
      expect(results.map((r) => r.title).sort()).toEqual(['Loom alpha plan', 'Loom alpha plan (dup)']);
    });

    it('leaves the ranking alone when there are no more candidates than limit', async () => {
      await seed(backend);
      const results = await backend.recall({ query: 'loom alpha gamma', limit: 5 });
      expect(results).toHaveLength(3);
      expect(results[2].title).toBe('Gamma note');
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].relevance).toBeGreaterThanOrEqual(results[i].relevance);
      }
    });

    it('still honours category / project filters before re-ranking', async () => {
      await seed(backend);
      await backend.remember({ category: 'user', title: 'Beta pref', content: 'loom beta', project: 'vigil' });
      const byCat = await backend.recall({ query: 'loom alpha gamma', category: 'user', limit: 2 });
      expect(byCat.map((r) => r.title)).toEqual(['Beta pref']);
      const byProj = await backend.recall({ query: 'loom', project: 'vigil', limit: 2 });
      expect(byProj.map((r) => r.title)).toEqual(['Beta pref']);
    });
  });

  describe('recall observation', () => {
    it('reports pool size, returned count, top score and MMR drops to the observer', async () => {
      const seen: import('./types.js').RecallObservation[] = [];
      const observed = new SqliteVecBackend(
        { dbPath: join(tmpDir, 'observed.db'), onRecall: (o) => { seen.push(o); } },
        makeKeywordEmbedder(),
      );
      try {
        await observed.remember({ category: 'project', title: 'A', content: 'loom alpha' });
        await observed.remember({ category: 'project', title: 'A dup', content: 'loom alpha' });
        await observed.remember({ category: 'project', title: 'G', content: 'gamma' });
        const results = await observed.recall({ query: 'loom alpha gamma', limit: 2, category: 'project' });
        expect(seen).toHaveLength(1);
        const o = seen[0];
        expect(o.tool).toBe('recall');
        expect(o.query).toBe('loom alpha gamma');
        expect(o.category).toBe('project');
        expect(o.project).toBeUndefined();
        expect(o.limit).toBe(2);
        expect(o.diversity).toBeCloseTo(0.3);
        expect(o.candidates).toBe(3);
        expect(o.returned).toBe(2);
        expect(o.topScore).toBeCloseTo(results[0].relevance);
        expect(o.threshold).toBeNull();
        expect(o.diversityDrops).toBe(1);
        expect(o.hit).toBe(true);
        expect(o.latencyMs).toBeGreaterThanOrEqual(0);
        expect(Date.parse(o.ts)).not.toBeNaN();

        await observed.recall({ query: 'loom', category: 'nothing-here' });
        expect(seen[1]).toMatchObject({ hit: false, returned: 0, topScore: null, candidates: 0 });
      } finally {
        observed.close();
      }
    });

    it('a throwing observer never fails the search', async () => {
      const angry = new SqliteVecBackend(
        { dbPath: join(tmpDir, 'angry.db'), onRecall: () => { throw new Error('disk full'); } },
        makeKeywordEmbedder(),
      );
      try {
        await angry.remember({ category: 'project', title: 'A', content: 'loom alpha' });
        await expect(angry.recall({ query: 'loom alpha' })).resolves.toHaveLength(1);
      } finally {
        angry.close();
      }
    });
  });
});
