import { z } from 'zod';
import { brick, ref } from './kit.js';

export default brick({ name: 'trend', big: true, shows: 'Tickets opened and closed per day in a project.',
  params: z.object({ project: ref, days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30) }).strict(),
  references: { project: 'project' }, actions: {} });
