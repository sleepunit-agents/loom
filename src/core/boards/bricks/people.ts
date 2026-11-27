import { z } from 'zod';
import { peopleFolders } from '../refs.js';
import { brick, none } from './kit.js';

// People's directory. What the member searches for is typed inside the drawn brick and is no parameter.
export default brick({ name: 'people', big: true,
  shows: 'The directory of people and agents the member may read, each a chip for its person or agent: everyone, only people or only agents. When big the member can search it and add a person.',
  params: z.object({ folder: z.enum(peopleFolders).default('all') }).strict(), references: {},
  actions: { add: { operation: 'mind.personAdd', detail: none } } });
