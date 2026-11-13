import { lazy } from 'react';
export const peopleApp = {
  id:'people',title:'People',icon:'users',path:'/p/people-preview',
  fit:{min:[520,320] as [number,number],ideal:1040,max:null,big:true,why:'directory, relationships and contact reader'},
  Screen:lazy(()=>import('./index')),
};
