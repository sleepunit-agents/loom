import { z } from 'zod';
import { brick, change } from './kit.js';

// A merge is answered through its approval (approvals.answer, changes.answer), with that card's safeguards,
// on the desktop. This brick has no action.
export default brick({ name: 'pull', big: true, flags: ['check failed', 'merged', 'closed'], shows: 'One pull request: state, checks, review, who it waits on, its tickets. Its id is github:owner/repo#number.',
  params: z.object({ change }).strict(), references: { change: 'change' }, linkKey: 'change', actions: {} });
