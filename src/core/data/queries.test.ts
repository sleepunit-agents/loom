import { tasksQuery } from '../../../web/src/pieces/tasks/query.js';
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
  it('counts visible comments with selected root and connected task rows in one statement', async () => {
    const { client, statements } = fixture();
    const schema = dataQueries(client, {
      tables: ['tasks', 'taskComments', 'projects'],
      visibility: { tasks: fields => ne(fields.id, 'hidden'), taskComments: fields => ne(fields.text, 'excluded-comment'), projects: () => sql`true` },
    });
    const root = await graphql({ schema, source: '{ tasks(orderBy:{id:{direction:asc,priority:0}}) { id total: commentCount } }' });
    expect(root.errors).toBeUndefined();
    expect(root.data).toEqual({ tasks: [{ id: 'a', total: 1 }, { id: 'b', total: 1 }] });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('count(*)');
    expect(statements[0]).not.toContain('"title"');
    statements.length = 0;
    const nested = await graphql({ schema, source: '{ projects(where:{id:{eq:"pond"}}) { tasksByProject(orderBy:{id:{direction:asc,priority:0}}) { id commentCount } } }' });
    expect(nested.errors).toBeUndefined();
    expect(nested.data).toEqual({ projects: [{ tasksByProject: [{ id: 'a', commentCount: 1 }, { id: 'b', commentCount: 1 }] }] });
    expect(statements).toHaveLength(1);
  });

  it('counts zero, sees fresh writes, supports fragments and omits unrequested counts', async () => {
    const { client, db, statements } = fixture();
    const schema = dataQueries(client, {
      tables: ['tasks', 'taskComments'],
      visibility: { tasks: () => sql`true`, taskComments: () => sql`true` },
    });
    const query = 'query { tasksSingle(where:{id:{eq:"a"}}) { ...Count } } fragment Count on TasksSelectItem { commentCount }';
    expect((await graphql({ schema, source: query })).data).toEqual({ tasksSingle: { commentCount: 2 } });
    const limited = await graphql({ schema, source: '{ counted: tasksSingle(where:{id:{eq:"a"}}) { commentCount taskCommentsByTask(limit:1) { seq } } plain: tasksSingle(where:{id:{eq:"b"}}) { id } }' });
    expect(limited.errors).toBeUndefined();
    expect(limited.data).toEqual({ counted: { commentCount: 2, taskCommentsByTask: [{ seq: 1 }] }, plain: { id: 'b' } });
    db.delete(taskComments).where(eq(taskComments.task, 'a')).run();
    statements.length = 0;
    const empty = await graphql({ schema, source: query });
    expect(empty.errors).toBeUndefined();
    expect(empty.data).toEqual({ tasksSingle: { commentCount: 0 } });
    expect(statements).toHaveLength(1);
    statements.length = 0;
    await graphql({ schema, source: '{ tasks { id } }' });
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain('count(*)');
    statements.length = 0;
    const skipped = await graphql({ schema, source: 'query($count:Boolean!) { tasks { id commentCount @include(if:$count) } }', variableValues: { count: false } });
    expect(skipped.errors).toBeUndefined();
    expect(statements[0]).not.toContain('count(*)');
    const noComments = dataQueries(client, { tables: ['tasks'], visibility: { tasks: () => sql`true` } });
    expect((await graphql({ schema: noComments, source: '{ tasks { commentCount } }' })).errors?.[0].message).toContain('Cannot query field');
  });

  it('preserves policy subqueries and parameter binding inside counts, failing closed on invalid policies', async () => {
    const { client, statements } = fixture();
    const read = (commentPolicy: () => ReturnType<typeof sql>) => dataQueries(client, {
      tables: ['tasks', 'taskComments'], visibility: { tasks: () => sql`true`, taskComments: commentPolicy },
    });
    const source = '{ tasksSingle(where:{id:{eq:"a"}}) { id commentCount } }';
    // A destructive column-alias rewrite would make this false predicate true.
    const denied = await graphql({ schema: read(() => sql`${taskComments.task} in (select ${projects.id} from ${projects} where ${projects.name} = ${'Pond'})`), source });
    expect(denied.errors).toBeUndefined();
    expect(denied.data).toEqual({ tasksSingle: { id: 'a', commentCount: 0 } });
    expect(statements).toHaveLength(1);
    const allowed = await graphql({ schema: read(() => sql`${taskComments.task} in (select ${tasks.id} from ${tasks} where ${tasks.project} = ${'pond'})`), source });
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data).toEqual({ tasksSingle: { id: 'a', commentCount: 2 } });
    statements.length = 0;
    expect((await graphql({ schema: read(() => undefined as never), source })).errors?.[0].message).toContain('SQL visibility required for taskComments');
    expect(statements).toHaveLength(0);
  });

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
        id projectRow { name } taskCommentsByTask(orderBy: {seq: {direction: desc, priority: 0}}, limit: 1) { text }
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
  it('preserves columns and parameters inside SQL visibility subqueries at root and connected tables', async () => {
    const { client, statements } = fixture();
    const schema = dataQueries(client, {
      tables: ['tasks', 'projects'],
      visibility: {
        // No task id is a project id. Rewriting projects.id to tasks.id
        // would turn this deny-all policy into an allow-all policy.
        tasks: fields => sql`${fields.id} in (select ${projects.id} from ${projects} where ${'allowed'} = ${'allowed'})`,
        projects: () => sql`true`,
      },
    });
    const root = await graphql({ schema, source: '{ tasks { id } }' });
    expect(root.errors).toBeUndefined();
    expect(root.data).toEqual({ tasks: [] });
    const nested = await graphql({ schema, source: '{ projects(where: {id: {eq: "pond"}}) { tasksByProject { id } } }' });
    expect(nested.errors).toBeUndefined();
    expect(nested.data).toEqual({ projects: [{ tasksByProject: [] }] });
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('select "projects"."id" from "projects"');
    expect(statements[1]).toContain('select "projects"."id" from "projects"');
  });

  it('rejects unsupported nested relation aliases including fragments before querying', async () => {
    const { client, statements } = fixture();
    const schema = dataQueries(client, {
      tables: ['tasks', 'taskComments'],
      visibility: { tasks: () => sql`true`, taskComments: () => sql`true` },
    });
    for (const source of [
      '{ tasks { first: taskCommentsByTask(where: {seq: {eq: 1}}) { text } second: taskCommentsByTask(where: {seq: {eq: 2}}) { text } } }',
      'query { tasks { ...Comments } } fragment Comments on TasksSelectItem { first: taskCommentsByTask { text } }',
      '{ tasks { taskCommentsByTask: taskCommentsByTask { text } } }',
      '{ tasks { ... on TasksSelectItem { first: taskCommentsByTask { text } } } }',
    ]) {
      const result = await graphql({ schema, source });
      expect(result.errors?.[0].message).toContain('Nested relation aliases');
    }
    expect(statements).toHaveLength(0);
    const valid = await graphql({ schema, source: '{ selected: tasksSingle(where: {id: {eq: "a"}}) { key: id taskCommentsByTask(where: {seq: {eq: 2}}) { body: text } } }' });
    expect(valid.errors).toBeUndefined();
    expect(valid.data).toEqual({ selected: { key: 'a', taskCommentsByTask: [{ body: 'excluded-comment' }] } });
    expect(statements).toHaveLength(1);
  });

  it('binds policy subquery parameters and still returns allowed root and connected rows', async () => {
    const { client } = fixture();
    for (const [name, ids] of [['Pond', ['a', 'b']], ['Private', ['hidden']]] as const) {
      const schema = dataQueries(client, {
        tables: ['tasks', 'projects'],
        visibility: {
          tasks: fields => sql`${fields.project} in (select ${projects.id} from ${projects} where ${projects.name} = ${name})`,
          projects: () => sql`true`,
        },
      });
      const root = await graphql({ schema, source: '{ tasks(orderBy: {id: {direction: asc, priority: 0}}) { id } }' });
      expect(root.errors).toBeUndefined();
      expect(root.data).toEqual({ tasks: ids.map(id => ({ id })) });
      const nested = await graphql({ schema, source: '{ projects(orderBy: {id: {direction: asc, priority: 0}}) { id tasksByProject { id } } }' });
      expect(nested.errors).toBeUndefined();
      expect(nested.data).toEqual({ projects: [
        { id: 'pond', tasksByProject: name === 'Pond' ? [{ id: 'a' }, { id: 'b' }] : [] },
        { id: 'secret', tasksByProject: name === 'Private' ? [{ id: 'hidden' }] : [] },
      ] });
    }
  });

});

