import { z } from 'zod';
import { knowledgeLists, knowledgeTopicRef } from '../refs.js';
import { brick, none } from './kit.js';

// Knowledge's list. What the member searches for is typed inside the drawn brick and is no parameter.
export default brick({ name: 'knowledge', big: true,
  shows: 'The shared knowledge pages, each a chip for its page: all of them, those verified lately or those due a check, in one topic or in every topic. When big the member can search them and add a page.',
  params: z.object({ show: z.enum(knowledgeLists).default('all'), domain: z.string().regex(knowledgeTopicRef).optional() }).strict(),
  references: { domain: 'knowledge topic' }, actions: { add: { operation: 'mind.knowledgeAdd', detail: none } } });
