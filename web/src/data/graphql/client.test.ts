import { expect, it, vi } from 'vitest';
import { createClient, gql } from '@urql/core';
import type { FormattedExecutionResult } from 'graphql';
import type { Sink, SubscribePayload } from 'graphql-ws';
import { cacheExchange } from '@urql/exchange-graphcache';
import { filter, map, pipe } from 'wonka';
import { browserQueryTransport, dataCacheKeys, applyDataPatches, generatedDataClient, type QueryTransport } from './client';

class Transport implements QueryTransport {
  feeds: { request: SubscribePayload; sink: Sink<FormattedExecutionResult> }[] = [];
  listeners = new Set<(connected: boolean) => void>();
  subscribe(request: SubscribePayload, sink: Sink<FormattedExecutionResult>) {
    const feed = { request, sink }; this.feeds.push(feed);
    return () => { this.feeds = this.feeds.filter(value => value !== feed); };
  }
  connectionChanged(listener: (connected: boolean) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close() { this.listeners.forEach(listener => listener(false)); }
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
  wire.listeners.forEach(listener => listener(true));
  expect(results.at(-1)?.error).toBeUndefined(); expect(results.at(-1)?.data).toBeUndefined();
  wire.send(1, [{ path: [], removed: false, value: { tasks: [] } }]);
  expect(results.at(-1)?.data).toEqual({ tasks: [] });
  subscription.unsubscribe();
});

it.each(['complete', 'error'] as const)('keeps a terminal %s unavailable when another subscription reconnects', kind => {
  const wire = new Transport(), client = generatedDataClient(wire);
  const results: {error?: unknown}[] = [];
  const sub = client.query(query, {}).subscribe(result => results.push(result));
  if (kind === 'complete') wire.feeds[0].sink.complete();
  else wire.feeds[0].sink.error(new Error('ended'));
  expect(results.at(-1)?.error).toBeDefined();
  const count = results.length;
  wire.close();
  wire.listeners.forEach(listener => listener(true));
  expect(results).toHaveLength(count);
  sub.unsubscribe();
});

it('removes rows without changing previously retained snapshots', () => {
  const initial = { tasks: [{ id: 'a' }, { id: 'b' }] };
  expect(applyDataPatches(initial, [{ path: ['tasks',0], removed: true }])).toEqual({ tasks: [{ id:'b' }] });
  expect(initial.tasks).toHaveLength(2);
  expect(applyDataPatches(initial, [{ path: ['tasks',0,'id'], removed: false, value: null }])).toEqual({ tasks: [{id:null},{id:'b'}] });
});

