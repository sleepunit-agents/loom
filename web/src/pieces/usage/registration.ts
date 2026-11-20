import {lazy} from 'react';
export const usageApp={id:'usage',title:'Job usage',icon:'activity',path:'/p/usage',fit:{min:[520,320] as [number,number],ideal:1120,max:null,big:true,why:'conversation usage and jobs'},Screen:lazy(()=>import('./index'))};
