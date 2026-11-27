import { z } from 'zod';
import { brick, none, ref } from './kit.js';

// One piece of agent work with its own conversation: what the agent handed off, or other work the member may read.
export default brick({ name: 'session', big: true, flags: ['finished', 'failed', 'stopped'],
  shows: 'A session of agent work: what it was asked, where it stands, what it has used and, when big, the steps it reports as it works. Its conversation id is what conversation.handoff returns.',
  params: z.object({ session: ref }).strict(), references: { session: 'session' }, linkKey: 'session',
  actions: { stop: { operation: 'runtime.jobStop', detail: none } } });
