import {lazy} from 'react';
export const projectsApp={id:'projects',title:'Projects',icon:'folder-kanban',path:'/p/projects-preview',fit:{min:[520,320] as [number,number],ideal:1120,max:null,big:true,why:'project cards and computed hubs'},Screen:lazy(()=>import('./index'))};
