import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeMove } from './knowledge-move.js';
import { knowledgeWrite } from './knowledge-write.js';
import { createKnowledgeBackend } from '../backends/index.js';

describe('knowledgeMove', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-km-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedPage(slug: string, domain = 'test', title?: string) {
    await knowledgeWrite(tempDir, {
      slug,
      domain,
      title: title ?? slug,
      body: `Body for ${slug}`,
      citations: [
        {
          claim: `${slug} fact`,
          source_kind: 'web',
          source_locator: `https://example.com/${slug}`,
          excerpt: `Excerpt for ${slug}`,
        },
      ],
    });
  }

  // ── Single-page: re-domain ──────────────────────────────────────────────────

  it('re-domain changes domain only, slug/uuid/citations/verified_at unchanged', async () => {
    await seedPage('syntakt', 'gear/elektron');

    const before = await (async () => {
      const b = createKnowledgeBackend(tempDir);
      try { return await b.getPage('syntakt'); } finally { b.close(); }
    })();

    const result = await knowledgeMove(tempDir, { slug: 'syntakt', new_domain: 'instruments/elektron' });
    expect(result).not.toMatch(/Error/i);

    const b = createKnowledgeBackend(tempDir);
    try {
      const after = await b.getPage('syntakt');
      expect(after).not.toBeNull();
      expect(after!.domain).toBe('instruments/elektron');
      expect(after!.slug).toBe('syntakt');
      expect(after!.uuid).toBe(before!.uuid);
      expect(after!.citations).toHaveLength(1);
    } finally {
      b.close();
    }
  });

  it('re-domain does not write a supersessions pointer', async () => {
    await seedPage('syntakt', 'gear/elektron');
    await knowledgeMove(tempDir, { slug: 'syntakt', new_domain: 'instruments/elektron' });

    const result = await knowledgeMove(tempDir, { slug: 'syntakt', new_domain: 'instruments/elektron' });
    // No pointer message
    expect(result).not.toMatch(/supersession/i);
  });

  // ── Single-page: re-slug ────────────────────────────────────────────────────

  it('re-slug changes slug, preserves uuid/citations', async () => {
    await seedPage('old-slug');

    const before = await (async () => {
      const b = createKnowledgeBackend(tempDir);
      try { return await b.getPage('old-slug'); } finally { b.close(); }
    })();

    await knowledgeMove(tempDir, { slug: 'old-slug', new_slug: 'new-slug' });

    const b = createKnowledgeBackend(tempDir);
    try {
      const after = await b.getPage('new-slug');
      expect(after).not.toBeNull();
      expect(after!.uuid).toBe(before!.uuid);
      expect(after!.citations).toHaveLength(1);
      expect(after!.citations[0].claim).toBe('old-slug fact');
      // Old slug no longer resolves
      const old = await b.getPage('old-slug');
      expect(old).toBeNull();
    } finally {
      b.close();
    }
  });

  it('re-slug writes a supersessions pointer by default', async () => {
    await seedPage('alpha');
    await knowledgeMove(tempDir, { slug: 'alpha', new_slug: 'alpha-v2' });

    const b = createKnowledgeBackend(tempDir);
    try {
      // @ts-expect-error accessing internal db for test assertion
      const row = b.db.prepare('SELECT * FROM supersessions WHERE old_slug = ?').get('alpha');
      expect(row).not.toBeNull();
      expect(row.new_slug).toBe('alpha-v2');
    } finally {
      b.close();
    }
  });

  it('re-slug with leave_pointer=false writes no supersessions row', async () => {
    await seedPage('beta');
    await knowledgeMove(tempDir, { slug: 'beta', new_slug: 'beta-v2', leave_pointer: false });

    const b = createKnowledgeBackend(tempDir);
    try {
      // @ts-expect-error accessing internal db for test assertion
      const row = b.db.prepare('SELECT * FROM supersessions WHERE old_slug = ?').get('beta');
      expect(row).toBeUndefined();
    } finally {
      b.close();
    }
  });

  it('re-slug collision is rejected with actionable error and no mutation', async () => {
    await seedPage('page-a');
    await seedPage('page-b');

    const result = await knowledgeMove(tempDir, { slug: 'page-a', new_slug: 'page-b' });
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/page-b/);
    expect(result).toMatch(/merge/i);

    // page-a must still exist and be unchanged
    const b = createKnowledgeBackend(tempDir);
    try {
      const p = await b.getPage('page-a');
      expect(p).not.toBeNull();
      expect(p!.slug).toBe('page-a');
    } finally {
      b.close();
    }
  });

  it('re-slug and re-domain simultaneously applies both changes', async () => {
    await seedPage('old-name', 'old-domain');

    await knowledgeMove(tempDir, { slug: 'old-name', new_slug: 'new-name', new_domain: 'new-domain' });

    const b = createKnowledgeBackend(tempDir);
    try {
      const p = await b.getPage('new-name');
      expect(p).not.toBeNull();
      expect(p!.domain).toBe('new-domain');
      expect(await b.getPage('old-name')).toBeNull();
    } finally {
      b.close();
    }
  });

  it('returns error when slug does not exist', async () => {
    const result = await knowledgeMove(tempDir, { slug: 'no-such-page', new_domain: 'x' });
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/no-such-page/);
  });

  it('returns error when neither new_slug nor new_domain is provided', async () => {
    await seedPage('lonely');
    const result = await knowledgeMove(tempDir, { slug: 'lonely' });
    expect(result).toMatch(/Error/i);
  });

  // ── Recall integration ──────────────────────────────────────────────────────

  it('recall finds page under new domain after re-domain', async () => {
    await seedPage('syntakt', 'gear/elektron');
    await knowledgeMove(tempDir, { slug: 'syntakt', new_domain: 'instruments/elektron' });

    const b = createKnowledgeBackend(tempDir);
    try {
      const results = await b.queryPages({ query: 'syntakt', excludeStatus: 'archived' });
      expect(results.map((p) => p.slug)).toContain('syntakt');
      expect(results.find((p) => p.slug === 'syntakt')!.domain).toBe('instruments/elektron');
    } finally {
      b.close();
    }
  });

  it('recall finds page under new slug and not old slug', async () => {
    await seedPage('old-rings');
    await knowledgeMove(tempDir, { slug: 'old-rings', new_slug: 'rings-canonical' });

    const b = createKnowledgeBackend(tempDir);
    try {
      const results = await b.queryPages({ query: 'rings', excludeStatus: 'archived' });
      expect(results.map((p) => p.slug)).toContain('rings-canonical');
      expect(results.map((p) => p.slug)).not.toContain('old-rings');
    } finally {
      b.close();
    }
  });

  // ── Batch by slug list ──────────────────────────────────────────────────────

  it('batch by slugs re-domains all listed pages atomically', async () => {
    await seedPage('page-1', 'old-domain');
    await seedPage('page-2', 'old-domain');
    await seedPage('page-3', 'old-domain');

    const result = await knowledgeMove(tempDir, {
      slugs: ['page-1', 'page-2', 'page-3'],
      new_domain: 'new-domain',
    });
    expect(result).not.toMatch(/Error/i);

    const b = createKnowledgeBackend(tempDir);
    try {
      for (const slug of ['page-1', 'page-2', 'page-3']) {
        const p = await b.getPage(slug);
        expect(p!.domain).toBe('new-domain');
      }
    } finally {
      b.close();
    }
  });

  it('batch by slugs rolls back entirely when one slug is missing', async () => {
    await seedPage('good-page', 'original-domain');

    const result = await knowledgeMove(tempDir, {
      slugs: ['good-page', 'missing-page'],
      new_domain: 'new-domain',
    });
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/missing-page/);

    // good-page must be unchanged (rollback)
    const b = createKnowledgeBackend(tempDir);
    try {
      const p = await b.getPage('good-page');
      expect(p!.domain).toBe('original-domain');
    } finally {
      b.close();
    }
  });

  // ── Batch by domain prefix ──────────────────────────────────────────────────

  it('prefix batch re-domains exact match and all children', async () => {
    await seedPage('page-a', 'gear/elektron');
    await seedPage('page-b', 'gear/elektron/drums');
    await seedPage('page-c', 'gear/elektron/synths/mono');
    await seedPage('unrelated', 'gear/moog');

    const result = await knowledgeMove(tempDir, {
      from_domain_prefix: 'gear/elektron',
      to_domain_prefix: 'instruments/elektron',
    });
    expect(result).not.toMatch(/Error/i);

    const b = createKnowledgeBackend(tempDir);
    try {
      expect((await b.getPage('page-a'))!.domain).toBe('instruments/elektron');
      expect((await b.getPage('page-b'))!.domain).toBe('instruments/elektron/drums');
      expect((await b.getPage('page-c'))!.domain).toBe('instruments/elektron/synths/mono');
      // Unrelated page is untouched
      expect((await b.getPage('unrelated'))!.domain).toBe('gear/moog');
    } finally {
      b.close();
    }
  });

  // t-415 review (loom#127): prefix mode is NOT idempotent when the target
  // prefix extends the source — a repeat call matches the already-moved pages
  // again. This is why knowledge_move must not advertise idempotentHint.
  it('repeating a prefix move into a child of itself nests again (not idempotent)', async () => {
    await seedPage('mixer', 'music');

    const args = { from_domain_prefix: 'music', to_domain_prefix: 'music/gear' };
    expect(await knowledgeMove(tempDir, args)).not.toMatch(/Error/i);
    expect(await knowledgeMove(tempDir, args)).not.toMatch(/Error/i);

    const b = createKnowledgeBackend(tempDir);
    try {
      expect((await b.getPage('mixer'))!.domain).toBe('music/gear/gear');
    } finally {
      b.close();
    }
  });

  it('prefix batch reports 0 when no pages match prefix', async () => {
    await seedPage('something', 'other/domain');
    const result = await knowledgeMove(tempDir, {
      from_domain_prefix: 'nonexistent/prefix',
      to_domain_prefix: 'new/prefix',
    });
    expect(result).toMatch(/No pages matched/i);
  });

  it('prefix batch rejects when from and to prefixes are the same', async () => {
    const result = await knowledgeMove(tempDir, {
      from_domain_prefix: 'same/prefix',
      to_domain_prefix: 'same/prefix',
    });
    expect(result).toMatch(/Error/i);
  });
});
