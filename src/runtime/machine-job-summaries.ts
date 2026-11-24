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
      const digest = db.select({ summary: digests.summary }).from(digests)
        .where(and(eq(digests.run, jobs.id), eq(digests.conversation, conversations.id)))
        .orderBy(desc(digests.revision), desc(digests.at), desc(digests.id)).limit(1);
      return db.select({ id: jobs.id, agent: jobs.agent, box: boxes.id, state: jobs.state,
        queuedAt: jobs.queuedAt, claimedAt: jobs.claimedAt, endedAt: jobs.endedAt,
        summary: sql<string | null>`(${digest})`,
      }).from(jobs).innerJoin(boxes, eq(boxes.id, jobs.box)).innerJoin(conversations, eq(conversations.id, jobs.conversation))
        .where(and(eq(jobs.agent, agent), isNotNull(conversations.member), ne(conversations.member, viewer.id),
          eq(conversations.agent, jobs.agent), sqlRule(machineJobSummaryOwner, viewer, { owner: boxes.owner })))
        .orderBy(desc(jobs.queuedAt), desc(jobs.id)).limit(30).all();
    },
  };
}
