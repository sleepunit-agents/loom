/** Startup values enter only this receiving child's private native environment. */
import type {Clock} from '../core/clock.js';
import {privateSecretClient} from '../pieces/secrets/private-client.js';
import {isHouseSecretAlias} from '../pieces/secrets/input.js';
import {bodyInput,type BodyBootstrap} from './body-bootstrap.js';
import type {WorkerAssignment} from './worker.js';
import {harnessReservesEnv} from './body-harnesses.js';
const unavailable=()=>new Error('Startup secret environment unavailable');
/** The shortest startup secret value the body looks for in what it says. A shorter one (a flag, a region, a
 * port) is in ordinary sentences all the time, and looking for it would fail ordinary answers. */
export const STARTUP_SECRET_CHECKED=8;
/** Whether a text says none of these secret values. The one scan, by bytes, for everything a body says: its
 * answer and every text of every tool call (body-secret-tools.ts), for the secrets it used and the ones it
 * was started with. Whoever holds a value gives it in each form it is looked for in (raw, and base64). */
export function saysNoSecret(text:string,values:readonly Buffer[]):boolean{
 const bytes=Buffer.from(text);try{return !values.some(value=>value.length>0&&bytes.includes(value));}finally{bytes.fill(0);}
}
// What no startup secret may be called on any body is said once, in isHouseSecretAlias. A body adds what only
// it can know: the names that sign its harness in to its account, and the ones the harness's adapter sets
// for its child (each harness lists its own, and only the harness this job runs on is asked), and below,
// any name its own environment already has.
export function bodyStartupSecrets(environment:NodeJS.ProcessEnv,options:{fetch?:typeof fetch;clock?:Clock}={}){
 let closed=false,started=false,active:ReturnType<typeof privateSecretClient>|undefined,unlisten:(()=>void)|undefined;
 const inserted:string[]=[],kept:Buffer[]=[];
 const remove=()=>{for(const name of inserted.splice(0))delete environment[name];};
 const close=()=>{closed=true;active?.close();unlisten?.();unlisten=undefined;remove();for(const value of kept.splice(0))value.fill(0);};
 /** The values this body was started with, for the checks that no secret is said (body-secret-tools.ts): each
  * as its bytes and as their base64, the two forms a used secret is looked for in. One shorter than
  * STARTUP_SECRET_CHECKED bytes is left out: it cannot be told from ordinary words. */
 const values=():readonly Buffer[]=>kept;
 const allowsReply=(text:string)=>saysNoSecret(text,kept);
 return {close,values,allowsReply,async startup(job:WorkerAssignment,bootstrap:BodyBootstrap,signal:AbortSignal){
  if(closed||started||signal.aborted)throw unavailable();started=true;
  let aliases:Map<string,Buffer>|undefined;
  try{
   const checked=bodyInput(job,'startup',bootstrap,true).bootstrap;if(!checked)throw unavailable();
   signal.addEventListener('abort',close,{once:true});unlisten=()=>signal.removeEventListener('abort',close);
   active=privateSecretClient({url:checked.origin,token:checked.token,signal,fetch:options.fetch,clock:options.clock});
   aliases=await active.startup();
   const values:[string,string][]=[];
   for(const [name,bytes] of aliases){
    if(!isHouseSecretAlias(name)||Object.hasOwn(environment,name)||harnessReservesEnv(job.harness,name.toUpperCase(),environment))throw unavailable();
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(text.includes('\0'))throw unavailable();
    values.push([name,text]);
   }
   if(closed||signal.aborted)throw unavailable();
   // Validate the entire batch before modifying launch input. Existing account
   // and execution settings remain selected by the explicit worker config.
   for(const [name,text] of values){Object.defineProperty(environment,name,{value:text,writable:true,enumerable:true,configurable:true});inserted.push(name);if(Buffer.byteLength(text)>=STARTUP_SECRET_CHECKED)kept.push(Buffer.from(text),Buffer.from(Buffer.from(text).toString('base64')));}
  }catch{remove();throw unavailable();}
  finally{for(const bytes of aliases?.values()??[])bytes.fill(0);aliases?.clear();active?.close();active=undefined;}
 }};
}
