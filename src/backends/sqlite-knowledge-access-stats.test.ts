/**
 * Per-identity access stats (t-677): knowledge_access rows are additive to
 * the shared pages.hit_count / last_accessed aggregate — never a replacement.
 * getPage / queryPages stamping with different identities must produce
 * independent per-identity counters while the aggregate still reflects
 * total reads across all identities.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteKnowledgeBackend } from './sqlite-knowledge.js';

describe('SqliteKnowledgeBackend — per-identity access stats', () => {
  let tmpDir: string;
  let backend: SqliteKnowledgeBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-know-access-'));
    backend = new SqliteKnowledgeBackend({ dbPath: join(tmpDir, 'knowledge.db') });
  });

  afterEach(() => {
    backend.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seed(slug: string) {
    await backend.writePage({
      slug,
      title: slug,
      domain: 'test',
      body: `Body of ${slug}`,
      citations: [{ claim: 'x', source_kind: 'web', excerpt: 'x' }],
    });
    const page = await backend.getPage(slug);
    return page!.id;
  }

  it('getPage stampAccess records a per-identity row and bumps the shared aggregate', async () => {
    await seed('p1');

    await backend.getPage('p1', { stampAccess: true, identity: 'art' });
    await backend.getPage('p1', { stampAccess: true, identity: 'art' });
    await backend.getPage('p1', { stampAccess: true, identity: 'mark' });

    const page = await backend.getPage('p1');
    expect(page!.hit_count).toBe(3); // shared aggregate: all reads, any identity

    const stats = await backend.getAccessStats(page!.id);
    const byIdentity = Object.fromEntries(stats.map((s) => [s.identity, s.hit_count]));
    expect(byIdentity.art).toBe(2);
    expect(byIdentity.mark).toBe(1);
    expect(stats.every((s) => s.last_accessed)).toBe(true);
  });

  it('defaults to "unknown" identity when none is passed, without breaking the aggregate', async () => {
    await seed('p2');
    await backend.getPage('p2', { stampAccess: true });
    const page = await backend.getPage('p2');
    expect(page!.hit_count).toBe(1);
    const stats = await backend.getAccessStats(page!.id);
    expect(stats).toEqual([{ identity: 'unknown', hit_count: 1, last_accessed: expect.any(String) }]);
  });

  it('queryPages stamps every returned page for the given identity', async () => {
    await seed('p3');
    await seed('p4');

    await backend.queryPages({ query: 'Body', identity: 'mark' });

    const p3 = await backend.getPage('p3');
    const statsP3 = await backend.getAccessStats(p3!.id);
    expect(statsP3).toEqual([{ identity: 'mark', hit_count: 1, last_accessed: expect.any(String) }]);
  });

  it('queryPages with stampAccess: false records nothing (index browsing)', async () => {
    await seed('p5');
    await backend.queryPages({ query: 'Body', identity: 'mark', stampAccess: false });
    const p5 = await backend.getPage('p5');
    expect(p5!.hit_count).toBe(0);
    expect(await backend.getAccessStats(p5!.id)).toEqual([]);
  });
});
