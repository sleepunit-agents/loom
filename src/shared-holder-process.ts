/** Default shared-program composition owns one original holder child. */
import {fork} from 'node:child_process';
import {isAbsolute} from 'node:path';
import type {Clock} from './core/clock.js';
import {sharedHolderClient,type HolderChannel} from './shared-holder-channel.js';
const failed=()=>new Error('Shared secret holder unavailable');
export async function startSharedHolder(directory:string,clock:Clock){
 if(!isAbsolute(directory)||directory.includes('\0'))throw failed();
 // A terminal interrupt belongs to Root first. Parent IPC loss still retires
 // this original child; detachment never permits adoption or reconnection.
 const child=fork(new URL('./shared-holder-program.js',import.meta.url),[directory],{execPath:process.execPath,execArgv:[],env:{},cwd:'/',detached:true,stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced'});
 let fingerprintKey:Uint8Array|undefined;
 let exited=false,fault=false,closing:Promise<void>|undefined,finish!:()=>void;
 const done=new Promise<void>(yes=>{finish=yes;});
 const client=sharedHolderClient(child as HolderChannel,clock);
 const lost=()=>{if(!closing){fault=true;void close().catch(()=>{});}};
 const error=()=>{fault=true;client.stop();void close().catch(()=>{});};
 child.once('close',(code,signal)=>{exited=true;if(code!==0||signal!==null||!closing)fault=true;client.stop();finish();if(!closing)void close().catch(()=>{});});
 child.on('disconnect',lost);child.on('error',error);
 function close(){return closing??=Promise.resolve().then(async()=>{
  // The original OS close event, not a protocol acknowledgment, proves exit.
  let cancelKill:()=>void=()=>{};
  const terminate=()=>{if(!exited)try{child.kill('SIGKILL');}catch{fault=true;}};
  cancelKill=clock.at(clock.now()+5000,terminate);
  try{if(fault)terminate();try{await client.close();}catch{fault=true;terminate();}await done;}
  finally{cancelKill();fingerprintKey?.fill(0);child.off('disconnect',lost);child.off('error',error);}
  if(fault)throw failed();
 });}
 try{
  fingerprintKey=await client.ready;
  if(exited||fault){fingerprintKey.fill(0);throw failed();}
  return {holder:client.holder,source:client.source,fingerprintKey,close};
 }catch{try{await close();}catch{}throw failed();}
}
