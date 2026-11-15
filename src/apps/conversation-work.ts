import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { approvals, changes, taskComments, tasks, threadRefs, threads } from '../core/data/schema.js';
import { refsIn } from '../core/conversations/refs.js';

/** Trusted composition read, not an outside door. The caller must constrain the
 * conversation and each returned record before sending them to an outside viewer.
 * Cards use the original rows, so answering or closing work changes both views.
 */
export function conversationWork(db: DataDatabase) {
  return {
    read(conversation: string) {
      return db.transaction(() => {
        const mentions = db.select({ ref: threadRefs.ref, messageSeq: threadRefs.messageSeq })
          .from(threadRefs).innerJoin(threads, eq(threads.id, threadRefs.thread))
          .where(eq(threads.conversation, conversation)).all();
        const refs = mentions.map(m => m.ref);
        const made = and(eq(tasks.sourceKind, 'conversation'), eq(tasks.sourceId, conversation));
        const taskRows = db.select().from(tasks).where(or(made, inArray(tasks.id, refs)))
          .orderBy(asc(tasks.priority), asc(tasks.position), asc(tasks.id)).all();
        const madeTasks = taskRows.filter(t => t.sourceKind === 'conversation' && t.sourceId === conversation).map(t => t.id);
        // A PR cited on work filed here is "Made here"; merely mentioning a
        // task from elsewhere does not import that task's PRs into this thread.
        const comments = madeTasks.length ? db.select({ text: taskComments.text }).from(taskComments)
          .where(inArray(taskComments.task, madeTasks)).all() : [];
        const citedChanges = new Set(comments.flatMap(c => refsIn(c.text)).filter(r => r.startsWith('github:')));
        const changeIds = [...new Set([...refs, ...citedChanges])];
        const changeRows = db.select().from(changes).where(inArray(changes.id, changeIds))
          .orderBy(asc(changes.openedAt), asc(changes.id)).all();
        const approvalRows = db.select().from(approvals).where(eq(approvals.conversation, conversation))
          .orderBy(asc(approvals.askedAt), asc(approvals.id)).all();
        const seq = (id: string) => mentions.find(m => m.ref === id)?.messageSeq ?? null;
        return {
          tasks: taskRows.map(task => ({ task, madeHere: madeTasks.includes(task.id), messageSeq: seq(task.id) })),
          approvals: approvalRows,
          changes: changeRows.map(change => ({ change, madeHere: citedChanges.has(change.id), messageSeq: seq(change.id) })),
        };
      });
    },
  };
}
