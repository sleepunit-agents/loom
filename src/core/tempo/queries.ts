/** Safe household display projection for Tempo; never expose settings wholesale. */
import { GraphQLString } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { readHouseholdTimezone } from '../data/household-timezone.js';
export function tempoQueryFields(db: DataDatabase, viewer: Viewer) {
 return { tempoTimezone: { type: GraphQLString,
   resolve: () => viewer.kind === 'member' || viewer.kind === 'agent'
     ? readHouseholdTimezone(db) : null,
 } };
}
