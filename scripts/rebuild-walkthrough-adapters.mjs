/** Compose ports only in the disposable acceptance home. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {privateBytes} from '../dist/pieces/secrets/local-holder.js';
export function installWalkthroughAdapters(home){
 const programPath=join(home,'program.json'),bytes=privateBytes(programPath);
 let program;try{program=JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);}
 let base="const base=async()=>({});\n";
 if(program.adapters){privateBytes(program.adapters).fill(0);base='import base from '+JSON.stringify(pathToFileURL(program.adapters).href)+';\n';}
 const wrapper=join(home,'walkthrough-adapter.mjs');
 const holder=new URL('./rebuild-secret-holder.mjs',import.meta.url).href;
 writeFileSync(wrapper,base+'import holder from '+JSON.stringify(holder)+`;\nexport default async context=>{
 const original=await base(context);let extra;
 try{extra=await holder(context);}catch(error){await original.close?.();throw error;}
 return {...original,...extra,async close(){try{await extra.close?.();}finally{await original.close?.();}}};
};\n`,{mode:0o600,flag:'wx'});
 program.adapters=wrapper;writeFileSync(programPath,JSON.stringify(program),{mode:0o600});
}
