import {lazy} from 'react';
export const activityApp={id:'activity',title:'Activity',icon:'activity',path:'/p/activity-preview',fit:{min:[520,320] as [number,number],ideal:1120,max:null,big:true,why:'household activity timeline and reader'},Screen:lazy(()=>import('./index'))};
