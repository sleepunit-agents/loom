import { clockLanes, clockLaneText, clockScheduleRevision } from './lanes.js';
import { wakeDeliveries } from './deliveries.js';
/** Safe household display projection for Tempo; never expose settings wholesale. */
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import { and, desc, eq } from 'drizzle-orm';
import { triggerLog, triggers } from '../data/schema.js';
import { dataValue } from '../data/subscriptions.js';
import { sharedSharing } from '../../shared-sharing.js';
import { directsAgent, isHouseholdOwner, rules, type Viewer } from '../../policy.js';
import { sqlHolds } from '../../policy-sql.js';
import type { DataDatabase } from '../data/database.js';
import { householdTimezone } from '../data/household-settings.js';
import { readTimings } from './volume.js';
import { hasAgentJournal, readJournal } from './journal.js';
const timings = new GraphQLObjectType({ name: 'TempoTimings', fields: Object.fromEntries(['settleSeconds', 'dimDays', 'muteDays'].map(name => [name, { type: new GraphQLNonNull(GraphQLInt) }])) });
export function tempoQueryFields(db: DataDatabase, viewer: Viewer, canReadProgram: () => boolean = () => true) {
 // Someone in the household now (rules.currentViewer): a removed member's token, or a body whose member has left, reads neither.
 const current = () => sqlHolds(db, rules.currentViewer, viewer);
 return { tempoProgram: { type: dataValue, args: { id: { type: new GraphQLNonNull(GraphQLString) } },
   resolve: (_source: unknown, { id }: { id: string }) => {
     if (!current() || !canReadProgram()) return null;
     const row = db.select().from(triggers).where(eq(triggers.id, id)).get();
     if (!row?.program || !(isHouseholdOwner(viewer, sharedSharing(db)) || (viewer.kind === 'agent' && !viewer.workingFor && viewer.id === row.to))) return null;
     const result = db.select({ note: triggerLog.note }).from(triggerLog).where(and(eq(triggerLog.trigger, id), eq(triggerLog.event, 'program'))).orderBy(desc(triggerLog.seq)).limit(1).get();
     return { lastResult: result?.note ?? null, program: row.program, readStateFrom: row.readStateFrom, programPeriod: row.programPeriod, programState: row.programState };
   },
 }, tempoJournal: { type: dataValue, args: { id: { type: new GraphQLNonNull(GraphQLString) } },
   resolve: (_source: unknown, { id }: { id: string }) => {
     if (viewer.kind !== 'member' || !current() || !isHouseholdOwner(viewer, sharedSharing(db))) return null;
     const trigger = db.select().from(triggers).where(eq(triggers.id, id)).get();
     if (!trigger || !hasAgentJournal(trigger)) return null;
     const { lessons, state, stateChangedAt } = readJournal(db, id);
     return { lessons, state, stateChangedAt };
   },
 }, tempoDeliveries: { type: dataValue, args: { agent: { type: new GraphQLNonNull(GraphQLString) },
   events: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLInt))) } },
   resolve: (_source: unknown, { agent, events }: { agent: string; events: number[] }) =>
     current() ? wakeDeliveries(db, viewer, agent, events, canReadProgram()) : [],
 }, tempoLanes: { type: dataValue, args: { after: { type: new GraphQLNonNull(GraphQLString) } },
   resolve: (_source: unknown, { after }: { after: string }) => current() ? clockLanes(db, viewer, after) : [],
 }, tempoLaneText: { type: dataValue, args: { agent: {type:GraphQLString}, id: { type: new GraphQLNonNull(GraphQLString) } },
   resolve: (_source: unknown, { id, agent }: { id: string; agent?: string }) => current() ? clockLaneText(db, viewer, id, agent) : null,
 }, tempoScheduleRevision: { type: GraphQLString, args: { id: { type: new GraphQLNonNull(GraphQLString) } },
   resolve: (_source: unknown, { id }: { id: string }) => current() ? clockScheduleRevision(db, viewer, id) : null,
 }, tempoDefaultAgent: { type: GraphQLString,
   resolve: () => {
     if (!current() || (viewer.kind !== 'agent' && viewer.kind !== 'member')) return null;
     const sharing = sharedSharing(db);
     if (viewer.kind === 'agent') return directsAgent(viewer, viewer.id, sharing) ? viewer.id : null;
     const clocks = (sharing.agents ?? []).filter(agent => directsAgent(viewer, agent, sharing));
     if (clocks.length <= 1) return clocks[0] ?? null;
     const chosen = db.query.household.findFirst({ columns: { defaultAgent: true } }).sync()?.defaultAgent;
     return chosen && clocks.includes(chosen) ? chosen : null;
   },
 }, tempoTimezone: { type: GraphQLString,
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
