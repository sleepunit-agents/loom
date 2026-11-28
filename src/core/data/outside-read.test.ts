/** Fields read from outside the database are refused as live selections (./outside-read.ts). */
import { GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql/index.js';
import { expect, it, vi } from 'vitest';
import { DataLive } from './live.js';
import { OUTSIDE_READ, outsideRead, outsideReadIn } from './outside-read.js';
import { parse } from 'graphql/index.js';

const outside = vi.fn(() => 'from outside');
const inner = new GraphQLObjectType({ name: 'Inner', fields: { far: outsideRead({ type: GraphQLString, resolve: outside }, 'a fictional service') } });
const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
  near: { type: GraphQLString, resolve: () => 'here' },
  far: outsideRead({ type: GraphQLString, resolve: outside }, 'a fictional service'),
  nested: { type: inner, resolve: () => ({}) },
} }) });

it('marks a field and finds it anywhere in a document', () => {
  expect(schema.getQueryType()!.getFields().far.extensions[OUTSIDE_READ]).toBe('a fictional service');
  expect(outsideReadIn(schema, parse('{near}'))).toBeUndefined();
  for (const query of ['{far}', '{a:far}', '{near nested{far}}', 'query{...F} fragment F on Query{far}', '{...on Query{far}}'])
    expect(outsideReadIn(schema, parse(query)), query).toBe('far (a fictional service)');
});

it('refuses such a field as a live selection, and reads nothing of it', async () => {
  const live = new DataLive();
  try {
    expect(() => live.watch({ schema, query: '{near nested{far}}', valid: () => true })).toThrow('A live selection cannot hold far (a fictional service): it is read from outside loom, once each time it is asked');
    expect(outside).not.toHaveBeenCalled();
    const ordinary = live.watch({ schema, query: '{near}', valid: () => true });
    expect((await ordinary.next()).value).toMatchObject({ revision: 1 });
    await ordinary.return?.();
  } finally { live.close(); }
});
