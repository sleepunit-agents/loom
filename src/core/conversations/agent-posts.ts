import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { DataDatabase } from '../data/database.js';
import { agentPosts, agentPostThreads } from '../data/schema.js';
import { threadTitle } from './title.js';
import { MESSAGE_WORDS_MAX, type WordsKey } from './words.js';

const words = z.string().min(1).max(MESSAGE_WORDS_MAX).refine(text => !!text.trim(), 'Activity post needs text');
const thread = z.string().min(1).max(200);
export const agentPostEdit = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), words, title: threadTitle.optional() }).strict(),
  z.object({ action: z.literal('reply'), thread, words }).strict(),
  z.object({ action: z.literal('rename'), thread, title: threadTitle }).strict(),
]);
type Edit = z.infer<typeof agentPostEdit>;

/** The operation authenticates the source and runs this prepared write inside its receipt transaction. */
export async function prepareAgentPost(db: DataDatabase, key: WordsKey, source: string, edit: Edit) {
  const id = edit.action === 'open' ? 'activity:' + randomUUID() : edit.thread;
  const scoped = and(eq(agentPostThreads.id, id), eq(agentPostThreads.source, source));
  const words = edit.action === 'rename' ? undefined : edit.words;
  if (words !== undefined && (!words.trim() || words.length > MESSAGE_WORDS_MAX))
    throw new Error('Activity post needs text within the message limit');
  let title: string | undefined;
  if (edit.action === 'open') {
    const firstLine = edit.words.trim().replace(/\s+/gu, ' ');
    title = threadTitle.parse(edit.title ?? [...firstLine].slice(0, 60).join(''));
  }
  if (edit.action === 'rename') title = threadTitle.parse(edit.title);
  const [sealedTitle, sealedWords] = await Promise.all([
    title === undefined ? undefined : key.seal(title),
    words === undefined ? undefined : key.seal(words),
  ]);
  return (at: string) => db.transaction(() => {
    if (edit.action === 'open') {
      db.insert(agentPostThreads).values({ id, source, title: sealedTitle! }).run();
    } else if (!db.select({ id: agentPostThreads.id }).from(agentPostThreads).where(scoped).get()) {
      throw new Error('Activity thread unavailable');
    }
    if (edit.action === 'rename') {
      db.update(agentPostThreads).set({ title: sealedTitle! }).where(scoped).run();
    } else {
      db.insert(agentPosts).values({ thread: id, at, words: sealedWords! }).run();
    }
    return id;
  });
}

/** Feed queries supply a source predicate computed for the authenticated viewer.
 * Choose the limited page before decrypting words. Sequence orders equal clock times. */
export async function agentPostPreviews(db: DataDatabase, key: WordsKey, visibleSource: SQL, limit: number) {
  const latest = sql<number>`(select max(p.seq) from agent_posts p where p.thread = ${agentPostThreads.id})`;
  const parent = alias(agentPosts, 'parent_post');
  const previous = sql<number>`(select max(p.seq) from agent_posts p
    where p.thread = ${agentPostThreads.id} and p.seq < ${agentPosts.seq})`;
  const rows = db.select({
    thread: agentPostThreads.id, source: agentPostThreads.source, title: agentPostThreads.title,
    latest: { seq: agentPosts.seq, at: agentPosts.at, words: agentPosts.words },
    parent: { seq: parent.seq, words: parent.words },
  }).from(agentPostThreads)
    .innerJoin(agentPosts, eq(agentPosts.seq, latest))
    .leftJoin(parent, eq(parent.seq, previous))
    .where(visibleSource).orderBy(desc(agentPosts.seq)).limit(limit).all();
  return Promise.all(rows.map(async row => ({
    thread: row.thread, title: await key.open(row.title),
    latest: { source: row.source, id: String(row.latest.seq), at: row.latest.at, words: await key.open(row.latest.words) },
    parent: row.parent ? { id: String(row.parent.seq), words: await key.open(row.parent.words) } : null,
  })));
}

/** Page forward in insertion order so a new reply never shifts a reader's place. */
export async function agentPostHistory(db: DataDatabase, key: WordsKey, visibleSource: SQL,
  thread: string, after: number, limit: number) {
  const rows = db.select({ source: agentPostThreads.source, seq: agentPosts.seq, words: agentPosts.words, at: agentPosts.at })
    .from(agentPostThreads).innerJoin(agentPosts, eq(agentPosts.thread, agentPostThreads.id))
    .where(and(visibleSource, eq(agentPostThreads.id, thread), gt(agentPosts.seq, after)))
    .orderBy(agentPosts.seq).limit(limit).all();
  return Promise.all(rows.map(async row => ({ source: row.source, id: String(row.seq), at: row.at, words: await key.open(row.words) })));
}
