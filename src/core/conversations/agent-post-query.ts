import { workForPage } from './agent-post-work.js';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { agentPostThreads, conversations, threads } from '../data/schema.js';
import { activitySources, allActivitySourcesMatch, agentPostHistory, agentPostPreviews } from './agent-posts.js';
import type { WordsKey } from './words.js';

export function agentPostFields(db: DataDatabase, key: WordsKey, allowed: (viewer: Viewer) => SQL):
GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const string = new GraphQLNonNull(GraphQLString);
  const workLink = new GraphQLObjectType({ name: 'AgentActivityWorkLink', fields: {
    id: { type: string }, title: { type: string }, state: { type: string }, href: { type: string },
  } });
  const post = new GraphQLObjectType({ name: 'AgentActivityPost', fields: {
    work: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(workLink))) },
    source: { type: string }, id: { type: string }, at: { type: string }, words: { type: string },
  } });
  const excerpt = new GraphQLObjectType({ name: 'AgentActivityExcerpt', fields: {
    id: { type: string }, words: { type: string },
  } });
  const preview = new GraphQLObjectType({ name: 'AgentActivityPreview', fields: {
    thread: { type: string }, title: { type: string },
    latest: { type: new GraphQLNonNull(post) }, parent: { type: excerpt },
  } });
  const sources = (viewer: Viewer, agent: string) => activitySources(db,
    viewer.kind === 'member' ? and(eq(conversations.agent, agent), allowed(viewer))! : sql`false`);
  const source = (viewer: Viewer, agent: string) => allActivitySourcesMatch(db, sources(viewer, agent));
  const visibleThreads = (viewer: Viewer, agent: string, ids: string[]) => new Set(
    db.select({ id: agentPostThreads.id }).from(agentPostThreads)
      .where(and(source(viewer, agent), inArray(agentPostThreads.id, ids))).all().map(row => row.id));
  const visibleSources = (viewer: Viewer, agent: string, ids: string[]) => new Set(
    db.select({id:threads.id}).from(threads).where(and(inArray(threads.id,[...new Set(ids)]),
      inArray(threads.id,sources(viewer,agent)))).all().map(row=>row.id));
  const size = (limit: number) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid activity page size');
    return limit;
  };
  const args = { agent: { type: string }, limit: { type: GraphQLInt, defaultValue: 20 } };
  return {
    agentActivityFeed: { type: new GraphQLList(new GraphQLNonNull(preview)), args,
      async resolve(_row, { agent, limit }, { viewer }) {
        const rows = await agentPostPreviews(db, key, source(viewer, agent), size(limit));
        if (!rows.length) return [];
        const current = visibleThreads(viewer, agent, rows.map(row => row.thread));
        const stillReadable = visibleSources(viewer,agent,rows.flatMap(row=>row.sources));
        const visible = rows.filter(row => current.has(row.thread) && row.sources.every(id=>stillReadable.has(id)));
        const work = workForPage(db, viewer, visible.map(row => row.latest));
        return visible.map(row => ({ ...row, latest: { ...row.latest, work: () => work(row.latest) } }));
      },
    },
    agentActivityHistory: { type: new GraphQLList(new GraphQLNonNull(post)),
      args: { ...args, thread: { type: string }, after: { type: GraphQLString, defaultValue: '0' } },
      async resolve(_row, { agent, thread, limit, after }, { viewer }) {
        const cursor = Number(after);
        if (!Number.isSafeInteger(cursor) || cursor < 0 || String(cursor) !== after) throw new Error('Invalid activity cursor');
        const rows = await agentPostHistory(db, key, source(viewer, agent), thread, cursor, size(limit));
        if (!rows.length || !visibleThreads(viewer, agent, [thread]).has(thread)) return [];
        const stillReadable = visibleSources(viewer,agent,rows.map(row=>row.source));
        const visible = rows.filter(row=>stillReadable.has(row.source));
        const work = workForPage(db, viewer, visible);
        return visible.map(row => ({ ...row, work: () => work(row) }));
      },
    },
  };
}
