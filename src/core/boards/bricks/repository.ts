import { z } from 'zod';
import { brick, ref } from './kit.js';

export default brick({ name: 'repository', big: true, shows: 'A repository and its pull requests, in one project or across all.',
  params: z.object({ repository: ref, project: ref.optional() }).strict(),
  references: { repository: 'repository', project: 'project' }, linkKey: 'repository', actions: {} });
