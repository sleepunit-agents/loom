import { z } from 'zod';
import { brick, none, ref } from './kit.js';

// Work, written from the board. Each sends the desktop's own tasks.command; what was typed goes to the ticket.
export default brick({ name: 'new-ticket', big: true, shows: 'A form to file a new ticket in a project.',
  params: z.object({ project: ref }).strict(), references: { project: 'project' },
  actions: { create: { operation: 'tasks.command', detail: none } } });
