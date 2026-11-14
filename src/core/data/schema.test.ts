import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { getTableColumns, getTableName, eq } from 'drizzle-orm';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { buildSchema } from 'drizzle-graphql';
import { graphql } from 'graphql/index.js';
import { createDataSchema } from './database.js';
import { schema, tables, plumbing, tasks, taskComments, members, projects, projectMembers, measuringSettings, timingDays } from './schema.js';

const opened: Database.Database[] = [];
function fresh() {
  const client = new Database(':memory:'); opened.push(client);
  return { client, db: createDataSchema(client) };
}
afterEach(() => { for (const client of opened.splice(0)) client.close(); });

describe('the approved data model', () => {
  it('covers every table and expanded column in the approved model, plus its internal bookkeeping', () => {
    // Read the approved source directly. No fixture copying the implementation,
    // Python subprocess or change to the site is needed to check coverage.
    const model = readFileSync(new URL('../../../docs/how-it-works/model.py', import.meta.url), 'utf8');
    const expected: Record<string, string[]> = {};
    let current: string | undefined;
    for (const line of model.split('\n')) {
      const table = line.match(/T\("([a-z_]+)"/);
      if (table) { current = table[1]; expected[current] = []; }
      const column = line.match(/^    \("([a-z_, ]+)", "/);
      if (column && current) expected[current].push(...column[1].split(', '));
      if (line.trim().endsWith(')]),')) current = undefined;
    }
    expect(Object.keys(expected)).toHaveLength(79);
    const actual = Object.fromEntries(Object.values(tables).map(table => [getTableName(table), Object.values(getTableColumns(table)).map(c => c.name).filter(n => n !== 'singleton')]));
    expect(actual).toEqual(expected);
    const names = [...model.matchAll(/^ \("([a-z_]+)", /gm)].map(m => m[1]);
    expect(Object.values(plumbing).map(getTableName).sort()).toEqual(names.sort());
    const { client } = fresh();
    for (const table of [...Object.values(tables), ...Object.values(plumbing)]) {
      const columns = client.prepare(`PRAGMA table_info("${getTableName(table)}")`).all() as { name: string }[];
      expect(columns.map(c => c.name)).toEqual(Object.values(getTableColumns(table)).map(c => c.name));
    }
    expect(client.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps generated installation SQL exactly in step with the sole Drizzle definition', async () => {
    const statements = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema));
    const checkedIn = readFileSync(new URL('../../../assets/data/schema.sql', import.meta.url), 'utf8');
    expect(checkedIn.slice(checkedIn.indexOf('\n') + 1)).toBe(statements.join('\n') + '\n');
  });

  it('refuses an existing database and leaves its records intact', () => {
    const client = new Database(':memory:'); opened.push(client);
    client.exec("CREATE TABLE precious (words TEXT); INSERT INTO precious VALUES ('keep me')");
    expect(() => createDataSchema(client)).toThrow('requires an empty database');
    expect(client.prepare('SELECT words FROM precious').get()).toEqual({ words: 'keep me' });
    expect(client.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([{ name: 'precious' }]);
  });

  it('joins connected records through the typed schema and rejects invalid rows', () => {
    const { client, db } = fresh();
    db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
    db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: '2026-11-14T00:00:00Z' }).run();
    db.insert(projectMembers).values({ project: 'pond', member: 'jonathan' }).run();
    const task = { id: 't-1', title: 'Pick a pump', ownerKind: 'member' as const, owner: 'jonathan', project: 'pond', createdByKind: 'member' as const, createdBy: 'jonathan', createdAt: '2026-11-14T00:00:00Z', changedAt: '2026-11-14T00:00:00Z' };
    db.insert(tasks).values(task).run();
    db.insert(taskComments).values({ task: task.id, seq: 1, actorKind: 'member', actor: 'jonathan', at: task.createdAt, text: 'Fits the old hose' }).run();
    const row = db.query.tasks.findFirst({ where: eq(tasks.id, task.id), with: { projectRow: true, taskCommentsByTask: true } }).sync();
    expect(row?.projectRow?.name).toBe('Pond');
    expect(row?.taskCommentsByTask.map(c => c.text)).toEqual(['Fits the old hose']);
    expect(() => db.insert(tasks).values({ ...task, id: 'bad', priority: 5 }).run()).toThrow();
    expect(() => db.insert(tasks).values({ ...task, id: 'bad', owner: null }).run()).toThrow();
    expect(() => db.insert(projectMembers).values({ project: 'missing', member: 'jonathan' }).run()).toThrow();
    expect(() => client.prepare("UPDATE tasks SET status = 'invented'").run()).toThrow();
    expect(() => db.insert(taskComments).values({ task: task.id, seq: 1, actorKind: 'member', actor: 'jonathan', at: task.createdAt, text: 'duplicate' }).run()).toThrow();
  });

  it('keeps Measuring off by default and accumulates fractional milliseconds in real columns', () => {
    const { db } = fresh();
    db.insert(measuringSettings).values({}).run();
    expect(db.select().from(measuringSettings).get()).toMatchObject({ singleton: 1, on: false, sendOutside: false, keepDays: 90 });
    expect(() => db.insert(measuringSettings).values({}).run()).toThrow();
    db.insert(timingDays).values({ day: '2026-11-14', kind: 'request', name: 'graphql', count: 2, totalMs: 1.75, slowestMs: 1.25, typicalMs: 0.875 }).run();
    expect(db.select().from(timingDays).get()?.typicalMs).toBe(0.875);
  });

  it('can generate GraphQL reads for the entire schema without hand-written table reads', async () => {
    const { db } = fresh();
    const generated = buildSchema(db, { relationsDepthLimit: 2 });
    const result = await graphql({ schema: generated.schema, source: '{ tasks { id title projectRow { name } taskCommentsByTask { text } } timingDays { day totalMs } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ tasks: [], timingDays: [] });
  });
});
