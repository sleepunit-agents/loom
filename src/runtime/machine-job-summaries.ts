import { and, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import type { DataDatabase } from '../core/data/database.js';
import { boxes, conversations, digests, jobs } from '../core/data/schema.js';
import { machineJobSummaryOwner, type Viewer } from '../policy.js';
import { sqlRule } from '../policy-sql.js';

const text = { type: GraphQLString };
const required = { type: new GraphQLNonNull(GraphQLString) };
const summary = new GraphQLObjectType({ name: 'PrivateMachineJob', fields: {
  id: required, agent: required, box: required, state: required, queuedAt: required,
  claimedAt: text, endedAt: text, summary: text,
} });

/** Only a digest written for this exact job and conversation may accompany its machine facts. */
export function machineJobSummaryField(db: DataDatabase, viewer: Viewer) {
  return {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(summary))),
    args: { agent: required },
    resolve: (_source: unknown, { agent }: { agent: string }) => {
      if (viewer.kind !== 'member') return [];
      const recent = db.$with('recent_private_jobs').as(db.select({
        id: jobs.id, agent: jobs.agent, box: jobs.box, state: jobs.state, conversation: jobs.conversation,
        queuedAt: jobs.queuedAt, claimedAt: jobs.claimedAt, endedAt: jobs.endedAt,
      }).from(jobs).innerJoin(boxes, eq(boxes.id, jobs.box)).innerJoin(conversations, eq(conversations.id, jobs.conversation))
        .where(and(eq(jobs.agent, agent), isNotNull(conversations.member), ne(conversations.member, viewer.id),
          eq(conversations.agent, jobs.agent), sqlRule(machineJobSummaryOwner, viewer, { owner: boxes.owner })))
        .orderBy(desc(jobs.queuedAt), desc(jobs.id)).limit(30));
      const ranked = db.$with('ranked_private_digests').as(db.select({
        job: digests.run, summary: digests.summary,
        position: sql<number>`row_number() over (partition by ${digests.run} order by ${digests.revision} desc, ${digests.at} desc, ${digests.id} desc)`.as('position'),
      }).from(digests).innerJoin(recent, and(eq(digests.run, recent.id), eq(digests.conversation, recent.conversation))));
      return db.with(recent, ranked).select({
        id: recent.id, agent: recent.agent, box: recent.box, state: recent.state, queuedAt: recent.queuedAt,
        claimedAt: recent.claimedAt, endedAt: recent.endedAt, summary: ranked.summary,
      }).from(recent).leftJoin(ranked, and(eq(ranked.job, recent.id), eq(ranked.position, 1)))
        .orderBy(desc(recent.queuedAt), desc(recent.id)).all();
    },
  };
}
