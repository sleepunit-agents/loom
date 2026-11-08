import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { knowledgeMerge } from './knowledge-merge.js';
import { knowledgeWrite } from './knowledge-write.js';
import { createKnowledgeBackend } from '../backends/index.js';

describe('knowledgeMerge', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-km2-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedPage(
    slug: string,
    opts: {
      domain?: string;
      body?: string;
      verified_at?: string;
      freshness_anchor?: string;
      citations?: Array<{ claim: string; source_kind?: 'web' | 'loom_memory' | 'conversation'; source_locator?: string; excerpt: string }>;
    } = {},
  ) {
    const citations = (opts.citations ?? [{ claim: `${slug} fact`, excerpt: `Excerpt for ${slug}` }]).map((c) => ({
      claim: c.claim,
      source_kind: (c.source_kind ?? 'web') as 'web' | 'loom_memory' | 'conversation',
      source_locator: c.source_locator ?? `https://example.com/${slug}`,
      excerpt: c.excerpt,
    }));
    await knowledgeWrite(tempDir, {
      slug,
      domain: opts.domain ?? 'test',
      title: slug,
      body: opts.body ?? `Body for ${slug}`,
      verified_at: opts.verified_at,
      freshness_anchor: opts.freshness_anchor,
      citations,
    });
  }

  // ── Basic merge ─────────────────────────────────────────────────────────────

  it('target survives the merge with correct status', async () => {
    await seedPage('target');
    await seedPage('source');

    const result = await knowledgeMerge(tempDir, {
      source_slugs: ['source'],
      target_slug: 'target',
    });
    expect(result).not.toMatch(/Error/i);

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('target');
      expect(page).not.toBeNull();
      expect(page!.status).toBe('active');
    } finally {
      b.close();
    }
  });

  it('loser is archived after merge', async () => {
    await seedPage('canonical');
    await seedPage('loser');

    await knowledgeMerge(tempDir, { source_slugs: ['loser'], target_slug: 'canonical' });

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('loser');
      expect(page!.status).toBe('archived');
    } finally {
      b.close();
    }
  });

  it('loser tombstone note references target slug', async () => {
    await seedPage('canonical');
    await seedPage('loser');

    await knowledgeMerge(tempDir, {
      source_slugs: ['loser'],
      target_slug: 'canonical',
      note: 'dedup during triage',
    });

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('loser');
      expect(page!.tombstone_note).toMatch(/canonical/);
      expect(page!.tombstone_note).toMatch(/dedup during triage/);
    } finally {
      b.close();
    }
  });

  it('loser tombstone note references target even without caller note', async () => {
    await seedPage('canonical');
    await seedPage('loser');

    await knowledgeMerge(tempDir, { source_slugs: ['loser'], target_slug: 'canonical' });

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('loser');
      expect(page!.tombstone_note).toMatch(/canonical/);
    } finally {
      b.close();
    }
  });

  // ── Supersessions pointer ────────────────────────────────────────────────────

  it('supersessions row is written with loser→target', async () => {
    await seedPage('canonical');
    await seedPage('loser');

    await knowledgeMerge(tempDir, { source_slugs: ['loser'], target_slug: 'canonical' });

    const b = createKnowledgeBackend(tempDir);
    try {
      // @ts-expect-error accessing internal db for test assertion
      const row = b.db.prepare('SELECT * FROM supersessions WHERE old_slug = ?').get('loser');
      expect(row).not.toBeNull();
      expect(row.new_slug).toBe('canonical');
    } finally {
      b.close();
    }
  });

  // ── Citation re-parenting ────────────────────────────────────────────────────

  it('source citations are moved to target', async () => {
    await seedPage('target', { citations: [{ claim: 'target fact', excerpt: 'target excerpt' }] });
    await seedPage('source', { citations: [{ claim: 'source fact', excerpt: 'source excerpt' }] });

    await knowledgeMerge(tempDir, { source_slugs: ['source'], target_slug: 'target' });

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('target');
      const claims = page!.citations.map((c) => c.claim);
      expect(claims).toContain('target fact');
      expect(claims).toContain('source fact');
      expect(page!.citations).toHaveLength(2);
    } finally {
      b.close();
    }
  });

  it('source page has no citations after merge', async () => {
    await seedPage('target');
    await seedPage('source', { citations: [{ claim: 'source fact', excerpt: 'source excerpt' }] });

    await knowledgeMerge(tempDir, { source_slugs: ['source'], target_slug: 'target' });

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('source');
      expect(page!.citations).toHaveLength(0);
    } finally {
      b.close();
    }
  });

  it('duplicate citations are NOT doubled on target', async () => {
    const sharedCitation = {
      claim: 'shared fact',
      source_locator: 'https://example.com/shared',
      excerpt: 'shared excerpt',
    };

    await seedPage('target', { citations: [sharedCitation] });
    await seedPage('source', { citations: [sharedCitation] });

    await knowledgeMerge(tempDir, { source_slugs: ['source'], target_slug: 'target' });

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('target');
      const matching = page!.citations.filter((c) => c.claim === 'shared fact');
      expect(matching).toHaveLength(1);
    } finally {
      b.close();
    }
  });

  it('result reports citations_moved and citations_deduped correctly', async () => {
    const shared = { claim: 'shared', source_locator: 'https://example.com/s', excerpt: 'shared' };
    const unique = { claim: 'unique', source_locator: 'https://example.com/u', excerpt: 'unique' };

    await seedPage('target', { citations: [shared] });
    await seedPage('source', { citations: [shared, unique] });

    const result = await knowledgeMerge(tempDir, { source_slugs: ['source'], target_slug: 'target' });
    // 1 unique citation moved, 1 duplicate removed
    expect(result).toMatch(/1 moved/i);
    expect(result).toMatch(/1 duplicate/i);
  });

  // ── verified_at MAX ──────────────────────────────────────────────────────────

  it('target gets MAX(verified_at) across all pages', async () => {
    // Write directly via backend to control verified_at.
    const b0 = createKnowledgeBackend(tempDir);
    const citation = [{ claim: 'fact', source_kind: 'web' as const, source_locator: 'https://x.com', excerpt: 'e' }];
    try {
      await b0.writePage({ slug: 'target', title: 'target', domain: 'test', body: 'Body', verified_at: '2026-01-01T00:00:00.000Z', citations: citation });
      await b0.writePage({ slug: 'source', title: 'source', domain: 'test', body: 'Body', verified_at: '2026-06-01T00:00:00.000Z', citations: citation });
    } finally {
      b0.close();
    }

    await knowledgeMerge(tempDir, { source_slugs: ['source'], target_slug: 'target' });

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('target');
      expect(page!.verified_at).toBe('2026-06-01T00:00:00.000Z');
    } finally {
      b.close();
    }
  });

  it('target keeps its own verified_at when it is the newest', async () => {
    const b0 = createKnowledgeBackend(tempDir);
    const citation = [{ claim: 'fact', source_kind: 'web' as const, source_locator: 'https://x.com', excerpt: 'e' }];
    try {
      await b0.writePage({ slug: 'target', title: 'target', domain: 'test', body: 'Body', verified_at: '2026-12-01T00:00:00.000Z', citations: citation });
      await b0.writePage({ slug: 'source', title: 'source', domain: 'test', body: 'Body', verified_at: '2026-01-01T00:00:00.000Z', citations: citation });
    } finally {
      b0.close();
    }

    await knowledgeMerge(tempDir, { source_slugs: ['source'], target_slug: 'target' });

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('target');
      expect(page!.verified_at).toBe('2026-12-01T00:00:00.000Z');
    } finally {
      b.close();
    }
  });

  it('verified_at stays null when all pages have no verified_at', async () => {
    await seedPage('target');
    await seedPage('source');
    // Null out verified_at directly — writePage always stamps a timestamp,
    // but migrated/legacy rows may have null verified_at in practice.
    const rawDb = new BetterSqlite3(join(tempDir, 'knowledge.db'));
    rawDb.prepare('UPDATE pages SET verified_at = NULL WHERE slug IN (?, ?)').run('target', 'source');
    rawDb.close();
    await knowledgeMerge(tempDir, { source_slugs: ['source'], target_slug: 'target' });
    const b = createKnowledgeBackend(tempDir);
    try {
      expect((await b.getPage('target'))!.verified_at).toBeNull();
    } finally {
      b.close();
    }
  });

  // ── freshness_anchor ─────────────────────────────────────────────────────────

  it('target freshness_anchor is preserved when set', async () => {
    const b0 = createKnowledgeBackend(tempDir);
    const citation = [{ claim: 'fact', source_kind: 'web' as const, source_locator: 'https://x.com', excerpt: 'e' }];
    try {
      await b0.writePage({ slug: 'target', title: 'target', domain: 'test', body: 'Body', freshness_anchor: 'OS 1.5', citations: citation });
      await b0.writePage({ slug: 'source', title: 'source', domain: 'test', body: 'Body', freshness_anchor: 'OS 2.0', citations: citation });
    } finally {
      b0.close();
    }

    await knowledgeMerge(tempDir, { source_slugs: ['source'], target_slug: 'target' });

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('target');
      expect(page!.freshness_anchor).toBe('OS 1.5');
    } finally {
      b.close();
    }
  });

  it('target gets source freshness_anchor when target has none', async () => {
    const b0 = createKnowledgeBackend(tempDir);
    const citation = [{ claim: 'fact', source_kind: 'web' as const, source_locator: 'https://x.com', excerpt: 'e' }];
    try {
      await b0.writePage({ slug: 'target', title: 'target', domain: 'test', body: 'Body', citations: citation });
      await b0.writePage({ slug: 'source', title: 'source', domain: 'test', body: 'Body', freshness_anchor: 'OS 2.0', citations: citation });
    } finally {
      b0.close();
    }

    await knowledgeMerge(tempDir, { source_slugs: ['source'], target_slug: 'target' });

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('target');
      expect(page!.freshness_anchor).toBe('OS 2.0');
    } finally {
      b.close();
    }
  });

  // ── append_loser_bodies ──────────────────────────────────────────────────────

  it('append_loser_bodies appends source body under section marker', async () => {
    await seedPage('target', { body: 'Target body.' });
    await seedPage('source', { body: 'Source body.' });

    await knowledgeMerge(tempDir, {
      source_slugs: ['source'],
      target_slug: 'target',
      append_loser_bodies: true,
    });

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('target');
      expect(page!.body).toContain('Target body.');
      expect(page!.body).toContain('Source body.');
      expect(page!.body).toContain('--- merged from source ---');
    } finally {
      b.close();
    }
  });

  it('loser bodies returned in result when append_loser_bodies is off', async () => {
    await seedPage('target', { body: 'Target body.' });
    await seedPage('source', { body: 'Source body content.' });

    const result = await knowledgeMerge(tempDir, {
      source_slugs: ['source'],
      target_slug: 'target',
    });

    expect(result).toContain('Source body content.');
  });

  // ── N-way merge ──────────────────────────────────────────────────────────────

  it('merges 3 pages into 1: all sources archived, all unique citations on target', async () => {
    await seedPage('canonical', { citations: [{ claim: 'c1', excerpt: 'e1' }] });
    await seedPage('dup-a', { citations: [{ claim: 'c2', excerpt: 'e2' }] });
    await seedPage('dup-b', { citations: [{ claim: 'c3', excerpt: 'e3' }] });

    const result = await knowledgeMerge(tempDir, {
      source_slugs: ['dup-a', 'dup-b'],
      target_slug: 'canonical',
    });
    expect(result).not.toMatch(/Error/i);

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('canonical');
      expect(page!.citations).toHaveLength(3);
      expect(page!.status).toBe('active');

      expect((await b.getPage('dup-a'))!.status).toBe('archived');
      expect((await b.getPage('dup-b'))!.status).toBe('archived');
    } finally {
      b.close();
    }
  });

  // ── Error cases ──────────────────────────────────────────────────────────────

  it('returns error when target does not exist — no partial mutation', async () => {
    await seedPage('source');
    const result = await knowledgeMerge(tempDir, {
      source_slugs: ['source'],
      target_slug: 'does-not-exist',
    });
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/does-not-exist/);

    // source must be untouched
    const b = createKnowledgeBackend(tempDir);
    try {
      expect((await b.getPage('source'))!.status).toBe('active');
    } finally {
      b.close();
    }
  });

  it('returns error when a source does not exist — no partial mutation', async () => {
    await seedPage('target');
    await seedPage('good-source');
    const result = await knowledgeMerge(tempDir, {
      source_slugs: ['good-source', 'missing-source'],
      target_slug: 'target',
    });
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/missing-source/);

    // good-source must be untouched
    const b = createKnowledgeBackend(tempDir);
    try {
      expect((await b.getPage('good-source'))!.status).toBe('active');
    } finally {
      b.close();
    }
  });

  it('returns error when source_slug equals target_slug', async () => {
    await seedPage('page');
    const result = await knowledgeMerge(tempDir, {
      source_slugs: ['page'],
      target_slug: 'page',
    });
    expect(result).toMatch(/Error/i);
  });

  it('returns error for empty source_slugs', async () => {
    await seedPage('target');
    const result = await knowledgeMerge(tempDir, {
      source_slugs: [],
      target_slug: 'target',
    });
    expect(result).toMatch(/Error/i);
  });

  it('hard_delete_losers: true hard-removes losers after consolidation', async () => {
    await seedPage('target');
    await seedPage('source');
    const result = await knowledgeMerge(tempDir, {
      source_slugs: ['source'],
      target_slug: 'target',
      hard_delete_losers: true,
    });
    expect(result).not.toMatch(/Error/i);
    const b = createKnowledgeBackend(tempDir);
    try {
      expect(await b.getPage('source')).toBeNull();
      expect((await b.getPage('target'))!.status).toBe('active');
    } finally {
      b.close();
    }
  });
});
