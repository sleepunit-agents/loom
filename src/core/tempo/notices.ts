/** Settled Inbox notifications for connected people. Metadata only; the Inbox
 * remains the source of words and of current recipient/read authority. */
import { randomUUID } from 'node:crypto';
import { and, eq, getTableColumns, ne, sql, type SQL, type AnyColumn } from 'drizzle-orm';
import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { inbox, members } from '../data/schema.js';
import { readInboxFolders } from '../data/inbox-read.js';
import { talkVisibility } from '../data/conversation-visibility.js';

const noticeType = new GraphQLObjectType({ name: 'SettledInboxNotice', fields: {
  id: { type: GraphQLString }, count: { type: GraphQLInt }, needs: { type: GraphQLInt }, fyi: { type: GraphQLInt },
} });
export function settledNotices(db: DataDatabase, changed: () => void, visibleRow: (viewer:Viewer,fields:Record<string,AnyColumn>)=>SQL = (viewer,fields)=>talkVisibility(viewer).inbox(fields)) {
  const notices = new Map<string, { id: string; items: readonly string[] }>();
  let closed = false;
  const recipientFilter = (member: string, ids: readonly string[]) => {
    if (closed || !ids.length || !db.select({ id: members.id }).from(members).where(eq(members.id, member)).get()) return undefined;
    return and(
      sql`${inbox.id} in (select value from json_each(${JSON.stringify(ids)}))`, eq(inbox.toKind, 'person'), eq(inbox.to, member),
      eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute'),
      visibleRow({ kind: 'member', id: member },getTableColumns(inbox)),
    );
  };
  return {
    publish(member: string, ids: readonly string[]) {
      if (closed) return false;
      if (db.$client.inTransaction) throw new Error('Publish settled notices after commit');
      const filter = recipientFilter(member, ids);
      if (!filter) return false;
      const items = db.select({ id: inbox.id }).from(inbox).where(filter).all().map(row => row.id);
      if (!items.length) return false;
      notices.set(member, { id: randomUUID(), items }); changed(); return true;
    },
    fields: { settledInboxNotice: { type: noticeType,
      resolve(_source: unknown, _args: unknown, context: { viewer: Viewer }) {
        if (closed || context?.viewer?.kind !== 'member') return null;
        const notice = notices.get(context.viewer.id);
        if (!notice) return null;
        const filter = recipientFilter(context.viewer.id, notice.items);
        if (!filter) return null;
        const { all, needs, fyi } = readInboxFolders(db, filter);
        return all ? { id: notice.id, count: all, needs, fyi } : null;
      },
    } },
    close() { closed = true; notices.clear(); },
  };
}
