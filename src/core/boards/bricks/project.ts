import { z } from 'zod';
import { brick, ref } from './kit.js';

export default brick({ name: 'project', big: true, shows: "A project: its goal, where it stands, the members and agents on it and, when big, what each agent calls it and its repositories.",
  params: z.object({ project: ref }).strict(), references: { project: 'project' }, linkKey: 'project', actions: {} });
