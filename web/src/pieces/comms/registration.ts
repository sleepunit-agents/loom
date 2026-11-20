import { lazy } from 'react';
export const commsApp={id:'comms',title:'Comms',icon:'message-circle',path:'/p/comms-preview',fit:{min:[390,320] as [number,number],ideal:1040,max:null,big:true,why:'thread list, messages and composer'},Screen:lazy(()=>import('./index'))};
