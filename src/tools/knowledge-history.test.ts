import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeHistory } from './knowledge-history.js';
import { knowledgeWrite } from './knowledge-write.js';
import { createKnowledgeBackend } from '../backends/index.js';

describe('knowledgeHistory', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-kh-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function writePage(slug: string, body: string) {
    await knowledgeWrite(tempDir, {
      slug,
      domain: 'test',
      title: slug,
      body,
      citations: [{ claim: `${slug} fact`, source_kind: 'web' as const, source_locator: `https://example.com/${slug}`, excerpt: `Excerpt for ${slug}` }],
    });
  }

  it('lists revisions newest-first without bodies', async () => {
    await writePage('my-page', 'Version one.');
    await writePage('my-page', 'Version two.');
    await writePage('my-page', 'Version three.');

    const result = await knowledgeHistory(tempDir, { slug: 'my-page' });
    expect(result).not.toMatch(/Error/i);
    expect(result).toContain('my-page');
    expect(result).toContain('write-replace');
    // Bodies are not dumped in the listing.
    expect(result).not.toContain('Version one.');
  });

  it('reports when a page has no revisions', async () => {
    await writePage('my-page', 'Only version.');

    const result = await knowledgeHistory(tempDir, { slug: 'my-page' });
    expect(result).toMatch(/no revisions/i);
  });

  it('reads a single revision body by id', async () => {
    await writePage('my-page', 'Version one.');
    await writePage('my-page', 'Version two.');

    const b = createKnowledgeBackend(tempDir);
    let revId: number;
    try {
      revId = (await b.listRevisions('my-page'))[0].id;
    } finally {
      b.close();
    }

    const result = await knowledgeHistory(tempDir, { slug: 'my-page', revision_id: revId });
    expect(result).not.toMatch(/Error/i);
    expect(result).toContain('Version one.');
  });

  it('restores a revision with restore: true', async () => {
    await writePage('my-page', 'Good body.');
    await writePage('my-page', 'Stomped body.');

    const b0 = createKnowledgeBackend(tempDir);
    let revId: number;
    try {
      revId = (await b0.listRevisions('my-page'))[0].id;
    } finally {
      b0.close();
    }

    const result = await knowledgeHistory(tempDir, {
      slug: 'my-page',
      revision_id: revId,
      restore: true,
    });
    expect(result).not.toMatch(/Error/i);
    expect(result).toMatch(/restored/i);

    const b = createKnowledgeBackend(tempDir);
    try {
      expect((await b.getPage('my-page'))!.body).toBe('Good body.');
    } finally {
      b.close();
    }
  });

  it('rejects restore without revision_id', async () => {
    await writePage('my-page', 'Body.');

    const result = await knowledgeHistory(tempDir, { slug: 'my-page', restore: true });
    expect(result).toMatch(/Error/i);
  });

  it('errors on unknown page', async () => {
    const result = await knowledgeHistory(tempDir, { slug: 'ghost' });
    expect(result).toMatch(/Error/i);
  });

  it('shows the recorded verifications alongside revisions', async () => {
    await writePage('my-page', 'Body.');
    const { knowledgeVerify } = await import('./knowledge-verify.js');
    await knowledgeVerify(tempDir, { slug: 'my-page', outcome: 'confirmed', citation_checked: true });

    const result = await knowledgeHistory(tempDir, { slug: 'my-page' });
    expect(result).toMatch(/verification/i);
    expect(result).toContain('confirmed');
    expect(result).toContain('citations checked');
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

    it('records who performed a restore — resolved from the loom identity, never a tool argument', async () => {
      process.env.LOOM_IDENTITY = 'art';
      await writePage('my-page', 'Good body.');
      await writePage('my-page', 'Stomped body.');

      const b0 = createKnowledgeBackend(tempDir);
      let revId: number;
      try {
        revId = (await b0.listRevisions('my-page'))[0].id;
      } finally {
        b0.close();
      }

      process.env.LOOM_IDENTITY = 'mark';
      await knowledgeHistory(tempDir, { slug: 'my-page', revision_id: revId, restore: true });

      const b = createKnowledgeBackend(tempDir);
      try {
        const [newest] = await b.listRevisions('my-page');
        expect(newest.op).toBe('history-restore');
        expect(newest.actor).toBe('mark');
      } finally {
        b.close();
      }
    });

    it('listing shows who performed each revision', async () => {
      process.env.LOOM_IDENTITY = 'art';
      await writePage('my-page', 'v1');
      await writePage('my-page', 'v2');

      const result = await knowledgeHistory(tempDir, { slug: 'my-page' });
      expect(result).toContain('art');
    });
  });
});
