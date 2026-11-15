import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { createDataSchema, dataDatabase } from '../../../../src/core/data/database';
import { nextData } from '../../../../src/next-data';
import { FakeClock } from '../../../../src/core/clock';
import { generatedDataClient, browserQueryTransport } from './client';
import { tasksQuery, type TasksSelection } from '../../pieces/tasks/query';

const clean: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
function results<T>() {
  const queued: T[] = []; let waiting: ((value: T) => void) | undefined;
  return {
    push(value: T) { if (waiting) { const resolve = waiting; waiting = undefined; resolve(value); } else queued.push(value); },
    next() { return queued.length ? Promise.resolve(queued.shift()!) : new Promise<T>(resolve => { waiting = resolve; }); },
  };
}
it('feeds the registered Tasks selection and a second reader over one authenticated socket with only change patches', async () => {
  const db = new Database(':memory:'); clean.push(() => db.close()); createDataSchema(db);
  const at = '1970-01-01T00:00:00.000Z', token = 'fictional-token'.repeat(5);
  db.exec(`INSERT INTO members(id,role,joined_at) VALUES('fiction','owner','${at}');
    INSERT INTO tasks(id,title,owner_kind,created_by_kind,created_by,created_at,changed_at)
    VALUES('t-1','Fictional pump','household','member','fiction','${at}','${at}');`);
  db.prepare('INSERT INTO tokens(fingerprint,label,kind,member,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run(createHash('sha256').update(token).digest('hex'), 'Fictional fixture', 'owner', 'fiction', at, '1970-01-01T00:00:01.000Z');
  const clock = new FakeClock(0);
  const data = nextData(dataDatabase(db, () => new Date(clock.now()).toISOString()), clock, () => true);
  const server = createServer(); data.attach(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  clean.push(() => new Promise<void>(resolve => server.close(() => resolve()))); clean.push(() => data.close());
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No address');
  let connections = 0; const frames: string[] = [];
  class BrowserSocket extends WebSocket {
    constructor(url: string, protocols: string | string[]) {
      super(url, protocols, { headers: { authorization: `Bearer ${token}` } }); connections++;
      this.on('message', raw => frames.push(String(raw)));
    }
  }
  vi.stubGlobal('WebSocket', BrowserSocket);
  const transport = browserQueryTransport(`ws://127.0.0.1:${address.port}/graphql`), client = generatedDataClient(transport);
  clean.push(() => transport.close());
  const tasks = results<{ data?: TasksSelection; error?: unknown }>(), detail = results<{ data?: { tasks: { title: string }[] }; error?: unknown }>();
  const a = client.query<TasksSelection>(tasksQuery, {}).subscribe(tasks.push);
  const b = client.query<{ tasks: { title: string }[] }>('{ tasks { id title } }', {}).subscribe(detail.push);
  clean.push(() => { a.unsubscribe(); b.unsubscribe(); });
  const initial = await tasks.next(); await detail.next();
  expect(initial.data?.tasks).toMatchObject([{ id: 't-1', title: 'Fictional pump', isReady: true, commentCount: 0 }]);
  expect(connections).toBe(1);
  data.writes.run(() => db.exec("UPDATE tasks SET title='Updated fictional pump'"));
  expect((await tasks.next()).data?.tasks[0].title).toBe('Updated fictional pump');
  expect((await detail.next()).data?.tasks[0].title).toBe('Updated fictional pump');
  expect(initial.data?.tasks[0].title).toBe('Fictional pump');
  expect(frames.some(frame => frame.includes('"path":["tasks",0,"title"]'))).toBe(true);
  clock.advance(1000);
  async function ended<T extends { error?: unknown }>(feed: { next(): Promise<T> }) {
    let result = await feed.next();
    while (!result.error) result = await feed.next();
    return result;
  }
  expect(await ended(tasks)).toMatchObject({ error: expect.anything(), data: undefined });
  expect(await ended(detail)).toMatchObject({ error: expect.anything(), data: undefined });
  expect(connections).toBe(1);
});
