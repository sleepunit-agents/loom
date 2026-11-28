import { z } from 'zod';
import { brick, change, none } from './kit.js';

// A merge is answered through its approval (approvals.answer, changes.answer), with that card's safeguards,
// on the desktop. The one action is the desktop's Refresh of Changes (changes.refresh), which reads every pull
// request loom follows again from GitHub; loom lets only a household owner do it, as on the desktop.
export default brick({ name: 'pull', big: true, flags: ['check failed', 'merged', 'closed'], shows: 'One pull request: state, checks, review, who it waits on, its tickets. Its id is github:owner/repo#number. When big, also when loom last read GitHub and, opened, its cold review history; a household owner can have loom read GitHub again.',
  params: z.object({ change }).strict(), references: { change: 'change' }, linkKey: 'change',
  actions: { refresh: { operation: 'changes.refresh', detail: none } } });
