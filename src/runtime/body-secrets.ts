/** Startup values enter only this receiving child's private native environment. */
import type {Clock} from '../core/clock.js';
import {privateSecretClient} from '../pieces/secrets/private-client.js';
import {bodyInput,type BodyBootstrap} from './body-bootstrap.js';
import type {WorkerAssignment} from './worker.js';
const unavailable=()=>new Error('Startup secret environment unavailable');
const controls=new Set(['PATH','HOME','SHELL','ENV','BASH_ENV','XDG_CONFIG_HOME','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR']);
function reserved(name:string,env:NodeJS.ProcessEnv){
 const key=name.toUpperCase();
 return controls.has(key)||/^(?:CLAUDE_|ANTHROPIC_|CODEX_|OPENAI_|NODE_|LD_|DYLD_)/.test(key)
  ||!!env.CLAUDE_CODE_USE_BEDROCK&&/^AWS_/.test(key)
  ||!!env.CLAUDE_CODE_USE_VERTEX&&/^(?:GOOGLE_|GCLOUD_)/.test(key)
  ||!!env.CLAUDE_CODE_USE_FOUNDRY&&/^AZURE_/.test(key);
}
export function bodyStartupSecrets(environment:NodeJS.ProcessEnv,options:{fetch?:typeof fetch;clock?:Clock}={}){
 let closed=false,started=false,active:ReturnType<typeof privateSecretClient>|undefined,unlisten:(()=>void)|undefined;
 const inserted:string[]=[];
 const remove=()=>{for(const name of inserted.splice(0))delete environment[name];};
 const close=()=>{closed=true;active?.close();unlisten?.();unlisten=undefined;remove();};
 return {close,async startup(job:WorkerAssignment,bootstrap:BodyBootstrap,signal:AbortSignal){
  if(closed||started||signal.aborted)throw unavailable();started=true;
  let aliases:Map<string,Buffer>|undefined;
  try{
   const checked=bodyInput(job,'startup',bootstrap,true).bootstrap;if(!checked)throw unavailable();
   signal.addEventListener('abort',close,{once:true});unlisten=()=>signal.removeEventListener('abort',close);
   active=privateSecretClient({url:checked.origin,token:checked.token,signal,fetch:options.fetch,clock:options.clock});
   aliases=await active.startup();
   const values:[string,string][]=[];
   for(const [name,bytes] of aliases){
    if(!/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(name)||Object.hasOwn(environment,name)||reserved(name,environment))throw unavailable();
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(text.includes('\0'))throw unavailable();
    values.push([name,text]);
   }
   if(closed||signal.aborted)throw unavailable();
   // Validate the entire batch before modifying launch input. Existing account
   // and execution settings remain selected by the explicit worker config.
   for(const [name,text] of values){Object.defineProperty(environment,name,{value:text,writable:true,enumerable:true,configurable:true});inserted.push(name);}
  }catch{remove();throw unavailable();}
  finally{for(const bytes of aliases?.values()??[])bytes.fill(0);aliases?.clear();active?.close();active=undefined;}
 }};
}
