import { z } from 'zod';
import { knowledgeAnnotations, knowledgePageRef } from '../refs.js';
import { brick, none } from './kit.js';

// What Knowledge's reader offers a member on one page. An annotation's words go to mind.knowledgeAnnotate and
// never to the board; the board is told which kind was chosen.
export default brick({ name: 'knowledge-page', big: true,
  shows: 'One shared knowledge page: its title, topic, words, sources, when it was last checked and whether it is due a check. Its id is the page slug knowledge_recall gives.',
  params: z.object({ page: z.string().regex(knowledgePageRef) }).strict(), references: { page: 'knowledge page' }, linkKey: 'page',
  actions: {
    verify: { operation: 'mind.knowledgeVerify', detail: none },
    recheck: { operation: 'mind.knowledgeRecheck', detail: none },
    annotate: { operation: 'mind.knowledgeAnnotate', detail: z.object({ kind: z.enum(knowledgeAnnotations) }).strict() },
  } });
