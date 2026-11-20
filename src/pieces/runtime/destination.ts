/** Immutable route/claim comparison data, never a bearer capability. */
import type {Db} from '../../core/index.js';
import type {RuntimeRecords} from './records.js';
import {runtimeStore} from './store.js';
export function runtimeDestination(db:Db,job:RuntimeRecords['job']):string {
 const binding=job.conversation?runtimeStore(db).read('binding',job.conversation):undefined;
 return JSON.stringify({job:job.id,agent:job.agent,member:job.member,project:job.project,
  service:job.service,conversation:job.conversation,runner:job.runner,box:job.box,
  claimedAt:job.claimedAt,made:job.made,
  binding:binding&&{id:binding.id,agent:binding.agent,member:binding.member,
   project:binding.project,venue:binding.venue,place:binding.place,job:binding.job}});
}