it('orders the actual Tasks selection by urgency, then position, then ID', async () => {
  const { client, db } = fixture();
  db.update(tasks).set({ priority: 3, position: 0 }).where(eq(tasks.id, 'a')).run();
  db.update(tasks).set({ priority: 1, position: 1 }).where(eq(tasks.id, 'b')).run();
  db.insert(tasks).values({ id: 'c', title: 'Urgent first', priority: 1, position: -1, ownerKind: 'member', owner: 'sam', createdByKind: 'member', createdBy: 'sam', createdAt: at, changedAt: at }).run();
  db.insert(tasks).values({ id: 'd', title: 'Equal urgency and position', priority: 1, position: 1, ownerKind: 'member', owner: 'sam', createdByKind: 'member', createdBy: 'sam', createdAt: at, changedAt: at }).run();
  const schema = dataQueries(client, { tables: ['tasks', 'taskComments', 'taskLinks', 'changeTasks', 'changes'], visibility: {
    tasks: fields => ne(fields.id, 'hidden'), taskComments: () => sql`true`, taskLinks: () => sql`true`, changeTasks: () => sql`true`, changes: () => sql`true`,
  } });
  const result = await graphql({ schema, source: tasksQuery });
  expect(result.errors).toBeUndefined();
  expect((result.data!.tasks as { id: string }[]).map(row => row.id)).toEqual(['c', 'b', 'd', 'a']);
});
