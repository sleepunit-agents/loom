import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq, ne, sql } from 'drizzle-orm';
import { GraphQLObjectType, GraphQLSchema, graphql } from 'graphql/index.js';
import { createDataSchema } from '../../core/data/database.js';
import { DataLive } from '../../core/data/live.js';
import { FakeClock } from '../../core/clock.js';
import { agents, members, secrets, bridgeConnections, bridgeIncoming } from '../../core/data/schema.js';
import { BridgeQueries, bridgeQueryFields, type BridgeActivityScope } from './queries.js';
const opened: Database.Database[] = [];
afterEach(() => { for (const client of opened.splice(0)) client.close(); });
const day = 86400_000, start = Date.parse('2026-11-14T12:00:00.000Z');
function fixture() {
  const statements: string[] = [], client = new Database(':memory:', { verbose: value => statements.push(value) }); opened.push(client);
  const clock = new FakeClock(start), db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: new Date(start).toISOString() }).run();
  for (const id of ['art', 'mark']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(secrets).values({ name: 'token', description: '', changedAt: new Date(start).toISOString(), changedBy: 'owner' }).run();
  for (const [id, agent] of [['c', 'art'], ['empty', 'art'], ['other', 'mark']]) db.insert(bridgeConnections).values({ id, platform: 'slack', agent, workspace: 'workspace', botUser: `bot-${id}`, tokenSecret: 'token', enabled: true, state: 'connected', stateAt: new Date(start).toISOString() }).run();
  const queries = new BridgeQueries(db, () => clock.now());
  const receive = (id: string, at: number, state: 'delivered' | 'held' | 'pending' | 'dropped' = 'delivered', connection = 'c') => db.insert(bridgeIncoming).values({
    id, connection, channel: 'room', isDm: false, user: 'outside', text: 'Not selected by statistics', postedAt: new Date(at).toISOString(), receivedAt: new Date(at).toISOString(), state,
  }).run();
  const scope: BridgeActivityScope = { connections: eq(bridgeConnections.agent, 'art'), incoming: ne(bridgeIncoming.id, 'private') };
  return { db, client, clock, statements, queries, receive, scope };
}
it('batches metadata, retaining visible zero-message connections and excluding both hidden connections and hidden messages', () => {
  const f = fixture();
  f.receive('delivered', start); f.receive('held', start - 1000, 'held'); f.receive('pending', start - 2000, 'pending'); f.receive('dropped', start - 3000, 'dropped');
  f.receive('private', start); f.receive('other-message', start, 'delivered', 'other');
  f.receive('boundary', start - day); f.receive('old', start - day - 1); f.receive('future', start + 1);
  f.statements.length = 0;
  expect(f.queries.activity(f.scope)).toEqual([{ id: 'c', received: 4, delivered: 1, held: 1 }, { id: 'empty', received: 0, delivered: 0, held: 0 }]);
  expect(f.statements).toHaveLength(2);
  for(const statement of f.statements){expect(statement).not.toContain('"text"');expect(statement).not.toMatch(/insert|update|delete/i);}
});
it('requires both SQL scopes before executing any query', () => {
  const f = fixture(); f.statements.length = 0;
  for (const bad of [undefined, {}, { connections: sql`true` }, { connections: sql`true`, incoming: true }, { connections: true, incoming: sql`true` }]) expect(() => f.queries.activity(bad as BridgeActivityScope)).toThrow('SQL bridge visibility required');
  expect(f.statements).toEqual([]);
});
it('uses actual instants across whole-second and millisecond timestamps, expiring at the exact boundary', () => {
  const f = fixture(); f.receive('whole', start - 1000); f.receive('millis', start - 500);
  f.db.update(bridgeIncoming).set({ receivedAt: '2026-11-14T11:59:59Z' }).where(eq(bridgeIncoming.id, 'whole')).run();
  expect(f.queries.nextDeadline()).toBe(start + day - 1000);
  f.clock.advance(day - 1000);
  expect(f.queries.activity(f.scope)[0].received).toBe(1); expect(f.queries.nextDeadline()).toBe(start + day - 500);
  f.clock.advance(500); expect(f.queries.activity(f.scope)[0].received).toBe(0); expect(f.queries.nextDeadline()).toBeUndefined();
});
it('schedules future receipt admission before an older receipt expiry and reacts to newly committed rows', () => {
  const f = fixture(); f.receive('current', start); f.receive('future', start + 1000);
  expect(f.queries.activity(f.scope)[0].received).toBe(1); expect(f.queries.nextDeadline()).toBe(start + 1000);
  f.clock.advance(1000); expect(f.queries.activity(f.scope)[0].received).toBe(2); expect(f.queries.nextDeadline()).toBe(start + day);
  f.receive('earlier-expiry', start - day + 2000); expect(f.queries.nextDeadline()).toBe(start + 2000);
});
it('the query adapter uses the current executor viewer and never supplies a permissive policy', async () => {
  const f = fixture(); f.receive('visible', start);
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: bridgeQueryFields(f.queries, viewer => ({
    connections: viewer.kind === 'member' && viewer.id === 'owner' ? f.scope.connections : sql`false`, incoming: f.scope.incoming,
  })) }) });
  const query = '{ bridgeActivity { id received delivered held } }';
  const owner = await graphql({ schema, source: query, contextValue: { viewer: { kind: 'member', id: 'owner' } } });
  expect(owner.errors).toBeUndefined(); expect(owner.data?.bridgeActivity).toEqual([{ id: 'c', received: 1, delivered: 1, held: 0 }, { id: 'empty', received: 0, delivered: 0, held: 0 }]);
  const other = await graphql({ schema, source: query, contextValue: { viewer: { kind: 'member', id: 'other' } } });
  expect(other.errors).toBeUndefined(); expect(other.data?.bridgeActivity).toEqual([]);
});
it('the common fake-clock deadline can refresh a live selection without a database write', async () => {
  const f = fixture(); f.receive('one', start);
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: bridgeQueryFields(f.queries, () => f.scope) }) });
  const live = new DataLive(), watch = live.watch({ schema, query: '{ bridgeActivity { id received delivered held } }', contextValue: { viewer: { kind: 'member', id: 'owner' } }, valid: () => true });
  expect((await watch.next()).value?.patches[0].value).toEqual({ bridgeActivity: [{ id: 'c', received: 1, delivered: 1, held: 0 }, { id: 'empty', received: 0, delivered: 0, held: 0 }] });
  const next = watch.next(); f.clock.at(f.queries.nextDeadline()!, () => live.changed()); f.clock.advance(day);
  const result = await next; expect(result.value?.patches).toEqual([{ path: ['bridgeActivity', 0, 'received'], value: 0 }, { path: ['bridgeActivity', 0, 'delivered'], value: 0 }]);
  await watch.return?.(); live.close();
});

