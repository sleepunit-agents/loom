import { NativeSelect } from '../../kit/native-select';
import {useState} from 'react';
import {AppFrame,Empty,Error as ErrorView,Field,Loading,Section} from '../../kit';
import {useDataQuery} from '../../data/graphql';
import {AgentJobs} from '../attention/agent-jobs';
import {SignInWarning} from '../runtime/sign-in-warning';
import {OwnerMachines} from '../runtime/machines';

import {MachineHostingDetails} from '../runtime/machine-hosting';
import {machinesInventoryQuery as query, signInWarnings, type MachinesInventory as Inventory} from '../runtime/machines-query';

export default function Machines({go=()=>{},active=true}:{go?:(path:string)=>void;active?:boolean}){
 const feed=useDataQuery<Inventory>(query);
 const [choice,select]=useState('');
 const inventory=feed.status==='live'?feed.data:undefined;
 const agents=inventory?.agents.filter(a=>!a.removedAt)??[];
 const agent=agents.find(a=>a.id===choice)??agents[0];
 const member=inventory?.account?.member;
 const warnings=signInWarnings(inventory);
 const others=inventory?.boxes.filter(b=>b.owner!==member&&!b.revokedAt)??[];
 return <AppFrame title="Machines and jobs" where="System" go={go} filters={inventory && member && agent && <Field label="Jobs for"><NativeSelect value={agent.id} onChange={e=>select(e.target.value)}>
     {agents.map(a=><option key={a.id} value={a.id}>{a.id}</option>)}
    </NativeSelect></Field>}>
  <div className="grid min-w-0 content-start gap-4 overflow-auto p-5">
   {feed.status==='loading'?<Loading label="Opening machines…"/>:!inventory||!member?<ErrorView text="Machines are unavailable."/>:<>
    {active&&<OwnerMachines key={member} member={member} signInWarnings={warnings}/>}
    {!!others.length&&<Section label="Other visible machines"><ul>{others.map(box=><li key={box.id}><h3>{box.name}{warnings.has(box.id)&&<SignInWarning/>}</h3><MachineHostingDetails box={box}/></li>)}</ul></Section>}
    {!inventory.boxes.length&&<Empty title="No machines" text="No machines are visible to this account."/>}
    {agent&&<AgentJobs key={agent.id} agent={agent.id} name={agent.id}/>}
   </>}
  </div>
 </AppFrame>;
}
