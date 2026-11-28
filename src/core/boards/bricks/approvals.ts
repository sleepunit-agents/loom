import { z } from 'zod';
import { brick } from './kit.js';

// Read-only in every state: a request is answered in its approval brick, and a standing rule is made, changed or
// removed by asking the agent, as the desktop's rule editor opens a conversation.
export default brick({ name: 'approvals', big: true, flags: ['new approval'],
  shows: 'The approvals the member may read, in one of four states: the requests pending, those answered with their outcome, the standing rules (what is always asked, told after or just done, for what and whom), or the reported steps (what agents did under a "tell me after" rule, and answers given in a conversation). A request is answered in its approval brick; a rule is changed by asking the agent.',
  params: z.object({ state: z.enum(['pending', 'answered', 'rules', 'notices']).default('pending') }).strict(), references: {}, actions: {} });
