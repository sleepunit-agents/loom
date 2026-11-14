import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { eq, ne, sql } from 'drizzle-orm';
import { graphql, printSchema } from 'graphql/index.js';
import { createDataSchema } from './database.js';
import { dataQueries } from './queries.js';
import { members, projects, tasks, taskComments, taskLinks } from './schema.js';

const opened: Database.Database[] = [];
const at = '2026-11-14T00:00:00.000Z';
function fixture() {
  const statements: string[] = [];
  const client = new Database(':memory:', { verbose: statement => statements.push(statement) });
  opened.push(client);
  const db = createDataSchema(client, () => at);
  db.insert(members).values({ id: 'sam', role: 'member', joinedAt: at }).run();
  db.insert(projects).values([{ id: 'pond', name: 'Pond' }, { id: 'secret', name: 'Private' }]).run();
  for (const [id, priority, project] of [['a', 2, 'pond'], ['b', 1, 'pond'], ['hidden', 0, 'secret']] as const) {
    db.insert(tasks).values({ id, title: id, priority, project, ownerKind: 'member', owner: 'sam', createdByKind: 'member', createdBy: 'sam', createdAt: at, changedAt: at }).run();
    db.insert(taskComments).values({ task: id, seq: 1, actorKind: 'member', actor: 'sam', at, text: id + '-comment' }).run();
  }
  db.insert(taskComments).values({ task: 'a', seq: 2, actorKind: 'member', actor: 'sam', at, text: 'excluded-comment' }).run();
  db.insert(taskLinks).values({ task: 'a', dependsOn: 'hidden', type: 'blocks' }).run();
  statements.length = 0;
  return { client, db, statements };
}
afterEach(() => { for (const client of opened.splice(0)) client.close(); });

describe('generated SQL reads', () => {
  it('filters, orders, limits and joins selected fields in one SQL statement', async () => {
    const { client, statements } = fixture();
    const schema = dataQueries(client, {
      tables: ['tasks', 'taskComments', 'projects'],
      visibility: {
        tasks: fields => ne(fields.id, 'hidden'),
        taskComments: fields => ne(fields.text, 'excluded-comment'),
        projects: () => sql`true`,
      },
    });
    const result = await graphql({ schema, source: `{
      tasks(where: {status: {eq: open}}, orderBy: {priority: {direction: asc, priority: 0}}, limit: 1) {
        id projectRow { name } taskCommentsByTask { text }
      }
    }` });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ tasks: [{ id: 'b', projectRow: { name: 'Pond' }, taskCommentsByTask: [{ text: 'b-comment' }] }] });
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain('"title"');
    expect(statements[0]).toContain('order by');
    expect(statements[0]).toContain('hidden');
  });

  it('constrains nested many AND singular relations, including single root reads', async () => {
    const { client, statements } = fixture();
    const schema = dataQueries(client, {
      tables: ['tasks', 'taskComments', 'taskLinks', 'projects'],
      visibility: {
        tasks: fields => ne(fields.id, 'hidden'),
        taskComments: fields => ne(fields.text, 'excluded-comment'),
        taskLinks: () => sql`true`,
        projects: fields => eq(fields.id, 'secret'),
      },
    });
    const result = await graphql({ schema, source: `{
      tasksSingle(where: {id: {eq: "a"}}) {
        id projectRow { name } taskCommentsByTask { text }
        taskLinksByTask { dependsOnRow { id } }
      }
    }` });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ tasksSingle: {
      id: 'a', projectRow: null, taskCommentsByTask: [{ text: 'a-comment' }],
      taskLinksByTask: [{ dependsOnRow: null }],
    } });
    expect(statements).toHaveLength(1);
    const hidden = await graphql({ schema, source: '{ tasksSingle(where: {id: {eq: "hidden"}}) { id } }' });
    expect(hidden.errors).toBeUndefined();
    expect(hidden.data).toEqual({ tasksSingle: null });
  });

  it('has no mutation, plumbing, credentials or non-selected reverse relations', async () => {
    const { client } = fixture();
    const schema = dataQueries(client, { tables: ['projects', 'tasks'], visibility: { projects: () => sql`true`, tasks: () => sql`true` } });
    const printed = printSchema(schema);
    expect(schema.getMutationType()).toBeUndefined();
    for (const name of ['tokens', 'sessions', 'signinChallenges', 'passkeys', 'operationResults', 'conversationsByProject', 'taskCommentsByTask']) expect(printed).not.toContain(name);
    const result = await graphql({ schema, source: '{ tokens { fingerprint } }' });
    expect(result.errors?.[0].message).toContain('Cannot query field');
  });

  it('requires an explicit policy for every selected table and refuses bad policy results', async () => {
    const { client, statements } = fixture();
    expect(() => dataQueries(client, { tables: [], visibility: {} })).toThrow('at least one');
    expect(() => dataQueries(client, { tables: ['tasks'], visibility: {} })).toThrow('Missing SQL visibility');
    expect(() => dataQueries(client, { tables: ['tasks'], visibility: { tasks: () => sql`true` }, relationsDepthLimit: 4 })).toThrow('depth');
    const schema = dataQueries(client, { tables: ['tasks'], visibility: { tasks: () => undefined as never } });
    const result = await graphql({ schema, source: '{ tasks { id } }' });
    expect(result.errors?.[0].message).toContain('SQL visibility required');
    expect(statements).toHaveLength(0);
  });

  it('keeps independently built caller policies separate and snapshots the policy map', async () => {
    const { client } = fixture();
    const visibility = { tasks: () => sql`false` };
    const denied = dataQueries(client, { tables: ['tasks'], visibility });
    visibility.tasks = () => sql`true`;
    const allowed = dataQueries(client, { tables: ['tasks'], visibility });
    const [a, b] = await Promise.all([
      graphql({ schema: denied, source: '{ tasks { id } }' }),
      graphql({ schema: allowed, source: '{ tasks { id } }' }),
    ]);
    expect(a.errors).toBeUndefined(); expect(b.errors).toBeUndefined();
    expect(a.data).toEqual({ tasks: [] });
    expect(b.data?.tasks).toHaveLength(3);
  });
});
