/** Safe household display projection for Tempo; never expose settings wholesale. */
import { GraphQLString } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { household } from '../data/schema.js';
export function tempoQueryFields(db: DataDatabase, viewer: Viewer) {
 return { tempoTimezone: { type: GraphQLString,
   resolve: () => viewer.kind === 'member' || viewer.kind === 'agent'
     ? db.select({zone:household.timezone}).from(household).get()?.zone ?? 'UTC' : null,
 } };
}
