import { LiveAgentFeed } from './live-agent-posts';
import { useDeskAgentProfiles } from './agent-profiles';
import { useDeskWaitingCounts } from './waiting';
import { useDeskAgentDisplays } from './agent-displays';
import { useDeskAgentDirectory } from './agent-directory';
import { useDeskAgentStatuses } from './agent-status';
import { useDeskRoster } from './roster';
import { agentPath, type AgentStatus } from './home-model';
import { Doing, WithDoing, useDoing } from './doing';
import { HomeTalk, useCardTalk } from './talk';
import { HomeComposer, useHomeComms, threadPath } from './home-comms';
import type { Summaries } from './home-comms-data';
import AgentFace, { faceState } from './agent-face';
import { NeedsBand } from './needs-band';
import './home.css';
import { useEffect, useState, type MouseEvent } from 'react';
import type { Snapshot } from '../../data';
import { Empty, Error, Loading, Row } from '../../kit';
import { agentStateLine, latestStatus, namedAgents, orderedAgents, shownState } from './home-model';
function Unavailable({ status, label }: { status: Snapshot['status']; label: string }) {
  return status === 'loading' ? <Loading label={`Opening ${label}…`} /> : <Error title={`Couldn’t load ${label}`} text={status === 'denied' ? 'Sign in with access to see this.' : 'Waiting for connection.'} />;
}
type Agent = ReturnType<typeof namedAgents>[number];
/** One agent's big card, a summary that leads to the whole of it in the Agents app: who it is and how it is, what
 * it is doing, its last answer and latest conversations in brief, and the box to write to it. */
