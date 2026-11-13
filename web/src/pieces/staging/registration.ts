import { lazy } from 'react';
export const stagingApp = {
  id:'staging',title:'Held work',icon:'pause',path:'/p/staging',
  fit:{min:[360,280] as [number,number],ideal:720,max:900,big:false,why:'a list of held outside work'},
  Screen:lazy(()=>import('./index')),
};
