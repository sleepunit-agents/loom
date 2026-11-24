import {Portrait} from './portrait';
import { NativeSelect } from '../../kit/native-select';
import {fullTime} from '../../kit/time';
import {useHouseholdZone} from '../../data/zone';
import {MachineAlertLines,type AlertLines} from './alert-lines';
import {GrantChoices,ProgramGrants,programQuery,type ProgramSetupData} from './programs';
import {sessionChange} from '../../signin/session-change';
import {useState,useEffect,useRef,type FormEvent} from 'react';
import {useDataQuery} from '../../data/graphql';
import {HomeMessageComposer} from '../attention/home-composer';
import {threadPath} from '../attention/home-comms-data';
import {liveAgents} from '../../data/live-agents';
import {memberOperation} from '../../data/operation';
import {AppFrame,Button,Input,Field,Fields,Section,Empty,Error as ErrorView,Loading} from '../../kit';
interface Member{id:string;role:'owner'|'member';fullOwner:boolean;agents:string[]}
interface Agent{id:string;spriteVersion:string|null;about:string;markBg:string;markFg:string;faceShape:string;faceEyes:string;github:string[];removedAt?:string|null}
/** `removedAt`: set on an agent taken out of use. It keeps its row and its owner link, so it can be restored. */
interface Setup{defaultAgent:string|null;members:Member[];agents:Agent[];tokens:Array<{fingerprint:string;label:string;kind:string;expired:boolean;identity:string;createdAt:string;expiresAt:string|null;revokedAt:string|null;lastUsedAt:string|null}>;sessions:Array<{ref:string;device:string;member:string|null;tokenLabel:string|null;isAgent:boolean;ended:boolean;issuedAt:string;seenAt:string}>}
function agentOwnership(members: Member[], agent: string) {
 const owners = members.filter(member => member.agents.includes(agent)).map(member => member.id);
 return owners.length ? 'Owned by ' + owners.join(', ') : 'No assigned owner';
}
const query=`{ householdSetup { defaultAgent members { id role fullOwner agents } agents { id about markBg markFg faceShape faceEyes github removedAt spriteVersion } tokens { fingerprint label kind expired identity createdAt expiresAt revokedAt lastUsedAt } sessions { ref device member tokenLabel isAgent ended issuedAt seenAt } } boxes { id name revokedAt } boxAlertSettings(limit:1) { diskPercent diskUrgentPercent diskFreeMib memoryFreeMib } }`;
export default function SetupApp({go=()=>{},active=true}:{path?:string;go?:(path:string)=>void;active?:boolean}={}){
 const zone=useHouseholdZone();
 const feed=useDataQuery<{householdSetup:Setup|null;boxAlertSettings:AlertLines[];boxes:Array<{id:string;name:string;revokedAt:string|null}>}>(query),setup=feed.data?.householdSetup;
 const [proposal,setProposal]=useState<{form:string;member:string;agent:string;words:string}>();
 const [restore,setRestore]=useState<string>();
 const comms=useDataQuery<{homeComms:{member:string;agents:string[]}|null}>('{ homeComms { member agents } }');
 const mailbox=comms.status==='live'?comms.data?.homeComms:null;
 const recipient=mailbox?.agents.find(id=>id===setup?.defaultAgent)??mailbox?.agents[0];
 const programFeed=useDataQuery<{programSetup:ProgramSetupData|null}>(programQuery),programs=programFeed.data?.programSetup;
 const [busy,setBusy]=useState(false),[message,say]=useState(''),[bearer,setBearer]=useState(''),[kind,setKind]=useState('owner');
 const rawProgramOwner=useRef<string|null>(null);
 const generation=useRef(0),pendingLabel=useRef<string|null>(null),enabled=active&&feed.status==='live'&&!!setup&&!busy;
 useEffect(()=>{if(!active||feed.status!=='live'||!setup){generation.current++;setBearer('');if(pendingLabel.current)say(`Token creation for “${pendingLabel.current}” may have completed. Check its label before trying again.`);}},[active,feed.status,setup]);
 useEffect(()=>()=>{generation.current++;pendingLabel.current=null;},[]);
 const programEnabled=enabled&&programFeed.status==='live'&&!!programs;
 useEffect(()=>{if(rawProgramOwner.current&&(programFeed.status!=='live'||programs?.owner!==rawProgramOwner.current)){generation.current++;setBearer('');rawProgramOwner.current=null;if(pendingLabel.current)say(`Token creation for “${pendingLabel.current}” may have completed. Check its label before trying again.`);}},[programFeed.status,programs?.owner]);
 const change=async(name:string,input:object)=>{if(!enabled)return;setBusy(true);say('');try{if(name==='sessions.revoke'||name==='token.revoke'){if(await sessionChange(name,input)==='signed-out')return;}else await memberOperation(name,input);say('Saved');}catch{say(name==='sessions.revoke'||name==='token.revoke'?'Could not confirm revocation. Check your sign-in and connection.':'Could not save. Check the values and connection.');}finally{setBusy(false);}};
 useEffect(()=>{setProposal(undefined);},[active,mailbox?.member,recipient,feed.status,!!setup]);
 const propose=(request:(form:FormData)=>string)=>(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();
  if(!enabled)return;
  const values=new FormData(event.currentTarget);
  if(values.get('fullOwner')==='on'&&values.get('role')!=='owner'){say('Choose Household owner before granting every agent.');return;}
  if(!mailbox||!recipient){say('Connect to your agent in Comms to request a household change.');return;}
  say('');
  setProposal({form:event.currentTarget.getAttribute('aria-label')!,member:mailbox.member,agent:recipient,words:request(values)});
 };
 const draftFor=(form:string)=>enabled&&proposal?.form===form&&proposal.member===mailbox?.member&&proposal.agent===recipient&&<div>
  <p>Review the message to {recipient}. You can approve the proposed change in Inbox.</p>
  <HomeMessageComposer key={proposal.words} member={proposal.member} agent={proposal.agent} suggestedText={proposal.words} onOpened={id=>{setProposal(undefined);go(threadPath(id));}}/>
  <Button onClick={()=>setProposal(undefined)}>Close draft</Button>
 </div>;
 const issue=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!enabled||bearer||kind==='program'&&!programEnabled)return;rawProgramOwner.current=kind==='program'?programs!.owner:null;const form=new FormData(event.currentTarget),attempt=++generation.current;pendingLabel.current=String(form.get('label')??'');setBearer('');setBusy(true);say('');try{const expires=String(form.get('expiresAt')??'').trim(),identity=kind==='owner'||kind==='program'?{member:form.get('member')}:kind==='agent'?{agent:form.get('agent')}:{box:form.get('box')};const response=await fetch(kind==='program'?'/api/signin/program':'/api/signin/token',{method:'POST',credentials:'same-origin',...(kind==='program'?{redirect:'error' as const,cache:'no-store' as const}:{}),headers:{'content-type':'application/json'},body:JSON.stringify({...(kind==='program'?{records:form.getAll('records'),operations:form.getAll('operations')}:{kind}),label:form.get('label'),...identity,...(expires?{expiresAt:expires}:{})})});const result:unknown=await response.json();if(!response.ok){if([400,401,403,409].includes(response.status)){say(response.status===403&&!!result&&typeof result==='object'&&'error'in result&&result.error==='Sign in again before making a token'?'Sign in again to make a token. This browser signed in more than ten minutes ago, or is an automated one.':'Token creation refused. Check its label and identity.');return;}throw Error();}if(!result||typeof result!=='object'||!('ok'in result)||result.ok!==true||!('value'in result)||!result.value||typeof result.value!=='object'||!('token'in result.value)||typeof result.value.token!=='string'||!/^loom_[A-Za-z0-9_-]{43}$/.test(result.value.token))throw Error();if(attempt===generation.current)setBearer(result.value.token);}catch{say('Token creation may have completed. Check its label and revoke it before trying again.');}finally{pendingLabel.current=null;setBusy(false);}};
 // A removed agent is no choice in a member's list. Its link to its owner is sent back unchanged (a hidden field), so a restore returns it to them.
 const memberForm=(member?:Member)=><div key={JSON.stringify(member??'new')}><form aria-label={member?`Save member ${member.id}`:'Add member'} onSubmit={propose(form=>`Please propose ${member?'updating':'adding'} household member ${member?.id??form.get('id')} with the ${form.get('role')} role. Own every agent: ${form.get('fullOwner')==='on'?'yes':'no'}. Assigned agents: ${form.getAll('agents').join(', ')||'none'}.`)} className="grid gap-3 rounded-xl border p-4"><Fields disabled={!enabled} className="grid gap-3">{member?<h3>{member.id}</h3>:<Field label="Member name"><Input name="id" required pattern="[a-z0-9]+(-[a-z0-9]+)*"/></Field>}<Field label="Role"><NativeSelect name="role" defaultValue={member?.role??'member'}><option value="member">Member</option><option value="owner">Household owner</option></NativeSelect></Field><label><input name="fullOwner" type="checkbox" defaultChecked={member?.fullOwner}/>Own every agent, present and future (household owners only)</label><fieldset><legend>Owned agents</legend>{liveAgents(setup?.agents??[]).map(agent=><label key={agent.id} className="flex gap-2"><input type="checkbox" name="agents" value={agent.id} defaultChecked={member?.agents.includes(agent.id)}/>{agent.id}</label>)}{(setup?.agents??[]).filter(agent=>agent.removedAt&&member?.agents.includes(agent.id)).map(agent=><input key={agent.id} type="hidden" name="agents" value={agent.id}/>)}</fieldset><Button disabled={!enabled} type="submit">{member?'Request member change':'Request new member'}</Button></Fields></form>{draftFor(member?`Save member ${member.id}`:'Add member')}</div>;
 return <AppFrame title="Household setup" where="Setup" go={go}><div className="grid min-w-0 gap-6 overflow-auto p-5">
 {feed.status==='loading'?<Loading label="Opening household…"/>:feed.status!=='live'?<ErrorView text="Connection lost. Household setup will return when the connection is restored."/>:!setup?<Empty title="Household owners manage setup" text="Sign in as a household owner to see members, agents, tokens and browsers."/>:<>
 {message&&<p role="status">{message}</p>}
 {feed.data?.boxAlertSettings?.[0]&&<MachineAlertLines lines={feed.data.boxAlertSettings[0]} enabled={enabled} save={patch=>void change('machine.setAlertLines',patch)}/>}
 <Section label="Members" className="grid gap-4">{setup.members.map(member=>memberForm(member))}{memberForm()}</Section>
 <Section label="Agents" className="grid gap-4"><p>Default agent: {setup.defaultAgent??'None'}</p>{liveAgents(setup.agents).map(agent=><article key={agent.id} className="grid gap-3"><h3>{agent.id}</h3>
  <p>{agentOwnership(setup.members,agent.id)}</p>
  <Portrait agent={agent.id} version={agent.spriteVersion??null} enabled={enabled}/><form key={JSON.stringify([agent.about,agent.markBg,agent.markFg,agent.faceShape,agent.faceEyes])} aria-label={`Save appearance for ${agent.id}`} onSubmit={propose(form=>`Please propose updating the appearance of ${agent.id}. Description: ${form.get('about')}. Badge background: ${form.get('markBg')}. Badge foreground: ${form.get('markFg')}. Face shape: ${form.get('faceShape')}. Eyes: ${form.get('faceEyes')}.`)}><Fields disabled={!enabled} className="grid gap-2"><Field label="Description"><Input key={agent.about} name="about" maxLength={600} defaultValue={agent.about}/></Field><Field label="Badge background"><Input type="color" name="markBg" defaultValue={agent.markBg}/></Field><Field label="Badge foreground"><Input type="color" name="markFg" defaultValue={agent.markFg}/></Field><Field label="Face shape"><NativeSelect name="faceShape" defaultValue={agent.faceShape}>{['pebble','trefoil','clover','drop'].map(value=><option key={value}>{value}</option>)}</NativeSelect></Field><Field label="Eyes"><NativeSelect name="faceEyes" defaultValue={agent.faceEyes}><option>dot</option><option>oval</option></NativeSelect></Field><Button disabled={!enabled} type="submit">Request appearance change</Button></Fields></form>{draftFor(`Save appearance for ${agent.id}`)}<form aria-label={`Save accounts for ${agent.id}`} onSubmit={propose(form=>`Please propose setting the GitHub accounts for ${agent.id} to ${String(form.get('github')??'').trim()||'none'}.`)}><Fields disabled={!enabled}><Field label="GitHub accounts"><Input key={agent.github.join(',')} name="github" defaultValue={agent.github.join(', ')}/></Field><Button disabled={!enabled} type="submit">Request account change</Button></Fields></form>{draftFor(`Save accounts for ${agent.id}`)}</article>)}
  {setup.agents.some(agent=>agent.removedAt)&&<section aria-label="Removed agents" className="grid gap-1 text-sm opacity-80"><h3>Removed</h3>
   <ul>{setup.agents.filter(agent=>agent.removedAt).map(agent=><li key={agent.id}>
    <span>{agent.id}</span>{recipient&&<Button variant="outline" disabled={!enabled} onClick={()=>setRestore(restore===agent.id?undefined:agent.id)}>Restore {agent.id}</Button>}
    {restore===agent.id&&mailbox&&recipient&&<div className="grid gap-2">
     <p>Ask {recipient} to propose the restore, then allow it in Inbox.</p>
     <HomeMessageComposer key={agent.id} member={mailbox.member} agent={recipient}
       suggestedText={`Please propose restoring the household agent ${agent.id}.`}
       onOpened={thread=>{setRestore(undefined);go(threadPath(thread));}}/>
    </div>}
   </li>)}</ul></section>}</Section>
 <Section label="Tokens and sessions" className="grid gap-4"><form aria-label="Create token" onSubmit={event=>void issue(event)}><Fields disabled={!enabled||!!bearer} className="grid gap-3"><Field label="Token label"><Input name="label" required maxLength={120}/></Field><Field label="Identity"><NativeSelect value={kind} onChange={event=>{generation.current++;setBearer('');rawProgramOwner.current=null;setKind(event.target.value);}}><option value="owner">Household member</option><option value="agent">Agent</option><option value="runner">Machine</option><option value="program" disabled={!programEnabled}>Outside program</option></NativeSelect></Field>{kind==='owner'||kind==='program'?<Field label="Member"><NativeSelect name="member">{setup.members.map(member=><option key={member.id}>{member.id}</option>)}</NativeSelect></Field>:kind==='agent'?<Field label="Agent"><NativeSelect name="agent">{liveAgents(setup.agents).map(agent=><option key={agent.id}>{agent.id}</option>)}</NativeSelect></Field>:<Field label="Machine"><NativeSelect name="box">{feed.data?.boxes.filter(box=>!box.revokedAt).map(box=><option key={box.id} value={box.id}>{box.name}</option>)}</NativeSelect></Field>}{kind==='program'&&programs&&<GrantChoices catalogue={programs.catalogue}/>}<Field label="Expires (optional ISO time)"><Input name="expiresAt"/></Field><Button disabled={!enabled||!!bearer||kind==='program'&&!programEnabled} type="submit">Create token</Button></Fields></form>
 {bearer&&active&&feed.status==='live'&&(!rawProgramOwner.current||(programFeed.status==='live'&&programs?.owner===rawProgramOwner.current))&&<div aria-label="New token"><p>Save this token now. It is shown once.</p><code aria-label="Token value" className="break-all">{bearer}</code><Button onClick={()=>setBearer('')}>Hide token</Button></div>}
 <h3>Tokens</h3>{setup.tokens.map(token=><div key={token.fingerprint} className="rounded-xl border p-4"><h4>{token.label}</h4><p>{token.kind} · {token.identity} · {token.revokedAt?'Revoked':token.expired?'Expired':'Active'}</p><p>Created {fullTime(token.createdAt,zone)} · Last used {token.lastUsedAt?fullTime(token.lastUsedAt,zone):'Never'}{token.expiresAt?` · Expires ${fullTime(token.expiresAt,zone)}`:''}</p>{!token.revokedAt&&<Button disabled={!enabled} variant="danger-quiet" onClick={()=>void change('token.revoke',{fingerprint:token.fingerprint})}>Revoke token</Button>}</div>)}
 <h3>Signed-in browsers</h3>{setup.sessions.map(session=><div key={session.ref} className="rounded-xl border p-4"><h4>{session.device}</h4><p>{session.member} · {session.tokenLabel} · {session.isAgent?'Agent browser':'Browser'} · {session.ended?'Ended':'Active'}</p><p>Last used {fullTime(session.seenAt,zone)}</p><Button disabled={!enabled} variant="outline" onClick={()=>void change('sessions.revoke',{ref:session.ref})}>Sign out browser</Button></div>)}</Section>
 {programs&&<ProgramGrants data={programs} enabled={programEnabled} save={input=>change('program.setGrants',input)}/>}
 </>}
 </div></AppFrame>;
}
