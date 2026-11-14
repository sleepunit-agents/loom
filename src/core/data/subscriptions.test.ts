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
