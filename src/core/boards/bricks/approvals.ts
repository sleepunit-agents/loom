import { z } from 'zod';
import { brick } from './kit.js';

export default brick({ name: 'approvals', big: true, flags: ['new approval'],
  shows: 'The list of approval requests the member may read: those pending, or those answered with their outcome. A request is answered in its approval brick.',
  params: z.object({ state: z.enum(['pending', 'answered']).default('pending') }).strict(), references: {}, actions: {} });
