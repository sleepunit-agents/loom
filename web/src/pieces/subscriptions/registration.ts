import { lazy } from 'react';

export const subscriptionsApp = {
  id: 'subscriptions', title: 'Subscriptions', icon: 'activity', path: '/p/subscriptions',
  fit: { min: [360, 320] as [number, number], ideal: 960, max: null, big: true, why: 'model usage and machine sign-ins' },
  Screen: lazy(() => import('./index')),
};
