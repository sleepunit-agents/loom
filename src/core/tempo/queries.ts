/** Safe household display projection for Tempo; never expose settings wholesale. */
import { createHash } from 'node:crypto';
import { and, eq, getTableColumns, isNotNull } from 'drizzle-orm';
import { triggers } from '../data/schema.js';
import type { Trigger } from './triggers.js';
import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import { rules, type Viewer } from '../../policy.js';
import { sqlHolds, sqlVisibility } from '../../policy-sql.js';
import type { DataDatabase } from '../data/database.js';
import { householdTimezone } from '../data/household-settings.js';
import { readTimings } from './volume.js';
const timings = new GraphQLObjectType({ name: 'TempoTimings', fields: Object.fromEntries(['settleSeconds', 'dimDays', 'muteDays'].map(name => [name, { type: new GraphQLNonNull(GraphQLInt) }])) });
export function tempoQueryFields(db: DataDatabase, viewer: Viewer, resolvedWords?: (trigger: Trigger) => string) {
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
 }, tempoMachineWordsMatch: { type: GraphQLBoolean, args: { id: { type: new GraphQLNonNull(GraphQLString) } },
   resolve(_parent: unknown, { id }: { id: string }) {
     const visible = sqlVisibility(viewer, ['triggers']).triggers(getTableColumns(triggers));
     const trigger = db.select().from(triggers).where(and(eq(triggers.id, id), isNotNull(triggers.machineWords), visible)).get();
     if (!trigger || !resolvedWords) return null;
     try { return createHash('sha256').update(resolvedWords(trigger)).digest('hex') === trigger.machineWords; }
     catch { return null; }
   },
 } };
}
