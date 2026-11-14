import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema, type DataDatabase } from './database.js';
import { DataWrites } from './writes.js';
import { members, projectMembers, projects } from './schema.js';
import { taskService } from '../../apps/tasks.js';

let client: Database.Database, db: DataDatabase;
const at = '2026-11-14T22:00:00.000Z';
beforeEach(() => {
  client = new Database(':memory:');
  db = createDataSchema(client, () => at);
  db.insert(members).values({ id: 'sam', role: 'member', joinedAt: at }).run();
  db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
});
afterEach(() => client.close());

it('commits direct Drizzle services and sharing changes before either notification', () => {
  const seen: string[] = [];
  const writes = new DataWrites(db, {
    refreshAccess() {
      expect(client.inTransaction).toBe(false);
      expect(db.select().from(projectMembers).all()).toHaveLength(1);
      expect(taskService(db).list()).toHaveLength(1);
      seen.push('access');
    },
    changed() { expect(client.inTransaction).toBe(false); seen.push('data'); },
  });
  const result = writes.run(() => {
    db.insert(projectMembers).values({ project: 'pond', member: 'sam' }).run();
    const task = taskService(db, () => at).create({ title: 'Fix pump', goal: 'Pump works', why: 'Pond needs water', owner: { kind: 'member', id: 'sam' }, project: 'pond' }, { kind: 'member', id: 'sam' });
    expect(seen).toEqual([]);
    return task;
  });
  expect(result.value.title).toBe('Fix pump');
  expect(result.notificationErrors).toEqual([]);
  expect(seen).toEqual(['access', 'data']);
});

it('rolls back service writes and sharing changes without notifying on failure', () => {
  const notify = { refreshAccess: vi.fn(), changed: vi.fn() };
  const writes = new DataWrites(db, notify);
  expect(() => writes.run(() => {
    taskService(db, () => at).create({ title: 'Fix pump', goal: 'Pump works', why: 'Pond needs water', owner: { kind: 'household' } }, { kind: 'member', id: 'sam' });
    db.insert(projectMembers).values({ project: 'pond', member: 'sam' }).run();
    throw new Error('receipt failed');
  })).toThrow('receipt failed');
  expect(taskService(db).list()).toEqual([]);
  expect(db.select().from(projectMembers).all()).toEqual([]);
  expect(notify.refreshAccess).not.toHaveBeenCalled();
  expect(notify.changed).not.toHaveBeenCalled();
  writes.run(() => db.update(projects).set({ name: 'Recovered' }).where(eq(projects.id, 'pond')).run());
  expect(notify.changed).toHaveBeenCalledOnce();
});

it('batches nested writes and rolls back a caught inner failure to its savepoint', () => {
  const notify = { refreshAccess: vi.fn(), changed: vi.fn() };
  const writes = new DataWrites(db, notify);
  writes.run(() => {
    writes.run(() => db.update(projects).set({ name: 'Outer value' }).run());
    expect(() => writes.run(() => {
      db.update(projects).set({ name: 'Rolled back' }).run();
      throw new Error('inner failed');
    })).toThrow('inner failed');
    expect(db.select().from(projects).get()!.name).toBe('Outer value');
    expect(notify.changed).not.toHaveBeenCalled();
  });
  expect(notify.refreshAccess).toHaveBeenCalledOnce();
  expect(notify.changed).toHaveBeenCalledOnce();
});

it('refuses an unrelated enclosing transaction before running any work', () => {
  const notify = { refreshAccess: vi.fn(), changed: vi.fn() }, operation = vi.fn();
  const writes = new DataWrites(db, notify);
  db.transaction(() => expect(() => writes.run(operation)).toThrow('outer transaction'));
  expect(operation).not.toHaveBeenCalled();
  expect(notify.changed).not.toHaveBeenCalled();
});

it('does not notify when SQLite rejects the final commit', () => {
  const notify = { refreshAccess: vi.fn(), changed: vi.fn() };
  const writes = new DataWrites(db, notify);
  expect(() => writes.run(() => {
    client.pragma('defer_foreign_keys = ON');
    db.insert(projectMembers).values({ project: 'missing', member: 'sam' }).run();
  })).toThrow('FOREIGN KEY');
  expect(client.inTransaction).toBe(false);
  expect(db.select().from(projectMembers).all()).toEqual([]);
  expect(notify.refreshAccess).not.toHaveBeenCalled();
  expect(notify.changed).not.toHaveBeenCalled();
});

it('does not notify for successful inner writes when the enclosing boundary rolls back', () => {
  const notify = { refreshAccess: vi.fn(), changed: vi.fn() };
  const writes = new DataWrites(db, notify);
  expect(() => writes.run(() => {
    writes.run(() => db.update(projects).set({ name: 'Inner success' }).run());
    throw new Error('outer failed');
  })).toThrow('outer failed');
  expect(db.select().from(projects).get()!.name).toBe('Pond');
  expect(notify.refreshAccess).not.toHaveBeenCalled();
  expect(notify.changed).not.toHaveBeenCalled();
});

it('rejects async callbacks before invocation and rolls back returned thenables', () => {
  const notify = { refreshAccess: vi.fn(), changed: vi.fn() };
  const writes = new DataWrites(db, notify);
  let started = false;
  expect(() => writes.run(async () => { started = true; })).toThrow('synchronous');
  expect(started).toBe(false);
  expect(() => writes.run(() => {
    db.update(projects).set({ name: 'Uncommitted' }).run();
    return Promise.resolve();
  })).toThrow('synchronous');
  expect(db.select().from(projects).get()!.name).toBe('Pond');
  expect(notify.changed).not.toHaveBeenCalled();
});

it('returns notification failures separately from the committed result and attempts both hooks', () => {
  const accessError = new Error('socket failure'), dataError = new Error('live failure');
  const writes = new DataWrites(db, {
    refreshAccess() { throw accessError; },
    changed() { throw dataError; },
  });
  const result = writes.run(() => {
    db.update(projects).set({ name: 'Committed' }).run();
    return 'receipt';
  });
  expect(result).toEqual({ value: 'receipt', notificationErrors: [accessError, dataError] });
  expect(db.select().from(projects).get()!.name).toBe('Committed');
});
