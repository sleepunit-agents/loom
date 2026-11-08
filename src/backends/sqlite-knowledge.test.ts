import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, linkSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteKnowledgeBackend } from './sqlite-knowledge.js';
import { resolveKnowledgeDbPath, assertKnowledgePathsNotCoLocated, assertStackVersionCompatible } from '../config.js';
import { SqliteVecBackend } from './sqlite-vec.js';
import type { EmbeddingProvider } from './types.js';

function makeNullEmbedder(): EmbeddingProvider {
  const encode = (_text: string): number[] => [0.01, 0, 0, 0];
  return {
    dimensions: 4,
    embed: async (t: string) => encode(t),
    embedBatch: async (ts: string[]) => ts.map(encode),
  };
}

describe('SqliteKnowledgeBackend', () => {
  let tmpDir: string;
  let backend: SqliteKnowledgeBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-know-'));
    backend = new SqliteKnowledgeBackend({
      dbPath: join(tmpDir, 'knowledge.db'),
    });
  });

  afterEach(() => {
    backend.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes schema and stamps user_version = 1', () => {
    const db = backend['ensureOpen']();
    const version = db.pragma('user_version', { simple: true });
    expect(version).toBe(1);

    // Verify tables exist
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('pages');
    expect(tables.map((t) => t.name)).toContain('citations');
  });

  it('uses WAL mode', () => {
    const db = backend['ensureOpen']();
    const journalMode = db.pragma('journal_mode', { simple: true });
    expect(journalMode).toBe('wal');
  });

  it('writes and retrieves a page', async () => {
    const result = await backend.writePage({
      slug: 'art-agent',
      title: 'Art E Fish',
      domain: 'identity',
      body: 'Persistent agent identity system for AI agents.',
      sourcing: 'sourced',
    });

    expect(result.uuid).toBeDefined();
    expect(result.slug).toBe('art-agent');
    expect(result.title).toBe('Art E Fish');
    expect(result.citationsAdded).toBe(0);

    const page = await backend.getPage('art-agent');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Art E Fish');
    expect(page!.body).toBe('Persistent agent identity system for AI agents.');
    expect(page!.sourcing).toBe('sourced');
    expect(page!.citations).toEqual([]);
  });

  it('writes a page with citations', async () => {
    const result = await backend.writePage({
      slug: 'loom-project',
      title: 'Loom Project',
      domain: 'project',
      body: 'Memory subsystem for AI agents.',
      citations: [
        {
          claim: 'Loom uses sqlite-vec',
          source_kind: 'loom_memory',
          source_locator: 'project/loom-architecture',
          excerpt: 'Vector search via sqlite-vec FTS index',
        },
      ],
    });

    expect(result.citationsAdded).toBe(1);

    const page = await backend.getPage('loom-project');
    expect(page!.citations).toHaveLength(1);
    expect(page!.citations[0].claim).toBe('Loom uses sqlite-vec');
    expect(page!.citations[0].source_kind).toBe('loom_memory');
  });

  it('upserts an existing page by slug', async () => {
    await backend.writePage({
      slug: 'test-page',
      title: 'Original Title',
      domain: 'test',
      body: 'Original body',
    });

    const original = await backend.getPage('test-page');
    const originalUuid = original!.uuid;

    const result = await backend.writePage({
      slug: 'test-page',
      title: 'Changed Title',
      domain: 'test',
      body: 'Updated body content',
    });

    expect(result.uuid).toBe(originalUuid);
    // Title follows the write — the page is addressed by slug, so a differing
    // title on upsert is an intentional revision (title typos must be fixable).
    expect(result.title).toBe('Changed Title');
    expect(result.created).toBe(false);
    expect(result.bodyMode).toBe('replace');

    const updated = await backend.getPage('test-page');
    expect(updated!.body).toBe('Updated body content');
    expect(updated!.title).toBe('Changed Title');
    expect(updated!.sourcing).toBe('sourced'); // preserved
  });

  it('upsert updates sourcing column — provisional page promoted by passing sourced on second write', async () => {
    // First write: provisional (conversation-only)
    await backend.writePage({
      slug: 'sourcing-transition',
      title: 'Sourcing Transition',
      domain: 'test',
      body: 'Initial body.',
      sourcing: 'provisional',
      citations: [
        { claim: 'session note', source_kind: 'conversation', excerpt: 'we talked' },
      ],
    });

    const before = await backend.getPage('sourcing-transition');
    expect(before!.sourcing).toBe('provisional');

    // Second write: promoted with a web citation
    await backend.writePage({
      slug: 'sourcing-transition',
      title: 'Sourcing Transition',
      domain: 'test',
      body: 'Updated body with independent source.',
      sourcing: 'sourced',
      citations: [
        { claim: 'web fact', source_kind: 'web', source_locator: 'https://example.com', excerpt: 'the fact' },
      ],
    });

    const after = await backend.getPage('sourcing-transition');
    expect(after!.sourcing).toBe('sourced');
  });

  it('returns null for unknown slug', async () => {
    const page = await backend.getPage('nonexistent');
    expect(page).toBeNull();
  });

  it('lists pages with ordering', async () => {
    await backend.writePage({
      slug: 'alpha',
      title: 'Alpha',
      domain: 'test',
      body: 'First page',
    });
    await backend.writePage({
      slug: 'beta',
      title: 'Beta',
      domain: 'test',
      body: 'Second page',
    });

    const pages = await backend.listPages({});
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.slug)).toContain('alpha');
    expect(pages.map((p) => p.slug)).toContain('beta');
  });

  it('filters listPages by domain', async () => {
    await backend.writePage({
      slug: 'page-a',
      title: 'A',
      domain: 'identity/something',
      body: 'Identity page',
    });
    await backend.writePage({
      slug: 'page-b',
      title: 'B',
      domain: 'project/loom',
      body: 'Project page',
    });

    const identity = await backend.listPages({ domain: 'identity' });
    expect(identity).toHaveLength(1);
    expect(identity[0].slug).toBe('page-a');

    const project = await backend.listPages({ domain: 'project' });
    expect(project).toHaveLength(1);
    expect(project[0].slug).toBe('page-b');
  });

  it('filters listPages by excludeStatus', async () => {
    await backend.writePage({
      slug: 'active-page',
      title: 'Active',
      domain: 'test',
      body: 'Active content',
    });

    // Manually set one page to archived status
    const db = backend['ensureOpen']();
    db.prepare("UPDATE pages SET status = 'archived' WHERE slug = ?").run('active-page');

    const active = await backend.listPages({ excludeStatus: 'archived' });
    expect(active).toHaveLength(0);

    const all = await backend.listPages({});
    expect(all).toHaveLength(1);
  });

  it('limits listPages results', async () => {
    for (let i = 0; i < 5; i++) {
      await backend.writePage({
        slug: `page-${i}`,
        title: `Page ${i}`,
        domain: 'test',
        body: `Body ${i}`,
      });
    }

    const pages = await backend.listPages({ limit: 2 });
    expect(pages).toHaveLength(2);
  });

  it('searches pages by query (LIKE)', async () => {
    await backend.writePage({
      slug: 'page-loom',
      title: 'Loom Architecture',
      domain: 'project',
      body: 'Loom uses sqlite-vec for vector search.',
    });
    await backend.writePage({
      slug: 'page-unrelated',
      title: 'Weather Report',
      domain: 'random',
      body: 'Temperature is 72 degrees.',
    });

    const results = await backend.queryPages({ query: 'sqlite-vec' });
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('page-loom');
  });

  it('searches across title, body, and domain', async () => {
    await backend.writePage({
      slug: 'page-title-match',
      title: 'Loom Knowledge System',
      domain: 'project',
      body: 'Some generic content',
    });
    await backend.writePage({
      slug: 'page-body-match',
      title: 'Generic Title',
      domain: 'project',
      body: 'Contains loom reference',
    });

    const results = await backend.queryPages({ query: 'loom' });
    expect(results).toHaveLength(2);
  });

  it('searches with domain filter', async () => {
    await backend.writePage({
      slug: 'page-identity',
      title: 'Art Agent',
      domain: 'identity/art',
      body: 'Loom integration',
    });
    await backend.writePage({
      slug: 'page-project',
      title: 'Loom Project',
      domain: 'project/loom',
      body: 'Loom integration',
    });

    const results = await backend.queryPages({ query: 'loom', domain: 'identity' });
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('page-identity');
  });

  // ── Regression: single-letter and roman-numeral token preservation ─────────
  // The query builder must never drop tokens based on length. Tokens like 'I'
  // (roman numeral / single letter) are semantically meaningful and must be
  // preserved in multi-word AND queries.

  it('bare single-letter query "I" returns pages whose title contains "I"', async () => {
    await backend.writePage({
      slug: 'digitakt-i',
      title: 'Elektron Digitakt I',
      domain: 'music/gear/elektron',
      body: 'The original Digitakt drum computer.',
    });
    await backend.writePage({
      slug: 'unrelated',
      title: 'Unrelated Page',
      domain: 'other',
      body: 'Nothing about the roman numeral here.',
    });

    const results = await backend.queryPages({ query: 'I', excludeStatus: 'archived', limit: 10 });
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain('digitakt-i');
  });

  it('multi-word query "Digitakt I" includes the page titled "Elektron Digitakt I"', async () => {
    await backend.writePage({
      slug: 'digitakt-i',
      title: 'Elektron Digitakt I',
      domain: 'music/gear/elektron',
      body: 'The original Digitakt drum computer.',
    });
    await backend.writePage({
      slug: 'digitakt-ii',
      title: 'Elektron Digitakt II',
      domain: 'music/gear/elektron',
      body: 'The second-generation Digitakt.',
    });

    const results = await backend.queryPages({ query: 'Digitakt I', excludeStatus: 'archived', limit: 10 });
    const slugs = results.map((r) => r.slug);
    // "Elektron Digitakt I" must appear — the 'I' token must not be dropped.
    expect(slugs).toContain('digitakt-i');
  });

  it('roman numeral "II" token is preserved and differentiates from "I"', async () => {
    await backend.writePage({
      slug: 'digitakt-i',
      title: 'Elektron Digitakt I',
      domain: 'music/gear/elektron',
      body: 'The original Digitakt drum computer.',
    });
    await backend.writePage({
      slug: 'digitakt-ii',
      title: 'Elektron Digitakt II',
      domain: 'music/gear/elektron',
      body: 'The second-generation Digitakt.',
    });

    // Query for "II" should include "Elektron Digitakt II"; "I" is a substring of "II"
    // so this also tests that the "II" token itself is not dropped.
    const results = await backend.queryPages({ query: 'II', excludeStatus: 'archived', limit: 10 });
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain('digitakt-ii');
  });

  it('multi-word query AND-joins tokens — all tokens must match', async () => {
    await backend.writePage({
      slug: 'analog-rytm',
      title: 'Elektron Analog Rytm',
      domain: 'music/gear/elektron',
      body: 'Analog drum machine with sample playback.',
    });
    await backend.writePage({
      slug: 'digitakt-i',
      title: 'Elektron Digitakt I',
      domain: 'music/gear/elektron',
      body: 'Digital drum computer from Elektron.',
    });

    // "Analog Rytm" — both tokens must be present; "Digitakt I" has neither.
    const results = await backend.queryPages({ query: 'Analog Rytm', excludeStatus: 'archived', limit: 10 });
    const slugs = results.map((r) => r.slug);
    expect(slugs).toContain('analog-rytm');
    expect(slugs).not.toContain('digitakt-i');
  });

  it('adds citations to existing page', async () => {
    await backend.writePage({
      slug: 'citation-test',
      title: 'Citation Test',
      domain: 'test',
      body: 'Page with citations',
    });

    const added = await backend.addCitations('citation-test', [
      {
        claim: 'First claim',
        source_kind: 'web',
        source_locator: 'https://example.com/page1',
        excerpt: 'Excerpt one',
      },
      {
        claim: 'Second claim',
        source_kind: 'conversation',
        excerpt: 'Excerpt two',
      },
    ]);

    expect(added).toBe(2);

    const page = await backend.getPage('citation-test');
    expect(page!.citations).toHaveLength(2);
  });

  it('throws when adding citations to nonexistent page', async () => {
    await expect(
      backend.addCitations('does-not-exist', [
        {
          claim: 'Claim',
          source_kind: 'web',
          excerpt: 'Excerpt',
        },
      ]),
    ).rejects.toThrow(/page not found/);
  });

  it('enforces page body hard cap', async () => {
    const largeBody = 'x'.repeat(64 * 1024 + 1);
    await expect(
      backend.writePage({
        slug: 'oversized',
        title: 'Oversized',
        domain: 'test',
        body: largeBody,
      }),
    ).rejects.toThrow(/exceeds hard cap/);
  });

  it('enforces citation excerpt hard cap', async () => {
    await backend.writePage({
      slug: 'cap-test',
      title: 'Cap Test',
      domain: 'test',
      body: 'Normal body',
    });

    const largeExcerpt = 'e'.repeat(4097);
    await expect(
      backend.addCitations('cap-test', [
        {
          claim: 'Claim',
          source_kind: 'web',
          excerpt: largeExcerpt,
        },
      ]),
    ).rejects.toThrow(/exceeds hard cap/);
  });

  it('allows page body at exactly the cap', async () => {
    const exactBody = 'x'.repeat(64 * 1024);
    await expect(
      backend.writePage({
        slug: 'exact-cap',
        title: 'Exact',
        domain: 'test',
        body: exactBody,
      }),
    ).resolves.toBeDefined();
  });

  it('errors after close', async () => {
    await backend.writePage({
      slug: 'before-close',
      title: 'Before',
      domain: 'test',
      body: 'Content',
    });

    backend.close();

    await expect(backend.getPage('before-close')).rejects.toThrow(
      /already closed/,
    );
  });

  it('resolves knowledge db path correctly', () => {
    const path = resolveKnowledgeDbPath(tmpDir);
    expect(path).toBe(join(tmpDir, 'knowledge.db'));
  });

  it('allows overriding knowledge db path via env', () => {
    const original = process.env.LOOM_KNOWLEDGE_DB_PATH;
    process.env.LOOM_KNOWLEDGE_DB_PATH = '/tmp/custom-knowledge.db';
    try {
      const path = resolveKnowledgeDbPath(tmpDir);
      expect(path).toBe('/tmp/custom-knowledge.db');
    } finally {
      process.env.LOOM_KNOWLEDGE_DB_PATH = original;
    }
  });

  it('co-location guard rejects same path', () => {
    const originalMem = process.env.LOOM_SQLITE_DB_PATH;
    const originalKn = process.env.LOOM_KNOWLEDGE_DB_PATH;
    try {
      process.env.LOOM_SQLITE_DB_PATH = '/tmp/same.db';
      process.env.LOOM_KNOWLEDGE_DB_PATH = '/tmp/same.db';
      expect(() => assertKnowledgePathsNotCoLocated(tmpDir)).toThrow(
        /same as memory database path/,
      );
    } finally {
      process.env.LOOM_SQLITE_DB_PATH = originalMem;
      process.env.LOOM_KNOWLEDGE_DB_PATH = originalKn;
    }
  });

  it('co-location guard rejects same inode', () => {
    const originalMem = process.env.LOOM_SQLITE_DB_PATH;
    const originalKn = process.env.LOOM_KNOWLEDGE_DB_PATH;
    try {
      const memPath = join(tmpDir, 'memories.db');
      const knPath = join(tmpDir, 'knowledge-link.db');
      // Create a real file at memPath, then hard-link knPath to it
      writeFileSync(memPath, 'dummy');
      linkSync(memPath, knPath);

      process.env.LOOM_SQLITE_DB_PATH = memPath;
      process.env.LOOM_KNOWLEDGE_DB_PATH = knPath;

      expect(() => assertKnowledgePathsNotCoLocated(tmpDir)).toThrow(
        /hard-linked/,
      );
    } finally {
      process.env.LOOM_SQLITE_DB_PATH = originalMem;
      process.env.LOOM_KNOWLEDGE_DB_PATH = originalKn;
    }
  });

  it('co-location guard allows separate files', () => {
    const originalMem = process.env.LOOM_SQLITE_DB_PATH;
    const originalKn = process.env.LOOM_KNOWLEDGE_DB_PATH;
    try {
      const memPath = join(tmpDir, 'memories.db');
      const knPath = join(tmpDir, 'knowledge.db');
      writeFileSync(memPath, 'memory');
      writeFileSync(knPath, 'knowledge');

      process.env.LOOM_SQLITE_DB_PATH = memPath;
      process.env.LOOM_KNOWLEDGE_DB_PATH = knPath;

      expect(() => assertKnowledgePathsNotCoLocated(tmpDir)).not.toThrow();
    } finally {
      process.env.LOOM_SQLITE_DB_PATH = originalMem;
      process.env.LOOM_KNOWLEDGE_DB_PATH = originalKn;
    }
  });

  it('co-location guard allows non-existent files', () => {
    const originalMem = process.env.LOOM_SQLITE_DB_PATH;
    const originalKn = process.env.LOOM_KNOWLEDGE_DB_PATH;
    try {
      process.env.LOOM_SQLITE_DB_PATH = join(tmpDir, 'future-mem.db');
      process.env.LOOM_KNOWLEDGE_DB_PATH = join(tmpDir, 'future-kn.db');

      expect(() => assertKnowledgePathsNotCoLocated(tmpDir)).not.toThrow();
    } finally {
      process.env.LOOM_SQLITE_DB_PATH = originalMem;
      process.env.LOOM_KNOWLEDGE_DB_PATH = originalKn;
    }
  });

  it('citations are cascaded on page delete', async () => {
    // Write page with citations, then delete page row directly and verify citations gone
    await backend.writePage({
      slug: 'cascade-test',
      title: 'Cascade',
      domain: 'test',
      body: 'Body',
      citations: [
        {
          claim: 'Claim',
          source_kind: 'web',
          excerpt: 'Excerpt',
        },
      ],
    });

    const db = backend['ensureOpen']();
    const page = db
      .prepare('SELECT id FROM pages WHERE slug = ?')
      .get('cascade-test') as { id: number };

    db.prepare('DELETE FROM pages WHERE id = ?').run(page.id);

    const citations = db
      .prepare('SELECT COUNT(*) as count FROM citations')
      .get() as { count: number };
    expect(citations.count).toBe(0);
  });
});

