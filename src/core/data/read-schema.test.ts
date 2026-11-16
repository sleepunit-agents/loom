import { expect, it } from 'vitest';
import { GraphQLObjectType, GraphQLSchema, GraphQLScalarType, GraphQLString, GraphQLUnionType } from 'graphql/index.js';
import { assertReadSchema } from './read-schema.js';
import { dataSubscriptions } from './subscriptions.js';
import { DataLive } from './live.js';

it('accepts model scalars, plain output types and the owned live envelope', () => {
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: { value: { type: GraphQLString } } }) });
  expect(() => assertReadSchema(dataSubscriptions(schema, new DataLive(), () => true))).not.toThrow();
});
it('refuses installed scalar and type callbacks without invoking them', () => {
  let called = 0;
  const scalar = new GraphQLScalarType({ name: 'Installed', serialize() { called++; return 'private'; } });
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: { value: { type: scalar } } }) });
  expect(() => assertReadSchema(schema)).toThrow('Unsupported read scalar');
  const child = new GraphQLObjectType({ name: 'Child', fields: { value: { type: GraphQLString } } });
  const union = new GraphQLUnionType({ name: 'InstalledUnion', types: [child], resolveType() { called++; return 'Child'; } });
  const typed = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: { value: { type: union } } }) });
  expect(() => assertReadSchema(typed)).toThrow('Unsupported read type callbacks');
  expect(called).toBe(0);
});
