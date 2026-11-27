import { z } from 'zod';
import { brick, ref } from './kit.js';

/** A ticket's priorities, 0 to 4 (src/apps/tasks.ts, `summary.priority`), as the words a detail may hold. The
 * suite holds them to that schema. */
export const ticketPriorities = ['0', '1', '2', '3', '4'] as const;

export default brick({ name: 'backlog', big: true, shows: "A project's open tickets that are in no lane, most urgent first. When big, a ticket's priority is set from it.",
  params: z.object({ project: ref }).strict(), references: { project: 'project' },
  actions: { priority: { operation: 'tasks.command', detail: z.object({ priority: z.enum(ticketPriorities) }).strict() } } });
