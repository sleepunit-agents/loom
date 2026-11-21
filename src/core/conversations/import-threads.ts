import { pendingThreadDeletions } from './archive-deletions.js';
/** Restore the live thread directory from a stopped archive. This phase never schedules work. */
import { legacyConversationId } from './legacy-thread-id.js';
import type { ArchiveReader } from './archive-reader.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../data/database.js';
import { conversations, deletedThreads, threads } from '../data/schema.js';

import { recordThreadDeletion } from './threads.js';

export class UnresolvedArchiveThread extends Error {}

const id = z.string().min(1);
const time = z.iso.datetime({offset:true}).transform(value => new Date(value).toISOString());
const deletedThread = z.object({id, conversation:id.nullish(), agent:id, member:id, channel:z.number().int().positive().optional(), at:time});
const sourceThread = z.object({
  id, conversation:id, agent:id, member:id, project:id.nullable(), title:z.string().nullable(),
  titled_by:z.enum(['member','agent']).nullable(), channel:z.number().int().positive(),
  pinned:z.union([z.literal(0),z.literal(1)]), archived:time.nullable(), opened:time, last:time,
  read_seq:z.number().int().nonnegative(),
});

export function importThreads(source:ArchiveReader, db:DataDatabase, recover:(agent:string,member:string,thread:string)=>string|undefined,
  activity?:(agent:string,conversation:string)=>{started:string;last:string}|undefined) {
  if (!source.readonly) throw Error('Expected a read-only household snapshot');
  pendingThreadDeletions(source, db);
  const gone = source.prepare('SELECT * FROM comms_deleted ORDER BY id');
  const rows = source.prepare('SELECT * FROM comms_threads ORDER BY id');
  return db.transaction(() => {
    let inserted = 0, total = 0, tombstones = 0;
    for (const raw of gone.iterate()) {
      const result = deletedThread.safeParse(raw);
      if (!result.success) throw new UnresolvedArchiveThread('A deleted thread needs its original conversation identity before import.');
      const {agent,member,id,at}=result.data;
      const conversation=result.data.conversation ?? recover(agent,member,id);
      if (!conversation) throw new UnresolvedArchiveThread('A deleted thread has no unique backing conversation in its agent archive.');
      const row={id,at,conversation,sourceMember:member,sourceAgent:agent,sourceChannel:result.data.channel??null};
      if (db.select({id:threads.id}).from(threads).where(eq(threads.id,row.id)).get())
        throw Error('Archive deletion conflicts with a staged live thread');
      const prior = db.select().from(deletedThreads).where(eq(deletedThreads.id,row.id)).get();
      if (prior && (prior.conversation!==row.conversation || prior.at!==row.at || prior.sourceMember!==member || prior.sourceAgent!==agent || prior.sourceChannel!==row.sourceChannel))
        throw Error('Staged thread deletion differs from archive');
      if (!prior) {
        recordThreadDeletion(db,row);
        tombstones++;
      }
    }
    for (const raw of rows.iterate()) {
      const row = sourceThread.parse(raw);
      total++;
      // A v1 job had a private Comms thread too. Preserve its backing conversation
      // ID only when the agent archive and the member's keyed thread ID agree.
      if (row.conversation !== legacyConversationId(row.agent,'loom',row.id) &&
          recover(row.agent,row.member,row.id) !== row.conversation)
        throw new UnresolvedArchiveThread('A thread needs its original backing conversation mapped before import.');
      if (db.select({id:deletedThreads.id}).from(deletedThreads).where(eq(deletedThreads.id,row.id)).get())
        throw Error('Cannot restore a deleted thread');
      const title = row.title ?? `Channel ${row.channel}`;
      const conversation = {id:row.conversation, agent:row.agent, member:row.member, project:row.project,
        venue:'loom' as const, place:row.id, label:title, startedAt:row.opened, lastAt:row.last};
      const thread = {id:row.id, conversation:row.conversation, title, titledBy:row.titled_by ?? 'agent',
        sourceChannel:row.channel, pinned:row.pinned===1, archivedAt:row.archived, openedAt:row.opened, lastAt:row.last, readSeq:row.read_seq};
      const prior = db.select().from(threads).where(eq(threads.id,row.id)).get();
      if (prior) {
        const cv = db.select().from(conversations).where(eq(conversations.id,prior.conversation)).get();
        // Staging turns can extend the thread directory's time range. Accept
        // only the bounds independently reproduced from the same v1 archive.
        if (cv && cv.turnCount > 0 && (cv.startedAt!==conversation.startedAt || cv.lastAt!==conversation.lastAt)) {
          const dates=activity?.(row.agent,row.conversation);
          if (dates) {
            const start=time.parse(dates.started), end=time.parse(dates.last);
            if (start<conversation.startedAt) conversation.startedAt=start;
            if (end>conversation.lastAt) conversation.lastAt=end;
          }
        }
        if (!cv || !Object.entries(conversation).every(([key,v]) => cv[key as keyof typeof cv]===v) ||
            !Object.entries(thread).every(([key,v]) => prior[key as keyof typeof prior]===v))
          throw Error('Staged thread differs from archive');
        continue;
      }
      db.insert(conversations).values({...conversation, turnCount:0}).run();
      db.insert(threads).values({...thread, working:false, stopRequested:false}).run();
      inserted++;
    }
    return {inserted,total,tombstones};
  });
}
