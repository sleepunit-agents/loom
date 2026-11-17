/** What state a project is in, and what that lets be done with it. Stated here once, with the one set of
 * words a caller is told. A task's project (apps/tasks.ts), an agent let onto a project, a merge, a retire
 * and a revive (shared-projects.ts) all ask this; none reads `removed_at` or `retired_at` itself.
 *
 * A project is in use, retired, or removed:
 *  - in use: tasks are filed under it and worked on;
 *  - retired (`retired_at`): everything under it stays, readable by exactly who could read it before, and
 *    nothing new is filed under it. Its unfinished tasks are shelved: `taskShelved`, below;
 *  - removed (`removed_at`): out of use, granting nothing (policy.ts). A retired project that is removed
 *    stays marked retired. */
import { eq, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { DataDatabase } from './database.js';
import { projects, tasks } from './schema.js';

export interface ProjectRefusal { code: 'not-found' | 'invalid'; message: string }
/** Why this project will not do, or nothing when it will.
 *  - `enter`: something new is to be filed under it (a new task, a task moved in, a project merged in). It
 *    must be in use: there, not removed and not retired.
 *  - `stand`: what is already there is being read or changed where it is (an edit of a task that stays, a
 *    merge out of it, an agent let onto it). It must be there and not removed; retired will do. */
export function projectRefusal(db: DataDatabase, project: string, to: 'enter' | 'stand' = 'enter'): ProjectRefusal | undefined {
  const found = db.select({ removedAt: projects.removedAt, retiredAt: projects.retiredAt }).from(projects).where(eq(projects.id, project)).get();
  return !found ? { code: 'not-found', message: 'No project has the id ' + project }
    : found.removedAt ? { code: 'invalid', message: 'Project ' + project + ' is removed' }
    : found.retiredAt && to === 'enter' ? { code: 'invalid', message: 'Project ' + project + ' is retired: nothing new is filed under it until it is revived' } : undefined;
}
/** Why this project cannot be retired, or revived, as it stands; nothing when it can. A removed project is
 * neither: it is restored first. */
export function projectStateRefusal(db: DataDatabase, project: string, retire: boolean): ProjectRefusal | undefined {
  const unusable = projectRefusal(db, project, 'stand');
  if (unusable) return unusable;
  return projectRetired(db, project) === retire ? { code: 'invalid', message: 'Project ' + project + (retire ? ' is already retired' : ' is not retired') } : undefined;
}
/** Is this project retired? For the one refusal that names a task rather than a project (a claim). */
export function projectRetired(db: DataDatabase, project: string | null): boolean {
  return project !== null && !!db.select({ retiredAt: projects.retiredAt }).from(projects).where(eq(projects.id, project)).get()?.retiredAt;
}

const retired = alias(projects, 'shelving_project');
/** A task is shelved when its project is retired and the task is not closed. It is never written on the
 * task: retiring and reviving change no task row, so a revive brings back every status, claim, question and
 * place in the order exactly. A shelved task is not ready, is in no list or count of open work, cannot be
 * claimed, and its waiting question does not ask for attention. Every reader that picks work asks this one
 * filter; `fields` are the task's own columns in that reader's query. Exactly 0 or 1. */
export function taskShelved(fields: { status: AnyColumn | SQL; project: AnyColumn | SQL }): SQL {
  return sql`(${fields.status} <> 'closed' and exists (select 1 from ${sql`${projects} as ${sql.identifier('shelving_project')}`} where ${retired.id} = ${fields.project} and ${retired.retiredAt} is not null))`;
}

const waitedOn = alias(tasks, 'shelved_waited_on');
/** An inbox item waits on a shelved task. Its question does not ask for attention while the project is
 * retired: it is out of "needs you" and its counts, and back when the project is revived. Nothing about
 * the item changes, and whoever could read it still can. `fields` are the item's own columns. Exactly 0 or 1. */
export function waitsOnShelvedTask(fields: { waitsOnKind: AnyColumn | SQL; waitsOnId: AnyColumn | SQL }): SQL {
  return sql`(${fields.waitsOnKind} is 'task' and exists (select 1 from ${sql`${tasks} as ${sql.identifier('shelved_waited_on')}`} where ${waitedOn.id} = ${fields.waitsOnId} and ${taskShelved({ status: waitedOn.status, project: waitedOn.project })}))`;
}
