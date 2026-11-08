import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeSupersede } from './knowledge-supersede.js';
import { knowledgeWrite } from './knowledge-write.js';
import { knowledgeArchive } from './knowledge-archive.js';
import { createKnowledgeBackend } from '../backends/index.js';

describe('knowledgeSupersede', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-ks-'));
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

  it('archives old_slug and returns success message', async () => {
    await seedPage('elektron-digitakt-1');
    await seedPage('elektron-digitakt-i');

    const result = await knowledgeSupersede(tempDir, {
      old_slug: 'elektron-digitakt-1',
      new_slug: 'elektron-digitakt-i',
    });

    expect(result).toMatch(/supersession recorded/i);
    expect(result).toMatch(/elektron-digitakt-1/);
    expect(result).toMatch(/elektron-digitakt-i/);
    expect(result).toMatch(/archived/i);
  });

  it('old_slug is archived in the database', async () => {
    await seedPage('old-page');
    await seedPage('canonical-page');
    await knowledgeSupersede(tempDir, { old_slug: 'old-page', new_slug: 'canonical-page' });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('old-page');
      expect(page!.status).toBe('archived');
    } finally {
      backend.close();
    }
  });

  it('new_slug remains active', async () => {
    await seedPage('loser');
    await seedPage('winner');
    await knowledgeSupersede(tempDir, { old_slug: 'loser', new_slug: 'winner' });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('winner');
      expect(page!.status).toBe('active');
    } finally {
      backend.close();
    }
  });

  it('tombstone note references new_slug', async () => {
    await seedPage('old-slug');
    await seedPage('new-slug');
    await knowledgeSupersede(tempDir, { old_slug: 'old-slug', new_slug: 'new-slug', note: 'merged during triage' });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('old-slug');
      const note = page!.tombstone_note;
      expect(note).toMatch(/new-slug/);
      expect(note).toMatch(/merged during triage/);
    } finally {
      backend.close();
    }
  });

  it('tombstone note contains new_slug even without caller note', async () => {
    await seedPage('dup-a');
    await seedPage('dup-canonical');
    await knowledgeSupersede(tempDir, { old_slug: 'dup-a', new_slug: 'dup-canonical' });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('dup-a');
      const note = page!.tombstone_note;
      expect(note).toMatch(/dup-canonical/);
    } finally {
      backend.close();
    }
  });

  it('returns error when old_slug does not exist', async () => {
    await seedPage('canonical');
    const result = await knowledgeSupersede(tempDir, {
      old_slug: 'does-not-exist',
      new_slug: 'canonical',
    });
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/does-not-exist/);
  });

  it('returns error when new_slug does not exist', async () => {
    await seedPage('old');
    const result = await knowledgeSupersede(tempDir, {
      old_slug: 'old',
      new_slug: 'missing-canonical',
    });
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/missing-canonical/);
  });

  it('returns error when old_slug and new_slug are the same', async () => {
    await seedPage('same-slug');
    const result = await knowledgeSupersede(tempDir, {
      old_slug: 'same-slug',
      new_slug: 'same-slug',
    });
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/different/i);
  });

  it('returns already-archived message and does not overwrite tombstone when old_slug is already archived', async () => {
    await seedPage('pre-archived');
    await seedPage('canonical-already');
    // Archive first with a known note so we can detect if supersede overwrites it.
    await knowledgeArchive(tempDir, { slug: 'pre-archived', note: 'original archive note' });

    const result = await knowledgeSupersede(tempDir, {
      old_slug: 'pre-archived',
      new_slug: 'canonical-already',
    });

    expect(result).toMatch(/already archived/i);

    // Tombstone note must not have been overwritten by the supersede call.
    const backend = createKnowledgeBackend(tempDir);
    try {
      const page = await backend.getPage('pre-archived');
      expect(page!.tombstone_note).toMatch(/original archive note/);
      expect(page!.tombstone_note).not.toMatch(/canonical-already/);
    } finally {
      backend.close();
    }
  });

  it('old_slug is excluded from recall after supersession', async () => {
    await seedPage('old-rings');
    await seedPage('rings-canonical');
    await knowledgeSupersede(tempDir, { old_slug: 'old-rings', new_slug: 'rings-canonical' });

    const backend = createKnowledgeBackend(tempDir);
    try {
      const pages = await backend.queryPages({ query: 'old-rings', excludeStatus: 'archived' });
      expect(pages.map((p) => p.slug)).not.toContain('old-rings');
    } finally {
      backend.close();
    }
  });
});
