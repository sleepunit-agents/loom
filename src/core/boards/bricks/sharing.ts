import { z } from 'zod';
import { brick } from './kit.js';

// Who is on which project, for a household owner, read-only. A project's sharing is changed by a proposal the
// agent files, as on the desktop.
export default brick({ name: 'sharing', big: true,
  shows: 'Project sharing, for a household owner: every project with the members and agents on it, each a chip for the project, the person or the agent. When big, also each project\'s goal and its repositories, each a repository chip.',
  params: z.object({}).strict(), references: {}, actions: {} });
