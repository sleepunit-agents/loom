import { TASK_ID } from '../../slug.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, lt, inArray, isNull, notExists, notInArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { DataDatabase } from '../data/database.js';
import { agentPostNames, agentPostWorkRefs, agentPostWorkPending, agentPosts, agentPostThreads, conversations, threads } from '../data/schema.js';
import { threadTitle } from './title.js';
import { MESSAGE_WORDS_MAX, type WordsKey } from './words.js';

const privateVenue = sql`${conversations.venue} in ('loom','terminal')`;
const words = z.string().min(1).max(MESSAGE_WORDS_MAX).refine(text => !!text.trim(), 'Activity post needs text');
const thread = z.string().min(1).max(200);
const ref = z.string().max(200).regex(new RegExp('^(?:' + TASK_ID + '|github:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[1-9][0-9]{0,9})$'));
const refs = z.array(ref).max(20).optional();
export const agentPostEdit = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), words, refs, title: threadTitle.optional() }).strict(),
  z.object({ action: z.literal('reply'), thread, words, refs }).strict(),
  z.object({ action: z.literal('rename'), thread, title: threadTitle }).strict(),
]);
type Edit = z.infer<typeof agentPostEdit>;

export function activitySources(db: DataDatabase, predicate: SQL) {
  return db.select({ id: threads.id }).from(threads)
    .innerJoin(conversations, eq(threads.conversation, conversations.id)).where(predicate);
}

export function allActivitySourcesMatch(db: DataDatabase, sources: ReturnType<typeof activitySources>) {
  return and(inArray(agentPostThreads.source, sources),
    notExists(db.select({ id: agentPosts.seq }).from(agentPosts).where(and(
      eq(agentPosts.thread, agentPostThreads.id), notInArray(agentPosts.source, sources)))),
    notExists(db.select({ id: agentPostNames.thread }).from(agentPostNames).where(and(
      eq(agentPostNames.thread, agentPostThreads.id), notInArray(agentPostNames.source, sources)))))!;
}

export function ticketRefDigest(key: WordsKey, id: string) {
  return key.hash(JSON.stringify(['activity-ticket', id]));
}

function indexPostRefs(db: DataDatabase, key: WordsKey, post: number, refs: readonly string[]) {
  const rows = [...new Set(refs)].filter(id => id.startsWith('t-')).map(id => ({post,digest:ticketRefDigest(key,id)}));
  if (rows.length) db.insert(agentPostWorkRefs).values(rows).onConflictDoNothing().run();
}

/** Upgrade old rows in restartable batches. Recheck each pending row after async key access. */
export async function indexEarlierPostRefs(db: DataDatabase, key: WordsKey) {
  for (;;) {
    const page = db.select({post:agentPostWorkPending.post,sealed:agentPosts.workRefs}).from(agentPostWorkPending)
      .innerJoin(agentPosts,eq(agentPosts.seq,agentPostWorkPending.post)).orderBy(agentPostWorkPending.post).limit(64).all();
    if (!page.length) return;
    const entries = await Promise.all(page.map(async row => ({post:row.post, refs:await openRefs(key,row.sealed)})));
    db.transaction(() => {
      for (const {post,refs} of entries) {
        const removed = db.delete(agentPostWorkPending).where(eq(agentPostWorkPending.post,post)).run();
        if (removed.changes) indexPostRefs(db,key,post,refs);
      }
    });
  }
}

