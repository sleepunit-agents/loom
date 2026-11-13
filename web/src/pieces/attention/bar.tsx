import type { ReactNode } from 'react';
import { useRecords } from '../../data';
import { Ticker, type TickPart } from '../../ticker';
import { latestStatus, namedAgents, openAsks, orderedAgents, type AgentPerson, type AgentStatus, type OwnedAgent } from './home-model';
import type { Ask } from './model';
import './bar.css';
import { BarClock, BarStatus } from './bar-system';

export interface BarProps { title: string; go(path: string): void; actions: ReactNode }
/** The bar reads the same policy-filtered facts as Home. No legacy shell or saved copy. */
export default function AttentionBar({ title, go, actions }: BarProps) {
  const roster = useRecords<OwnedAgent>('attention.ownedAgent');
  const people = useRecords<AgentPerson>('person');
  const statuses = useRecords<AgentStatus>('attention.agent');
  const asks = useRecords<Ask>('attention.ask');
  const agents = orderedAgents(namedAgents(roster.status === 'live' ? roster.records : [], people.status === 'live' ? people.records : []));
  const live = [roster, statuses, asks].every(s => s.status === 'live');
  const parts: TickPart[] = roster.status !== 'live' ? [{text:'Your agents are unavailable'}] : [
    {text:`${agents.length} agent${agents.length===1?'':'s'}`,href:'/'},
    ...agents.map(agent => {
      const status = statuses.status === 'live' ? latestStatus(statuses.records,agent.id) : undefined;
      return {text:`${agent.name} · ${status ? status.work || (status.state === 'working' ? 'Working' : status.state === 'waiting' ? 'Waiting' : status.state === 'offline' ? 'Unavailable' : 'Nothing right now') : 'Status unavailable'}`,href:'/p/home-preview'};
    }),
  ];
  const count = asks.status === 'live' ? openAsks(asks.records).length : undefined;
  return <header className="next-status-bar">
    <div className="next-status-line loom-pbar">
      <div className="next-status-start"><BarClock /><span className="next-system-separator" aria-hidden="true">·</span><div className="loom-pbar__name"><h1>{title}</h1></div></div>
      <Ticker live={live} parts={parts} go={go} />
      <div className="next-status-end">
        <span className="loom-pbar__brand" aria-label="loom">LOOM<i aria-hidden="true">//</i>OS</span>
        <span className="next-system-separator" aria-hidden="true">·</span>
        <BarStatus roster={agents} statuses={statuses.status==='live'?statuses.records:[]} available={roster.status==='live'&&statuses.status==='live'} live={live} go={go} />
        <a className="loom-pbar__needs loom-data" href="/p/inbox-preview" aria-label={count===undefined?'Needs you: unavailable':`${count} need${count===1?'s':''} you`} onClick={e=>{if(e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;e.preventDefault();go('/p/inbox-preview');}}>{count??'?'}</a>
        {actions}
      </div>
    </div>
  </header>;
}
