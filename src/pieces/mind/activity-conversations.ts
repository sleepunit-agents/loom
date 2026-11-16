import { readActivityAgents, readActivityWindow, readActivityConversation, readActivityDigest, readActivitySet, type ActivityReadSet } from '../../core/data/activity-read.js';
/** Activity's read projection of the shared Conversations service's records.
 * No legacy database, copied content, or independent visibility policy. */
import type { DataDatabase } from '../../core/data/database.js';
import { conversations, digests } from '../../core/data/schema.js';
import { type Viewer } from '../../core/index.js';
import type { ActivityConversation, ActivityConversations, ActivityRun } from './activity-role.js';
import {hasPrivateInboxPayload} from '../../core/conversations/private-inbox-words.js';

type Conversation = typeof conversations.$inferSelect;
type Digest = typeof digests.$inferSelect;
export function sharedActivityConversations(db: DataDatabase, options: {
  conversationHref?(id: string): string;
}): ActivityConversations {
  function conversation(row: Conversation, set: ActivityReadSet): ActivityConversation {
    return {
      id: row.id, agent: row.agent, venue: row.venue, place: row.place, label: row.label,
      people: set.conversation(row.id)?.conversationPeopleByConversation.map(p => p.who) ?? [],
      ...(row.project === null ? {} : { project: row.project }),
      ...(row.member === null ? {} : { member: row.member }),
    };
  }
  function run(viewer: Viewer, row: Conversation, set: ActivityReadSet, digest?: Digest): ActivityRun {
    const items = digest ? set.items(digest.id) : [];
    const question = digest?.inboxItem ? set.question(digest.inboxItem) : undefined;
    const href = options.conversationHref?.(row.id);
    return {
      kind: digest ? 'digest' : 'conversation', key: digest?.id ?? row.id, at: digest?.at ?? row.lastAt,
      conversation: conversation(row, set), ...(digest ? { summary: digest.summary } : {}), turns: row.turnCount,
      replies: set.conversation(row.id)?.replyCount ?? 0,
      asked: items.filter(i => i.kind === 'ask').map(i => i.text),
      decided: items.filter(i => i.kind === 'decision').map(i => i.text),
      tasks: items.filter(i => i.kind === 'task').map(i => i.text),
      references: items.map(i => i.text),
      links: href ? [{ label: 'Conversation', href }] : [],
      ...(viewer.kind === 'member' && question?.toKind === 'person' && question.to === viewer.id && question.state === 'waiting' && question.words && !hasPrivateInboxPayload(db,question) ? {
        needs: question.words, needsForMember: question.to,
        ...(question.link ? { needsHref: question.link } : {}),
      } : {}),
      more: (set.conversation(row.id)?.digestsByConversation ?? []).filter(d => d.id !== digest?.id).slice(0, 8)
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
    agents(viewer) { return readActivityAgents(db, viewer); },
    list(viewer, query) {
      const limit = Math.max(0, Math.min(601, Math.trunc(query.limit)));
      if (!limit) return { available: true, rows: [] };
      const { digestRows, moved } = readActivityWindow(db, viewer, { ...query, limit });
      const set = readActivitySet(db, viewer, [...new Set([...digestRows.map(row => row.conversation), ...moved.map(row => row.id)])], digestRows.map(row => row.id), digestRows.flatMap(row => row.inboxItem ? [row.inboxItem] : []));
      const rows = [...digestRows.flatMap(({ conversationRow, ...digest }) => conversationRow ? [run(viewer, conversationRow, set, digest)] : []), ...moved.map(row => run(viewer, row, set))];
      return { available: true, rows: rows.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key)).slice(0, limit) };
    },
    read(viewer, agent, kind, key) {
      const digest = kind === 'digest' ? readActivityDigest(db, viewer, agent, key) : undefined;
      if (kind === 'digest' && !digest) return;
      const row = readActivityConversation(db, viewer, agent, digest?.conversation ?? key);
      if (row) return run(viewer, row, readActivitySet(db, viewer, [row.id], digest ? [digest.id] : [], digest?.inboxItem ? [digest.inboxItem] : []), digest);
    },
    conversation(viewer, agent, id) {
      const row = readActivityConversation(db, viewer, agent, id);
      if (row) return conversation(row, readActivitySet(db, viewer, [row.id], [], []));
    },
  };
}
