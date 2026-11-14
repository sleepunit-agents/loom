import { useRecords, type LiveRecord } from '../../data';
import { Split, List, Row, Empty, Error, Loading } from '../../kit';
import AgentFace, { faceState, useAgentDisplays } from './agent-face';
import { agentPath, inboxPath, latestStatus, namedAgents, openAsks, orderedAgents, type OwnedAgent, type AgentPerson, type AgentStatus } from './home-model';
import { HomeSteps } from './home-steps';
import { threadPath } from './home-comms';
import type { ActivityWindow } from '../activity/model';
import type { Ask } from './model';
import './home.css';
interface Profile extends LiveRecord { agent: string; description?: string; requestedAt?: string; canEdit: boolean }
interface Thread extends LiveRecord { agent: string; archived: number|null; last: number; unread: boolean }
/** A record-only agent window; profile writes and deeper sections stay in their owning apps. */
export default function AgentApp({ path = '/p/agents-preview', go = p => location.assign(p) }: {path?:string;go?:(path:string)=>void} = {}) {
  const roster=useRecords<OwnedAgent>('attention.ownedAgent'), people=useRecords<AgentPerson>('person');
  const profiles=useRecords<Profile>('household.profile'), statuses=useRecords<AgentStatus>('attention.agent');
  const asks=useRecords<Ask>('attention.ask'), threads=useRecords<Thread>('thread');
  const activity=useRecords<ActivityWindow>('activity.window','recent'), displays=useAgentDisplays();
  const agents=orderedAgents(namedAgents(roster.status==='live'?roster.records:[],people.status==='live'?people.records:[]));
  const pathname=new URL(path,'http://loom').pathname, prefix='/p/agents-preview/agent/';
  let id:string|undefined;
  if(pathname.startsWith(prefix))try{id=decodeURIComponent(pathname.slice(prefix.length));}catch{id='invalid';}
  const agent=agents.find(a=>a.id===id), profile=profiles.status==='live'?profiles.records.find(p=>p.agent===agent?.id):undefined;
  const status=statuses.status==='live'&&agent?latestStatus(statuses.records,agent.id):undefined;
  const open=asks.status==='live'&&agent?openAsks(asks.records).filter(a=>a.agent===agent.id):[];
  const recent=threads.status==='live'&&agent?threads.records.filter(t=>t.agent===agent.id&&t.archived===null).sort((a,b)=>b.last-a.last||a.id.localeCompare(b.id)):[];
  const thread=recent.find(t=>t.unread)??recent[0];
  const unavailable=roster.status==='loading'?<Loading label="Opening your agents…"/>:roster.status!=='live'?<Error title="Your agents are unavailable" text="Waiting for access and connection."/>:undefined;
  const links=agent?[
    {title:'Conversation',meta:threads.status==='live'?'First unread or latest open thread':'Open Comms to reconnect',href:thread?threadPath(thread.id):'/p/comms-preview'},
    {title:'Activity',meta:'Recent work and conversations',href:`/p/activity-preview/?who=${encodeURIComponent(agent.id)}`},
    ...(agent.personPath?[{title:'People',meta:'Shared identity and relationships',href:agent.personPath}]:[]),
    {title:'Home',meta:'Current work, Clock and questions for all your agents',href:'/p/home-preview'},
    ...(profile?.canEdit?[{title:'Edit profile in Setup',meta:'Description and description requests',href:'/p/setup-preview'}]:[]),
  ]:[];
  return <Split className="h-full" label="Agents" folders={[{id:'owned',label:'Your agents',count:agents.length}]} folder="owned" onFolder={()=>go('/p/agents-preview')}
    listTitle="Your agents" listMeta={String(agents.length)} open={!!id} onBack={()=>go('/p/agents-preview')} backLabel="Your agents"
    list={unavailable??(agents.length?<List label="Your agents">{agents.map(a=><Row key={a.id} title={a.name} selected={a.id===id} onClick={()=>go(agentPath(a.id))}/>)}</List>:<Empty title="No agents of your own" text="Agents you own appear here."/>)}
    reader={unavailable??(agent?<article className="grid min-w-0 gap-5 p-5" aria-label={`${agent.name} agent window`}>
      <header className="desk-home-identity"><AgentFace display={displays.find(d=>d.id===agent.id)} name={agent.name} state={faceState(status?.state,!!open.length)} size={96}/><h1 className="text-2xl font-semibold">{agent.name}</h1><p>{status?.state??'No status reported'}</p></header>
      <section aria-label={`${agent.name} description`} className="grid gap-2"><h2>Description</h2>{profiles.status==='loading'?<Loading label="Opening description…"/>:profiles.status!=='live'?<p>Description unavailable.</p>:<><p className="whitespace-pre-wrap">{profile?.description??'No profile description.'}</p>{profile?.requestedAt&&<p>A description has been requested.</p>}</>}</section>
      <section className="grid gap-2" aria-label={`${agent.name} current work`}><h2>Now</h2><p className="whitespace-pre-wrap">{statuses.status!=='live'?'Status unavailable.':status?.work||'Nothing right now'}</p></section>
      <section className="grid gap-2" aria-label={`${agent.name} questions`}><h2>Needs you</h2>{asks.status!=='live'?<p>Questions unavailable.</p>:open.length?<List label={`${agent.name} open questions`}>{open.map(ask=><Row key={ask.id} title={ask.ask} meta={ask.why} onClick={()=>go(inboxPath(ask))}/>)}</List>:<p>Nothing needs you.</p>}</section>
      <HomeSteps agent={agent.id} name={agent.name} activity={activity} go={go}/>
      <section className="grid gap-2"><h2>Explore</h2><List label={`${agent.name} apps`}>{links.map(link=><Row key={link.title} title={link.title} meta={link.meta} onClick={()=>go(link.href)}/>)}</List></section>
    </article>:id?<Empty title="Agent not available" text="Choose one of your agents."/>:null)}
    blank={<Empty title="Open an agent" text="Choose an agent to see its profile and current work."/>}/>;
}
