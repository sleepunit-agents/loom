import { canHost } from './boxes.js';
import { configuredHouse, sameHouse } from './builds.js';
import { mayUseThread, type Sharing } from '../../core/index.js';
import type { RuntimeRecords } from './records.js';
import type { runtimeStore } from './store.js';
/** Derive control proof from runtime-owned linkage, never caller input. */
export function controlScope(store:ReturnType<typeof runtimeStore>, job:RuntimeRecords['job'], sharing:Sharing) {
 const binding=job.conversation?store.read('binding',job.conversation):undefined;
 const box=store.read('box',job.box),house=configuredHouse(store.read('settings',job.agent));
 const privateControl=!!box&&box.revokedAt===undefined&&canHost(box,job.agent,sharing)&&!!house
  &&(job.state==='queued'||sameHouse(job.made,house))&&!!job.member&&!!binding&&binding.venue==='loom'&&binding.job===job.id&&binding.member===job.member&&binding.agent===job.agent
  &&mayUseThread({kind:'member',id:job.member},{member:job.member,agent:job.agent},sharing);
 return {...job,type:'runtime.job',privateControl};
}
