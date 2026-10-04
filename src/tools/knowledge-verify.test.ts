import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeVerify } from './knowledge-verify.js';
import { knowledgeWrite } from './knowledge-write.js';
import { knowledgeArchive } from './knowledge-archive.js';
import { createKnowledgeBackend } from '../backends/index.js';

describe('knowledgeVerify', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-kv-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function writePage(slug: string) {
    await knowledgeWrite(tempDir, {
      slug,
      domain: 'test',
      title: slug,
      body: `Body for ${slug}`,
      citations: [{ claim: `${slug} fact`, source_kind: 'web' as const, source_locator: `https://example.com/${slug}`, excerpt: `Excerpt for ${slug}` }],
    });
  }

  it('stamps a single page without touching the body', async () => {
    await writePage('my-page');

    const result = await knowledgeVerify(tempDir, {
      slug: 'my-page',
      verified_at: '2026-06-10T12:00:00.000Z',
    });
    expect(result).not.toMatch(/Error/i);
    expect(result).toContain('my-page');
    expect(result).toContain('2026-06-10');

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('my-page');
      expect(page!.verified_at).toBe('2026-06-10T12:00:00.000Z');
      expect(page!.body).toBe('Body for my-page');
    } finally {
      b.close();
    }
  });

  it('appends a note section in single-page mode', async () => {
    await writePage('my-page');

    const result = await knowledgeVerify(tempDir, {
      slug: 'my-page',
      verified_at: '2026-06-10T12:00:00.000Z',
      note: 'Claims hold; firmware unchanged.',
    });
    expect(result).not.toMatch(/Error/i);

    const b = createKnowledgeBackend(tempDir);
    try {
      const page = await b.getPage('my-page');
      expect(page!.body).toContain('Body for my-page');
      expect(page!.body).toContain('## Verification — 2026-06-10');
      expect(page!.body).toContain('Claims hold; firmware unchanged.');
    } finally {
      b.close();
    }
  });

  it('stamps a batch of slugs', async () => {
    await writePage('a');
    await writePage('b');

    const result = await knowledgeVerify(tempDir, {
      slugs: ['a', 'b'],
      verified_at: '2026-06-10T12:00:00.000Z',
    });
    expect(result).not.toMatch(/Error/i);
    expect(result).toContain('2');

    const b = createKnowledgeBackend(tempDir);
    try {
      expect((await b.getPage('a'))!.verified_at).toBe('2026-06-10T12:00:00.000Z');
      expect((await b.getPage('b'))!.verified_at).toBe('2026-06-10T12:00:00.000Z');
    } finally {
      b.close();
    }
  });

  it('returns an error for archived pages', async () => {
    await writePage('my-page');
    await knowledgeArchive(tempDir, { slug: 'my-page' });

    const result = await knowledgeVerify(tempDir, { slug: 'my-page' });
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/archived/);
  });

  it('returns an error when neither slug nor slugs given', async () => {
    const result = await knowledgeVerify(tempDir, {});
    expect(result).toMatch(/Error/i);
  });

  describe('actor attribution (t-675)', () => {
    const originalIdentity = process.env.LOOM_IDENTITY;

    afterEach(() => {
      if (originalIdentity === undefined) {
        delete process.env.LOOM_IDENTITY;
      } else {
        process.env.LOOM_IDENTITY = originalIdentity;
      }
    });

    it('records the verifier from the resolved loom identity — never a tool argument', async () => {
      await writePage('my-page');
      process.env.LOOM_IDENTITY = 'mark';

      const result = await knowledgeVerify(tempDir, { slug: 'my-page' });
      expect(result).toContain('mark');

      const backend = createKnowledgeBackend(tempDir);
      try {
        const [v] = await backend.getVerifications('my-page');
        expect(v.verifier).toBe('mark');
        expect(v.outcome).toBe('confirmed');
        expect(v.citation_checked).toBe(false);
      } finally {
        backend.close();
      }
    });

    it('passes through outcome and citation_checked', async () => {
      await writePage('my-page');
      process.env.LOOM_IDENTITY = 'art';

      const result = await knowledgeVerify(tempDir, {
        slug: 'my-page',
        outcome: 'stale',
        citation_checked: true,
      });
      expect(result).toContain('stale');

      const backend = createKnowledgeBackend(tempDir);
      try {
        const [v] = await backend.getVerifications('my-page');
        expect(v.outcome).toBe('stale');
        expect(v.citation_checked).toBe(true);
      } finally {
        backend.close();
      }
    });
  });
});
