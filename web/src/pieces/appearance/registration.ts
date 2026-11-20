import { lazy } from 'react';
export const appearanceApp = {
  id: 'appearance', title: 'Appearance', icon: 'palette', path: '/p/appearance',
  fit: { min: [360, 280] as [number, number], ideal: 560, max: 680, big: false, why: 'one column of your own settings' },
  Screen: lazy(() => import('./index')),
};
