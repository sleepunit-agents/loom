import { and, desc, eq, getTableColumns, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { agentPosts, agentPostSources, agentPostThreads, agentPostWorkRefs, conversations, tasks, threads } from '../data/schema.js';
import { taskVisibility } from '../data/visibility.js';
import { readableActivitySources, allActivitySourcesMatch, indexEarlierPostRefs, ticketRefDigest } from './agent-posts.js';
import type { WordsKey } from './words.js';

/** An explicit reference attaches the activity thread, including later replies. */
export async function ticketPosts(db:DataDatabase,key:WordsKey,viewer:Viewer,allowed:()=>SQL,task:string,before:number,limit:number) {
  if (viewer.kind !== 'member') return [];
  const taskVisible = () => db.select({id:tasks.id}).from(tasks).where(and(eq(tasks.id,task),
    taskVisibility(viewer).tasks!(getTableColumns(tasks)))).get();
  if (!taskVisible()) return [];
  await indexEarlierPostRefs(db,key);
  const anchor = alias(agentPosts,'ticket_anchor');
  const matchingThreads = db.select({thread:anchor.thread}).from(agentPostWorkRefs)
    .innerJoin(anchor,eq(anchor.seq,agentPostWorkRefs.post)).where(eq(agentPostWorkRefs.digest,ticketRefDigest(key,task)));
  const scope = () => allActivitySourcesMatch(db,readableActivitySources(db,viewer,allowed()));
  const condition = () => and(inArray(agentPostThreads.id,matchingThreads),scope());
  const select = db.select({seq:agentPosts.seq,at:agentPosts.at,words:agentPosts.words,agent:sql<string>`coalesce(${agentPostSources.agent},${conversations.agent})`,thread:agentPostThreads.id})
    .from(agentPostThreads).innerJoin(agentPosts,eq(agentPosts.thread,agentPostThreads.id))
    .innerJoin(agentPostSources,eq(agentPostSources.id,agentPosts.source))
    .leftJoin(threads,eq(threads.id,agentPostSources.conversationThread)).leftJoin(conversations,eq(conversations.id,threads.conversation));
  const rows = select.where(and(condition(),before ? lt(agentPosts.seq,before) : undefined)).orderBy(desc(agentPosts.seq)).limit(limit).all();
  const opened = await Promise.all(rows.map(async ({words,...row}) => ({...row,task,id:String(row.seq),words:await key.open(words)})));
  if (!opened.length || !taskVisible()) return [];
  const ids = opened.map(row=>row.seq);
  const readable = new Set(db.select({seq:agentPosts.seq}).from(agentPostThreads)
    .innerJoin(agentPosts,eq(agentPosts.thread,agentPostThreads.id)).where(and(condition(),inArray(agentPosts.seq,ids))).all().map(row=>row.seq));
  return opened.filter(row=>readable.has(row.seq));
}
