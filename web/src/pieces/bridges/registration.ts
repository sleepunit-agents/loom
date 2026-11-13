import { lazy } from 'react';
export const bridgesApp = {
  id: 'bridges', title: 'Bridges', icon: 'network', path: '/p/bridges-preview',
  fit: { min: [520, 320] as [number, number], ideal: 1040, max: null, big: true, why: 'connections, routes and held sends' },
  Screen: lazy(() => import('./index')),
};
