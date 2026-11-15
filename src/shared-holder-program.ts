#!/usr/bin/env node
/** Fixed package entrypoint: an inherited channel is its only caller. */
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateBytes} from './pieces/secrets/local-holder.js';
import {openSharedHolderStorage} from './shared-holder-storage.js';
import {serveSharedHolderChannel,type HolderChannel} from './shared-holder-channel.js';
export async function runSharedHolder(directory:string,channel:HolderChannel){
 if(!channel.connected||!channel.send)throw Error('Shared secret holder unavailable');
 const handle=serveSharedHolderChannel(channel,async()=>{
  const store=await openSharedHolderStorage(directory);
  try{return {store,key:privateBytes(join(directory,'daemon-fingerprint.key'),32)};}catch(error){store.close();throw error;}
 });
 // The inherited owner channel is the sole orderly shutdown path. An OS
 // signal is a process fault, observed and joined by the original supervisor.
 try{await handle.done;}finally{await handle.close();}
}
let entry=false;try{entry=!!process.argv[1]&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url));}catch{}
if(entry){try{if(process.argv.length!==3)throw Error();await runSharedHolder(process.argv[2],process as unknown as HolderChannel);}catch{process.exitCode=2;}}
