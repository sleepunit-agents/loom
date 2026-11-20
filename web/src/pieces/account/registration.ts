import { lazy } from 'react';
export const accountApp={id:'account',title:'Your account',icon:'user',path:'/p/account-preview',fit:{min:[360,320] as [number,number],ideal:960,max:null,big:true,why:'your passkeys and signed-in browsers'},Screen:lazy(()=>import('./index'))};
