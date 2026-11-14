import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { listenNext } from './next.js';
import { createDataSchema } from './core/data/database.js';
import { members, tokens } from './core/data/schema.js';
import { FakeClock } from './core/clock.js';
import { Operations } from './core/operations/index.js';
import { Live } from './core/live/index.js';
import { migrateHouseholdTables } from './core/household/schema.js';
import { taskService } from './apps/tasks.js';

it('mounts /graphql on the actual HTTP server and reads trusted Tasks writes from the same shared connection', async () => {
  const client = new Database(':memory:');
  const clock = new FakeClock();
  const now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  // Transitional root's unrelated sign-in/live infrastructure; never a home or importer.
  client.exec('CREATE TABLE core_migrations (piece TEXT, number INTEGER, sql TEXT, PRIMARY KEY(piece,number))');
  migrateHouseholdTables(client);
  const operations = new Operations(client, clock, changes => live.changed(changes));
  const live = new Live(clock, operations);
  const stops: Array<() => void> = [];
  const app = { db: client, operations, live, onClose: (fn: () => void) => { stops.push(fn); }, close() {} };
  db.insert(members).values({ id: 'sam', role: 'owner', joinedAt: now() }).run();
  const raw = 'actual-door-token-'.repeat(4);
  const fingerprint = createHash('sha256').update(raw).digest('hex');
  db.insert(tokens).values({ fingerprint, label: 'test', kind: 'owner', member: 'sam', createdAt: now() }).run();
  const tasks = taskService(db, now);
  const task = tasks.create({ title: 'Shared task', goal: 'Same DB', why: 'No copied reads', owner: { kind: 'household' } }, { kind: 'member', id: 'sam' });
  const server = await listenNext(app, { home: '/unused', authenticate: () => undefined });
  const read = () => fetch(server.url + '/graphql', { method: 'POST', headers: { authorization: 'Bearer ' + raw, 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ tasks { id title } }' }) });
  try {
    expect(await (await read()).json()).toEqual({ data: { tasks: [{ id: task.id, title: 'Shared task' }] } });
    tasks.edit(task.id, { title: 'Updated directly' });
    expect(await (await read()).json()).toEqual({ data: { tasks: [{ id: task.id, title: 'Updated directly' }] } });
    db.update(tokens).set({ expiresAt: new Date(clock.now() + 1000).toISOString() }).where(eq(tokens.fingerprint, fingerprint)).run();
    expect((await read()).status).toBe(200);
    clock.advance(1000);
    expect((await read()).status).toBe(401);
    db.update(tokens).set({ expiresAt: null }).where(eq(tokens.fingerprint, fingerprint)).run();
    expect((await read()).status).toBe(200);
    db.update(tokens).set({ revokedAt: now() }).where(eq(tokens.fingerprint, fingerprint)).run();
    expect((await read()).status).toBe(401);
  } finally { await server.close(); stops.reverse().forEach(stop => stop()); live.close(); operations.close(); client.close(); }
});
