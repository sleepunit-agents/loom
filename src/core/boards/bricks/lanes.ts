import { z } from 'zod';
import { brick, none, ref } from './kit.js';

export default brick({ name: 'lanes', big: true, shows: "A project's active tickets in lanes: working, verifying, waiting, each with who has it, its priority and why it waits. When big, how many questions wait on the member and whether each agent takes new tickets there.",
  params: z.object({ project: ref }).strict(), references: { project: 'project' },
  // The desktop's pause and resume of an agent's new claims in the project. Which agent is not told.
  actions: { pause: { operation: 'work.setProjectClaims', detail: none }, resume: { operation: 'work.setProjectClaims', detail: none } } });
