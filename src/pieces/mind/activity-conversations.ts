/** Activity's read projection of the shared Conversations service's records.
 * No legacy database, copied content, or independent visibility policy. */
import { and, asc, count, desc, eq, gte, lt, notExists, ne } from 'drizzle-orm';
import type { DataDatabase } from '../../core/data/database.js';
import { conversations, conversationPeople, digests, digestItems, inbox, turns } from '../../core/data/schema.js';
import { maySee, type Sharing, type Viewer } from '../../core/index.js';
import type { ActivityConversation, ActivityConversations, ActivityRun } from './activity-role.js';

type Conversation = typeof conversations.$inferSelect;
type Digest = typeof digests.$inferSelect;
function* pages<T>(read: (offset: number) => T[]) {
  for (let offset = 0; ; offset += 200) {
    const rows = read(offset);
    yield* rows;
    if (rows.length < 200) return;
  }
}

export function sharedActivityConversations(db: DataDatabase, options: {
  sharing(): Sharing;
  conversationHref?(id: string): string;
}): ActivityConversations {
  const visible = (viewer: Viewer, row: Conversation) => maySee(viewer, {
    type: 'conversation', agent: row.agent,
    ...(row.project === null ? {} : { project: row.project }),
    ...(row.member === null ? {} : { member: row.member }),
  }, options.sharing());
  function conversation(row: Conversation): ActivityConversation {
    return {
      id: row.id, agent: row.agent, venue: row.venue, place: row.place, label: row.label,
      people: db.select().from(conversationPeople).where(eq(conversationPeople.conversation, row.id))
        .orderBy(asc(conversationPeople.who)).all().map(p => p.who),
      ...(row.project === null ? {} : { project: row.project }),
      ...(row.member === null ? {} : { member: row.member }),
    };
  }
  function run(viewer: Viewer, row: Conversation, digest?: Digest): ActivityRun {
    const items = digest ? db.select().from(digestItems).where(eq(digestItems.digest, digest.id))
      .orderBy(asc(digestItems.kind), asc(digestItems.text)).all() : [];
    const question = digest?.inboxItem ? db.select().from(inbox).where(eq(inbox.id, digest.inboxItem)).get() : undefined;
    const href = options.conversationHref?.(row.id);
    return {
      kind: digest ? 'digest' : 'conversation', key: digest?.id ?? row.id, at: digest?.at ?? row.lastAt,
      conversation: conversation(row), ...(digest ? { summary: digest.summary } : {}), turns: row.turnCount,
      replies: db.select({ n: count() }).from(turns).where(and(eq(turns.conversation, row.id), eq(turns.kind, 'reply'))).get()!.n,
      asked: items.filter(i => i.kind === 'ask').map(i => i.text),
      decided: items.filter(i => i.kind === 'decision').map(i => i.text),
      tasks: items.filter(i => i.kind === 'task').map(i => i.text),
      references: items.map(i => i.text),
      links: href ? [{ label: 'Conversation', href }] : [],
      ...(viewer.kind === 'member' && question?.toKind === 'person' && question.to === viewer.id && question.state === 'waiting' && question.words ? {
        needs: question.words, needsForMember: question.to,
        ...(question.link ? { needsHref: question.link } : {}),
      } : {}),
      more: db.select().from(digests).where(and(eq(digests.conversation, row.id),
        ...(digest ? [ne(digests.id, digest.id)] : []))).orderBy(desc(digests.at), asc(digests.id)).limit(8).all()
        .map(d => ({ id: `d~${row.agent}~${d.id}`, at: d.at, title: d.summary })),
    };
  }
  return {
    nextDeadline(now) {
      let next=Infinity;
      // The list has an exclusive skew boundary, the detail an inclusive one.
      // Read only timestamp metadata; visibility remains in the content reads.
      for(const [table,column] of [['conversations','last_at'],['digests','at']]){
        const row=db.$client.prepare(`SELECT ${column} AS at FROM ${table} WHERE julianday(${column})>=julianday(?) ORDER BY julianday(${column}) LIMIT 1`).get(new Date(now+60000).toISOString()) as {at:string}|undefined;
        if(row){const enters=Date.parse(row.at)-60000;for(const at of [enters,enters+1])if(Number.isFinite(at)&&at>now)next=Math.min(next,at);}
      }
      return next===Infinity?undefined:next;
    },
    agents(viewer) {
      return [...new Set(db.select().from(conversations).all().filter(row => visible(viewer, row)).map(row => row.agent))];
    },
    list(viewer, query) {
      const from = new Date(query.from).toISOString(), until = new Date(query.until).toISOString();
      const limit = Math.max(0, Math.min(601, Math.trunc(query.limit)));
      if (!limit) return { available: true, rows: [] };
      // Iterate in time order, filtering before bounding. A page of someone
      // else's private threads cannot crowd visible work out of Activity.
      const rows: ActivityRun[] = [];
      const digestRows = db.select({ conversation: conversations, digest: digests }).from(digests)
        .innerJoin(conversations, eq(conversations.id, digests.conversation))
        .where(and(eq(conversations.agent, query.agent), gte(digests.at, from), lt(digests.at, until)))
        .orderBy(desc(digests.at), asc(digests.id));
      let n = 0;
      for (const row of pages(offset => digestRows.limit(200).offset(offset).all())) {
        if (!visible(viewer, row.conversation)) continue;
        rows.push(run(viewer, row.conversation, row.digest));
        if (++n === limit) break;
      }
      const moved = db.select().from(conversations).where(and(eq(conversations.agent, query.agent),
        gte(conversations.lastAt, from), lt(conversations.lastAt, until),
        notExists(db.select({ id: digests.id }).from(digests).where(and(eq(digests.conversation, conversations.id),
          gte(digests.at, from), lt(digests.at, until)))))).orderBy(desc(conversations.lastAt), asc(conversations.id));
      n = 0;
      for (const row of pages(offset => moved.limit(200).offset(offset).all())) {
        if (!visible(viewer, row)) continue;
        rows.push(run(viewer, row));
        if (++n === limit) break;
      }
      return { available: true, rows: rows.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key)).slice(0, limit) };
    },
    read(viewer, agent, kind, key) {
      const digest = kind === 'digest' ? db.select().from(digests).where(eq(digests.id, key)).get() : undefined;
      if (kind === 'digest' && !digest) return;
      const row = db.select().from(conversations).where(and(eq(conversations.id, digest?.conversation ?? key), eq(conversations.agent, agent))).get();
      if (row && visible(viewer, row)) return run(viewer, row, digest);
    },
    conversation(viewer, agent, id) {
      const row = db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.agent, agent))).get();
      if (row && visible(viewer, row)) return conversation(row);
    },
  };
}
