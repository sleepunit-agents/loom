/** The selections the Work bricks wrote for themselves, run against the schema loom generates from its tables (as
 * brick-queries.test.ts runs the pull request's): every field, filter, order and relation they name exists. The
 * unfiled tickets and the choices of project and owner are the desktop's own selections, run here too. */
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
// The root's graphql, the one the generated schema is built with (web/ has its own copy).
import { graphql } from '../../../node_modules/graphql/index.js';
import { sql } from 'drizzle-orm';
import { createDataSchema } from '../../../src/core/data/database.js';
import { dataQueries, type QueryVisibility } from '../../../src/core/data/queries.js';
import * as s from '../../../src/core/data/schema.js';
import { taskChoicesQuery } from '../pieces/tasks/query';
import { workUnfiledQuery } from '../pieces/work/query';
import './bricks';
import { backlogQuery, inBacklog } from './bricks-backlog';
import { newTicketQuery } from './bricks-new-ticket';
import { projectQuery } from './bricks-project';
import { ticketChoicesQuery, ticketMoreQuery } from './bricks-ticket-edit';

it('reads a ticket\'s facts and links, a backlog, the unfiled tickets and the choices with selections the generated schema answers', async () => {
  const client = new Database(':memory:');
  try {
    const at = '2026-11-14T00:00:00.000Z';
    const db = createDataSchema(client, () => at);
    db.insert(s.members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
    db.insert(s.agents).values({ id: 'art', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
    db.insert(s.projects).values({ id: 'pond', name: 'Pond' } as typeof s.projects.$inferInsert).run();
    const task = { ownerKind: 'member', owner: 'sam', createdByKind: 'member', createdBy: 'sam', createdAt: at, changedAt: at, project: 'pond' } as const;
    db.insert(s.tasks).values([
      { ...task, id: 't-1', title: 'Epic', priority: 2, position: 1 },
      { ...task, id: 't-2', title: 'Second by position', priority: 1, position: 5, description: 'Words' },
      { ...task, id: 't-3', title: 'First by position', priority: 1, position: 2 },
      { ...task, id: 't-4', title: 'Most urgent', priority: 0, position: 9 },
      { ...task, id: 't-5', title: 'Closed', priority: 0, position: 1, status: 'closed', closedAt: at, closeReason: 'Done with it' },
      { ...task, id: 't-6', title: 'Claimed', priority: 0, position: 2, status: 'in_progress', assigneeKind: 'agent', assignee: 'art' },
      { ...task, id: 't-7', title: 'Unfiled', project: null },
    ] as (typeof s.tasks.$inferInsert)[]).run();
    db.insert(s.taskLinks).values([{ task: 't-2', dependsOn: 't-1', type: 'parent-child' }, { task: 't-2', dependsOn: 't-3', type: 'blocks' }, { task: 't-4', dependsOn: 't-2', type: 'blocks' }]).run();
    const tables = ['tasks', 'taskLinks', 'projects', 'projectMembers', 'agents', 'members'] as const;
    const schema = dataQueries(client, { tables, visibility: Object.fromEntries(tables.map(name => [name, () => sql`true`])) as QueryVisibility });
    const read = async (source: string, variableValues: Record<string, unknown> = {}) => {
      const result = await graphql({ schema, source, variableValues });
      expect(result.errors).toBeUndefined();
      return result.data as Record<string, any>;
    };
    const more = (await read(ticketMoreQuery, { id: 't-2' })).ticket;
    expect(more).toMatchObject({ id: 't-2', status: 'open', title: 'Second by position', description: 'Words', priority: 1, project: 'pond', createdAt: at, createdBy: 'sam', closedAt: null, closeReason: null });
    expect(more.taskLinksByTask).toEqual(expect.arrayContaining([{ dependsOn: 't-1', type: 'parent-child', dependsOnRow: { id: 't-1', title: 'Epic' } }, { dependsOn: 't-3', type: 'blocks', dependsOnRow: { id: 't-3', title: 'First by position' } }]));
    expect(more.taskLinksByDependsOn).toEqual([{ task: 't-4', type: 'blocks', taskRow: { id: 't-4', title: 'Most urgent' } }]);
    expect((await read(ticketMoreQuery, { id: 't-5' })).ticket).toMatchObject({ status: 'closed', closedAt: at, closeReason: 'Done with it' });
    expect((await read(ticketMoreQuery, { id: 't-404' })).ticket).toBeNull();
    expect((await read(ticketChoicesQuery)).tasks.map((t: { id: string }) => t.id)).toEqual(['t-5', 't-6', 't-4', 't-3', 't-2', 't-7', 't-1']);
    // The backlog: open tickets of the project by priority, then position, then id; closed and other projects' are not read.
    const backlog = await read(backlogQuery, { project: 'pond' });
    expect(backlog.project).toEqual({ id: 'pond', name: 'Pond' });
    expect(backlog.open.map((t: { id: string }) => t.id)).toEqual(['t-6', 't-4', 't-3', 't-2', 't-1']);
    expect(inBacklog(backlog.open, [{ id: 't-3' }]).map((t) => t.id)).toEqual(['t-4', 't-2', 't-1']);
    expect((await read(backlogQuery, { project: 'none' })).project).toBeNull();
    expect((await read(newTicketQuery, { id: 'pond' })).project).toMatchObject({ id: 'pond', name: 'Pond', lifecycle: 'active' });
    db.insert(s.projectMembers).values({ project: 'pond', member: 'sam' }).run();
    expect((await read(projectQuery, { id: 'pond' })).project).toEqual({ name: 'Pond', goal: null, lifecycle: 'active', projectMembersByProject: [{ member: 'sam' }] });
    expect((await read(workUnfiledQuery, { offset: 0 })).unfiled.map((t: { id: string }) => t.id)).toEqual(['t-7']);
    expect(await read(taskChoicesQuery)).toMatchObject({ projects: [{ id: 'pond', name: 'Pond', projectMembersByProject: [{ member: 'sam' }] }], agents: [{ id: 'art' }], members: [{ id: 'sam' }] });
  } finally { client.close(); }
});
