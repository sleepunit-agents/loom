import { lazy } from 'react';
export const sharingApp = {
  id: 'sharing', title: 'Project sharing', icon: 'users', path: '/p/sharing-preview',
  fit: { min: [520,320] as [number,number], ideal:1040, max:null, big:true, why:'projects and their members and agents' },
  Screen: lazy(() => import('./index')),
};
