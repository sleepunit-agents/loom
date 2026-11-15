/** Settled Inbox notifications for connected people. Metadata only; the Inbox
 * remains the source of words and of current recipient/read authority. */
import { randomUUID } from 'node:crypto';
import { and, eq, getTableColumns, ne, sql, type SQL, type AnyColumn } from 'drizzle-orm';
import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { inbox, members } from '../data/schema.js';
import { workVisibility } from '../data/work-visibility.js';

const noticeType = new GraphQLObjectType({ name: 'SettledInboxNotice', fields: {
  id: { type: GraphQLString }, count: { type: GraphQLInt },
} });
export function settledNotices(db: DataDatabase, changed: () => void, visibleRow: (viewer:Viewer,fields:Record<string,AnyColumn>)=>SQL = (viewer,fields)=>workVisibility(viewer).approvals!(fields)) {
  const notices = new Map<string, { id: string; items: readonly string[] }>();
  let closed = false;
  const visible = (member: string, ids: readonly string[]) => {
    if (closed || !ids.length || !db.select({ id: members.id }).from(members).where(eq(members.id, member)).get()) return [];
    return db.select({ id: inbox.id }).from(inbox).where(and(
      sql`${inbox.id} in (select value from json_each(${JSON.stringify(ids)}))`, eq(inbox.toKind, 'person'), eq(inbox.to, member),
      eq(inbox.state, 'waiting'), ne(inbox.volume, 'mute'),
      visibleRow({ kind: 'member', id: member },getTableColumns(inbox)),
    )).all().map(row => row.id);
  };
  return {
    publish(member: string, ids: readonly string[]) {
      if (closed) return false;
      if (db.$client.inTransaction) throw new Error('Publish settled notices after commit');
      const items = visible(member, ids);
      if (!items.length) return false;
      notices.set(member, { id: randomUUID(), items }); changed(); return true;
    },
    fields: { settledInboxNotice: { type: noticeType,
      resolve(_source: unknown, _args: unknown, context: { viewer: Viewer }) {
        if (closed || context?.viewer?.kind !== 'member') return null;
        const notice = notices.get(context.viewer.id);
        if (!notice) return null;
        const count = visible(context.viewer.id, notice.items).length;
        return count ? { id: notice.id, count } : null;
      },
    } },
    close() { closed = true; notices.clear(); },
  };
}
