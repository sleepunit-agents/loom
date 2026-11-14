import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { GraphQLString } from 'graphql/index.js';
import { createDataSchema } from './database.js';
import { dataHttp } from './http.js';
import { members, tasks } from './schema.js';

const clients: Database.Database[] = [];
afterEach(() => clients.splice(0).forEach(client => client.close()));
const request = (query: string, token = 'sam') => ({ method: 'POST', headers: { 'content-type': 'application/json', authorization: token }, body: JSON.stringify({ query, extensions: { viewer: { kind: 'member', id: 'owner' } } }) });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  const db = createDataSchema(client);
  const at = '2026-11-14T00:00:00.000Z';
  db.insert(members).values(['sam','other'].map(id => ({ id, role: 'member' as const, joinedAt: at }))).run();
  db.insert(tasks).values({ id: 'mine', title: 'Mine', ownerKind: 'member', owner: 'sam', createdByKind: 'member', createdBy: 'sam', createdAt: at, changedAt: at }).run();
  return db;
}
it('composes typed extension roots with generated reads and server-owned caller context', async () => {
  const db = fixture();
  const app = dataHttp(db, req => ({ viewer: { kind: 'member', id: req.headers.get('authorization')! }, valid: () => true }), undefined, {
    queryFields: [
      { memoryExample: { type: GraphQLString, resolve: (_source, _args, context) => context.viewer.id } },
      { secondExample: { type: GraphQLString, args: { prefix: { type: GraphQLString } }, resolve: (_source, args, context) => args.prefix + context.viewer.id } },
    ],
  });
  expect(await (await app.request('http://loom/graphql', request('{ tasks { id } mine: memoryExample secondExample(prefix:"hello ") }'))).json()).toEqual({ data: { tasks: [{ id: 'mine' }], mine: 'sam', secondExample: 'hello sam' } });
  expect(await (await app.request('http://loom/graphql', request('{ tasks { id } memoryExample }', 'other'))).json()).toEqual({ data: { tasks: [], memoryExample: 'other' } });
  expect((await (await app.request('http://loom/graphql', request('{ tokens { fingerprint } }'))).json()).errors).toBeDefined();
});
it('does not admit unauthenticated extension execution or release words after async auth loss', async () => {
  const db = fixture();
  let valid = true, calls = 0;
  const app = dataHttp(db, req => req.headers.get('authorization') === 'sam' ? { viewer: { kind: 'member', id: 'sam' }, valid: () => valid } : undefined, undefined, {
    queryFields: [{ memoryExample: { type: GraphQLString, async resolve() { calls++; await Promise.resolve(); valid = false; return 'private words'; } } }],
  });
  expect((await app.request('http://loom/graphql', request('{ memoryExample }', 'unknown'))).status).toBe(401);
  expect(calls).toBe(0);
  const response = await app.request('http://loom/graphql', request('{ tasks { title } memoryExample }'));
  expect(response.status).toBe(401);
  expect(calls).toBe(1);
  expect(JSON.stringify(await response.json())).not.toContain('private words');
});
it('refuses extension collisions rather than replacing generated or other extension fields', async () => {
  const db = fixture();
  for (const queryFields of [
    [{ tasks: { type: GraphQLString, resolve: () => 'replacement' } }],
    [{ duplicate: { type: GraphQLString } }, { duplicate: { type: GraphQLString } }],
  ]) {
    const app = dataHttp(db, () => ({ viewer: { kind: 'member', id: 'sam' }, valid: () => true }), undefined, { queryFields });
    const response = await app.request('http://loom/graphql', request('{ tasks { id } }'));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('replacement');
  }
});
