import { z } from 'zod';
import { brick, none } from './kit.js';

// The machine opened inside the drawn brick is the page's own state and no parameter. Enrolling a machine ends in
// a credential and the desktop offers neither that nor revoking one, so neither is an action here.
export default brick({ name: 'machines', big: true,
  shows: 'The machines the member may read: each one\'s name, whether it is the loom machine, when it was last seen, its slots, what it hosts, what its worker last read on it and any open alert. When big the member opens one machine: the jobs on it now (each a session chip where the job has a conversation), who may read it, with requests to grant or revoke a read and their answers, its read history, and the household\'s alert lines.',
  params: z.object({}).strict(), references: {},
  actions: {
    proposeReader: { operation: 'machine.proposeReader', detail: z.object({ allow: z.enum(['yes', 'no']) }).strict() },
    answerReader: { operation: 'machine.answerReader', detail: z.object({ answer: z.enum(['allow', 'deny']) }).strict() },
    setAlertLines: { operation: 'machine.setAlertLines', detail: none },
  } });
