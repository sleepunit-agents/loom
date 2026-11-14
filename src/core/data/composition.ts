import { GraphQLObjectType, GraphQLSchema, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';

/** Supplied only by the authenticated door. File-backed roots apply their own
 * current visibility using this caller, never a viewer from operation input. */
export interface DataQueryContext { readonly viewer: Viewer }
export interface DataQueryExtensions {
  /** Trusted composition supplies typed roots, e.g. Memory's file-backed reads.
   * These share the generated endpoint and its authentication/release checks. */
  readonly queryFields?: readonly GraphQLFieldConfigMap<unknown, DataQueryContext>[];
}

export function composeDataQueries(generated: GraphQLSchema, extensions: DataQueryExtensions): GraphQLSchema {
  if (!extensions.queryFields?.length) return generated;
  const query = generated.getQueryType()!;
  const fields: GraphQLFieldConfigMap<unknown, DataQueryContext> = { ...query.toConfig().fields };
  for (const group of extensions.queryFields) for (const [name, field] of Object.entries(group)) {
    if (Object.hasOwn(fields, name)) throw new Error(`Duplicate data query field: ${name}`);
    fields[name] = field;
  }
  const config = generated.toConfig();
  return new GraphQLSchema({ ...config,
    query: new GraphQLObjectType({ ...query.toConfig(), fields }),
    types: config.types.filter(type => type !== query),
  });
}
