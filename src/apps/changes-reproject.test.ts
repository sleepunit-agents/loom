import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { graphql } from 'graphql/index.js';
import { createDataSchema, type DataDatabase } from '../core/data/database.js';
import { changes, members, projects, projectMembers, projectRepositories } from '../core/data/schema.js';
import { DataWrites } from '../core/data/writes.js';
import { dataQueries } from '../core/data/queries.js';
import { workVisibility } from '../core/data/work-visibility.js';
import { reprojectChanges } from './changes.js';
const at = '2026-11-14T20:00:00.000Z', id = 'github:house/loom#1';
let client: Database.Database, db: DataDatabase;
let writes: DataWrites, notifications: unknown[];
let read: (member: 'sam' | 'lee') => Promise<string[]>;
beforeEach(() => {
  client = new Database(':memory:'); db = createDataSchema(client, () => at);
  db.insert(members).values(['sam','lee'].map(id => ({id,role:'member' as const,joinedAt:at}))).run();
  db.insert(projects).values(['pond','bank'].map(id => ({id,name:id}))).run();
  db.insert(projectMembers).values([{project:'pond',member:'sam'},{project:'bank',member:'lee'}]).run();
  db.insert(projectRepositories).values({project:'pond',repository:'House/Loom'}).run();
  db.insert(changes).values({id,repository:'house/loom',number:1,title:'Cached facts',body:'Body',url:'https://github.com/house/loom/pull/1',state:'open',draft:false,authorLogin:'author',project:'pond',branch:'feature',headCommit:'a'.repeat(40),baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'you',openedAt:at,updatedAt:at}).run();
  const schemas = Object.fromEntries(['sam','lee'].map(id => [id,dataQueries(client, {tables:['changes'],visibility:workVisibility({kind:'member',id})})]));
  read = async member => {
    const result = await graphql({schema:schemas[member]!,source:'{ changes { id } }'});
    expect(result.errors).toBeUndefined();
    return (result.data!.changes as {id:string}[]).map(row => row.id);
  };
  notifications = [];
  writes = new DataWrites(db, {refreshAccess() { notifications.push({transaction:client.inTransaction,project:db.select().from(changes).get()!.project}); },changed() { notifications.push('changed'); }});
});
afterEach(() => client.close());

it('moves and removes current project labels atomically before notifying retained SQL readers, preserving every GitHub fact', async () => {
  const before = db.select().from(changes).get()!;
  expect(await read('sam')).toEqual([id]); expect(await read('lee')).toEqual([]);
  const transferred = writes.run(() => {
    db.delete(projectRepositories).run();
    db.insert(projectRepositories).values({project:'bank',repository:'github:HOUSE/LOOM'}).run();
    return reprojectChanges(db);
  });
  expect(transferred.value).toEqual([id]);
  expect(notifications).toEqual([{transaction:false,project:'bank'},'changed']);
  expect(db.select().from(changes).get()).toEqual({...before,project:'bank'});
  expect(await read('sam')).toEqual([]); expect(await read('lee')).toEqual([id]);
  notifications.length = 0;
  writes.run(() => { db.delete(projectRepositories).run(); reprojectChanges(db); });
  expect(db.select().from(changes).get()).toEqual({...before,project:null});
  expect(await read('sam')).toEqual([]); expect(await read('lee')).toEqual([]);
  expect(notifications).toEqual([{transaction:false,project:null},'changed']);
  writes.run(() => { db.insert(projectRepositories).values({project:'pond',repository:'house/loom'}).run(); reprojectChanges(db); });
  expect(db.select().from(changes).get()).toEqual(before);
  expect(writes.run(() => reprojectChanges(db)).value).toEqual([]);
});

it('rejects ambiguous normalized mappings and rolls back the enclosing repository edit without publication', () => {
  expect(() => writes.run(() => {
    db.insert(projectRepositories).values({project:'bank',repository:'github:HOUSE/LOOM'}).run();
    reprojectChanges(db);
  })).toThrow('Repository belongs to more than one project');
  expect(db.select().from(projectRepositories).all()).toEqual([{project:'pond',repository:'House/Loom'}]);
  expect(db.select().from(changes).where(eq(changes.id,id)).get()!.project).toBe('pond');
  expect(notifications).toEqual([]);
});

it('rolls successful reprojection back with a later failure in the caller transaction', () => {
  const before = db.select().from(changes).all();
  expect(() => writes.run(() => {
    db.delete(projectRepositories).run();
    expect(reprojectChanges(db)).toEqual([id]);
    throw new Error('Later operation failed');
  })).toThrow('Later operation failed');
  expect(db.select().from(changes).all()).toEqual(before);
  expect(db.select().from(projectRepositories).all()).toEqual([{project:'pond',repository:'House/Loom'}]);
  expect(notifications).toEqual([]);
});
