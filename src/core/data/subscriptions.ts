import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLScalarType, GraphQLSchema, GraphQLString, valueFromASTUntyped } from 'graphql/index.js';
import { DataLive, type DataPatch } from './live.js';
import { livePace, NOW_KEYS_MOST, NOW_KEY_LONGEST } from './live-pace.js';

// JSON is only the wire envelope for selected results and variables. The data
// definition, validation, joins and visibility still come from Drizzle.
export const dataValue = new GraphQLScalarType({ name: 'DataValue', serialize: value => value, parseValue: value => value, parseLiteral: node => valueFromASTUntyped(node) });
const patch = new GraphQLObjectType({ name: 'DataPatch', fields: {
  path: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(dataValue))) },
  removed: { type: new GraphQLNonNull(GraphQLBoolean), resolve: (patch: DataPatch) => !Object.hasOwn(patch, 'value') },
  value: { type: dataValue },
} });
const delta = new GraphQLObjectType({ name: 'DataDelta', fields: {
  revision: { type: new GraphQLNonNull(GraphQLInt) },
  patches: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(patch))) },
} });

/** The selections one socket holds open under a name its client gave them, so the client can ask for some of them
 * "now" (./live.ts, `refresh`). One per socket: a name reaches only the selections of the socket that named them.
 * A name is the client's own and means nothing to loom; two selections may share one and are then asked together. */
export class NamedSelections {
  private open = new Map<string, Set<() => void>>();
  add(key: string, now: () => void): () => void {
    const named = this.open.get(key) ?? new Set();
    this.open.set(key, named.add(now));
    return () => { named.delete(now); if (!named.size && this.open.get(key) === named) this.open.delete(key); };
  }
  /** Asks each named selection that is open, and says which names were. */
  now(keys: readonly string[]): string[] {
    const asked: string[] = [];
    for (const key of new Set(keys)) {
      const named = this.open.get(key);
      if (!named) continue;
      asked.push(key);
      for (const now of [...named]) now();
    }
    return asked;
  }
}
const nowKey = (key: unknown): key is string => typeof key === 'string' && key.length > 0 && key.length <= NOW_KEY_LONGEST;

/** Keep the generated query schema intact, adding one subscription envelope.
 * A tile supplies the same validated query it uses for a read. Revision 1 is
 * its initial result; later revisions contain changed paths only. Reconnection
 * starts at revision 1, so a cache cannot reuse another connection's authority.
 *
 * Two optional words travel with a selection (./live-pace.ts). `pace: "relaxed"` has it read again less often;
 * anything else, and leaving it out, is eager. `key` is the client's name for it on this socket. With `named`
 * (one per socket) the envelope also has one mutation, `now(keys)`: it writes nothing; it asks the named
 * selections of this socket to be read again now, and answers with the names that were open. A selection asked
 * for now is still read no sooner than the settle time after its last reading began, so asking as often as a
 * client likes costs no more than an eager selection under a stream of commits.
 */
export function dataSubscriptions(schema: GraphQLSchema, live: DataLive, valid: () => boolean, active: () => boolean = () => true, named?: NamedSelections) {
  const guard = live.transportGuard(active);
  const keys = new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString)));
  return new GraphQLSchema({ ...schema.toConfig(), subscription: new GraphQLObjectType({ name: 'Subscription', fields: {
    observe: {
      type: new GraphQLNonNull(delta),
      args: { query: { type: new GraphQLNonNull(GraphQLString) }, variables: { type: dataValue }, operationName: { type: GraphQLString }, pace: { type: GraphQLString }, key: { type: GraphQLString } },
      subscribe: (_source, args, contextValue) => live.watch({ schema, contextValue, query: args.query, variables: args.variables, operationName: args.operationName, valid, active: guard,
        pace: livePace(args.pace), refresh: named && nowKey(args.key) ? now => named.add(args.key, now) : undefined }),
      resolve: event => event,
    },
  } }), mutation: named && new GraphQLObjectType({ name: 'LiveNow', fields: {
    now: {
      type: keys, args: { keys: { type: keys } },
      resolve: (_source, args: { keys: string[] }) => {
        if (!valid()) throw new Error('Live data access ended');
        if (args.keys.length > NOW_KEYS_MOST) throw new Error('Too many selections');
        return named.now(args.keys.filter(nowKey));
      },
    },
  } }) });
}
