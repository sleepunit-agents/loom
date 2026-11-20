import { lazy } from 'react';
export const inboxApp = {
  id: 'inbox', title: 'Inbox', icon: 'inbox', path: '/p/inbox-preview',
  fit: { min: [520,320] as [number,number], ideal:1040, max:null, big:true, why:'asks, agent folders and the full question' },
  Screen: lazy(() => import('./index')),
};
