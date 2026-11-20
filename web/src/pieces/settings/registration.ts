import { lazy } from 'react';
export const settingsApp = {
  id:'settings',title:'Settings',icon:'settings',path:'/p/settings-preview',
  fit:{min:[520,320] as [number,number],ideal:1100,max:null,big:true,why:'secrets, grants and household piece settings'},
  Screen:lazy(()=>import('./index')),
};
