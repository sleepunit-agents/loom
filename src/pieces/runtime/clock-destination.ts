/** Runtime metadata only, internal to the Clock composition. No operation accepts
 * a conversation or turns this witness into a body credential. */
import { isClosing, type Foundation } from '../../core/app.js';
import { mayFilePrivateWork, mayCreate, type Sharing } from '../../core/index.js';
import type { ClockDestinationReader } from '../clock/destination.js';
import { runtimeStore } from './store.js';
import { currentExecution } from './control.js';
import { bodyPolicyExecutionHeld } from './policy-store.js';
import { provenanceStore } from './provenance-store.js';
export function clockDestination(app: Foundation, sharing:()=>Sharing): ClockDestinationReader {
  const store=runtimeStore(app.db);
  return input=>{
    const resolve=()=>{
      if(isClosing(app)||!input.place.startsWith('lane:')||bodyPolicyExecutionHeld(app.db,input.agent))return;
      const matches=store.ids('binding').map(id=>store.read('binding',id)!)
        .filter(b=>b.venue==='wake'&&b.agent===input.agent&&b.place===input.place);
      // Ambiguous/conflicting bindings never select the first one's body.
      if(matches.length!==1)return;
      const binding=matches[0],job=binding.job?store.read('job',binding.job):undefined;
      if(binding.member!==input.member||binding.project!==input.project||!job||job.agent!==input.agent
        ||job.member!==input.member||job.project!==input.project||job.service!==input.service||job.conversation!==binding.id
        ||job.runner!==job.box||job.claimedAt===undefined
        ||job.imported||job.principalReset||job.writtenOff||job.endedAt!==undefined
        ||!['running','waiting'].includes(job.state)||!currentExecution(store,job,sharing())
        ||provenanceStore(app.db).read(binding.id)?.agent!==input.agent)return;
      const viewer={kind:'agent' as const,id:input.agent},access=sharing();
      if(input.member===undefined ? !mayCreate(viewer,{type:'wake',agent:input.agent,project:input.project},access)
        : !mayFilePrivateWork(viewer,{type:'wake',...input,privateControl:true},access))return;
      return {agent:binding.agent,member:binding.member,project:binding.project,conversation:binding.id,place:binding.place,service:job.service,job:job.id,runner:job.runner,box:job.box,claimedAt:job.claimedAt};
    };
    let before:ReturnType<typeof resolve>;
    try{before=resolve();}catch{return;}
    if(!before)return;
    const identity=JSON.stringify(before);
    const {agent,member,project,conversation,place,service}=before;
    const destination={agent,member,project,conversation,place,service};
    return Object.freeze({...destination,current(){try{return JSON.stringify(resolve())===identity;}catch{return false;}}});
  };
}
