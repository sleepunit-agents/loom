/** Explicit in-process IPC fixture. Does not prove physical process isolation. */
import {EventEmitter} from 'node:events';
import type {Clock} from '../../src/core/clock.js';
import {runSharedHolder} from '../../src/shared-holder-program.js';
import {sharedHolderClient,type HolderChannel} from '../../src/shared-holder-channel.js';
export function holderChannelPair(){
 class Endpoint extends EventEmitter implements HolderChannel{
  connected=true;peer!:Endpoint;
  send(value:unknown,callback:(error:Error|null)=>void){
   if(!this.connected){callback(Error('Closed fixture channel'));return false;}
   const copy=structuredClone(value);queueMicrotask(()=>{if(this.connected&&this.peer.connected){this.peer.emit('message',copy);callback(null);}else callback(Error('Closed fixture channel'));});return true;
  }
  disconnect(){if(!this.connected)return;this.connected=false;this.peer.connected=false;this.emit('disconnect');this.peer.emit('disconnect');}
 }
 const parent=new Endpoint(),child=new Endpoint();parent.peer=child;child.peer=parent;return {parent,child};
}
export async function inProcessSharedHolder(directory:string,clock:Clock){
 const {parent,child}=holderChannelPair();
 const done=runSharedHolder(directory,child);void done.catch(()=>{});
 const client=sharedHolderClient(parent,clock),fingerprintKey=await client.ready;
 let closing:Promise<void>|undefined;
 return {...client,fingerprintKey,close(){return closing??=(async()=>{try{await client.close();await done;}finally{fingerprintKey.fill(0);child.disconnect();await done;}})();}};
}
