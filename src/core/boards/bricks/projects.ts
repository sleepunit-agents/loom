import { z } from 'zod';
import { brick } from './kit.js';

// The project directory: every project the member may read, as the desktop's Work home lists them. What the member
// searches for is typed inside the drawn brick and is no parameter.
export default brick({ name: 'projects', big: true,
  shows: 'The projects the member may read, by name, each with where it stands and a chip that places its project brick. When big the member can search it by name and goal.',
  params: z.object({}).strict(), references: {}, actions: {} });
