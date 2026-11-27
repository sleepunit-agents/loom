import { z } from 'zod';
import { taskLinkType } from '../../../apps/tasks.js';
import { brick, none, ticket } from './kit.js';

export default brick({ name: 'ticket', big: true, flags: ['closed', 'reopened'], shows: 'One ticket: goal, why, done when, status, priority, who has it, who filed it, its links to other tickets and, when big, its edit and link forms and the sessions handed off for it (those whose conversation.handoff named it in tickets).',
  params: z.object({ ticket }).strict(), references: { ticket: 'ticket' }, linkKey: 'ticket',
  // What tasks.command offers a member on one ticket. A close takes a reason in words; the words go to the
  // ticket and never to the board, so every detail here is empty.
  actions: {
    claim: { operation: 'tasks.command', detail: none },
    unclaim: { operation: 'tasks.command', detail: none },
    close: { operation: 'tasks.command', detail: none },
    reopen: { operation: 'tasks.command', detail: none },
    // The desktop's Edit, Parent and Blocked by forms. What was typed goes to the ticket; a link says only its kind.
    edit: { operation: 'tasks.command', detail: none },
    link: { operation: 'tasks.command', detail: z.object({ type: taskLinkType }).strict() },
    unlink: { operation: 'tasks.command', detail: z.object({ type: taskLinkType }).strict() },
  } });
