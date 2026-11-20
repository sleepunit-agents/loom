import {useState} from 'react';
import {AppFrame,Empty,Error as ErrorView,Field,Loading,Section} from '../../kit';
import {useDataQuery} from '../../data/graphql';
import {AgentJobs} from '../attention/agent-jobs';
import {OwnerMachines} from '../runtime/machines';

const query='{ account { member } agents { id removedAt } boxes { id name owner revokedAt } }';
type Inventory={
 account:{member:string}|null;
 agents:{id:string;removedAt:string|null}[];
 boxes:{id:string;name:string;owner:string;revokedAt:string|null}[];
};

export default function Machines({go=()=>{},active=true}:{go?:(path:string)=>void;active?:boolean}){
 const feed=useDataQuery<Inventory>(query);
 const [choice,select]=useState('');
 const inventory=feed.status==='live'?feed.data:undefined;
 const agents=inventory?.agents.filter(a=>!a.removedAt)??[];
 const agent=agents.find(a=>a.id===choice)??agents[0];
 const member=inventory?.account?.member;
 const others=inventory?.boxes.filter(b=>b.owner!==member&&!b.revokedAt)??[];
 return <AppFrame title="Machines and jobs" where="System" go={go}>
  <div className="grid min-w-0 content-start gap-4 overflow-auto p-5">
   {feed.status==='loading'?<Loading label="Opening machines…"/>:!inventory||!member?<ErrorView text="Machines are unavailable."/>:<>
    {active&&<OwnerMachines key={member} member={member}/>}
    {!!others.length&&<Section label="Other visible machines"><ul>{others.map(box=><li key={box.id}>{box.name}</li>)}</ul></Section>}
    {!inventory.boxes.length&&<Empty title="No machines" text="No machines are visible to this account."/>}
    {agent&&<><Field label="Jobs for"><select value={agent.id} onChange={e=>select(e.target.value)}>
     {agents.map(a=><option key={a.id} value={a.id}>{a.id}</option>)}
    </select></Field><AgentJobs key={agent.id} agent={agent.id} name={agent.id}/></>}
   </>}
  </div>
 </AppFrame>;
}
