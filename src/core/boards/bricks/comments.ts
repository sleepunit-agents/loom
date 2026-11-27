import { z } from 'zod';
import { brick, none, ticket } from './kit.js';

export default brick({ name: 'comments', big: true, flags: ['comment'], shows: "A ticket's comments, newest first.",
  params: z.object({ ticket }).strict(), references: { ticket: 'ticket' },
  actions: { comment: { operation: 'tasks.command', detail: none } } });