it('edits shared paths in order while retaining prior snapshots and incoming values', () => {
  const kept = {id:'kept'};
  const initial = {tasks:[{id:'removed'}, kept]};
  const incoming = {id:'new', comments:['first']};
  const patches = [
    {path:['tasks',0], removed:true},
    {path:['tasks',1], removed:false, value:incoming},
    {path:['tasks',1,'id'], removed:false, value:'edited'},
    {path:['tasks',1,'comments',1], removed:false, value:'second'},
  ];
  const updated = applyDataPatches(initial, patches) as typeof initial;
  expect(updated.tasks).toEqual([kept, {id:'edited', comments:['first','second']}]);
  expect(updated.tasks[0]).toBe(kept);
  expect(initial.tasks).toEqual([{id:'removed'}, kept]);
  expect(incoming).toEqual({id:'new', comments:['first']});
  expect(() => applyDataPatches(initial, [...patches, {path:['missing',0], removed:true}])).toThrow();
  expect(initial.tasks).toEqual([{id:'removed'}, kept]);
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

it('updates another open selection when a shared entity changes without reopening either feed', async () => {
  const wire = new Transport(), client = generatedDataClient(wire);
  const messages = gql`query Messages($thread: String!) { commsMessages(thread: $thread) { thread seq words } }`;
  const recent = gql`query Recent { recentMessages { thread seq words } }`;
  const seen: unknown[] = [];
  const a = client.query(messages, {thread: 'a'}).subscribe(result => seen.push(result.data));
  const b = client.query(recent, {}).subscribe(() => {});
  const separate: unknown[] = [];
  const c = client.query(messages, {thread: 'b'}).subscribe(result => separate.push(result.data));
  const row = { __typename: 'CommsMessageView', thread: 'a', seq: 1, words: 'Before' };
  wire.feeds[2].sink.next({ data: { observe: { revision: 1, patches: [{path: [], removed: false, value: {commsMessages: [{...row, thread: 'b', words: 'Separate'}]}}] } } });
  wire.feeds[0].sink.next({ data: { observe: { revision: 1, patches: [{path: [], removed: false, value: {commsMessages: [row]}}] } } });
  wire.feeds[1].sink.next({ data: { observe: { revision: 1, patches: [{path: [], removed: false, value: {recentMessages: [row]}}] } } });
  wire.feeds[1].sink.next({ data: { observe: { revision: 2, patches: [{path: ['recentMessages', 0, 'words'], removed: false, value: 'After'}] } } });
  await Promise.resolve();
  expect(seen.at(-1)).toMatchObject({commsMessages: [{words: 'After'}]});
  expect(separate.at(-1)).toMatchObject({commsMessages: [{thread: 'b', words: 'Separate'}]});
  expect(wire.feeds).toHaveLength(3);
  a.unsubscribe(); b.unsubscribe(); c.unsubscribe();
  expect(wire.feeds).toHaveLength(0);
});

it('closes a transport even when its handshake never acknowledges',async()=>{
  vi.useFakeTimers();
  let closed=0;
  class SilentSocket {
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    readyState=SilentSocket.CONNECTING;
    close(){this.readyState=SilentSocket.CLOSED;closed++;}
  }
  vi.stubGlobal('WebSocket',SilentSocket);
  try{
    const transport=browserQueryTransport('ws://fixture/graphql');
    const sink={next:vi.fn(),error:vi.fn(),complete:vi.fn()};
    transport.subscribe({query:'subscription { example }'},sink);
    transport.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    const after={...sink,complete:vi.fn()};
    transport.subscribe({query:'subscription { example }'},after);
    expect(after.complete).toHaveBeenCalledOnce();
  }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});

it('times out an unacknowledged handshake even when the server sends a pong',async()=>{
  vi.useFakeTimers();
  const codes:number[]=[];
  class Unacknowledged {
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    readyState=Unacknowledged.OPEN;
    constructor(){queueMicrotask(()=>this.onopen?.());}
    onopen?:()=>void;
    onclose?:(event:{code:number;reason:string})=>void;
    onmessage?:(event:{data:string})=>void;
    send(){queueMicrotask(()=>this.onmessage?.({data:'{"type":"pong"}'}));}
    close(code:number,reason:string){codes.push(code);this.readyState=Unacknowledged.CLOSED;this.onclose?.({code,reason});}
  }
  vi.stubGlobal('WebSocket',Unacknowledged);
  const transport=browserQueryTransport('ws://fixture/graphql');
  try{
    transport.subscribe({query:'subscription { example }'},{next:vi.fn(),error:vi.fn(),complete:vi.fn()});
    await vi.advanceTimersByTimeAsync(15_000);
    expect(codes).toContain(4504);
  }finally{transport.close();vi.unstubAllGlobals();vi.useRealTimers();}
});

it('sends an eager selection exactly as it always was, and a relaxed one with its pace and its name beside it', async () => {
  const { createRequest } = await import('@urql/core');
  const { relaxedKey } = await import('./pace');
  const wire = new Transport(), client = generatedDataClient(wire);
  const request = createRequest(query, {}), relaxed = { ...request, key: relaxedKey(request.key) };
  const eager: unknown[] = [], slow: unknown[] = [];
  const first = client.query(query, {}, { requestPolicy: 'network-only' }).subscribe(result => eager.push(result.data));
  const second = client.executeQuery(relaxed, { requestPolicy: 'network-only', pace: 'relaxed' }).subscribe(result => slow.push(result.data));
  // Two selections on the socket: the same query at two paces is never one feed.
  expect(wire.feeds).toHaveLength(2);
  expect(wire.feeds[0].request.query).toBe('subscription LoomData($query: String!, $variables: DataValue, $operationName: String) { observe(query: $query, variables: $variables, operationName: $operationName) { revision patches { path removed value } } }');
  expect(Object.keys(wire.feeds[0].request.variables!)).toEqual(['query', 'variables', 'operationName']);
  expect(wire.feeds[1].request.query).toContain('pace: $pace, key: $key');
  expect(wire.feeds[1].request.variables).toMatchObject({ query: wire.feeds[0].request.variables!.query, pace: 'relaxed', key: String(relaxed.key) });
  expect(relaxed.key).not.toBe(request.key);
  // Loom's word that a selection was read and nothing changed (a revision with no patches) is an answer: the reader
  // is told, with the same data, and the next change still applies to it.
  const rows = { tasks: [{ __typename: 'TasksSelectItem', id: 't-1', title: 'Pump' }] };
  wire.feeds[1].sink.next({ data: { observe: { revision: 1, patches: [{ path: [], removed: false, value: rows }] } } });
  const told = slow.length;
  wire.feeds[1].sink.next({ data: { observe: { revision: 2, patches: [] } } });
  expect(slow.length).toBe(told + 1);
  expect(slow.at(-1)).toMatchObject({ tasks: [{ id: 't-1', title: 'Pump' }] });
  wire.feeds[1].sink.next({ data: { observe: { revision: 3, patches: [{ path: ['tasks', 0, 'title'], removed: false, value: 'Fits' }] } } });
  expect(slow.at(-1)).toMatchObject({ tasks: [{ id: 't-1', title: 'Fits' }] });
  first.unsubscribe(); second.unsubscribe(); expect(wire.feeds).toHaveLength(0);
});
