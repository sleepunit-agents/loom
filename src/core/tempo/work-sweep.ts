import { and, eq, ne, or, sql } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { DataDatabase } from '../data/database.js';
import { approvals, changes, tasks } from '../data/schema.js';
import type { SweepPart } from './sweep.js';

export const WORK_SWEEP_LIMIT = 20;
/** Trusted contributors over committed work. Tasks go to their assignee,
 * otherwise owner; changes to their agent; approvals to their actingFor person.
 * Unassigned household work needs an explicit assignment. Counts cover all open
 * work; wording lists the oldest twenty. Register once before starting Tempo.
 */
export function workSweepParts(db: DataDatabase, clock: Clock): readonly SweepPart[] {
  return [
    { name: 'Tasks', open(who) {
      const kind = who.kind === 'person' ? 'member' : 'agent';
      const where = and(ne(tasks.status, 'closed'),
        or(and(eq(tasks.assigneeKind, kind), eq(tasks.assignee, who.id)),
          and(sql`${tasks.assignee} is null`, eq(tasks.ownerKind, kind), eq(tasks.owner, who.id))));
      return db.transaction(() => ({
        items: db.select({ id: tasks.id, words: tasks.title, openedAt: tasks.createdAt }).from(tasks).where(where)
          .orderBy(sql`julianday(${tasks.createdAt})`, tasks.id).limit(WORK_SWEEP_LIMIT).all(),
        count: db.select({ count: sql<number>`count(*)` }).from(tasks).where(where).get()!.count,
      }));
    } },
    { name: 'Changes', open(who) {
      if (who.kind !== 'agent') return [];
      const where = and(eq(changes.state, 'open'), eq(changes.agent, who.id));
      return db.transaction(() => ({
        items: db.select({ id: changes.id, words: changes.title, openedAt: changes.openedAt }).from(changes).where(where)
          .orderBy(sql`julianday(${changes.openedAt})`, changes.id).limit(WORK_SWEEP_LIMIT).all(),
        count: db.select({ count: sql<number>`count(*)` }).from(changes).where(where).get()!.count,
      }));
    } },
    { name: 'Approvals', open(who) {
      if (who.kind !== 'person') return [];
      const now = new Date(clock.now()).toISOString();
      const where = and(eq(approvals.state, 'pending'), eq(approvals.actingFor, who.id),
        sql`(${approvals.member} is null or ${approvals.member} = ${who.id})`,
        // UTC columns allow both second and millisecond precision.
        sql`(${approvals.expiresAt} is null or julianday(${approvals.expiresAt}) > julianday(${now}))`);
      return db.transaction(() => ({
        items: db.select({ id: approvals.id, words: approvals.ask, openedAt: approvals.askedAt }).from(approvals).where(where)
          .orderBy(sql`julianday(${approvals.askedAt})`, approvals.id).limit(WORK_SWEEP_LIMIT).all(),
        count: db.select({ count: sql<number>`count(*)` }).from(approvals).where(where).get()!.count,
      }));
    } },
  ];
}
