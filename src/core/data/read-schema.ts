import { GraphQLObjectType, GraphQLSchema, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../index.js';
import type { DataDatabase } from './database.js';
import { dataQueries } from './queries.js';
import { taskVisibility } from './visibility.js';

/** One read surface for HTTP and graphql-ws. Only trusted composition supplies
 * extra fields; the caller is the admitted principal, never query input. */
export function dataReadSchema(db: DataDatabase, viewer: Viewer, fields: GraphQLFieldConfigMap<unknown, { viewer: Viewer }> = {}) {
  const generated = dataQueries(db.$client, { tables: ['tasks', 'taskComments', 'taskLinks', 'projects', 'agents'], visibility: taskVisibility(viewer) });
  const query = generated.getQueryType()!;
  return new GraphQLSchema({ ...generated.toConfig(), types: generated.toConfig().types.filter(type => type !== query), query: new GraphQLObjectType({
    ...query.toConfig(), fields: { ...query.toConfig().fields, ...fields },
  }) });
}
