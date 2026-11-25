import { lazy } from 'react';

export const workApp = {
  id: 'work', title: 'Work', icon: 'folder-kanban', path: '/p/work',
  aliases: [
    {id:'tasks', path:'/p/tasks-preview', destination:'/p/work/backlog'},
    {id:'changes', path:'/p/changes-preview', destination:'/p/work/changes'},
  ],
  fit: { min: [480,320] as [number,number], ideal: 1040, max: null, big: true, why: 'project cards and a ticket overview' },
  Screen: lazy(() => import('./index')),
};
