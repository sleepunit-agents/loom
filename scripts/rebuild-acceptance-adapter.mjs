/** Augment only the disposable browser home; preserve its existing startup ports. */
import {pathToFileURL} from 'node:url';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {privateBytes} from '../dist/pieces/secrets/local-holder.js';

export function prepareAcceptanceHome(home){
 const config=join(home,'program.json'),file=join(home,'walkthrough-adapter.mjs');
 const bytes=privateBytes(config);let program;
 try{program=JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);}
 const holder=new URL('./rebuild-secret-holder.mjs',import.meta.url).href;
 writeFileSync(file,'import {acceptanceAdapter} from '+JSON.stringify(import.meta.url)+';\nimport holder from '+JSON.stringify(holder)+';\nexport default acceptanceAdapter('+JSON.stringify(program.adapters??null)+',holder);\n',{mode:0o600,flag:'wx'});
 program.adapters=file;writeFileSync(config,JSON.stringify(program),{mode:0o600});
}

async function closePorts(acquired){
 const failures=[];
 for(const ports of [...acquired].reverse())try{await ports.close?.();}catch(error){failures.push(error);}
 if(failures.length)throw new AggregateError(failures,'Acceptance adapter cleanup failed');
}
function ports(value){
 if(!value||typeof value!=='object')throw new TypeError('Acceptance adapters must return startup ports');
 return value;
}
// The ports consumed by SharedStartupAdapters in src/shared-startup.ts.
const startupPorts=['changes','workAnswerAuthority','tempo','secretWrites','secretInputs','bridges','modelRoles','runtimeJobEnded'];
export function acceptanceAdapter(previousPath,additional){
 return async context=>{
  const acquired=[];
  try{
   let previous={};
   if(previousPath){
    // Keep the ordinary startup loader's private-file checks on the original.
    privateBytes(previousPath).fill(0);
    const module=await import(pathToFileURL(previousPath).href);
    if(typeof module.default!=='function')throw new TypeError('Existing acceptance adapter must export a factory');
    previous=ports(await module.default(context));
   }
   acquired.push(previous);
   const added=ports(await additional(context));acquired.push(added);
   let closing;
   const combined={};
   for(const key of startupPorts){const source=key in added?added:previous;if(key in source)combined[key]=Reflect.get(source,key,source);}
   return {...combined,close:()=>closing??=closePorts(acquired)};
  }catch(error){
   try{await closePorts(acquired);}catch(cleanup){throw new AggregateError([error,cleanup],'Acceptance adapter startup and cleanup failed');}
   throw error;
  }
 };
}
