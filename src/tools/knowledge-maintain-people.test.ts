/**
 * Acceptance criterion 13 of docs/specs/person-cards.md — the person-page
 * misfile heuristic in knowledge_maintain. A report, not enforcement.
 *
 * better-sqlite3 is wrapped so every database a test opens is recorded: the
 * knowledge-only server must never open the memory database, whatever code
 * path it would take to get there.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const opened = vi.hoisted(() => [] as string[]);
vi.mock('better-sqlite3', async (importOriginal) => {
  const actual = (await importOriginal()) as { default: new (...a: unknown[]) => unknown };
  const Wrapped = new Proxy(actual.default, {
    construct(target, args) {
      if (typeof args[0] === 'string') opened.push(resolve(args[0]));
      return Reflect.construct(target, args);
    },
  });
  return { ...actual, default: Wrapped };
});

import BetterSqlite3 from 'better-sqlite3';
import { knowledgeMaintain } from './knowledge-maintain.js';
import { createKnowledgeBackend, closeAllBackends } from '../backends/index.js';
import { openPeopleStore } from '../backends/people.js';
import { resolveKnowledgeDbPath, resolveSqliteDbPath } from '../config.js';
import { createLoomServer } from '../server.js';
import { createKnowledgeOnlyServer } from '../transport/knowledge-server.js';
import { runCliCaptured } from '../cli/test-helpers.js';

const SECTION = '## Person-page misfile check';

/** The lines of the person-page section, heading excluded. */
function personSection(report: string): string {
  const start = report.indexOf(SECTION);
  expect(start, report).toBeGreaterThanOrEqual(0);
  const rest = report.slice(report.indexOf('\n', start));
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

describe('knowledge_maintain person-page misfile check (criterion 13)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-km-people-'));
    opened.length = 0;
  });
  afterEach(() => {
    closeAllBackends();
    rmSync(dir, { recursive: true, force: true });
  });

  function card(slug: string, name: string) {
    const store = openPeopleStore(dir)!;
    try {
      store.write({ slug, name });
    } finally {
      store.close();
    }
  }

  async function page(slug: string, title: string, extra: { domain?: string; sourcing?: 'sourced' | 'internal' | 'provisional' } = {}) {
    const backend = createKnowledgeBackend(dir);
    try {
      await backend.writePage({
        slug,
        title,
        domain: extra.domain ?? 'test',
        body: 'Body.',
        sourcing: extra.sourcing ?? 'sourced',
      });
    } finally {
      backend.close();
    }
  }

  const run = () => knowledgeMaintain(dir, { personCards: true });

  it('flags a page whose slug contains a card slug as whole words', async () => {
    card('patrick-kells', 'Patrick Kells');
    await page('patrick-kells-pond-notes', 'Pond notes');
    const section = personSection(await run());
    expect(section).toMatch(/`patrick-kells-pond-notes`.*`patrick-kells`/);
  });

  it('flags a page whose title contains a card name, case-insensitively', async () => {
    card('patrick-kells', 'Patrick Kells');
    await page('field-lead', 'What PATRICK kells prefers');
    expect(personSection(await run())).toMatch(/`field-lead`.*`patrick-kells`/);
  });

  it('matches the card name against the page slug and the card slug against the title', async () => {
    card('dan', 'Daniel Ortiz');
    await page('daniel-ortiz-access', 'Access');
    await page('misc', 'Notes for dan');
    const section = personSection(await run());
    expect(section).toMatch(/`daniel-ortiz-access`.*`dan`/);
    expect(section).toMatch(/`misc`.*`dan`/);
  });

  it('matches whole words only — a substring of a word is not a match', async () => {
    card('dan', 'Dan');
    card('patrick-kells', 'Patrick Kells');
    await page('dance-floor', 'Abundance');
    await page('patrick-kellsy', 'Kells Patrick');
    await page('danish_pastry', 'Patrick-Kellsworth');
    const section = personSection(await run());
    expect(section).toMatch(/^\s*None/);
  });

  it('treats hyphens and spaces as the same word boundary', async () => {
    card('allison-ray', 'Allison Ray');
    await page('team', 'Allison-Ray on call');
    await page('allison--ray', 'x');
    const section = personSection(await run());
    expect(section).toMatch(/`team`/);
    expect(section).toMatch(/`allison--ray`/);
  });

  it('uses only active cards — an archived card matches nothing', async () => {
    card('patrick-kells', 'Patrick Kells');
    const store = openPeopleStore(dir)!;
    store.archive({ slug: 'patrick-kells', reason: 'left', actor: 'art' });
    store.close();
    await page('patrick-kells-notes', 'Notes');
    expect(personSection(await run())).toMatch(/^\s*None/);
  });

  it('skips pages exempt from the misfile audit (ours/ with internal sourcing)', async () => {
    card('patrick-kells', 'Patrick Kells');
    await page('patrick-kells-runbook', 'Runbook', { domain: 'ours/ops', sourcing: 'internal' });
    await page('patrick-kells-draft', 'Draft', { domain: 'ours/ops', sourcing: 'provisional' });
    const section = personSection(await run());
    expect(section).not.toMatch(/patrick-kells-runbook/);
    expect(section).toMatch(/`patrick-kells-draft`/);
  });

  it('ignores archived pages', async () => {
    card('patrick-kells', 'Patrick Kells');
    await page('patrick-kells-old', 'Old');
    const backend = createKnowledgeBackend(dir);
    await backend.archivePage({ slug: 'patrick-kells-old' });
    backend.close();
    expect(personSection(await run())).toMatch(/^\s*None/);
  });

  it('reports none when there are no cards or no memory database at all', async () => {
    await page('patrick-kells-notes', 'Notes');
    expect(personSection(await run())).toMatch(/^\s*None/);
  });

  it('inherits the 1,000-page scan limit', async () => {
    card('patrick-kells', 'Patrick Kells');
    await page('patrick-kells-oldest', 'Oldest');
    const backend = createKnowledgeBackend(dir);
    for (let i = 0; i < 1000; i++) {
      await backend.writePage({ slug: `filler-${i}`, title: `Filler ${i}`, domain: 'test', body: 'b', sourcing: 'sourced' });
    }
    backend.close();
    const db = new BetterSqlite3(resolveKnowledgeDbPath(dir));
    db.prepare(`UPDATE pages SET updated = '2000-01-01T00:00:00.000Z', created = '2000-01-01T00:00:00.000Z' WHERE slug = ?`)
      .run('patrick-kells-oldest');
    db.close();
    const report = await run();
    expect(report).toMatch(/Total active pages:\*\* 1000/);
    expect(personSection(report)).not.toMatch(/patrick-kells-oldest/);
  }, 60_000);

  it('is off unless asked for: the default report says it was not run', async () => {
    card('patrick-kells', 'Patrick Kells');
    await page('patrick-kells-notes', 'Notes');
    const section = personSection(await knowledgeMaintain(dir));
    expect(section).toMatch(/Not run/);
    expect(section).not.toMatch(/patrick-kells/);
  });

  describe('surfaces', () => {
    async function callMaintain(server: { connect: (t: never) => Promise<void> }): Promise<string> {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT as never);
      const client = new Client({ name: 't', version: '0' });
      await client.connect(clientT);
      const r = await client.callTool({ name: 'knowledge_maintain', arguments: {} });
      await client.close();
      return (r.content as { text: string }[])[0].text;
    }

    it('the full loom server runs the check', async () => {
      card('patrick-kells', 'Patrick Kells');
      await page('patrick-kells-notes', 'Notes');
      const { server } = createLoomServer({ contextDir: dir });
      expect(personSection(await callMaintain(server as never))).toMatch(/`patrick-kells-notes`/);
    });

    it('the knowledge-only server leaves it out, says so, and never opens the memory database', async () => {
      card('patrick-kells', 'Patrick Kells');
      await page('patrick-kells-notes', 'Notes');
      opened.length = 0;
      const { server } = createKnowledgeOnlyServer({ contextDir: dir, identity: 'mark' });
      const report = await callMaintain(server as never);
      const section = personSection(report);
      expect(section).toMatch(/Not run/);
      expect(section).toMatch(/knowledge-only/);
      expect(section).not.toMatch(/patrick-kells/);
      expect(opened).toContain(resolve(resolveKnowledgeDbPath(dir)));
      expect(opened).not.toContain(resolve(resolveSqliteDbPath(dir)));
    });

    it('the CLI runs the check', async () => {
      card('patrick-kells', 'Patrick Kells');
      await page('patrick-kells-notes', 'Notes');
      const { stdout, code } = await runCliCaptured(['knowledge', 'maintain', '--context-dir', dir]);
      expect(code).toBe(0);
      expect(personSection(stdout)).toMatch(/`patrick-kells-notes`/);
    });
  });
});
