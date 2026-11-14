/** Internal Comms metadata, not execution or parentage authority. Spawn transport
 * places remain Runtime's; Comms resolves its own independently owned thread.
 * Only an already owned thread is classified; this cannot bootstrap a spawn.
 * No ordinary conversation lookup is supplied until its audience proof exists. */
import { createHash, randomUUID } from 'node:crypto';
import { isClosing, type Foundation } from '../../core/app.js';
import { mayUseThread, type Sharing } from '../../core/index.js';
import { commsMetadata } from '../comms/role.js';
import type { StepConversation } from '../comms/conversation-steps.js';
import { runtimeStore } from './store.js';
export function spawnMetadata(app: Foundation, sharing:()=>Sharing): (id:string)=>StepConversation|undefined {
 const store=runtimeStore(app.db),epoch=randomUUID();let revision=0;
 // Comms owns its derived records and refreshes them on conversation changes.
 // Runtime owns this notification; Comms never reads Runtime tables.
 const stop=app.live.observe(changes=>{
  if(changes.some(c=>['runtime.binding','runtime.job','thread','core.access'].includes(c.type)))revision++;
  if(!isClosing(app)&&changes.some(c=>c.type==='runtime.binding'||c.type==='runtime.job'))
   app.live.changed([{type:'conversation',id:'runtime-spawns'}]);
 });
 app.onClose(stop);
 return id=>{
  try {
   if(isClosing(app))return;
   const binding=store.read('binding',id);
   if(!binding||binding.venue!=='spawn'||!binding.member||!binding.job)return;
   const job=store.read('job',binding.job);
   if(!job||job.conversation!==id||job.agent!==binding.agent||job.member!==binding.member||job.project!==binding.project
    ||!mayUseThread({kind:'member',id:binding.member},{agent:binding.agent,member:binding.member},sharing()))return;
   const owner=commsMetadata(app.operations)?.privateThread({kind:'member',id:binding.member},{id,agent:binding.agent,member:binding.member});
   if(!owner||owner.project!==binding.project)return;
   // Full records catch same-clock edits; the notification epoch also changes
   // on identical replacement and restarts, per the Comms version contract.
   const version=createHash('sha256').update(JSON.stringify([epoch,revision,binding,job,owner])).digest('hex');
   return {agent:binding.agent,member:binding.member,venue:'spawn',label:job.title,version};
  }catch{return;}
 };
}
