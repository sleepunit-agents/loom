import { expect, it } from 'vitest';
import { createClient, gql } from '@urql/core';
import type { FormattedExecutionResult } from 'graphql';
import type { Sink, SubscribePayload } from 'graphql-ws';
import { cacheExchange } from '@urql/exchange-graphcache';
import { filter, map, pipe } from 'wonka';
import { dataCacheKeys, applyDataPatch, generatedDataClient, type QueryTransport } from './client';

class Transport implements QueryTransport {
  feeds: { request: SubscribePayload; sink: Sink<FormattedExecutionResult> }[] = [];
  listeners = new Set<() => void>();
  subscribe(request: SubscribePayload, sink: Sink<FormattedExecutionResult>) {
    const feed = { request, sink }; this.feeds.push(feed);
    return () => { this.feeds = this.feeds.filter(value => value !== feed); };
  }
  disconnected(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close() { this.listeners.forEach(listener => listener()); }
  send(revision: number, patches: unknown[]) { this.feeds[0].sink.next({ data: { observe: { revision, patches } } }); }
}
const query = gql`query Tasks { tasks { id title } }`;

it('feeds normalized generated query results from initial rows and changed paths, without asking again', () => {
  const wire = new Transport(), client = generatedDataClient(wire);
  const results: unknown[] = [];
  const subscription = client.query(query, {}).subscribe(result => results.push(result.data));
  expect(wire.feeds).toHaveLength(1);
  expect(wire.feeds[0].request.variables?.query).toContain('__typename');
  wire.send(1, [{ path: [], removed: false, value: { tasks: [{ __typename: 'TasksSelectItem', id: 't-1', title: 'Pump' }] } }]);
  expect(results.at(-1)).toMatchObject({ tasks: [{ id: 't-1', title: 'Pump' }] });
  wire.send(2, [{ path: ['tasks', 0, 'title'], removed: false, value: 'Fits' }]);
  expect(results.at(-1)).toMatchObject({ tasks: [{ id: 't-1', title: 'Fits' }] });
  expect(wire.feeds).toHaveLength(1);
  subscription.unsubscribe(); expect(wire.feeds).toHaveLength(0);
});

it('clears the visible result on disconnect and replaces it from a reconnect snapshot', () => {
  const wire = new Transport(), client = generatedDataClient(wire), results: {data?: unknown; error?: unknown}[] = [];
  const subscription = client.query(query, {}).subscribe(result => results.push(result));
  wire.send(1, [{ path: [], removed: false, value: { tasks: [{ __typename: 'TasksSelectItem', id: 't-1', title: 'Private' }] } }]);
  wire.close(); expect(results.at(-1)?.error).toBeDefined(); expect(results.at(-1)?.data).toBeUndefined();
  wire.send(1, [{ path: [], removed: false, value: { tasks: [] } }]);
  expect(results.at(-1)?.data).toEqual({ tasks: [] });
  subscription.unsubscribe();
});

it('removes rows without changing previously retained snapshots', () => {
  const initial = { tasks: [{ id: 'a' }, { id: 'b' }] };
  expect(applyDataPatch(initial, { path: ['tasks',0], removed: true })).toEqual({ tasks: [{ id:'b' }] });
  expect(initial.tasks).toHaveLength(2);
  expect(applyDataPatch(initial, { path: ['tasks',0,'id'], removed: false, value: null })).toEqual({ tasks: [{id:null},{id:'b'}] });
});

it('refuses a revision gap and hides data until a fresh initial result', () => {
  const wire = new Transport(), client = generatedDataClient(wire), results: {data?: unknown; error?: unknown}[] = [];
  const subscription = client.query(query, {}).subscribe(result => results.push(result));
  wire.send(1, [{ path: [], removed: false, value: { tasks: [] } }]);
  wire.send(3, [{ path: ['tasks',0], removed: false, value: {id:'bad',title:'Bad'} }]);
  expect(results.at(-1)?.error).toBeDefined(); expect(results.at(-1)?.data).toBeUndefined();
  subscription.unsubscribe();
});

it('shares one live selection between readers and does not release cached rows to a fresh reader after disconnect', () => {
  const wire = new Transport(), client = generatedDataClient(wire), first: unknown[] = [], second: unknown[] = [];
  const a = client.query(query, {}).subscribe(result => first.push(result));
  const b = client.query(query, {}).subscribe(result => second.push(result));
  expect(wire.feeds).toHaveLength(1);
  wire.send(1, [{ path: [], removed: false, value: { tasks: [{ __typename:'TasksSelectItem', id:'t-1', title:'Old authority' }] } }]);
  wire.close(); a.unsubscribe(); b.unsubscribe();
  const fresh: {data?:unknown}[] = [];
  const c = client.query(query, {}).subscribe(result => fresh.push(result));
  expect(fresh.every(result => result.data === undefined)).toBe(true);
  wire.send(1, [{ path: [], removed: false, value: { tasks: [] } }]);
  expect(fresh.at(-1)?.data).toEqual({tasks:[]}); c.unsubscribe();
});

it('normalizes Comms messages by thread and sequence across selections', () => {
  const messages = gql`query Messages($thread: String!) { commsMessages(thread: $thread) { thread seq words } }`;
  const recent = gql`query Recent { recentMessages { thread seq words } }`;
  const message = (thread: string, words: string) => ({__typename: 'CommsMessageView', thread, seq: 1, words});
  const client = createClient({url:'/graphql', exchanges:[cacheExchange({keys:dataCacheKeys}), () => operations => pipe(operations, filter(operation => operation.kind === 'query'), map(operation => ({
    operation,
    data: !operation.variables?.thread
      ? {recentMessages:[message('a','After')]}
      : {commsMessages:[message(String(operation.variables.thread), operation.variables.thread === 'a' ? 'Before' : 'Separate')]},
    stale:false, hasNext:false,
  })))]});
  client.query(messages, {thread:'a'}).subscribe(() => {});
  client.query(messages, {thread:'b'}).subscribe(() => {});
  client.query(recent, {}).subscribe(() => {});
  expect(client.readQuery(messages, {thread:'a'})?.data).toMatchObject({commsMessages:[{thread:'a',seq:1,words:'After'}]});
  expect(client.readQuery(messages, {thread:'b'})?.data).toMatchObject({commsMessages:[{thread:'b',seq:1,words:'Separate'}]});
});
