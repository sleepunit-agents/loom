import { lazy } from 'react';
export const knowledgeApp = {
  id: 'knowledge', title: 'Knowledge', icon: 'book-open', path: '/p/knowledge-preview',
  fit: { min: [520,320] as [number,number], ideal: 1040, max: null, big: true, why: 'topics, pages and knowledge reader' },
  Screen: lazy(() => import('./index')),
};
