/** Safe household display projection for Tempo; never expose settings wholesale. */
import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import { rules, type Viewer } from '../../policy.js';
import { sqlHolds } from '../../policy-sql.js';
import type { DataDatabase } from '../data/database.js';
import { householdTimezone } from '../data/household-settings.js';
import { readTimings } from './volume.js';
const timings = new GraphQLObjectType({ name: 'TempoTimings', fields: Object.fromEntries(['settleSeconds', 'dimDays', 'muteDays'].map(name => [name, { type: new GraphQLNonNull(GraphQLInt) }])) });
export function tempoQueryFields(db: DataDatabase, viewer: Viewer) {
 // Someone in the household now (rules.currentViewer): a removed member's token, or a body whose member has left, reads neither.
 const current = () => sqlHolds(db, rules.currentViewer, viewer);
 return { tempoTimezone: { type: GraphQLString,
   resolve: () => current() ? householdTimezone(db) : null,
 },
 // The caller's own timings: a person's or an agent's. Defaults when it has changed none.
 tempoTimings: { type: timings,
   resolve: () => {
     if ((viewer.kind !== 'member' && viewer.kind !== 'agent') || !current()) return null;
     return readTimings(db, { kind: viewer.kind === 'member' ? 'person' : 'agent', id: viewer.id });
   },
 } };
}
