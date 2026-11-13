import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { call, useRecords, type Call } from '../../data';
import { Split, List, Row, Empty, Error, Loading, Button, Input, Textarea } from '../../kit';
import { activeGrant, revokeInput, warnings, type SettingsAccess, type SecretName, type Grant, type Request, type Policy, type Use, type Change } from './model';
const idle={pending:false,status:'done' as const},noop=()=>()=>{};
const date=(at?:number)=>at===undefined?'No expiry':new Date(at).toLocaleString();
function useWrite() {
  const [request,setRequest]=useState<Call>();
  const state=useSyncExternalStore(request?.subscribe??noop,request?.getSnapshot??(()=>idle));
  // An unavailable answer may mean the holder committed. Retry the same input/id.
  const uncertain=state.result?.ok===false&&state.result.code==='unavailable';
  return {state,blocked:state.pending||uncertain,send:(name:string,input:unknown)=>setRequest(call(name,input)),
    feedback:<>{state.pending&&<Loading label={state.status==='offline'?'Waiting for connection…':'Saving…'}/>}{state.result&&(state.result.ok?<p role="status">Saved</p>:<><Error text={`${state.result.code}: ${state.result.message}`}/>{uncertain&&<Button onClick={()=>request?.retry?.()}>Retry this save</Button>}</>)}</>};
}
/** Credential input is uncontrolled, cleared before dispatch, never a draft or a
 * record. Only the shared in-memory call keeps its exact wire for uncertain retries. */
