/** What state a project is in, and what that lets be done with it. Stated here once, with the one set of
 * words a caller is told. A task's project (apps/tasks.ts), an agent let onto a project, a merge, a retire
 * and a revive (shared-projects.ts) all ask this; none reads a project's `removed_at` or `retired_at`
 * itself (`projectState` is the one read, pinned by single-home.contract.test.ts).
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
/** What is to be done with the project: see `projectRefusal`. */
export type ProjectUse = 'enter' | 'stand';
/** Whether a project is removed and whether it is retired, or nothing when there is no such project. The
 * one read of the two columns; everything else in the program asks this. */
export function projectState(db: DataDatabase, project: string): { removed: boolean; retired: boolean } | undefined {
  const found = db.select({ removedAt: projects.removedAt, retiredAt: projects.retiredAt }).from(projects).where(eq(projects.id, project)).get();
  return found && { removed: !!found.removedAt, retired: !!found.retiredAt };
}
/** Project state in an existing relational selection, including an aliased project row. */
export function projectLifecycle(fields: Record<string, AnyColumn | SQL>): SQL {
  return sql`case when ${fields.removedAt} is not null then 'removed' when ${fields.retiredAt} is not null then 'retired' else 'active' end`;
}
/** Why this project will not do, or nothing when it will.
 *  - `enter`: something new is to be filed under it (a new task, a task moved in, a project merged in). It
 *    must be in use: there, not removed and not retired.
 *  - `stand`: what is already there is being read or changed where it is (an edit of a task that stays, a
 *    merge out of it, an agent let onto it). It must be there and not removed; retired will do. */
export function projectRefusal(db: DataDatabase, project: string, use: ProjectUse = 'enter'): ProjectRefusal | undefined {
  const found = projectState(db, project);
  return !found ? { code: 'not-found', message: 'No project has the id ' + project }
    : found.removed ? { code: 'invalid', message: 'Project ' + project + ' is removed' }
    : found.retired && use === 'enter' ? { code: 'invalid', message: 'Project ' + project + ' is retired: nothing new is filed under it until it is revived' } : undefined;
}
/** Why this project cannot be retired, or revived, as it stands; nothing when it can. A removed project is
 * neither: it is restored first. */
export function projectStateRefusal(db: DataDatabase, project: string, retire: boolean): ProjectRefusal | undefined {
  const unusable = projectRefusal(db, project, 'stand');
  if (unusable) return unusable;
  return projectState(db, project)?.retired === retire ? { code: 'invalid', message: 'Project ' + project + (retire ? ' is already retired' : ' is not retired') } : undefined;
}
/** Is this project retired? For the one refusal that names a task rather than a project (a claim). */
export function projectRetired(db: DataDatabase, project: string | null): boolean {
  return project !== null && !!projectState(db, project)?.retired;
}

const RETIRED = 'shelving_project', WAITED_ON = 'shelved_waited_on';
const retired = alias(projects, RETIRED);
/** A task is shelved when its project is retired and the task is not closed. It is never written on the
 * task: retiring and reviving change no task row, so a revive brings back every status, claim, question and
 * place in the order exactly. A shelved task is not ready, is in no list or count of open work, cannot be
 * claimed, and its waiting question does not ask for attention. Every reader that picks work asks this one
 * filter; `fields` are the task's own columns in that reader's query. Exactly 0 or 1. */
export function taskShelved(fields: { status: AnyColumn | SQL; project: AnyColumn | SQL }): SQL {
  return sql`(${fields.status} <> 'closed' and exists (select 1 from ${sql`${projects} as ${sql.identifier(RETIRED)}`} where ${retired.id} = ${fields.project} and ${retired.retiredAt} is not null))`;
}

const waitedOn = alias(tasks, WAITED_ON);
/** An inbox item waits on a shelved task. Its question does not ask for attention while the project is
 * retired: it is out of "needs you" and its counts, and back when the project is revived. Nothing about
 * the item changes, and whoever could read it still can. `fields` are the item's own columns. Exactly 0 or 1. */
export function waitsOnShelvedTask(fields: { waitsOnKind: AnyColumn | SQL; waitsOnId: AnyColumn | SQL }): SQL {
  return sql`(${fields.waitsOnKind} is 'task' and exists (select 1 from ${sql`${tasks} as ${sql.identifier(WAITED_ON)}`} where ${waitedOn.id} = ${fields.waitsOnId} and ${taskShelved({ status: waitedOn.status, project: waitedOn.project })}))`;
}
