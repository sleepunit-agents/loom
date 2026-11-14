import { expect, it } from 'vitest';
import { GraphQLObjectType, GraphQLSchema, GraphQLString, parse, subscribe } from 'graphql/index.js';
import { DataLive } from './live.js';
import { dataSubscriptions } from './subscriptions.js';

it('exposes initial selection and deltas through the standard GraphQL subscription executor', async () => {
  let title = 'First';
  const read = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: { title: { type: GraphQLString, resolve: () => title } } }) });
  const live = new DataLive(), schema = dataSubscriptions(read, live, () => true);
  const result = await subscribe({ schema, document: parse('subscription($selection: String!) { observe(query: $selection) { revision patches { path removed value } } }'), variableValues: { selection: '{ title }' } });
  expect(Symbol.asyncIterator in result).toBe(true);
  if (!(Symbol.asyncIterator in result)) throw new Error('Expected a subscription');
  try {
    expect((await result.next()).value).toEqual({ data: { observe: { revision: 1, patches: [{ path: [], removed: false, value: { title: 'First' } }] } } });
    title = 'Second'; live.changed();
    expect((await result.next()).value).toEqual({ data: { observe: { revision: 2, patches: [{ path: ['title'], removed: false, value: 'Second' }] } } });
  } finally { await result.return?.(); live.close(); }
});

it('retains each execution context across live reruns without sharing it between callers', async () => {
  let title = 'First';
  const contexts: unknown[] = [];
  const read = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
    title: { type: GraphQLString, resolve: (_source, _args, context) => { contexts.push(context); return `${context.viewer.id}:${title}`; } },
  } }) });
  const live = new DataLive(), schema = dataSubscriptions(read, live, () => true);
  const document = parse('subscription { observe(query: "{ title }") { revision patches { path value } } }');
  const sam = Object.freeze({ viewer: { kind: 'member', id: 'sam' } });
  const alex = Object.freeze({ viewer: { kind: 'member', id: 'alex' } });
  const a = await subscribe({ schema, document, contextValue: sam });
  const b = await subscribe({ schema, document, contextValue: alex });
  if (!(Symbol.asyncIterator in a) || !(Symbol.asyncIterator in b)) throw new Error('Expected subscriptions');
  try {
    expect((await a.next()).value.data.observe.patches[0].value).toEqual({ title: 'sam:First' });
    expect((await b.next()).value.data.observe.patches[0].value).toEqual({ title: 'alex:First' });
    title = 'Second'; live.changed();
    expect((await a.next()).value.data.observe).toEqual({ revision: 2, patches: [{ path: ['title'], value: 'sam:Second' }] });
    expect((await b.next()).value.data.observe).toEqual({ revision: 2, patches: [{ path: ['title'], value: 'alex:Second' }] });
    expect(contexts).toEqual([sam, alex, sam, alex]);
    expect(contexts[0]).toBe(sam); expect(contexts[2]).toBe(sam);
  } finally { await a.return?.(); await b.return?.(); live.close(); }
});
