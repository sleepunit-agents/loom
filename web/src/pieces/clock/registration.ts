import { lazy } from 'react';
export const clockApp = {
  id:'clock', title:'Clock', icon:'clock', path:'/p/clock-preview',
  fit:{min:[520,320] as [number,number],ideal:1040,max:null,big:true,why:'wakes, schedules and their details'},
  Screen:lazy(() => import('./index')),
};