// ── Isolation invariant tests (the #1 gate) ──────────────────────────────────

describe('knowledge isolation invariants', () => {
  let tmpDir: string;
  const memDbPath = () => join(tmpDir, 'memories.db');
  const knDbPath = () => join(tmpDir, 'knowledge.db');

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-isolation-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(a) a knowledge write that throws leaves memories.db readable and writable', async () => {
    // Seed memories.db with a real SqliteVecBackend so the file exists.
    const memBackend = new SqliteVecBackend(
      { dbPath: memDbPath() },
      makeNullEmbedder(),
    );
    await memBackend.remember({ category: 'test', title: 'Sentinel', content: 'ok' });
    memBackend.close();

    // Open knowledge backend and attempt a write that will throw (body cap exceeded).
    const knBackend = new SqliteKnowledgeBackend({ dbPath: knDbPath() });
    const oversizedBody = 'x'.repeat(64 * 1024 + 1);
    await expect(
      knBackend.writePage({ slug: 'boom', title: 'Boom', domain: 'test', body: oversizedBody }),
    ).rejects.toThrow(/exceeds hard cap/);
    knBackend.close();

    // memories.db must still be readable and writable.
    const memBackend2 = new SqliteVecBackend(
      { dbPath: memDbPath() },
      makeNullEmbedder(),
    );
    const results = await memBackend2.recall({ query: 'Sentinel' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Sentinel');
    // Write must still work.
    await expect(
      memBackend2.remember({ category: 'test', title: 'After knowledge error', content: 'still works' }),
    ).resolves.toBeDefined();
    memBackend2.close();
  });

  it('(b) a corrupt knowledge.db surfaces a contained error; memory wing unaffected', async () => {
    // Seed memories.db.
    const memBackend = new SqliteVecBackend(
      { dbPath: memDbPath() },
      makeNullEmbedder(),
    );
    await memBackend.remember({ category: 'test', title: 'Survivor', content: 'lives' });
    memBackend.close();

    // Write deliberate garbage into knowledge.db so SQLite rejects it.
    writeFileSync(knDbPath(), 'THIS IS NOT A SQLITE DATABASE\n');

    // Opening a corrupted knowledge.db should throw (SQLite rejects the file).
    expect(() => new SqliteKnowledgeBackend({ dbPath: knDbPath() })).toThrow();

    // memories.db must still be open-able and readable after the knowledge failure.
    const memBackend2 = new SqliteVecBackend(
      { dbPath: memDbPath() },
      makeNullEmbedder(),
    );
    const results = await memBackend2.recall({ query: 'Survivor' });
    expect(results.length).toBeGreaterThan(0);
    memBackend2.close();
  });

  it('(c) memory boot path (assertStackVersionCompatible v2) boots with knowledge.db present', () => {
    // Create a knowledge.db in the context dir (simulates a knowledge-enabled context dir).
    const knBackend = new SqliteKnowledgeBackend({ dbPath: knDbPath() });
    knBackend.close();

    // assertStackVersionCompatible must not fail even when knowledge.db is present.
    // This is the "older/knowledge-disabled build is not bricked" regression test.
    expect(() => assertStackVersionCompatible(tmpDir)).not.toThrow();

    // The LOOM_STACK_VERSION file must be stamped at v2, not at any knowledge version.
    const stamp = readFileSync(join(tmpDir, 'LOOM_STACK_VERSION'), 'utf-8');
    expect(stamp.trim()).toBe('2');
  });

  it('memories.db is never opened when operating on knowledge.db', async () => {
    // Create a knowledge backend and do a write — memories.db must remain absent.
    const knBackend = new SqliteKnowledgeBackend({ dbPath: knDbPath() });
    await knBackend.writePage({ slug: 'isolated', title: 'Isolated', domain: 'test', body: 'ok' });
    knBackend.close();

    // memories.db must NOT exist — the knowledge backend never opens it.
    expect(existsSync(memDbPath())).toBe(false);
  });
});
