import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeArchive } from './knowledge-archive.js';
import { knowledgeWrite } from './knowledge-write.js';
import { createKnowledgeBackend } from '../backends/index.js';

describe('knowledgeArchive', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-ka-'));
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

  it('archives an active page and returns success message', async () => {
    await seedPage('rings');
    const result = await knowledgeArchive(tempDir, { slug: 'rings' });
    expect(result).toMatch(/archived/i);
    expect(result).toMatch(/rings/);
  });

  it('page becomes invisible to knowledge_recall after archive', async () => {
    await seedPage('plaits');
    await knowledgeArchive(tempDir, { slug: 'plaits' });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const pages = await backend.queryPages({ query: 'plaits', excludeStatus: 'archived' });
      expect(pages).toHaveLength(0);
    } finally {
      backend.close();
    }
  });

  it('sets status to archived in the database', async () => {
    await seedPage('clouds');
    await knowledgeArchive(tempDir, { slug: 'clouds' });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('clouds');
      expect(page!.status).toBe('archived');
    } finally {
      backend.close();
    }
  });

  it('stores tombstone note when provided', async () => {
    await seedPage('tides');
    await knowledgeArchive(tempDir, { slug: 'tides', note: 'superseded by tides-v2' });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('tides');
      expect(page!.tombstone_note).toBe('superseded by tides-v2');
    } finally {
      backend.close();
    }
  });

  it('returns not-found message for unknown slug', async () => {
    const result = await knowledgeArchive(tempDir, { slug: 'does-not-exist' });
    expect(result).toMatch(/not found/i);
    expect(result).toMatch(/does-not-exist/);
  });

  it('returns not-found when page is already archived', async () => {
    await seedPage('warps');
    await knowledgeArchive(tempDir, { slug: 'warps' });
    const result = await knowledgeArchive(tempDir, { slug: 'warps' });
    expect(result).toMatch(/not found|already archived/i);
  });
});
