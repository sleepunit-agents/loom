import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { graphql, parse, validate } from 'graphql/index.js';
import { sharedQueryTables } from '../../next-data.js';
import { createDataSchema } from './database.js';
import { dataQueries } from './queries.js';
import { members, projects, tasks } from './schema.js';
import {
  entities,
  entityGroups,
  entityAddress,
  entityAt,
  entityKey,
  entityRequest,
  tableWhere,
  type EntityTarget,
} from '../../../web/src/contexts/entities.js';

it('has a module projection for every published table and selects authorized rows before filtering and paging', async () => {
  const client = new Database(':memory:');
  try {
    const at = '2026-11-25T12:00:00Z',
      db = createDataSchema(client, () => at);
    db.insert(members).values({ id: 'reader', role: 'member', joinedAt: at }).run();
    db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
    for (const id of ['allowed', 'hidden'])
      db.insert(tasks)
        .values({
          id,
          title: 'Review ' + id,
          ownerKind: 'member',
          owner: 'reader',
          project: 'pond',
          createdByKind: 'member',
          createdBy: 'reader',
          createdAt: at,
          changedAt: at,
        })
        .run();
    const schema = dataQueries(client, {
      tables: sharedQueryTables,
      visibility: {
        ...Object.fromEntries(sharedQueryTables.map((t) => [t, () => sql`1`])),
        tasks: (f) => sql`${f.id} <> 'hidden'`,
      },
    });
    const covered = new Set<string>();
    for (const spec of Object.values(entities)) {
      if (!spec.table) continue;
      expect(validate(schema, parse(spec.query)), spec.table).toEqual([]);
      covered.add(spec.table);
    }
    // Digest items are addressable child modules of their encrypted or public digest.
    expect(entities.digest.query).toContain('digestItemsByDigest { kind text }');
    covered.add('digestItems');
    expect([...sharedQueryTables].filter((t) => !covered.has(t))).toEqual([]);
    const results = async (id?: string) =>
      graphql({
        schema,
        source: entities.ticket.query,
        variableValues: { where: tableWhere(entities.ticket, id, 'Review'), offset: 0, limit: 31 },
      });
    expect((await results()).data?.rows).toMatchObject([{ id: 'allowed' }]);
    expect((await results('hidden')).data?.rows).toEqual([]);
  } finally {
    client.close();
  }
});
it('keeps composite keys, numeric filters, nested references and unusual IDs intact', () => {
  const key = entityKey(entities.comment, { task: 't-/ ?#', seq: 92 });
  expect(tableWhere(entities.comment, key, '')).toEqual({ task: { eq: 't-/ ?#' }, seq: { eq: 92 } });
  const ref: EntityTarget = {
    kind: 'comment',
    id: key,
    scope: 'a/b+?#%',
    part: ['related', 'reviews', 'a'.repeat(64)],
  };
  expect(entityAt(entityAddress(ref))).toEqual(ref);
  expect(entityAt('entity/toString')).toBeNull();
  expect(entityAt('entity/project/%')).toBeNull();
});
it('recognizes the more specific noun and leaves ordinary questions in chat', () => {
  expect(entityRequest('Show me the project notes')).toEqual({ kind: 'projectNotes' });
  expect(entityRequest('open task T-123')).toEqual({ kind: 'ticket', id: 't-123' });
  expect(entityRequest('What changed in the project?')).toBeNull();
});

it('makes every module type reachable from the subject picker', () => {
  expect(Object.values(entityGroups).flat().sort()).toEqual(Object.keys(entities).sort());
});
