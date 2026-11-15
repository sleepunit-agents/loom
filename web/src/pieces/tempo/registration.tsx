import { lazy } from 'react';
export const tempoApp = {
  id: 'tempo', title: 'Tempo', icon: 'clock', path: '/p/tempo',
  fit: { min: [520, 320] as [number, number], ideal: 1040, max: null, big: true, why: 'triggers and their history' },
  Screen: lazy(() => import('./screen')),
};