export function ValueForm({name,enabled,replace=false}:{name?:string;enabled:boolean;replace?:boolean}) {
  const write=useWrite(),form=useRef<HTMLFormElement>(null);
  useEffect(()=>{if(!enabled)form.current?.reset();},[enabled]);
  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(!enabled||write.blocked)return;
    const target=event.currentTarget,data=new FormData(target);
    const input={name:name??String(data.get('name')),value:String(data.get('value')),mode:replace?'replace':'add',writeId:crypto.randomUUID()};
    target.reset();write.send('secrets.set',input);
  }
  return <form ref={form} aria-label={replace?'Replace secret':'Add secret'} onSubmit={submit} className="grid gap-3">
    <h2>{replace?`Replace ${name}`:'Add a secret'}</h2><p>The value is write-only. It cannot be read back here.</p>
    {!enabled&&<p>The key holder write connection is unavailable.</p>}
    <fieldset disabled={!enabled||write.blocked} className="grid gap-3">
      {!name&&<label>Name<Input name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" maxLength={64}/></label>}
      <label>New value<Input name="value" type="password" autoComplete="new-password" required/></label>
      <Button type="submit">{replace?'Save replacement':'Save secret'}</Button>
    </fieldset>{write.feedback}
  </form>;
}
function RequestActions({request,enabled}:{request:Request;enabled:boolean}) {
  const write=useWrite();
  return <section className="grid gap-3"><h2>{request.agent} asks for {request.target}</h2><p>{request.why}</p>
    <p>{request.kind} · {request.scope?.house??'No house'}{request.scope?.service&&` · ${request.scope.service}`} · {request.minutes??'Default'} minutes · {request.state}</p>
    {request.state==='pending'&&<div className="flex flex-wrap gap-2"><Button disabled={!enabled||write.blocked} onClick={()=>write.send('secrets.answer',{id:request.id,allow:true})}>Allow once</Button>
      {request.kind==='secret'&&<Button disabled={!enabled||write.blocked} onClick={()=>write.send('secrets.answer',{id:request.id,allow:true,always:true})}>Always allow</Button>}
      <Button disabled={!enabled||write.blocked} onClick={()=>write.send('secrets.answer',{id:request.id,allow:false})}>Deny</Button></div>}{write.feedback}</section>;
}
function GrantForm({agent,enabled}:{agent:string;enabled:boolean}) {
  const write=useWrite();
  return <form aria-label="Grant access" className="grid gap-3" onSubmit={e=>{e.preventDefault();if(!enabled||write.blocked)return;const f=new FormData(e.currentTarget),expires=String(f.get('expires'));
    write.send('secrets.grant',{agent,kind:f.get('kind'),target:f.get('target'),...(expires?{expiresAt:Date.parse(expires)}:{})});}}>
    <h2>Give {agent} access</h2><fieldset disabled={!enabled||write.blocked} className="grid gap-3"><label>Resource kind<select name="kind">{['secret','piece','runner','tailnet'].map(k=><option key={k}>{k}</option>)}</select></label>
      <label>Resource name<Input name="target" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"/></label><label>Expires at (optional)<Input name="expires" type="datetime-local"/></label><Button type="submit">Grant access</Button></fieldset>{write.feedback}</form>;
}
function GrantRow({grant,enabled,now}:{grant:Grant;enabled:boolean;now:number}) {
  const write=useWrite();
  const service=grant.agent.startsWith('service:');
  return <section className="grid gap-2 border-t py-3"><h3>{grant.kind}: {grant.target}</h3><p>{activeGrant(grant,now)?'Granted':grant.movedTo?'Moved to another house':'Expired'} · {date(grant.expiresAt)}</p>
    {grant.scope&&<p>{grant.scope.house}{grant.scope.service&&` · ${grant.scope.service}`}</p>}
    <Button disabled={!enabled||write.blocked} onClick={()=>write.send(service?'secrets.revokeService':'secrets.revoke',service?{service:grant.agent.slice(8),name:grant.target}:revokeInput(grant))}>Revoke {grant.target}</Button>{write.feedback}</section>;
}
function SecretReader({name,policy,agents,grants,uses,changes,enabled,values,now}:{name:SecretName;policy:Policy;agents:string[];grants:readonly Grant[];uses:readonly Use[];changes:readonly Change[];enabled:boolean;values:boolean;now:number}) {
  const write=useWrite(),[removing,setRemoving]=useState(false);
  const rule=policy.secrets[name.id];
  return <article className="grid gap-5 p-5"><header><h1 className="text-2xl font-semibold">{name.id}</h1><p>{name.description}</p></header>
    <form aria-label="Describe secret" className="grid gap-3" onSubmit={e=>{e.preventDefault();if(enabled&&!write.blocked)write.send('secrets.describe',{name:name.id,description:String(new FormData(e.currentTarget).get('description'))});}}><label>Description<Textarea key={name.description} name="description" defaultValue={name.description} maxLength={2000} disabled={!enabled||write.blocked}/></label><Button disabled={!enabled||write.blocked}>Save description</Button></form>
    <section><h2>Who may use it</h2>{grants.filter(g=>g.kind==='secret'&&g.target===name.id).map(g=><p key={g.id}>{g.agent} · {activeGrant(g,now)?'Granted':'Expired or moved'} · {g.scope?.house??'All houses'} · {date(g.expiresAt)}</p>)}
      <p>Request policy: {rule?.grant??policy.default}. Requests last at most {rule?.minutes??60} minutes.</p>
      <p>At startup: {rule?.houses?.join(', ')||'No agents'}</p>
      <div className="grid gap-2">{agents.map(agent=><label className="flex gap-2" key={agent}><input type="checkbox" checked={rule?.grant==='auto'&&!!rule.agents?.includes(agent)} disabled={!enabled||write.blocked||rule?.grant==='never'} onChange={e=>write.send('secrets.always',{name:name.id,agent,on:e.target.checked})}/>Always allow {agent} when asked</label>)}</div>
    </section>
    <section><h2>Recorded use</h2>{uses.filter(u=>u.name===name.id).length?uses.filter(u=>u.name===name.id).slice().sort((a,b)=>b.at-a.at).slice(0,30).map(u=><p key={u.id}>{date(u.at)} · {u.by.id} · {u.state==='released'?'Delivered':u.state==='failed'?'Failed':'Delivery unconfirmed'}</p>):<p>No recorded use.</p>}</section>
    <section><h2>Changes</h2>{changes.filter(c=>c.name===name.id).slice().sort((a,b)=>b.at-a.at).map(c=><p key={c.id}>{date(c.at)} · {c.action} · {c.by}</p>)}</section>
    <ValueForm key={name.id} name={name.id} enabled={enabled&&values} replace/>
    <section><h2>Remove secret</h2>{removing?<div><p>Remove {name.id} and revoke its future access?</p><Button disabled={!enabled||!values||write.blocked} onClick={()=>write.send('secrets.remove',{name:name.id,writeId:crypto.randomUUID()})}>Confirm removal</Button><Button onClick={()=>setRemoving(false)}>Cancel removal</Button></div>:<Button disabled={!enabled||!values||write.blocked} onClick={()=>setRemoving(true)}>Remove {name.id}</Button>}</section>{write.feedback}
  </article>;
}
const pieces=[['Sharing','/p/sharing-preview','Project membership'],['Approvals','/p/approvals-preview','Standing approval rules'],['Clock','/p/clock-preview','Schedules and wakes'],['Bridges','/p/bridges-preview','Venues, routes and identities']];
export default function SettingsApp({path:shellPath,go}:{path?:string;go?:(path:string)=>void}={}) {
  const base='/p/settings-preview',[local,setLocal]=useState(()=>typeof location==='undefined'?base:location.pathname),path=shellPath??local;
  const parts=path.slice(base.length).split('/');let id:string|undefined;try{id=parts[2]?decodeURIComponent(parts[2]):undefined;}catch{/* malformed link */}
  const [folder,setFolder]=useState(parts[1]||'secrets'),[query,setQuery]=useState('');
  const view=parts[1]||folder;
  const navigate=(folder:string,id?:string)=>{setFolder(folder);const next=`${base}/${folder}${id?`/${encodeURIComponent(id)}`:''}`;if(go)go(next);else{history.pushState(null,'',next);setLocal(next);}};
  useEffect(()=>{if(go)return;const pop=()=>setLocal(location.pathname);window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[go]);
  const access=useRecords<SettingsAccess>('secret.settings'),names=useRecords<SecretName>('secret.name'),grants=useRecords<Grant>('secret.grant'),requests=useRecords<Request>('secret.request'),policies=useRecords<Policy>('secret.policy'),uses=useRecords<Use>('secret.use'),changes=useRecords<Change>('secret.change');
  const feeds=[access,names,grants,requests,policies,uses,changes],ready=feeds.every(s=>s.status==='live'),permission=access.records[0];
  if(feeds.some(s=>s.status==='loading'))return <Loading label="Opening Settings…"/>;
  if(!ready)return <Error text="Settings is unavailable. Reconnect to continue."/>;
  if(!permission)return <Empty title="Household owners manage Settings" text="An owner manages secrets and grants for the household."/>;
  const policy=policies.records[0];if(!policy)return <Error text="Secret policy is unavailable."/>;
  const selected=names.records.find(n=>n.id===id),request=requests.records.find(r=>r.id===id);
  const principals=[...new Set([...permission.agents,...grants.records.map(g=>g.agent)])].sort();
  const pending=requests.records.filter(r=>r.state==='pending');
  const missing=Object.keys(policy.secrets).filter(name=>!names.records.some(n=>n.id===name)&&(policy.secrets[name].houses?.length||policy.secrets[name].agents?.length));
  let list;
  if(view==='grants')list=<List label="Agents and services">{principals.filter(a=>a.includes(query)).map(a=><Row key={a} title={a} meta={`${grants.records.filter(g=>g.agent===a).length} grants`} selected={a===id} onClick={()=>navigate('grants',a)}/>)}</List>;
  else if(view==='requests')list=<List label="Secret requests">{requests.records.filter(r=>`${r.agent} ${r.target}`.toLowerCase().includes(query.toLowerCase())).map(r=><Row key={r.id} title={`${r.agent}: ${r.target}`} status={r.state} meta={r.why} selected={r.id===id} onClick={()=>navigate('requests',r.id)}/>)}</List>;
  else if(view==='pieces')list=<List label="Household piece settings">{pieces.map(([title,path,meta])=><Row key={path} title={title} meta={meta} onClick={()=>{if(go)go(path);else location.assign(path);}}/>)}</List>;
  else list=<><List label="Secret names">{names.records.filter(n=>n.id.toLowerCase().includes(query.toLowerCase())).map(n=><Row key={n.id} title={n.id} meta={n.description} status={warnings(n,uses.records,changes.records,permission.now).join(' · ')} selected={n.id===id} onClick={()=>navigate('secrets',n.id)}/>)}</List>{missing.length>0&&<section className="p-3"><h2>Not in the store</h2>{missing.map(n=><p key={n}>{n} · Named by policy</p>)}</section>}{!names.records.length&&<Empty title="No secrets yet" text="Add a name and its value to begin."/>}</>;
  const reader=view==='add'?<div className="p-5"><ValueForm enabled={permission.valuesAvailable}/></div>:view==='secrets'&&selected?<SecretReader key={selected.id} name={selected} policy={policy} agents={permission.agents} grants={grants.records} uses={uses.records} changes={changes.records} enabled={ready} values={permission.valuesAvailable} now={permission.now}/>:view==='requests'&&request?<div className="p-5"><RequestActions key={request.id} request={request} enabled={ready}/></div>:view==='grants'&&id?<div className="grid gap-5 p-5"><h1>{id}</h1>{grants.records.filter(g=>g.agent===id).map(g=><GrantRow key={g.id} grant={g} enabled={ready} now={permission.now}/>)}{!id.startsWith('service:')&&<GrantForm key={id} agent={id} enabled={ready}/>}</div>:id?<Empty title="This item is no longer available" text="It may have been removed or your access changed."/>:null;
  return <Split label="Settings" className="h-full" folders={[{id:'secrets',label:'Secrets',count:names.records.length},{id:'requests',label:'Requests',count:pending.length},{id:'grants',label:'Grants',count:grants.records.length},{id:'pieces',label:'Piece settings'}]} folder={view==='add'?'secrets':view} onFolder={f=>navigate(f)}
    search={<label>Search Settings<Input type="search" value={query} onChange={e=>setQuery(e.target.value)}/></label>} listTitle={view==='grants'?'Agents and services':view==='requests'?'Requests':view==='pieces'?'Household piece settings':'Secrets'}
    listTop={view==='secrets'?<div className="p-3"><Button onClick={()=>navigate('add')}>Add a secret</Button></div>:undefined} list={list} reader={reader} open={!!id||view==='add'} onBack={()=>navigate(view)} backLabel="Settings" blank={<Empty title="Settings" text="Choose a secret, request or agent to manage its access."/>}/>;
}
