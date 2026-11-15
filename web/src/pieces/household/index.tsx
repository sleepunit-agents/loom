import {useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {useDataQuery} from '../../data/graphql';
import {memberOperation} from '../../data/operation';
import {AppFrame,Button,Input,Empty,Error,Loading} from '../../kit';
import {setupQuery,type SetupAgent,type SetupData,type SetupMember} from './query';
function SaveForm({name,operation,id,read,children}:{name:string;operation:string;id:string;read:(form:FormData)=>object;children:ReactNode}){
 const busy=useRef(false),mounted=useRef(true),[state,setState]=useState<'idle'|'pending'|'saved'|'error'>('idle');
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy.current)return;
  const input=read(new FormData(event.currentTarget));busy.current=true;setState('pending');
  try{const saved=await memberOperation<{id:string}>(operation,input);if(mounted.current)setState(saved?.id===id?'saved':'error');}
  catch{if(mounted.current)setState('error');}finally{busy.current=false;}
 }
 return <form aria-label={name} onSubmit={submit} className="grid gap-3 rounded-xl border p-4"><fieldset disabled={state==='pending'} className="grid gap-3">{children}<Button type="submit" variant="outline">{name}</Button></fieldset>{state==='pending'&&<Loading label="Saving…"/>}{state==='saved'&&<p role="status">Saved</p>}{state==='error'&&<Error text="Could not confirm this change. Check current settings and try again."/>}</form>;
}
function MemberForm({member,agents}:{member:SetupMember;agents:SetupAgent[]}){
 const [role,setRole]=useState(member.role),[fullOwner,setFullOwner]=useState(member.fullOwner);
 return <SaveForm name={`Save membership for ${member.id}`} operation="household.setMember" id={member.id} read={form=>({id:member.id,role,fullOwner:role==='owner'&&fullOwner,agents:form.getAll('agents').map(String)})}>
  <h3 className="font-semibold">{member.id}</h3>
  <label className="grid gap-1">Household role<select value={role} onChange={event=>setRole(event.target.value as SetupMember['role'])}><option value="member">Member</option><option value="owner">Household owner</option></select></label>
  <label className="flex gap-2"><input type="checkbox" checked={role==='owner'&&fullOwner} disabled={role!=='owner'} onChange={event=>setFullOwner(event.target.checked)}/>Owns every agent, present and future</label>
  <fieldset className="grid gap-2"><legend>Selected agents</legend>{agents.map(agent=><label key={agent.id} className="flex gap-2"><input type="checkbox" name="agents" value={agent.id} defaultChecked={member.memberAgentsByMember.some(row=>row.agent===agent.id)}/>{agent.id}</label>)}</fieldset>
  <label className="flex gap-2"><input type="checkbox" required/>I confirm this membership change</label>
 </SaveForm>;
}
function AgentForm({agent}:{agent:SetupAgent}){
 return <SaveForm name={`Save agent ${agent.id}`} operation="household.setAgent" id={agent.id} read={form=>({id:agent.id,about:String(form.get('about')),markBg:String(form.get('markBg')),markFg:String(form.get('markFg')),faceShape:String(form.get('faceShape')),faceEyes:String(form.get('faceEyes'))})}>
  <h3 className="font-semibold">{agent.id}</h3>
  <label className="grid gap-1">Description<Input name="about" defaultValue={agent.about} maxLength={600}/></label>
  <label className="grid gap-1">Badge background<Input name="markBg" type="color" defaultValue={agent.markBg}/></label>
  <label className="grid gap-1">Badge foreground<Input name="markFg" type="color" defaultValue={agent.markFg}/></label>
  <label className="grid gap-1">Face shape<select name="faceShape" defaultValue={agent.faceShape}>{['pebble','trefoil','clover','drop'].map(value=><option key={value}>{value}</option>)}</select></label>
  <label className="grid gap-1">Eyes<select name="faceEyes" defaultValue={agent.faceEyes}><option>dot</option><option>oval</option></select></label>
 </SaveForm>;
}
export default function SetupApp({go=()=>{},active=true}:{path?:string;go?:(path:string)=>void;active?:boolean}={}){
 const reading=useDataQuery<SetupData>(setupQuery),data=reading.status==='live'?reading.data:undefined;
 // The generated members policy returns other people only to a current owner;
 // an ordinary member sees their own current non-owner row, an agent none.
 const owner=active&&data?.members.some(member=>member.role==='owner');
 return <AppFrame title="Household setup" where="Setup" go={go}>{reading.status==='loading'||reading.status==='live'&&!data?<Loading label="Opening household…"/>:reading.status!=='live'?<Error text="Household setup is unavailable. Reconnect to check current access."/>:!owner?<Empty title="Household owners manage setup" text="Ask a household owner to change membership or agent settings."/>:<div className="grid min-w-0 gap-6 overflow-auto p-4 sm:p-6">
  <section className="grid gap-4"><h2 className="text-xl font-semibold">Members</h2><p>Household owners manage membership. Owning every agent is a separate setting. At least one household owner must remain.</p>{data!.members.map(member=><MemberForm key={JSON.stringify(member)} member={member} agents={data!.agents}/>)}</section>
  <section className="grid gap-4"><h2 className="text-xl font-semibold">Agents</h2>{data!.agents.map(agent=><AgentForm key={JSON.stringify(agent)} agent={agent}/>)}</section>
  <nav aria-label="Related setup" className="flex flex-wrap gap-2"><Button variant="outline" onClick={()=>go('/p/people-preview')}>Open People</Button><Button variant="outline" onClick={()=>go('/p/sharing-preview')}>Open Project sharing</Button></nav>
 </div>}</AppFrame>;
}
