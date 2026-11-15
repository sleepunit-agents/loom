import { GraphQLObjectType, GraphQLSchema, GraphQLInterfaceType, GraphQLUnionType, GraphQLList, GraphQLNonNull, type GraphQLType, type GraphQLNamedType, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';

/** Clone output types together: connected fields may point back at the query
 * root, so replacing that root alone would create duplicate named types. */
export function withQueryFields(schema: GraphQLSchema, fields: GraphQLFieldConfigMap<unknown, { viewer: Viewer }>): GraphQLSchema {
  if (!Object.keys(fields).length) return schema;
  const query = schema.getQueryType()!;
  const copies = new Map<GraphQLNamedType, GraphQLNamedType>();
  const type = (original: GraphQLType): GraphQLType => {
    if (original instanceof GraphQLList) return new GraphQLList(type(original.ofType) as typeof original.ofType);
    if (original instanceof GraphQLNonNull) return new GraphQLNonNull(type(original.ofType) as typeof original.ofType);
    if (original.name.startsWith('__')) return original;
    const prior = copies.get(original);
    if (prior) return prior;
    let copy: GraphQLNamedType = original;
    if (original instanceof GraphQLObjectType || original instanceof GraphQLInterfaceType) {
      const config = original.toConfig();
      const options = { ...config,
        interfaces: () => config.interfaces.map(item => type(item) as GraphQLInterfaceType),
        fields: () => Object.fromEntries(Object.entries(original === query ? { ...config.fields, ...fields } : config.fields).map(([name, field]) => [name, { ...field, type: type(field.type) }])),
      };
      copy = original instanceof GraphQLObjectType ? new GraphQLObjectType(options as ConstructorParameters<typeof GraphQLObjectType>[0]) : new GraphQLInterfaceType(options as ConstructorParameters<typeof GraphQLInterfaceType>[0]);
    } else if (original instanceof GraphQLUnionType) {
      const config = original.toConfig();
      copy = new GraphQLUnionType({ ...config, types: () => config.types.map(item => type(item) as GraphQLObjectType) });
    }
    copies.set(original, copy);
    return copy;
  };
  const config = schema.toConfig();
  return new GraphQLSchema({ ...config, query: type(query) as GraphQLObjectType,
    mutation: config.mutation ? type(config.mutation) as GraphQLObjectType : undefined,
    subscription: config.subscription ? type(config.subscription) as GraphQLObjectType : undefined,
    types: config.types.map(item => type(item) as GraphQLNamedType),
  });
}
