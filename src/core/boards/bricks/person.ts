import { z } from 'zod';
import { brick, person } from './kit.js';

export default brick({ name: 'person', big: true, shows: "A person: who they are, where they are reached, the agents that know them and, when big, those agents' notes the member may read, their projects and conversations. A member also has their open tickets.",
  params: z.object({ person }).strict(), references: { person: 'person' }, linkKey: 'person', actions: {} });
