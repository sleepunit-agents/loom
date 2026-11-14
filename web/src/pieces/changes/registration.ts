import { lazy } from 'react';
export const changesApp = {
 id:'changes',title:'Changes',icon:'git-pull-request',path:'/p/changes-preview',
 fit:{min:[520,320] as [number,number],ideal:1040,max:null,big:true,why:'projects, changes and a pull request reader'},
 Screen:lazy(()=>import('../../data/work-views').then(module=>({default:module.ChangesApp}))),
};
