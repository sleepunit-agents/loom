import { lazy } from 'react';
/** The piece declares its app; shells consume the registration without knowing its domain. */
export const tasksApp = {
  id: 'tasks', title: 'Tasks', icon: 'list-checks', path: '/_dev/tasks-preview',
  fit: { min: [520,320] as [number,number], ideal:1040, max:null, big:true, why:'folders, work list and task reader' },
  Screen: lazy(() => import('./index')),
};
