import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useDataQuery} from '../../data/graphql';
import {HomeMessageComposer} from '../attention/home-composer';
import {threadPath} from '../attention/home-comms-data';
import {AppFrame,List,Row,Empty,Error,Loading,Button,Input} from '../../kit';
interface Project{id:string;name:string;goal?:string|null;members:string[];agents:string[];repositories:string[]}
interface Sharing{members:string[];agents:string[];projects:Project[]}
const query=`{ householdSharing { members agents projects { id name goal members agents repositories } } }`;
interface Recipient {member:string;agent:string}
function ProjectForm({project,choices,enabled,recipient,go}:{project?:Project;choices:Sharing;enabled:boolean;recipient?:Recipient;go:(path:string)=>void}){
 const [words,setWords]=useState('');
 function prepare(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!enabled||!recipient)return;
  const fields=new FormData(event.currentTarget);
  const goal=String(fields.get('goal')??'').trim() || null;
  const request={
   ...(goal!==(project?.goal??null)?{goal}:{}),
   id:project?.id??fields.get('id'),name:fields.get('name'),
   members:fields.getAll('members'),agents:fields.getAll('agents'),
   repositories:String(fields.get('repositories')??'').trim().split(/\s+/).filter(Boolean),
  };
  setWords(`Please propose ${project?'updating':'creating'} this project with these sharing settings.\n${JSON.stringify(request,null,2)}`);
 }
 return <><form aria-label={project?'Edit project':'Create project'} onSubmit={prepare} onChange={()=>setWords('')} className="grid gap-4"><h2>{project?project.name:'Create project'}</h2><fieldset disabled={!enabled||!recipient} className="grid gap-3">
 {!project&&<label>Slug<Input name="id" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={100}/></label>}
 <label>Name<Input name="name" defaultValue={project?.name} required maxLength={200}/></label>
 <label>Project goal<Input name="goal" defaultValue={project?.goal??''} maxLength={280}/></label>
 {(['members','agents'] as const).map(field=><fieldset key={field}><legend>{field==='members'?'Members':'Agents'}</legend>{choices[field].map(id=><label key={id} className="flex gap-2"><input type="checkbox" name={field} value={id} defaultChecked={project?.[field].includes(id)}/>{id}</label>)}</fieldset>)}
 <label>Repositories<Input name="repositories" defaultValue={project?.repositories.join(' ')} placeholder="github:owner/repo"/></label>
 <Button type="submit">{project?'Review project changes':'Review new project'}</Button></fieldset></form>
 {!recipient&&<p>Connect to your agent in Comms to request a project change.</p>}
 {enabled&&recipient&&words&&<section aria-label="Project change request"><p>Review the message to {recipient.agent}. You can answer the proposed change in Inbox.</p>
 <HomeMessageComposer key={words} member={recipient.member} agent={recipient.agent} suggestedText={words} onOpened={id=>{setWords('');go(threadPath(id));}}/></section>}</>;
}
const home='/p/sharing-preview';
export default function SharingApp({path=home,go=()=>{},active=true}:{path?:string;go?:(path:string)=>void;active?:boolean}){
 const feed=useDataQuery<{householdSharing:Sharing|null}>(query),choices=feed.data?.householdSharing;
 const url=new URL(path,'https://loom.local');
 const creating=url.pathname===home+'/new';
 const selected=url.pathname.startsWith(home+'/project/')?url.pathname.slice((home+'/project/').length):undefined;
 const list=!selected&&!creating;
 const focusId=url.searchParams.get('focus');
 const origin=useRef<HTMLButtonElement>(null);
 useEffect(()=>{if(active&&list&&focusId)origin.current?.focus();},[active,list,focusId,!!choices]);
 const comms=useDataQuery<{homeComms:{member:string;agents:string[]}|null;householdSetup:{defaultAgent:string|null}|null}>('{ homeComms { member agents } householdSetup { defaultAgent } }');
 const mailbox=comms.status==='live'?comms.data?.homeComms:null;
 const agent=mailbox?.agents.find(id=>id===comms.data?.householdSetup?.defaultAgent)??mailbox?.agents[0];
 const recipient=mailbox&&agent?{member:mailbox.member,agent}:undefined;
 const project=choices?.projects.find(row=>row.id===selected),enabled=active&&feed.status==='live'&&!!choices;
 const back=selected?home+'?focus='+encodeURIComponent(selected):home;
 return <AppFrame title="Sharing" where={path} go={go} crumb={list?undefined:{label:'Projects',href:back}}
   actions={choices&&!creating&&<Button disabled={!enabled} variant="outline" onClick={()=>go(home+'/new')}>New project</Button>}>
   {feed.status==='loading'?<Loading label="Opening project sharing…"/>:!choices?<Empty title="Household owners manage sharing" text="Ask an owner to put members and agents on a project."/>:
    <div className="grid gap-6 p-5">
     {feed.status!=='live'&&<Error text="Project sharing is disconnected. Changes are disabled."/>}
     {list?<List label="Projects">
       {choices.projects.map(row=><Row key={row.id} ref={row.id===focusId?origin:undefined} title={row.name} meta={row.id}
         status={`${row.members.length} members · ${row.agents.length} agents`} onClick={()=>go(home+'/project/'+encodeURIComponent(row.id))}/>)}
       {!choices.projects.length&&<Empty title="No projects to share"/>}
     </List>:creating||project?<ProjectForm key={JSON.stringify([project??'new',recipient,enabled])} project={project}
       choices={choices} enabled={enabled} recipient={recipient} go={go}/>:<Empty title="Project unavailable"/>}
    </div>}
 </AppFrame>;
}
