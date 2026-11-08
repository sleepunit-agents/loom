import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgePurge } from './knowledge-purge.js';
import { knowledgeWrite } from './knowledge-write.js';
import { knowledgeArchive } from './knowledge-archive.js';
import { knowledgeMerge } from './knowledge-merge.js';
import { createKnowledgeBackend } from '../backends/index.js';

describe('knowledgePurge', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-kp-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function writePage(slug: string, opts: { citations?: boolean } = {}) {
    const citations = opts.citations !== false
      ? [{ claim: `${slug} fact`, source_kind: 'web' as const, source_locator: `https://example.com/${slug}`, excerpt: `Excerpt for ${slug}` }]
      : undefined;
    await knowledgeWrite(tempDir, {
      slug,
      domain: 'test',
      title: slug,
      body: `Body for ${slug}`,
      citations: citations ?? [{ claim: `${slug} fact`, source_kind: 'web' as const, source_locator: `https://example.com/${slug}`, excerpt: `Excerpt for ${slug}` }],
    });
  }

  async function archivePage(slug: string) {
    await knowledgeArchive(tempDir, { slug });
  }

  // ── Test 1: purges archived page — row gone, recall returns null ────────────

  it('purges archived page — row gone, recall returns null', async () => {
    await writePage('my-page');
    await archivePage('my-page');

    const result = await knowledgePurge(tempDir, { slugs: ['my-page'], confirm: true });
    expect(result).not.toMatch(/Error/i);

    const b = createKnowledgeBackend(tempDir);
    try {
      expect(await b.getPage('my-page')).toBeNull();
    } finally {
      b.close();
    }
  });

  // ── Test 2: citations cascade on purge ──────────────────────────────────────

  it('citations cascade on purge', async () => {
    await writePage('page-with-cites');
    await archivePage('page-with-cites');

    const result = await knowledgePurge(tempDir, { slugs: ['page-with-cites'], confirm: true });
    expect(result).not.toMatch(/Error/i);

    const b = createKnowledgeBackend(tempDir);
    try {
      expect(await b.getPage('page-with-cites')).toBeNull();
      // Confirm no citations remain in the DB for this page.
      // @ts-expect-error accessing internal db for test assertion
      const cites = b.db.prepare('SELECT * FROM citations WHERE page_id NOT IN (SELECT id FROM pages)').all();
      expect(cites).toHaveLength(0);
    } finally {
      b.close();
    }
  });

  // ── Test 3: rejects active page (archive-first guard) — no mutation ─────────

  it('rejects active page (archive-first guard) — no mutation', async () => {
    await writePage('active-page');
    // Do NOT archive — leave it active.

    const result = await knowledgePurge(tempDir, { slugs: ['active-page'], confirm: true });
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/not archived/i);

    // Page must still be retrievable.
    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('active-page');
      expect(page).not.toBeNull();
      expect(page!.status).toBe('active');
    } finally {
      b.close();
    }
  });

  // ── Test 4: rejects missing confirm ─────────────────────────────────────────

  it('rejects missing confirm', async () => {
    await writePage('confirm-test');
    await archivePage('confirm-test');

    const result = await knowledgePurge(tempDir, { slugs: ['confirm-test'], confirm: false });
    expect(result).toMatch(/Error/i);
  });

  // ── Test 5: rejects missing slugs ───────────────────────────────────────────

  it('rejects missing slugs', async () => {
    const result = await knowledgePurge(tempDir, { slugs: [], confirm: true });
    expect(result).toMatch(/Error/i);
  });

  // ── Test 6: batch: all archived — all purged ─────────────────────────────────

  it('batch: all archived — all purged', async () => {
    await writePage('batch-a');
    await writePage('batch-b');
    await writePage('batch-c');
    await archivePage('batch-a');
    await archivePage('batch-b');
    await archivePage('batch-c');

    const result = await knowledgePurge(tempDir, {
      slugs: ['batch-a', 'batch-b', 'batch-c'],
      confirm: true,
    });
    expect(result).not.toMatch(/Error/i);

    const b = createKnowledgeBackend(tempDir);
    try {
      expect(await b.getPage('batch-a')).toBeNull();
      expect(await b.getPage('batch-b')).toBeNull();
      expect(await b.getPage('batch-c')).toBeNull();
    } finally {
      b.close();
    }
  });

  // ── Test 7: batch mixed (some active) — rejects entire batch, all-or-nothing ─

  it('batch mixed (some active) — rejects entire batch, all-or-nothing', async () => {
    await writePage('page-a');
    await writePage('page-b');
    await archivePage('page-a'); // archived
    // page-b stays active

    const result = await knowledgePurge(tempDir, {
      slugs: ['page-a', 'page-b'],
      confirm: true,
    });
    expect(result).toMatch(/Error/i);

    // page-a must still exist (not deleted by partial batch).
    const b = createKnowledgeBackend(tempDir);
    try {
      const pageA = await b.getPage('page-a');
      expect(pageA).not.toBeNull();
      expect(pageA!.status).toBe('archived');
    } finally {
      b.close();
    }
  });

  // ── Test 8: supersessions rows survive purge ─────────────────────────────────

  it('supersessions rows survive purge', async () => {
    // Write a page that will be superseded (creating a supersession row), then purge it.
    await writePage('old-page');
    await writePage('new-page');

    // Manually insert a supersession row and archive old-page.
    const b0 = createKnowledgeBackend(tempDir);
    try {
      // @ts-expect-error accessing internal db for test setup
      b0.db.prepare(
        'INSERT INTO supersessions (old_slug, new_slug, note, created) VALUES (?, ?, ?, ?)',
      ).run('old-page', 'new-page', 'test supersession', new Date().toISOString());
    } finally {
      b0.close();
    }
    await archivePage('old-page');

    const result = await knowledgePurge(tempDir, { slugs: ['old-page'], confirm: true });
    expect(result).not.toMatch(/Error/i);

    // Supersession row must still exist.
    const b = createKnowledgeBackend(tempDir);
    try {
      // @ts-expect-error accessing internal db for test assertion
      const row = b.db.prepare('SELECT * FROM supersessions WHERE old_slug = ?').get('old-page');
      expect(row).not.toBeNull();
      expect(row.new_slug).toBe('new-page');
    } finally {
      b.close();
    }
  });

  // ── Test 9: merge with hard_delete_losers: true — loser is gone after merge ──

  it('merge with hard_delete_losers: true — loser is gone after merge', async () => {
    await writePage('target');
    await writePage('source');

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

  // ── Test 10: merge with hard_delete_losers: true — supersessions pointer survives ─

  it('merge with hard_delete_losers: true — supersessions pointer survives', async () => {
    await writePage('target2');
    await writePage('source2');

    await knowledgeMerge(tempDir, {
      source_slugs: ['source2'],
      target_slug: 'target2',
      hard_delete_losers: true,
    });

    const b = createKnowledgeBackend(tempDir);
    try {
      // @ts-expect-error accessing internal db for test assertion
      const row = b.db.prepare('SELECT * FROM supersessions WHERE old_slug = ?').get('source2');
      expect(row).not.toBeNull();
      expect(row.new_slug).toBe('target2');
    } finally {
      b.close();
    }
  });

  // ── Test 11: merge with hard_delete_losers: false — loser still archived ─────

  it('merge with hard_delete_losers: false — loser still archived (not deleted)', async () => {
    await writePage('target3');
    await writePage('loser3');

    await knowledgeMerge(tempDir, {
      source_slugs: ['loser3'],
      target_slug: 'target3',
      hard_delete_losers: false,
    });

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('loser3');
      expect(page).not.toBeNull();
      expect(page!.status).toBe('archived');
    } finally {
      b.close();
    }
  });
});
