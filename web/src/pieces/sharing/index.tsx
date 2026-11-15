import {useState,type FormEvent} from 'react';
import {useDataQuery} from '../../data/graphql';
import {memberOperation} from '../../data/operation';
import {AppFrame,List,Row,Empty,Error,Loading,Button,Input} from '../../kit';
interface Project{id:string;name:string;members:string[];agents:string[];repositories:string[]}
interface Sharing{members:string[];agents:string[];projects:Project[]}
const query=`{ householdSharing { members agents projects { id name members agents repositories } } }`;
function ProjectForm({project,choices,enabled}:{project?:Project;choices:Sharing;enabled:boolean}){
 const [busy,setBusy]=useState(false),[message,say]=useState('');
 const submit=async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!enabled||busy)return;const form=new FormData(event.currentTarget);setBusy(true);say('');try{await memberOperation('household.setProject',{id:project?.id??form.get('id'),name:form.get('name'),members:form.getAll('members'),agents:form.getAll('agents'),repositories:String(form.get('repositories')??'').split(/\s+/).filter(Boolean)});say('Saved');}catch{say('Could not save project. Check its members, agents and repositories.');}finally{setBusy(false);}};
 return <form aria-label={project?'Edit project':'Create project'} onSubmit={event=>void submit(event)} className="grid gap-4"><h2>{project?project.name:'Create project'}</h2><fieldset disabled={!enabled||busy} className="grid gap-3">
 {!project&&<label>Slug<Input name="id" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={100}/></label>}
 <label>Name<Input name="name" defaultValue={project?.name} required maxLength={200}/></label>
 {(['members','agents'] as const).map(field=><fieldset key={field}><legend>{field==='members'?'Members':'Agents'}</legend>{choices[field].map(id=><label key={id} className="flex gap-2"><input type="checkbox" name={field} value={id} defaultChecked={project?.[field].includes(id)}/>{id}</label>)}</fieldset>)}
 <label>Repositories<Input name="repositories" defaultValue={project?.repositories.join(' ')} placeholder="github:owner/repo"/></label>
 <Button disabled={!enabled||busy} type="submit">{busy?'Saving…':project?'Save project':'Create project'}</Button></fieldset>{message&&<p role="status">{message}</p>}</form>;
}
export default function SharingApp({go=()=>{}}:{path?:string;go?:(path:string)=>void}={}){
 const feed=useDataQuery<{householdSharing:Sharing|null}>(query),choices=feed.data?.householdSharing,[selected,select]=useState<string>();
 const project=choices?.projects.find(row=>row.id===selected),enabled=feed.status==='live'&&!!choices;
 return <AppFrame title="Project sharing" where="Sharing" go={go}>{feed.status==='loading'?<Loading label="Opening project sharing…"/>:!choices?<Empty title="Household owners manage sharing" text="Ask an owner to put members and agents on a project."/>:<div className="grid gap-6 p-5">
 {feed.status!=='live'&&<Error text="Project sharing is disconnected. Changes are disabled."/>}<p>A project shares its work with the members and agents on its lists.</p><Button disabled={!enabled} variant="outline" onClick={()=>select(undefined)}>New project</Button>
 <List label="Projects">{choices.projects.map(row=><Row key={row.id} title={row.name} meta={row.id} status={`${row.members.length} members · ${row.agents.length} agents`} selected={row.id===selected} onClick={()=>select(row.id)}/>)}</List>
 <ProjectForm key={JSON.stringify(project??'new')} project={project} choices={choices} enabled={enabled}/></div>}</AppFrame>;
}
