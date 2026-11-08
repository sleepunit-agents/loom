import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeMaintain } from './knowledge-maintain.js';
import { createKnowledgeBackend } from '../backends/index.js';

describe('knowledgeMaintain', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loom-km-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns a clean report on an empty store', async () => {
    const result = await knowledgeMaintain(tempDir);
    expect(result).toMatch(/Knowledge maintain report/);
    expect(result).toMatch(/Total active pages.*0/);
    expect(result).toMatch(/None/);
  });

  it('reports expansion candidates (thin body + high hit_count)', async () => {
    const backend = createKnowledgeBackend(tempDir);
    try {
      await backend.writePage({
        slug: 'thin-hot',
        title: 'Thin Hot Page',
        domain: 'test',
        body: 'Short body.',
        sourcing: 'sourced',
      });
      // Simulate 5 hits via queryPages
      for (let i = 0; i < 5; i++) {
        await backend.queryPages({ query: 'Short body' });
      }
    } finally {
      backend.close();
    }

    const result = await knowledgeMaintain(tempDir, {
      expansionHitThreshold: 3,
      thinBodyThreshold: 100,
    });

    expect(result).toMatch(/thin-hot/);
    expect(result).toMatch(/5 hits/);
  });

  it('does not flag fat pages as expansion candidates even with high hits', async () => {
    const backend = createKnowledgeBackend(tempDir);
    try {
      await backend.writePage({
        slug: 'fat-hot',
        title: 'Fat Page',
        domain: 'test',
        body: 'x'.repeat(600),
        sourcing: 'sourced',
      });
      for (let i = 0; i < 5; i++) {
        await backend.queryPages({ query: 'x'.repeat(10) });
      }
    } finally {
      backend.close();
    }

    const result = await knowledgeMaintain(tempDir, {
      expansionHitThreshold: 3,
      thinBodyThreshold: 500,
    });

    expect(result).toMatch(/Expansion candidates.*\n.*None/s);
  });

  it('reports cold pages (never accessed)', async () => {
    const backend = createKnowledgeBackend(tempDir);
    try {
      await backend.writePage({
        slug: 'never-accessed',
        title: 'Cold Page',
        domain: 'test',
        body: 'Nobody reads this.',
        sourcing: 'sourced',
      });
    } finally {
      backend.close();
    }

    const result = await knowledgeMaintain(tempDir, { coldDays: 1 });
    expect(result).toMatch(/never-accessed/);
    expect(result).toMatch(/never/);
  });

  it('reports misfiled pages (provisional sourcing) in misfile audit', async () => {
    const backend = createKnowledgeBackend(tempDir);
    try {
      await backend.writePage({
        slug: 'misfile-candidate',
        title: 'Subjective Note',
        domain: 'test',
        body: 'Jonathan loves the Strega.',
        sourcing: 'provisional',
      });
    } finally {
      backend.close();
    }

    const result = await knowledgeMaintain(tempDir);
    expect(result).toMatch(/misfile-candidate/);
    expect(result).toMatch(/provisional/);
    expect(result).toMatch(/relocate to memory/i);
  });

  it('reports misfiled pages (all-conversation citations)', async () => {
    const backend = createKnowledgeBackend(tempDir);
    try {
      await backend.writePage({
        slug: 'conversation-only',
        title: 'Session Notes',
        domain: 'test',
        body: 'We talked about this in a session.',
        sourcing: 'sourced',
        citations: [
          {
            claim: 'session insight',
            source_kind: 'conversation',
            source_locator: 'session/x',
            excerpt: 'we talked',
          },
        ],
      });
    } finally {
      backend.close();
    }

    const result = await knowledgeMaintain(tempDir);
    expect(result).toMatch(/conversation-only/);
    expect(result).toMatch(/conversation-only citations/);
  });

  it('does not flag sourced pages with web citations in misfile audit', async () => {
    const backend = createKnowledgeBackend(tempDir);
    try {
      await backend.writePage({
        slug: 'good-page',
        title: 'Well-Cited Page',
        domain: 'test',
        body: 'Some knowledge fact.',
        sourcing: 'sourced',
        citations: [
          {
            claim: 'a fact',
            source_kind: 'web',
            source_locator: 'https://example.com',
            excerpt: 'the fact',
          },
        ],
      });
    } finally {
      backend.close();
    }

    const result = await knowledgeMaintain(tempDir);
    expect(result).toMatch(/None — all active pages have independent citation support/);
  });

  it('does not include archived pages in any report section', async () => {
    const backend = createKnowledgeBackend(tempDir);
    try {
      await backend.writePage({
        slug: 'archived-thin',
        title: 'Archived Thin',
        domain: 'test',
        body: 'Short.',
        sourcing: 'provisional',
      });
      const db = (backend as unknown as { ensureOpen(): unknown })['ensureOpen']() as {
        prepare(sql: string): { run(...args: unknown[]): unknown };
      };
      db.prepare("UPDATE pages SET status = 'archived', hit_count = 10 WHERE slug = ?")
        .run('archived-thin');
    } finally {
      backend.close();
    }

    const result = await knowledgeMaintain(tempDir, {
      expansionHitThreshold: 3,
      thinBodyThreshold: 100,
    });

    expect(result).not.toMatch(/archived-thin/);
  });

  it('total count excludes archived pages', async () => {
    const backend = createKnowledgeBackend(tempDir);
    try {
      await backend.writePage({
        slug: 'active-page',
        title: 'Active Page',
        domain: 'test',
        body: 'Active body.',
        sourcing: 'sourced',
        citations: [
          { claim: 'fact', source_kind: 'web', source_locator: 'https://example.com', excerpt: 'the fact' },
        ],
      });
      await backend.writePage({
        slug: 'archived-page',
        title: 'Archived Page',
        domain: 'test',
        body: 'Archived body.',
        sourcing: 'sourced',
      });
      const db = (backend as unknown as { ensureOpen(): unknown })['ensureOpen']() as {
        prepare(sql: string): { run(...args: unknown[]): unknown };
      };
      db.prepare("UPDATE pages SET status = 'archived' WHERE slug = ?").run('archived-page');
    } finally {
      backend.close();
    }

    const result = await knowledgeMaintain(tempDir);
    expect(result).toMatch(/Total active pages:.*1/);
    expect(result).not.toMatch(/Total active pages:.*2/);
  });
});
