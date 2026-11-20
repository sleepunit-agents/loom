import {lazy} from 'react';

export const machinesApp = {
 id:'machines',title:'Machines and jobs',icon:'monitor',path:'/p/machines',
 fit:{min:[360,320] as [number,number],ideal:960,max:null,big:true,why:'machine readings, access and jobs'},
 Screen:lazy(()=>import('./index')),
};
