/** Safe household display projection for Tempo; never expose settings wholesale. */
import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { householdTimezone } from '../data/household-settings.js';
import { readTimings } from './volume.js';
const timings = new GraphQLObjectType({ name: 'TempoTimings', fields: Object.fromEntries(['settleSeconds', 'dimDays', 'muteDays'].map(name => [name, { type: new GraphQLNonNull(GraphQLInt) }])) });
export function tempoQueryFields(db: DataDatabase, viewer: Viewer) {
 return { tempoTimezone: { type: GraphQLString,
   resolve: () => viewer.kind === 'member' || viewer.kind === 'agent'
     ? householdTimezone(db) : null,
 },
 // The caller's own timings: a person's or an agent's. Defaults when it has changed none.
 tempoTimings: { type: timings,
   resolve: () => {
     if (viewer.kind !== 'member' && viewer.kind !== 'agent') return null;
     return readTimings(db, { kind: viewer.kind === 'member' ? 'person' : 'agent', id: viewer.id });
   },
 } };
}
