import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { KnowledgePages } from '../../../test/fixtures/knowledge-pages.js';
import { knowledgeView } from './knowledge.js';

it('reads the whole knowledge page, all its sources and all its referring pages', async () => {
  const home = mkdtempSync(join(tmpdir(), 'knowledge-complete-'));
  const path = join(home, 'knowledge.db');
  const store = new KnowledgePages({ dbPath: path });
  let reader: Database.Database | undefined;
  try {
    const body = `${'Long factual text. '.repeat(1500)}The final fact.`;
    await store.writePage({ slug: 'fact', title: 'Complete fact', domain: 'test', body,
      citations: Array.from({ length: 45 }, (_, i) => ({ claim: `Claim ${i}`, source_kind: 'web' as const,
        source_locator: `https://example.com/${i}`, excerpt: `Source ${i}` })),
    });
    for (let i = 0; i < 25; i++) await store.writePage({ slug: `ref-${i}`, title: `Reference ${i}`, domain: 'test', body: '[[fact]]' });
    reader = new Database(path, { readonly: true });
    const view = knowledgeView(reader, Date.UTC(2026, 10, 14), 'fact', true);
    expect(view.open?.body).toBe(body);
    expect(view.open?.sources).toHaveLength(45);
    expect(view.open?.sources.at(-1)).toMatchObject({ claim: 'Claim 44', href: 'https://example.com/44' });
    expect(view.open?.citedBy).toHaveLength(25);
    expect(view.open?.citedBy.map(p => p.slug)).toContain('ref-24');
  } finally {
    reader?.close();
    await store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
