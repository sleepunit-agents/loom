import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLScalarType, GraphQLSchema, GraphQLString, valueFromASTUntyped } from 'graphql/index.js';
import { DataLive, type DataPatch } from './live.js';

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

/** Keep the generated query schema intact, adding one subscription envelope.
 * A tile supplies the same validated query it uses for a read. Revision 1 is
 * its initial result; later revisions contain changed paths only. Reconnection
 * starts at revision 1, so a cache cannot reuse another connection's authority.
 */
export function dataSubscriptions(schema: GraphQLSchema, live: DataLive, valid: () => boolean, active: () => boolean = () => true) {
  const guard = live.transportGuard(active);
  return new GraphQLSchema({ ...schema.toConfig(), subscription: new GraphQLObjectType({ name: 'Subscription', fields: {
    observe: {
      type: new GraphQLNonNull(delta),
      args: { query: { type: new GraphQLNonNull(GraphQLString) }, variables: { type: dataValue }, operationName: { type: GraphQLString } },
      subscribe: (_source, args, contextValue) => live.watch({ schema, contextValue, query: args.query, variables: args.variables, operationName: args.operationName, valid, active: guard }),
      resolve: event => event,
    },
  } }) });
}