/** The operation authenticates the source and runs this prepared write inside its receipt transaction. */
export async function prepareAgentPost(db: DataDatabase, key: WordsKey, source: string, edit: Edit) {
  const id = edit.action === 'open' ? 'activity:' + randomUUID() : edit.thread;
  const audience = (thread: string) => db.select({
    agent: conversations.agent, member: conversations.member, project: conversations.project,
  }).from(threads).innerJoin(conversations, eq(conversations.id, threads.conversation))
    .where(and(eq(threads.id, thread), privateVenue)).get();
  const words = edit.action === 'rename' ? undefined : edit.words;
  if (words !== undefined && (!words.trim() || words.length > MESSAGE_WORDS_MAX))
    throw new Error('Activity post needs text within the message limit');
  let title: string | undefined;
  if (edit.action === 'open') {
    const firstLine = edit.words.trim().replace(/\s+/gu, ' ');
    title = threadTitle.parse(edit.title ?? [...firstLine].slice(0, 60).join(''));
  }
  if (edit.action === 'rename') title = threadTitle.parse(edit.title);
  const [sealedTitle, sealedWords, workRefs] = await Promise.all([
    title === undefined ? undefined : key.seal(title),
    words === undefined ? undefined : key.seal(words),
    edit.action !== 'rename' && edit.refs?.length ? key.seal(JSON.stringify(edit.refs)) : null,
  ]);
  return (at: string) => db.transaction(() => {
    if (edit.action === 'open') {
      db.insert(agentPostThreads).values({ id, source, title: sealedTitle! }).run();
    } else {
      const writer = audience(source);
      if (!writer?.member) throw new Error('Activity thread unavailable');
      const matching = activitySources(db, and(privateVenue,
        eq(conversations.member, writer.member), eq(conversations.agent, writer.agent),
        writer.project === null ? isNull(conversations.project) : eq(conversations.project, writer.project))!);
      const available = db.select({ id: agentPostThreads.id }).from(agentPostThreads)
        .where(and(eq(agentPostThreads.id, id), allActivitySourcesMatch(db, matching))).get();
      if (!available) throw new Error('Activity thread unavailable');
    }
    if (edit.action === 'rename') {
      db.insert(agentPostNames).values({thread:id,source,title:sealedTitle!}).onConflictDoUpdate({
        target:agentPostNames.thread,set:{source,title:sealedTitle!},
      }).run();
    } else {
      const post = db.insert(agentPosts).values({ thread: id, source, at, workRefs, words: sealedWords! }).returning({seq:agentPosts.seq}).get();
      indexPostRefs(db,key,post.seq,edit.refs ?? []);
    }
    return id;
  });
}

/** Feed queries supply a source predicate computed for the authenticated viewer.
 * Choose the limited page before decrypting words. Sequence orders equal clock times. */
export async function agentPostPreviews(db: DataDatabase, key: WordsKey, visibleSource: SQL, limit: number, before = 0) {
  const latest = sql<number>`(select max(p.seq) from agent_posts p where p.thread = ${agentPostThreads.id})`;
  const parent = alias(agentPosts, 'parent_post');
  const previous = sql<number>`(select max(p.seq) from agent_posts p
    where p.thread = ${agentPostThreads.id} and p.seq < ${agentPosts.seq})`;
  const rows = db.select({
    thread: agentPostThreads.id, source: agentPostThreads.source, title: agentPostThreads.title, rename: { source:agentPostNames.source, title:agentPostNames.title },
    latest: { source: agentPosts.source, seq: agentPosts.seq, at: agentPosts.at, words: agentPosts.words, workRefs: agentPosts.workRefs },
    parent: { source: parent.source, seq: parent.seq, words: parent.words },
  }).from(agentPostThreads)
    .leftJoin(agentPostNames, eq(agentPostNames.thread,agentPostThreads.id))
    .innerJoin(agentPosts, eq(agentPosts.seq, latest))
    .leftJoin(parent, eq(parent.seq, previous))
    .where(and(visibleSource, before ? lt(agentPosts.seq, before) : undefined)).orderBy(desc(agentPosts.seq)).limit(limit).all();
  return Promise.all(rows.map(async row => ({
    thread: row.thread, sources: [row.source,row.latest.source,...(row.parent?[row.parent.source]:[]),...(row.rename?[row.rename.source]:[])],
    title: await key.open(row.rename?.title ?? row.title),
    latest: { source: row.latest.source, id: String(row.latest.seq), at: row.latest.at, refs: await openRefs(key,row.latest.workRefs), words: await key.open(row.latest.words) },
    parent: row.parent ? { id: String(row.parent.seq), words: await key.open(row.parent.words) } : null,
  })));
}

/** Page forward in insertion order so a new reply never shifts a reader's place. */
export async function agentPostHistory(db: DataDatabase, key: WordsKey, visibleSource: SQL,
  thread: string, after: number, limit: number, newestFirst = false) {
  const cursor = after === 0 ? undefined : newestFirst ? lt(agentPosts.seq, after) : gt(agentPosts.seq, after);
  const rows = db.select({ source: agentPosts.source, seq: agentPosts.seq, words: agentPosts.words, at: agentPosts.at, workRefs: agentPosts.workRefs })
    .from(agentPostThreads).innerJoin(agentPosts, eq(agentPosts.thread, agentPostThreads.id))
    .where(and(visibleSource, eq(agentPostThreads.id, thread), cursor))
    .orderBy(newestFirst ? desc(agentPosts.seq) : agentPosts.seq).limit(limit).all();
  return Promise.all(rows.map(async row => ({ source: row.source, id: String(row.seq), at: row.at, refs: await openRefs(key,row.workRefs), words: await key.open(row.words) })));
}

async function openRefs(key: WordsKey, sealed: Buffer | null): Promise<string[]> {
  return sealed ? z.array(ref).max(20).parse(JSON.parse(await key.open(sealed))) : [];
}
