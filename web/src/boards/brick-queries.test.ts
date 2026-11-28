/** The selections the pull and repository bricks wrote for themselves, run against the schema loom generates
 * from its tables (as src/core/data/work-query.test.ts runs the desktop's): every field, filter and order they
 * name exists. The question, approval and contact bricks use the desktop's own selections, which have their suites. */
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
// The root's graphql, the one the generated schema is built with (web/ has its own copy).
import { graphql } from '../../../node_modules/graphql/index.js';
import { sql } from 'drizzle-orm';
import { createDataSchema } from '../../../src/core/data/database.js';
import { dataQueries, type QueryVisibility } from '../../../src/core/data/queries.js';
import * as s from '../../../src/core/data/schema.js';
import { repositoryKey as storedKey } from '../../../src/pieces/changes/model.js';
import './bricks';
import { pullQuery } from './bricks-pull';
import { repositoryKey, repositoryQuery } from './bricks-repository';

it('reads a pull request and a repository with selections the generated schema answers', async () => {
  const client = new Database(':memory:');
  try {
    const at = '2026-11-14T00:00:00.000Z';
    const db = createDataSchema(client, () => at);
    db.insert(s.members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
    db.insert(s.agents).values({ id: 'art', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
    db.insert(s.projects).values({ id: 'pond', name: 'Pond' } as typeof s.projects.$inferInsert).run();
    const change = { repository: 'acme/app', body: '', url: 'https://example.test/1', draft: false, authorLogin: 'sam', agent: 'art', branch: 'work', headCommit: 'head', baseBranch: 'next',
      checks: 'failing', review: 'required', mergeable: 'unknown', waitingOn: 'author', openedAt: at, updatedAt: at } as const;
    db.insert(s.changes).values([
      { ...change, id: 'github:acme/app#1', number: 1, title: 'One', state: 'open', project: 'pond' },
      { ...change, id: 'github:acme/app#2', number: 2, title: 'Two', state: 'merged', project: 'pond' },
      { ...change, id: 'github:acme/app#3', number: 3, title: 'Three', state: 'open', updatedAt: '2026-11-15T00:00:00.000Z' },
      { ...change, id: 'github:acme/other#1', number: 1, title: 'Elsewhere', state: 'open', repository: 'acme/other' },
    ]).run();
    db.insert(s.tasks).values({ id: 't-1', title: 'A ticket', ownerKind: 'member', owner: 'sam', createdByKind: 'member', createdBy: 'sam', createdAt: at, changedAt: at }).run();
    db.insert(s.changeTasks).values({ change: 'github:acme/app#1', task: 't-1' }).run();
    db.insert(s.changeChecks).values([{ change: 'github:acme/app#1', name: 'build', state: 'failing' }, { change: 'github:acme/app#3', name: 'unit', state: 'running' }]).run();
    db.insert(s.changePeople).values({ change: 'github:acme/app#1', login: 'sam', role: 'author' }).run();
    db.insert(s.changeFiles).values([{ change: 'github:acme/app#1', path: 'src/a.ts', additions: 4, deletions: 1 }, { change: 'github:acme/app#3', path: 'src/b.ts', additions: 2, deletions: 0 }]).run();
    const tables = ['changes', 'changeChecks', 'changePeople', 'changeFiles', 'changeTasks', 'tasks'] as const;
    const schema = dataQueries(client, { tables, visibility: Object.fromEntries(tables.map(name => [name, () => sql`true`])) as QueryVisibility });
    const read = async (source: string, variableValues: Record<string, string>) => {
      const result = await graphql({ schema, source, variableValues });
      expect(result.errors).toBeUndefined();
      return result.data as Record<string, any[]>;
    };
    const pull = await read(pullQuery, { id: 'github:acme/app#1' });
    expect(pull.changes).toMatchObject([{ id: 'github:acme/app#1', number: 1, state: 'open', checks: 'failing', waitingOn: 'author', project: 'pond', agent: 'art' }]);
    expect(pull.changeChecks).toEqual([{ change: 'github:acme/app#1', name: 'build', state: 'failing' }]);
    expect(pull.changePeople).toEqual([{ change: 'github:acme/app#1', login: 'sam', role: 'author' }]);
    expect(pull.changeFiles).toEqual([{ change: 'github:acme/app#1', path: 'src/a.ts', additions: 4, deletions: 1 }]);
    expect(pull.changeTasks).toEqual([{ change: 'github:acme/app#1', task: 't-1', taskRow: { id: 't-1', title: 'A ticket', status: 'open' } }]);
    expect((await read(pullQuery, { id: 'github:acme/app#9' })).changes).toEqual([]);
    // A repository's open pull requests, latest first; in one project when one is named; nothing for one loom has not read.
    const all = await read(repositoryQuery(false), { repository: repositoryKey('github:Acme/App.git') });
    expect(all.open.map(c => c.number)).toEqual([3, 1]);
    expect(all.known).toHaveLength(1);
    const pond = await read(repositoryQuery(true), { repository: 'acme/app', project: 'pond' });
    expect(pond.open.map(c => c.number)).toEqual([1]);
    expect(await read(repositoryQuery(false), { repository: 'acme/none' })).toEqual({ open: [], known: [] });
    for (const raw of ['github:Acme/App.git', 'acme/app', 'Acme/App', 'github:acme/app']) expect(repositoryKey(raw)).toBe(storedKey(raw));
  } finally { client.close(); }
});
