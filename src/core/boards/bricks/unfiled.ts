import { z } from 'zod';
import { brick, none } from './kit.js';

export default brick({ name: 'unfiled', big: true, shows: 'The tickets under no project. When big, one is filed into a project from it.',
  params: z.object({}).strict(), references: {},
  actions: { project: { operation: 'tasks.command', detail: none } } });
