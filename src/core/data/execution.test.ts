import { expect, it } from 'vitest';
import { execute, parse, GraphQLSchema, GraphQLObjectType, GraphQLNonNull, GraphQLString, GraphQLScalarType, GraphQLInterfaceType } from 'graphql/index.js';
import { ExecutionDrain, instrumentExecution } from './execution.js';

it('assimilates a query thenable once and preserves synchronous results/errors', async () => {
  const drain = new ExecutionDrain(); let calls = 0;
  const query = { then(resolve: (value: string) => void) { calls++; resolve('one'); } };
  expect(await drain.scope(() => true, () => query)).toBe('one'); expect(calls).toBe(1);
  expect(drain.scope(() => true, () => 'sync')).toBe('sync');
  expect(() => drain.scope(() => true, () => { throw Error('sync error'); })).toThrow('sync error');
  let denied = 0;
  expect(() => drain.scope(() => false, () => { denied++; })).toThrow('execution ended');
  expect(denied).toBe(0); await drain.drain();
});
it('keeps concurrent retained schemas and unscoped installed callers independent', async () => {
  const a = new ExecutionDrain(), b = new ExecutionDrain();
  let release!: () => void, open = true;
  const held = new Promise<void>(resolve => { release = resolve; });
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
    value: { type: GraphQLString, resolve: async (_s,_a,ctx) => { if (ctx.id === 'a') await held; return ctx.id; } },
  } }) });
  const identities = { ...schema.getTypeMap() };
  instrumentExecution(schema); instrumentExecution(schema);
  for (const [name, type] of Object.entries(identities)) expect(schema.getType(name)).toBe(type);
  const args = { schema, document: parse('{ value }') };
  const first = a.scope(() => open, () => execute({ ...args, contextValue: { id: 'a' } }));
  open = false;
  const second = await b.scope(() => true, () => execute({ ...args, contextValue: { id: 'b' } }));
  expect(second.data?.value).toBe('b'); await b.drain();
  expect((await execute({ ...args, contextValue: { id: 'installed' } })).data?.value).toBe('installed');
  release(); await first; await a.drain();
});
it('retains a failed execution sibling and fences later child coercion/resolvers', async () => {
  const drain = new ExecutionDrain(); let open = true, release!: () => void, coerced = 0, children = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const input = new GraphQLScalarType({ name: 'ChildInput', serialize: v => v, parseValue: v => v, parseLiteral() { coerced++; return 'x'; } });
  const child = new GraphQLObjectType({ name: 'Child', fields: { value: { type: GraphQLString, args: { input: { type: input } }, resolve() { children++; return 'child'; } } } });
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
    slow: { type: child, async resolve() { await held; return {}; } },
    broken: { type: new GraphQLNonNull(GraphQLString), async resolve() { throw Error('failed'); } },
  } }) });
  instrumentExecution(schema);
  const result = await drain.scope(() => open, () => execute({ schema, document: parse('{ slow { value(input:"x") } broken }') }));
  expect(result.errors).toBeDefined(); open = false;
  let closed = false; const closing = drain.drain().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  release(); await closing;
  expect(coerced).toBe(0); expect(children).toBe(0);
});

it.each(['isTypeOf', 'resolveType'])('retains an asynchronous %s callback after a parallel error', async callback => {
  const drain = new ExecutionDrain(); let open = true, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const iface = new GraphQLInterfaceType({ name: 'Typed', fields: { value: { type: GraphQLString } }, resolveType: callback === 'resolveType' ? async () => { await held; return 'Actual'; } : () => 'Actual' });
  const actual = new GraphQLObjectType({ name: 'Actual', interfaces: [iface], fields: { value: { type: GraphQLString } }, isTypeOf: callback === 'isTypeOf' ? async () => { await held; return true; } : undefined });
  const schema = new GraphQLSchema({ types: [actual], query: new GraphQLObjectType({ name: 'Query', fields: {
    typed: { type: iface, resolve: () => ({ value: 'typed' }) },
    broken: { type: new GraphQLNonNull(GraphQLString), async resolve() { throw Error('failed'); } },
  } }) });
  instrumentExecution(schema);
  expect(schema.getType('Actual')).toBe(actual); expect(schema.getType('Typed')).toBe(iface);
  const result = await drain.scope(() => open, () => execute({ schema, document: parse('{ typed { value } broken }') }));
  expect(result.errors).toBeDefined(); open = false;
  let closed = false; const closing = drain.drain().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); release(); await closing; expect(closed).toBe(true);
});
