import { lazy } from 'react';
export const approvalsApp = {
  id: 'approvals', title: 'Approvals', icon: 'shield-check', path: '/p/approvals-preview',
  fit: { min: [520,320] as [number,number], ideal:1040, max:null, big:true, why:'pending questions, history and household rules' },
  Screen: lazy(() => import('./index')),
};
