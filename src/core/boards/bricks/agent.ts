import { z } from 'zod';
import { brick, none, ref } from './kit.js';

// A running job is stopped as the session brick stops one, after asking. Nothing else about an agent is a member's to change here.
export default brick({ name: 'agent', big: true, flags: ['waiting on you'],
  shows: 'An agent: who it is, its state and its own report, what it is doing now, its running and recent jobs (each a session chip where it has a conversation; when big, its last thirty), its open tickets, and the way to its conversation.',
  params: z.object({ agent: ref }).strict(), references: { agent: 'agent' }, linkKey: 'agent',
  actions: { stop: { operation: 'runtime.jobStop', detail: none } } });
