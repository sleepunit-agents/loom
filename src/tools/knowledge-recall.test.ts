import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeRecall } from './knowledge-recall.js';
import { knowledgeWrite } from './knowledge-write.js';
import { createKnowledgeBackend } from '../backends/index.js';

describe('knowledgeRecall', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-kr-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedPage(slug: string, domain: string, title: string, body: string) {
    await knowledgeWrite(tempDir, {
      slug,
      domain,
      title,
      body,
      citations: [
        {
          claim: `${title} fact`,
          source_kind: 'web',
          source_locator: `https://example.com/${slug}`,
          excerpt: body.slice(0, 100),
        },
      ],
    });
  }

  it('returns a no-results message when store is empty', async () => {
    const result = await knowledgeRecall(tempDir, { query: 'anything' });
    expect(result).toMatch(/No knowledge pages found/);
  });

  it('finds pages matching query in body', async () => {
    await seedPage('rings', 'music/eurorack', 'Rings', 'Physical modelling resonator for eurorack.');
    await seedPage('plaits', 'music/eurorack', 'Plaits', 'Macro-oscillator with 16 synthesis engines.');

    const result = await knowledgeRecall(tempDir, { query: 'resonator' });
    expect(result).toMatch(/Rings/);
    expect(result).not.toMatch(/Plaits/);
  });

  it('finds pages matching query in title', async () => {
    await seedPage('rings', 'music/eurorack', 'Rings Resonator Module', 'Details about the module.');
    await seedPage('plaits', 'music/eurorack', 'Plaits Macro-Oscillator', 'Details about oscillation.');

    const result = await knowledgeRecall(tempDir, { query: 'Rings' });
    expect(result).toMatch(/Rings/);
    expect(result).not.toMatch(/Plaits/);
  });

  it('increments hit_count and stamps last_accessed on recall (tested AC)', async () => {
    await seedPage('rings', 'music/eurorack', 'Rings', 'Physical modelling resonator.');

    const backend = createKnowledgeBackend(tempDir);
    try {
      const before = await backend.getPage('rings');
      expect(before!.hit_count).toBe(0);
      expect(before!.last_accessed).toBeNull();
    } finally {
      backend.close();
    }

    await knowledgeRecall(tempDir, { query: 'resonator' });

    const backend2 = createKnowledgeBackend(tempDir);
    try {
      const after = await backend2.getPage('rings');
      expect(after!.hit_count).toBe(1);
      expect(after!.last_accessed).not.toBeNull();
    } finally {
      backend2.close();
    }
  });

  it('increments hit_count in a transaction — multiple recalls accumulate correctly', async () => {
    await seedPage('rings', 'music/eurorack', 'Rings', 'Physical modelling resonator.');

    await knowledgeRecall(tempDir, { query: 'resonator' });
    await knowledgeRecall(tempDir, { query: 'modelling' });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('rings');
      expect(page!.hit_count).toBe(2);
    } finally {
      backend.close();
    }
  });

  it('does not surface archived pages', async () => {
    await seedPage('archived-page', 'test', 'Archived', 'This is archived.');

    // Manually archive it
    const backend = createKnowledgeBackend(tempDir);
    try {
      const db = (backend as unknown as { ensureOpen(): unknown })['ensureOpen']() as {
        prepare(sql: string): { run(...args: unknown[]): unknown };
      };
      db.prepare("UPDATE pages SET status = 'archived' WHERE slug = ?").run('archived-page');
    } finally {
      backend.close();
    }

    const result = await knowledgeRecall(tempDir, { query: 'archived' });
    expect(result).toMatch(/No knowledge pages found/);
  });

  it('filters by domain prefix', async () => {
    await seedPage('rings', 'music/eurorack', 'Rings', 'Resonator.');
    await seedPage('python-basics', 'programming/python', 'Python', 'A language.');

    const result = await knowledgeRecall(tempDir, { domain: 'music' });
    expect(result).toMatch(/Rings/);
    expect(result).not.toMatch(/Python/);
  });

  it('returns all pages when no query given (browsing)', async () => {
    await seedPage('page-a', 'test', 'Alpha', 'First page.');
    await seedPage('page-b', 'test', 'Beta', 'Second page.');

    const result = await knowledgeRecall(tempDir, {});
    expect(result).toMatch(/Alpha/);
    expect(result).toMatch(/Beta/);
  });

  // ── Regression: single-letter / roman-numeral tokens must never be dropped ──
  // Searching for "Digitakt I" must surface "Elektron Digitakt I" even though 'I'
  // is a single-letter token. A query builder that stopwords or min-length-filters
  // short tokens would silently turn "Digitakt I" into "Digitakt", causing
  // "Elektron Digitakt I" to appear absent when drowned out by higher-hit-count pages.

  it('bare "I" token query returns pages titled with that roman numeral', async () => {
    await seedPage('digitakt-i', 'music/gear', 'Elektron Digitakt I', 'The original Digitakt drum computer.');
    await seedPage('unrelated', 'other', 'Unrelated', 'No roman numerals here.');

    const result = await knowledgeRecall(tempDir, { query: 'I' });
    expect(result).toMatch(/Elektron Digitakt I/);
  });

  it('"Digitakt I" query includes the "Elektron Digitakt I" page — I token not dropped', async () => {
    await seedPage('digitakt-i', 'music/gear', 'Elektron Digitakt I', 'The original Digitakt drum computer.');
    await seedPage('digitakt-ii', 'music/gear', 'Elektron Digitakt II', 'The second-generation Digitakt.');

    const result = await knowledgeRecall(tempDir, { query: 'Digitakt I' });
    expect(result).toMatch(/Elektron Digitakt I/);
  });

  it('"Digitakt II" query includes the "Elektron Digitakt II" page — II token not dropped', async () => {
    await seedPage('digitakt-i', 'music/gear', 'Elektron Digitakt I', 'The original Digitakt drum computer.');
    await seedPage('digitakt-ii', 'music/gear', 'Elektron Digitakt II', 'The second-generation Digitakt.');

    const result = await knowledgeRecall(tempDir, { query: 'Digitakt II' });
    expect(result).toMatch(/Elektron Digitakt II/);
  });

  // ── Tiered recall: index vs full ──

  it('browse without query defaults to index tier (no bodies, no citations)', async () => {
    await seedPage('page-a', 'test', 'Alpha', 'First page body that should not appear in full.');
    await seedPage('page-b', 'test', 'Beta', 'Second page body.');

    const result = await knowledgeRecall(tempDir, {});
    expect(result).toMatch(/Knowledge index — 2 pages/);
    expect(result).toMatch(/`page-a`/);
    expect(result).toMatch(/`page-b`/);
    // Index shows a snippet, not the full formatted page with citations.
    expect(result).not.toMatch(/\*\*Citations:\*\*/);
  });

  it('query defaults to full tier (whole pages with citations)', async () => {
    await seedPage('rings', 'music/eurorack', 'Rings', 'Physical modelling resonator.');

    const result = await knowledgeRecall(tempDir, { query: 'resonator' });
    expect(result).toMatch(/Knowledge recall — 1 result/);
    expect(result).toMatch(/Physical modelling resonator\./);
    expect(result).toMatch(/\*\*Citations:\*\*/);
  });

  it('detail overrides the default in both directions', async () => {
    await seedPage('rings', 'music/eurorack', 'Rings', 'Physical modelling resonator.');

    const indexed = await knowledgeRecall(tempDir, { query: 'resonator', detail: 'index' });
    expect(indexed).toMatch(/Knowledge index/);
    expect(indexed).not.toMatch(/\*\*Citations:\*\*/);

    const full = await knowledgeRecall(tempDir, { detail: 'full' });
    expect(full).toMatch(/Knowledge recall/);
    expect(full).toMatch(/\*\*Citations:\*\*/);
  });

  it('index tier does NOT stamp hit_count or last_accessed', async () => {
    await seedPage('rings', 'music/eurorack', 'Rings', 'Physical modelling resonator.');

    await knowledgeRecall(tempDir, { query: 'resonator', detail: 'index' });
    await knowledgeRecall(tempDir, {}); // browse → index default

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('rings');
      expect(page!.hit_count).toBe(0);
      expect(page!.last_accessed).toBeNull();
    } finally {
      backend.close();
    }
  });

  it('full tier output is size-guarded — overflow degrades to index entries', async () => {
    const bigBody = `Opening line of a very large page. ${'x'.repeat(15_000)}`;
    await seedPage('big-1', 'test', 'Big One', bigBody);
    await seedPage('big-2', 'test', 'Big Two', bigBody);
    await seedPage('big-3', 'test', 'Big Three', bigBody);

    const result = await knowledgeRecall(tempDir, { query: 'Opening line', detail: 'full' });
    // First page is always rendered in full; the budget (24k chars) admits
    // one 15k page but not two, so at least one match must degrade.
    expect(result).toMatch(/output budget reached/);
    expect(result).toMatch(/more match/);
    // Every match is still visible — full or as an index entry.
    for (const slug of ['big-1', 'big-2', 'big-3']) {
      expect(result).toContain(slug);
    }
    // Hard ceiling: nowhere near 3 × 15k.
    expect(result.length).toBeLessThan(30_000);
  });

  it('single oversized page is never truncated when it is the only full result', async () => {
    const bigBody = `Huge page. ${'y'.repeat(30_000)}`;
    await seedPage('huge', 'test', 'Huge', bigBody);

    const result = await knowledgeRecall(tempDir, { query: 'Huge page' });
    expect(result).toContain(bigBody);
  });

  // ── Domain filter: prefix must include the exact domain ──

  it('domain filter matches pages whose domain equals the filter exactly', async () => {
    await seedPage('exact', 'music/gear/elektron', 'Exact Domain Page', 'Lives at the exact domain.');
    await seedPage('nested', 'music/gear/elektron/deep', 'Nested Page', 'Lives below it.');
    await seedPage('other', 'music/theory', 'Other Page', 'Unrelated domain.');

    const result = await knowledgeRecall(tempDir, { domain: 'music/gear/elektron', detail: 'index' });
    expect(result).toMatch(/`exact`/);
    expect(result).toMatch(/`nested`/);
    expect(result).not.toMatch(/`other`/);
  });

  describe('slug lookup', () => {
    it('fetches exactly the named page even when other pages mention its terms', async () => {
      // The original failure: the Digitone II page mentions "Syntakt" in its
      // body and outranks the actual Syntakt page on hit_count.
      await seedPage('syntakt-config', 'test', 'Syntakt Config', 'Syntakt settings live here.');
      await seedPage('digitone-config', 'test', 'Digitone Config', 'Unlike Syntakt, balanced inputs. Syntakt Config Reference mentioned.');

      const result = await knowledgeRecall(tempDir, { slug: 'syntakt-config' });
      expect(result).toContain('`syntakt-config`');
      expect(result).toContain('Syntakt settings live here.');
      expect(result).not.toContain('`digitone-config`');
    });

    it('stamps access on slug reads (a slug fetch is a real read)', async () => {
      await seedPage('page', 'test', 'Page', 'Body.');
      await knowledgeRecall(tempDir, { slug: 'page' });

      const b = createKnowledgeBackend(tempDir);
      try {
        expect((await b.getPage('page'))!.hit_count).toBe(1);
      } finally {
        b.close();
      }
    });

    it('reports an unknown slug as not found', async () => {
      const result = await knowledgeRecall(tempDir, { slug: 'ghost' });
      expect(result).toMatch(/No knowledge page found/i);
      expect(result).toContain('ghost');
    });

    it('does not surface archived pages by slug, and says why', async () => {
      await seedPage('retired', 'test', 'Retired', 'Old body.');
      const b = createKnowledgeBackend(tempDir);
      try {
        await b.archivePage({ slug: 'retired' });
      } finally {
        b.close();
      }

      const result = await knowledgeRecall(tempDir, { slug: 'retired' });
      expect(result).not.toContain('Old body.');
      expect(result).toMatch(/archived/);
    });

    it('slug takes precedence over query', async () => {
      await seedPage('alpha', 'test', 'Alpha', 'Alpha body.');
      await seedPage('beta', 'test', 'Beta', 'Beta body.');

      const result = await knowledgeRecall(tempDir, { slug: 'alpha', query: 'Beta' });
      expect(result).toContain('Alpha body.');
      expect(result).not.toContain('Beta body.');
    });
  });

  describe('sort_by_verified', () => {
    it('orders never-verified then stalest-first and shows verified stamps', async () => {
      await seedPage('fresh', 'test', 'Fresh', 'Recently verified page.');
      await seedPage('stale', 'test', 'Stale', 'Long-unverified page.');
      await seedPage('never', 'test', 'Never', 'Never-verified page.');

      const b = createKnowledgeBackend(tempDir);
      try {
        await b.verifyPages({ slug: 'fresh', verified_at: '2026-06-01T00:00:00.000Z' });
        await b.verifyPages({ slug: 'stale', verified_at: '2025-01-01T00:00:00.000Z' });
        const raw = (b as unknown as { ensureOpen(): { prepare(sql: string): { run(...args: unknown[]): unknown } } })['ensureOpen']();
        raw.prepare('UPDATE pages SET verified_at = NULL WHERE slug = ?').run('never');
      } finally {
        b.close();
      }

      const result = await knowledgeRecall(tempDir, { sort_by_verified: true, detail: 'index' });
      const neverPos = result.indexOf('`never`');
      const stalePos = result.indexOf('`stale`');
      const freshPos = result.indexOf('`fresh`');
      expect(neverPos).toBeGreaterThan(-1);
      expect(neverPos).toBeLessThan(stalePos);
      expect(stalePos).toBeLessThan(freshPos);

      // Index entries carry the verification stamp so the verifier can
      // apply its SLA filter without reading whole pages.
      expect(result).toContain('verified: never');
      expect(result).toContain('verified: 2025-01-01');
    });

    it('does not show verified stamps on normal browsing', async () => {
      await seedPage('page', 'test', 'Page', 'A page.');
      const result = await knowledgeRecall(tempDir, { detail: 'index' });
      expect(result).not.toContain('verified:');
    });
  });

  // ── Recall-miss logging ─────────────────────────────────────────────────────

  describe('recall-miss logging', () => {
    let gapsDir: string;

    beforeEach(() => {
      gapsDir = mkdtempSync(join(tmpdir(), 'loom-gaps-'));
    });
    afterEach(() => {
      rmSync(gapsDir, { recursive: true, force: true });
    });

    const missFile = () => join(gapsDir, 'recall-miss.jsonl');

    function readMisses(): Array<{ query: string | null; slug: string | null; at: string }> {
      if (!existsSync(missFile())) return [];
      return readFileSync(missFile(), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    }

    it('appends a query miss entry when a query returns no results', async () => {
      await knowledgeRecall(tempDir, { query: 'nonexistent topic' }, gapsDir);
      const misses = readMisses();
      expect(misses).toHaveLength(1);
      expect(misses[0].query).toBe('nonexistent topic');
      expect(misses[0].slug).toBeNull();
      expect(misses[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('appends a slug miss entry when an exact-slug lookup finds nothing', async () => {
      await knowledgeRecall(tempDir, { slug: 'no-such-page' }, gapsDir);
      const misses = readMisses();
      expect(misses).toHaveLength(1);
      expect(misses[0].slug).toBe('no-such-page');
      expect(misses[0].query).toBeNull();
    });

    it('does NOT log a miss when a query returns results', async () => {
      await seedPage('rings', 'music', 'Rings', 'Resonator module.');
      await knowledgeRecall(tempDir, { query: 'resonator' }, gapsDir);
      expect(existsSync(missFile())).toBe(false);
    });

    it('does NOT log a miss when browsing with no query', async () => {
      await knowledgeRecall(tempDir, {}, gapsDir);
      expect(existsSync(missFile())).toBe(false);
    });

    it('does NOT log a miss for an archived slug (different error path)', async () => {
      // Archived pages return a specific "it is archived" message — not a true
      // miss, so we don't log them. (A miss log would re-prompt research on
      // a page Art intentionally retired.)
      await seedPage('old-page', 'test', 'Old', 'Old content.');
      const backend = createKnowledgeBackend(tempDir);
      try {
        await backend.archivePage('old-page', { note: 'test archive' });
      } finally {
        backend.close();
      }
      await knowledgeRecall(tempDir, { slug: 'old-page' }, gapsDir);
      expect(existsSync(missFile())).toBe(false);
    });

    it('accumulates multiple misses across calls', async () => {
      await knowledgeRecall(tempDir, { query: 'first miss' }, gapsDir);
      await knowledgeRecall(tempDir, { query: 'second miss' }, gapsDir);
      await knowledgeRecall(tempDir, { slug: 'slug-miss' }, gapsDir);
      const misses = readMisses();
      expect(misses).toHaveLength(3);
      expect(misses[0].query).toBe('first miss');
      expect(misses[1].query).toBe('second miss');
      expect(misses[2].slug).toBe('slug-miss');
    });

    it('does not write a miss file when gapsDir is not provided', async () => {
      await knowledgeRecall(tempDir, { query: 'no gapsDir' });
      // No gapsDir means no file created anywhere — the gapsDir-less call
      // cannot write to a default location; it simply does nothing.
      expect(existsSync(missFile())).toBe(false);
    });

    it('creates the gapsDir if it does not exist yet', async () => {
      const nested = join(gapsDir, 'sub', 'nested');
      await knowledgeRecall(tempDir, { query: 'deep dir test' }, nested);
      const misses = readFileSync(join(nested, 'recall-miss.jsonl'), 'utf8');
      expect(misses).toContain('deep dir test');
    });
  });
});