function HomeCard({ agent, names, needs, state, display, conversations, go, solo = false }: {
  agent: Agent; names: ReadonlyMap<string,string>; needs?: number; state?: AgentStatus['state'];
  display: Parameters<typeof AgentFace>[0]['display']; conversations?: Summaries; go(path:string): void; solo?: boolean;
}) {
  const doing = useDoing(agent.id, solo), talk = useCardTalk(agent.id, solo ? 6 : 3), count = doing.items.length;
  const page = agentPath(agent.id), summary = conversations?.summaries.find(s=>s.agent===agent.id);
  const open = (event: MouseEvent) => { if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return; event.preventDefault(); go(page); };
  if (solo) return <AgentDesk agent={agent} display={display} state={shownState(state, count)} needs={needs} open={open}>
    <section className="desk-solo-now" aria-label="Right now">
      <h3>Right now</h3>
      <LiveAgentFeed agent={agent.id} go={go}/>
      <Doing doing={{ ...doing, items: doing.items.slice(0, 12), more: doing.more + Math.max(0, count - 12) }}
        name={agent.name} agent={agent.id} names={names} go={go} />
    </section>
    <section className="desk-solo-talk" aria-label="Talk">
      <h3>Talk</h3>
      <HomeTalk talk={talk} name={agent.name} unread={summary?.unread} firstUnread={summary?.first?.thread}
        all={page} go={go} composer={<HomeComposer agent={agent.id} name={agent.name} reading={conversations} go={go} />} />
    </section>
  </AgentDesk>;
  return <section aria-label={`${agent.name} card`} data-agent={agent.id} className="desk-home-card grid min-w-0 gap-3">
    <header className="desk-home-identity">
      <a className="inline-flex shrink-0 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 [&>*]:pointer-events-none" aria-label={`Open ${agent.name} agent window`} tabIndex={-1} href={page} onClick={open}><AgentFace display={display} name={agent.name} state={faceState(shownState(state,count), !!needs)} size={96} /></a>
      <h2><a href={page} onClick={open}>{agent.name}</a></h2>
      <a className="desk-home-open" href={page} onClick={open}>Open {agent.name} ›</a>
      <p>{agentStateLine(state,count,needs)}</p>
    </header>
    <LiveAgentFeed agent={agent.id} go={go}/>
    <Doing doing={doing} name={agent.name} agent={agent.id} names={names} go={go} />
    <HomeTalk talk={talk} name={agent.name} unread={summary?.unread} firstUnread={summary?.first?.thread} all={page} go={go} />
    <HomeComposer agent={agent.id} name={agent.name} reading={conversations} go={go} />
  </section>;
}
function AgentDesk({ agent, display, state, needs, open, children }: {
  agent: Agent; display: Parameters<typeof AgentFace>[0]['display']; state?: AgentStatus['state'];
  needs?: number; open(event: MouseEvent): void; children: React.ReactNode;
}) {
  const profiles = useDeskAgentProfiles();
  const about = profiles.records.find(row => row.agent === agent.id)?.description;
  const page = agentPath(agent.id);
  return <section className="desk-solo" aria-label={`${agent.name}’s desk`} data-agent={agent.id}
    style={{ '--c': display?.mark.bg } as React.CSSProperties}>
    <header className="desk-solo-hero">
      <a className="desk-solo-face" href={page} onClick={open} aria-label={`Open ${agent.name} agent window`}>
        <AgentFace display={display} name={agent.name} state={faceState(state, !!needs)} size={192} />
      </a>
      <div className="min-w-0">
        <h2><a href={page} onClick={open}>{agent.name}</a></h2>
        {about && <p className="desk-solo-about" title={about}>{about}</p>}
        <p className="desk-solo-state">{agentStateLine(state, 0, needs)}</p>
      </div>
      <a className="desk-home-open" href={page} onClick={open}>Open {agent.name} ›</a>
    </header>
    <div className="desk-solo-columns">{children}</div>
  </section>;
}
export default function Home({ go = path => location.assign(path) }: { go?: (path:string)=>void } = {}) {
  const roster = useDeskRoster();
  const displays = useDeskAgentDisplays();
  const { reading:conversations, status:threadStatus } = useHomeComms();
  const [phone,setPhone] = useState(()=>globalThis.window?.matchMedia?.('(max-width: 1023px)').matches ?? false);
  useEffect(()=>{const query=globalThis.window?.matchMedia?.('(max-width: 1023px)');if(!query)return;const change=()=>setPhone(query.matches);change();query.addEventListener('change',change);return()=>query.removeEventListener('change',change);},[]);
  const people = useDeskAgentDirectory();
  const agents = namedAgents(roster.records, people.status === 'live' ? people.records : []);
  const waiting = useDeskWaitingCounts();
  const statuses = useDeskAgentStatuses();
  const columns = roster.records.length <= 1 ? '' : roster.records.length === 2 || roster.records.length === 4 ? 'lg:grid-cols-2' : 'lg:grid-cols-3';
  const ordered = orderedAgents(agents);
  const names = new Map(agents.map(agent=>[agent.id,agent.name]));
  const fold = phone && ordered.length > 4;
  const opened = (ordered.find(a=>statuses.status==='live'&&latestStatus(statuses.records,a.id)?.state==='working')
    ?? ordered.find(a=>waiting.status==='live'&&(waiting.agents.get(a.id)??0)>0)
    ?? ordered.find(a=>conversations?.summaries.some(s=>s.agent===a.id&&s.unread)) ?? ordered[0])?.id;
  return <div className="desk-home h-full w-full min-w-0 max-w-full [overflow-wrap:anywhere]" data-attention-home="">
    <div className="desk-home-content">
        <NeedsBand waiting={waiting} names={names} go={go} />
        {roster.status !== 'live' ? <div className="desk-home-placeholder"><Unavailable status={roster.status} label="your agents" /></div> : !roster.records.length ? <Empty title="No agents of your own" text="Agents you own appear here, including when idle." /> : ordered.length === 1 ? <HomeCard key={ordered[0].id} agent={ordered[0]} names={names} solo
          needs={waiting.status === 'live' ? waiting.agents.get(ordered[0].id) ?? 0 : undefined}
          state={statuses.status === 'live' ? latestStatus(statuses.records, ordered[0].id)?.state : undefined}
          display={displays.find(d => d.id === ordered[0].id)} conversations={conversations} go={go} />
        : <div className={`desk-home-agents grid min-w-0 grid-cols-1 items-start gap-4 ${columns}`} aria-label="Your agents">
          {ordered.map(agent=>{
            const needs = waiting.status==='live'?(waiting.agents.get(agent.id)??0):undefined, first=(needs??0)>0;
            const status = statuses.status === 'live' ? latestStatus(statuses.records,agent.id) : undefined;
            if(fold && agent.id!==opened) {
              const summary=conversations?.summaries.find(s=>s.agent===agent.id);
              const unread=summary?.unread??0, thread=summary?.first??summary?.last;
              return <WithDoing key={agent.id} agent={agent.id}>{doing=>{
                const count=doing.items.length, state=shownState(status?.state,count), word=agentStateLine(status?.state,count,needs);
                return <section className="desk-home-compact" data-agent={agent.id} aria-label={`${agent.name} card`}>
                <Row aria-label={`Open ${agent.name} conversation`} title={agent.name} meta={word}
                  icon={<AgentFace display={displays.find(d=>d.id===agent.id)} name={agent.name} state={faceState(state,!!first)} size={32}/>}
                  trailing={<span className="desk-home-flags"><span role="img" className="desk-home-dot" data-state={state} aria-label={word}/>{first&&<span>ASK</span>}<span aria-label={threadStatus==='live'?`${unread} unread threads`:'Conversations unavailable'}>{threadStatus==='live'?(unread?`${unread} unread`:''):'?'}</span></span>}
                  onClick={()=>go(thread?threadPath(thread.thread):'/p/comms-preview')} />
                <Doing doing={doing} name={agent.name} names={names} go={go} compact />
              </section>;}}</WithDoing>;
            }
            return <HomeCard key={agent.id} agent={agent} names={names} needs={needs} state={status?.state}
              display={displays.find(d=>d.id===agent.id)} conversations={conversations} go={go} />;
          })}
        </div>}
    </div>
  </div>;
}
