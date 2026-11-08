import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeRestore } from './knowledge-restore.js';
import { knowledgeArchive } from './knowledge-archive.js';
import { knowledgeWrite } from './knowledge-write.js';
import { createKnowledgeBackend } from '../backends/index.js';

describe('knowledgeRestore', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-kr2-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedPage(slug: string) {
    await knowledgeWrite(tempDir, {
      slug,
      domain: 'test',
      title: slug,
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

  it('restores an archived page and returns success message', async () => {
    await seedPage('rings');
    await knowledgeArchive(tempDir, { slug: 'rings' });
    const result = await knowledgeRestore(tempDir, { slug: 'rings' });
    expect(result).toMatch(/restored/i);
    expect(result).toMatch(/rings/);
  });

  it('page becomes active again after restore', async () => {
    await seedPage('plaits');
    await knowledgeArchive(tempDir, { slug: 'plaits' });
    await knowledgeRestore(tempDir, { slug: 'plaits' });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('plaits');
      expect(page!.status).toBe('active');
      expect((page as unknown as { tombstone_note: string | null }).tombstone_note).toBeNull();
    } finally {
      backend.close();
    }
  });

  it('page is visible to recall after restore', async () => {
    await seedPage('clouds');
    await knowledgeArchive(tempDir, { slug: 'clouds' });
    await knowledgeRestore(tempDir, { slug: 'clouds' });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const pages = await backend.queryPages({ query: 'clouds', excludeStatus: 'archived' });
      expect(pages).toHaveLength(1);
      expect(pages[0].slug).toBe('clouds');
    } finally {
      backend.close();
    }
  });

  it('returns not-found message for unknown slug', async () => {
    const result = await knowledgeRestore(tempDir, { slug: 'does-not-exist' });
    expect(result).toMatch(/not found/i);
    expect(result).toMatch(/does-not-exist/);
  });

  it('returns not-found when page is active (not archived)', async () => {
    await seedPage('warps');
    const result = await knowledgeRestore(tempDir, { slug: 'warps' });
    expect(result).toMatch(/not found|not archived/i);
  });
});
