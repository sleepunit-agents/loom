import { lazy } from 'react';
export const setupApp = { id: 'setup', title: 'Household setup', icon: 'settings', path: '/p/setup-preview', fit: { min: [360, 320] as [number, number], ideal: 960, max: null, big: true, why: 'household members and agents' }, Screen: lazy(() => import('./index')) };
