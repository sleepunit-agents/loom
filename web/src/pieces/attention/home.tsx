import { useDeskWaitingCounts, WaitingRow, waitingPath } from './waiting';
import { useDeskAgentDisplays } from './agent-displays';
import { useDeskRecentActivity } from './recent-activity';
import { useDeskAgentDirectory } from './agent-directory';
import { useDeskAgentStatuses } from './agent-status';
import { useDeskRoster } from './roster';
import { stamp } from './time';
import { agentPath } from './home-model';
import { HomeSteps } from './home-steps';
import { Doing, WithDoing } from './doing';
import { LastAnswer } from './last-answer';
import { HomeConversations, HomeComposer, useHomeComms, threadPath } from './home-comms';
import AgentFace, { faceState } from './agent-face';
import { NeedsBand } from './needs-band';
import './home.css';
import { useEffect, useState } from 'react';
import type { Snapshot } from '../../data';
import { Button, Empty, Error, List, Loading, Row } from '../../kit';
import { agentStateWord, latestStatus, namedAgents, orderedAgents, shownState } from './home-model';
function Unavailable({ status, label }: { status: Snapshot['status']; label: string }) {
  return status === 'loading' ? <Loading label={`Opening ${label}…`} /> : <Error title={`Couldn’t load ${label}`} text={status === 'denied' ? 'Sign in with access to see this.' : 'Waiting for connection.'} />;
}
export default function Home({ go = path => location.assign(path) }: { go?: (path:string)=>void } = {}) {
  const roster = useDeskRoster();
  const activity = useDeskRecentActivity();
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
        {roster.status !== 'live' ? <Unavailable status={roster.status} label="your agents" /> : !roster.records.length ? <Empty title="No agents of your own" text="Agents you own appear here, including when idle." /> : <div className={`desk-home-agents grid min-w-0 grid-cols-1 items-start gap-4 ${columns}`} aria-label="Your agents">
          {ordered.map(agent=>{
            const needs = waiting.status==='live'?(waiting.agents.get(agent.id)??0):undefined, first=(needs??0)>0;
            const status = statuses.status === 'live' ? latestStatus(statuses.records,agent.id) : undefined;
            if(fold && agent.id!==opened) {
              const summary=conversations?.summaries.find(s=>s.agent===agent.id);
              const unread=summary?.unread??0, thread=summary?.first??summary?.last;
              return <WithDoing key={agent.id} agent={agent.id}>{doing=>{
                const count=doing.items.length, state=shownState(status?.state,count), word=first?'Needs you':agentStateWord(status?.state,count);
                return <section className="desk-home-compact" data-agent={agent.id} aria-label={`${agent.name} card`}>
                <Row aria-label={`Open ${agent.name} conversation`} title={agent.name} meta={word}
                  icon={<AgentFace display={displays.find(d=>d.id===agent.id)} name={agent.name} state={faceState(state,!!first)} size={32}/>}
                  trailing={<span className="desk-home-flags"><span role="img" className="desk-home-dot" data-state={state} aria-label={word}/>{first&&<span>ASK</span>}<span aria-label={threadStatus==='live'?`${unread} unread threads`:'Conversations unavailable'}>{threadStatus==='live'?(unread?`${unread} unread`:''):'?'}</span></span>}
                  onClick={()=>go(thread?threadPath(thread.thread):'/p/comms-preview')} />
                <Doing doing={doing} name={agent.name} names={names} go={go} compact />
              </section>;}}</WithDoing>;
            }
            return <WithDoing key={agent.id} agent={agent.id}>{doing=><section aria-label={`${agent.name} card`} data-agent={agent.id} className="desk-home-card grid min-w-0 gap-3">
              <header className="desk-home-identity"><a className="inline-flex shrink-0 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 [&>*]:pointer-events-none" aria-label={`Open ${agent.name} agent window`} href={agentPath(agent.id)} onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();go(agentPath(agent.id));}}><AgentFace display={displays.find(d=>d.id===agent.id)} name={agent.name} state={faceState(shownState(status?.state,doing.items.length), !!first)} size={96} /></a><h2 className="text-xl font-semibold">{agent.name}</h2>{agent.personPath && <Button variant="outline" size="sm" aria-label={`${agent.name} in People`} onClick={()=>go(agent.personPath!)}>People</Button>}<p>{agentStateWord(status?.state,doing.items.length)}{needs ? ` · ${needs} needs you` : ''}</p></header>
              <Doing doing={doing} name={agent.name} names={names} go={go} />
              <div role="region" aria-label={`${agent.name} desk details`} tabIndex={0} className="desk-home-details grid min-w-0 gap-3 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 lg:max-h-[70dvh] lg:overflow-y-auto lg:pr-2">
              {waiting.status !== 'live' ? <Unavailable status={waiting.status} label="agent waiting items" /> : first ? <List label={`${agent.name} first waiting item`}><WaitingRow agent={agent.id} go={go}/></List> : <p>Nothing needs you from {agent.name}.</p>}
              {(needs??0) > 1 && <Button variant="outline" onClick={()=>go(waitingPath())}>Inbox · +{needs!-1} more</Button>}
              <LastAnswer key={agent.id} agent={agent.id} name={agent.name} />
              <div className="desk-home-columns">
                <div className="grid min-w-0 content-start gap-4">
              <section aria-label={`${agent.name} reported work`} className="grid min-w-0 gap-3"><h3>Now</h3>{statuses.status !== 'live' ? <Unavailable status={statuses.status} label="agent status" /> : <><p className="whitespace-pre-wrap">{status?.work || 'Nothing right now'}</p>{status && <>
                <p>Reported <time dateTime={new Date(status.changedAt).toISOString()}>{stamp(status.changedAt)}</time></p>
              </>}</>}</section>
                  <HomeConversations agent={agent.id} name={agent.name} reading={conversations} go={go} />
                </div>
                <div className="grid min-w-0 content-start gap-4">
                  <HomeSteps agent={agent.id} name={agent.name} activity={activity} go={go} />
                </div>
              </div>
              </div>
              <HomeComposer agent={agent.id} name={agent.name} reading={conversations} go={go} />
            </section>}</WithDoing>;
          })}
        </div>}
    </div>
  </div>;
}
