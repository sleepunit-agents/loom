/** Safe household display projection for Tempo; never expose settings wholesale. */
import { and, eq } from 'drizzle-orm';
import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { household, tempoSettings } from '../data/schema.js';
import { defaultTimings } from './volume.js';
const timings = new GraphQLObjectType({ name: 'TempoTimings', fields: Object.fromEntries(['settleSeconds', 'dimDays', 'muteDays'].map(name => [name, { type: new GraphQLNonNull(GraphQLInt) }])) });
export function tempoQueryFields(db: DataDatabase, viewer: Viewer) {
 return { tempoTimezone: { type: GraphQLString,
   resolve: () => viewer.kind === 'member' || viewer.kind === 'agent'
     ? db.select({zone:household.timezone}).from(household).get()?.zone ?? 'UTC' : null,
 },
 // The caller's own timings: a person's or an agent's. Defaults when it has changed none.
 tempoTimings: { type: timings,
   resolve: () => {
     if (viewer.kind !== 'member' && viewer.kind !== 'agent') return null;
     const row = db.select().from(tempoSettings).where(and(eq(tempoSettings.whoKind, viewer.kind === 'member' ? 'person' : 'agent'), eq(tempoSettings.who, viewer.id))).get();
     return row ? { settleSeconds: row.settleSeconds, dimDays: row.dimDays, muteDays: row.muteDays } : { ...defaultTimings };
   },
 } };
}
