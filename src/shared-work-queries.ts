/** Presentation metadata on the same query door; commands recheck authority. */
import { GraphQLBoolean, GraphQLNonNull } from 'graphql/index.js';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { workAnswersAllowed } from './shared-work-access.js';
export function workQueryFields(db: DataDatabase, refreshConfigured = false) {
  return { workAnswerOwner: { type:new GraphQLNonNull(GraphQLBoolean),
    resolve: (_source: unknown, _args: unknown, context: {viewer:Viewer}) => workAnswersAllowed(db,context.viewer),
  }, workChangesRefresh: { type:new GraphQLNonNull(GraphQLBoolean),
    resolve: (_source:unknown,_args:unknown,context:{viewer:Viewer}) => refreshConfigured && workAnswersAllowed(db,context.viewer),
  } };
}
