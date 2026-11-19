import { useDeskWaitingCounts, WaitingRow, waitingPath } from './waiting';
import { useDeskAgentDisplays } from './agent-displays';
import { useDeskAgentProfiles } from './agent-profiles';
import { useDeskRecentActivity } from './recent-activity';
import { useDeskAgentDirectory } from './agent-directory';
import { useDeskAgentStatuses } from './agent-status';
import { useDeskRoster } from './roster';
import { AppFrame, Body, List, Row, Empty, Error, Loading, Button, LinkButton, Meta, Reader, Section } from '../../kit';
import AgentFace, { faceState } from './agent-face';
import { agentPath, agentStateLine, latestStatus, namedAgents, orderedAgents, shownState } from './home-model';
import { LastSteps } from './last-steps';
import { useHomeComms, threadPath } from './home-comms-data';
import { Doing, useDoing, busyCount } from './doing';
import { AgentJobs } from './agent-jobs';
import { ConversationsSection, LastAnswerSection, useCardTalk } from './talk';
import { stamp } from './time';
import './home.css';

type Agent = ReturnType<typeof namedAgents>[number];
/** Everything about one agent, in full: what Home's card summarises, and what only lives here (its jobs, its steps). */
function AgentReader({ agent, names, go }: { agent: Agent; names: ReadonlyMap<string, string>; go(path: string): void }) {
  const profiles=useDeskAgentProfiles(), statuses=useDeskAgentStatuses();
  const waiting=useDeskWaitingCounts(), comms=useHomeComms();
  const activity=useDeskRecentActivity(), displays=useDeskAgentDisplays();
  const doing=useDoing(agent.id,true), talk=useCardTalk(agent.id,12);
  const profile=profiles.status==='live'?profiles.records.find(p=>p.agent===agent.id):undefined;
  const status=statuses.status==='live'?latestStatus(statuses.records,agent.id):undefined;
  const needs=waiting.status==='live'?(waiting.agents.get(agent.id)??0):undefined;
  const summary=comms.reading?.summaries.find(s=>s.agent===agent.id),thread=summary?.first??summary?.last;
  const count=busyCount(doing.items);
  const links=[
    {title:'Conversation',meta:comms.status==='live'?'First unread or latest open thread':'Open Comms to reconnect',href:thread?threadPath(thread.thread):'/p/comms-preview'},
    {title:'Activity',meta:'Recent work and conversations',href:`/p/activity-preview/?who=${encodeURIComponent(agent.id)}`},
    ...(agent.personPath?[{title:'People',meta:'Shared identity and relationships',href:agent.personPath}]:[]),
    {title:'Home',meta:'What all your agents are doing, and what needs you',href:'/p/home-preview'},
  ];
  return <Reader aria-label={`${agent.name} agent window`} className="desk-agent-page">
    <div className="desk-agent-who"><AgentFace display={displays.find(d=>d.id===agent.id)} name={agent.name} state={faceState(shownState(status?.state,count),!!needs)} size={96}/>
      <Meta>{agentStateLine(status?.state,count,needs)}</Meta></div>
    <Section label="Doing now"><Doing doing={doing} name={agent.name} agent={agent.id} names={names} go={go}/></Section>
    {profiles.status==='live'&&(profile?.description||profile?.requestedAt)&&<Section label="About">{profile.description&&<Body>{profile.description}</Body>}{profile.requestedAt&&<Body quiet>A description has been asked for.</Body>}</Section>}
    {statuses.status==='live'&&status?.work&&<Section label="Its own report"><Body>{status.work}</Body><Meta><time dateTime={new Date(status.changedAt).toISOString()}>{stamp(status.changedAt)}</time></Meta></Section>}
    <Section label="Needs you">{waiting.status==='loading'?<Body quiet>Checking…</Body>:waiting.status!=='live'?<Body quiet>Can’t tell what is waiting on you right now.</Body>:needs?<><List label={`${agent.name} first waiting item`}><WaitingRow agent={agent.id} go={go}/></List>{needs>1&&<LinkButton onClick={()=>go(waitingPath())}>{`+${needs-1} more in Inbox`}</LinkButton>}</>:<Body quiet>Nothing.</Body>}</Section>
    <AgentJobs agent={agent.id} name={agent.name}/>
    <LastAnswerSection talk={talk} go={go}/>
    <ConversationsSection talk={talk} name={agent.name} unread={summary?.unread} firstUnread={summary?.first?.thread} go={go}/>
    <LastSteps agent={agent.id} name={agent.name} activity={activity} go={go}/>
    <Section label="Explore"><List label={`${agent.name} apps`}>{links.map(link=><Row key={link.title} title={link.title} meta={link.meta} onClick={()=>go(link.href)}/>)}</List></Section>
  </Reader>;
}
/** The Agents app: one of your agents in full at /p/agents-preview/agent/<id>, or the list of them. Profile
 * writes and deeper sections stay in their owning apps. */
export default function AgentApp({ path = '/p/agents-preview', go = p => location.assign(p) }: {path?:string;go?:(path:string)=>void} = {}) {
  const roster=useDeskRoster(), people=useDeskAgentDirectory();
  const agents=orderedAgents(namedAgents(roster.status==='live'?roster.records:[],people.status==='live'?people.records:[]));
  const pathname=new URL(path,'http://loom').pathname, prefix='/p/agents-preview/agent/';
  let id:string|undefined;
  if(pathname.startsWith(prefix))try{id=decodeURIComponent(pathname.slice(prefix.length));}catch{id='invalid';}
  const agent=agents.find(a=>a.id===id);
  const unavailable=roster.status==='loading'?<Loading label="Opening your agents…"/>:roster.status!=='live'?<Error title="Your agents are unavailable" text="Waiting for access and connection."/>:undefined;
  return <div className="desk-agent-app h-full w-full min-w-0 max-w-full overflow-auto [overflow-wrap:anywhere]"><AppFrame title={agent?.name??'Your agents'} where="Agents" go={go}
    actions={id?<Button variant="outline" onClick={()=>go('/p/agents-preview')}>All your agents</Button>:undefined}>
    {unavailable??(agent?<AgentReader key={agent.id} agent={agent} names={new Map(agents.map(a=>[a.id,a.name]))} go={go}/>
      :id?<Empty title="Agent not available" text="Choose one of your agents."/>:agents.length?<List label="Your agents">{agents.map(a=><Row key={a.id} title={a.name} onClick={()=>go(agentPath(a.id))}/>)}</List>:<Empty title="No agents of your own" text="Agents you own appear here."/>)}
  </AppFrame></div>;
}