it('counts receipt time rather than platform-post time and schedules the matching receipt deadline', () => {
  const f = fixture();
  f.receive('old-post-new-receipt', start - 1000);
  f.db.update(bridgeIncoming).set({ postedAt: new Date(start - 2 * day).toISOString() }).where(eq(bridgeIncoming.id, 'old-post-new-receipt')).run();
  f.receive('new-post-old-receipt', start - day - 1000);
  f.db.update(bridgeIncoming).set({ postedAt: new Date(start).toISOString() }).where(eq(bridgeIncoming.id, 'new-post-old-receipt')).run();
  expect(f.queries.activity(f.scope)[0].received).toBe(1);
  expect(f.queries.nextDeadline()).toBe(start + day - 1000);
});

it.each(['receipts','connections'])('keeps two activity statements when %s grow from two to ten',kind=>{
 const f=fixture();let small=0;
 for(let n=0;n<10;n++){
  const connection=kind==='connections'?'extra-'+n:'c';
  if(kind==='connections')f.db.insert(bridgeConnections).values({id:connection,platform:'slack',agent:'art',workspace:'workspace',botUser:'bot-'+n,tokenSecret:'token',enabled:true,state:'connected',stateAt:new Date(start).toISOString()}).run();
  f.receive('row-'+n,start,'delivered',connection);
  if(n===1||n===9){f.statements.length=0;expect(f.queries.activity(f.scope).reduce((n,row)=>n+row.received,0)).toBe(n+1);if(n===1)small=f.statements.length;else expect(f.statements.length).toBe(small);}
 }
 expect(small).toBe(2);
});
