import { useDeskWaitingCounts } from './waiting';
import { useDeskAgentDirectory } from './agent-directory';
import { useDeskAgentStatuses } from './agent-status';
import { useDeskRoster } from './roster';
import { Ticker, type TickPart } from '../../ticker';
import { agentPath, latestStatus, namedAgents, orderedAgents } from './home-model';
import './bar.css';
import { useDataQuery } from '../../data/graphql';
import { BarClock, BarStatus } from './bar-system';
import { useDeskStats } from './bar-stats';

const workQuery = 'query DeskBarWork($agents: [String!]!) { agentsAtWork(agents: $agents) }';

export interface BarProps { title: string; go(path: string): void }
/** The bar reads the same policy-filtered facts as Home. No legacy shell or saved copy. */
export default function AttentionBar({ title, go }: BarProps) {
  const stats = useDeskStats();
  const roster = useDeskRoster();
  const people = useDeskAgentDirectory();
  const statuses = useDeskAgentStatuses();
  const waiting = useDeskWaitingCounts();
  const agents = orderedAgents(namedAgents(roster.status === 'live' ? roster.records : [], people.status === 'live' ? people.records : []));
  const work = useDataQuery<{agentsAtWork: string[]}>(workQuery, {agents: agents.map(agent => agent.id)}, {pause: !agents.length});
  const current = work.status === 'live' ? work.data?.agentsAtWork : undefined;
  const active = new Set(current);
  const reports = agents.map(agent => ({
    agent, status: statuses.status === 'live' ? latestStatus(statuses.records, agent.id) : undefined,
  }));
  const live = [roster, statuses, waiting].every(s => s.status === 'live') && (!agents.length || !!current);
  const known = roster.status === 'live' && statuses.status === 'live' && (!agents.length || !!current)
    && reports.every(({agent, status}) => active.has(agent.id) || status);
  const working = reports.filter(({agent, status}) => active.has(agent.id) || status?.state === 'working').length;
  const parts: TickPart[] = roster.status !== 'live' ? [{text:'Your agents are unavailable'}] : [
    {text:`${agents.length} agent${agents.length===1?'':'s'}`,href:'/'},
    ...reports.map(({agent, status}) => {
      if (active.has(agent.id) && status?.state !== 'working') return {text:`${agent.name} · Working`,href:agentPath(agent.id)};
      if (!current && status?.state !== 'working') return {text:`${agent.name} · Status unavailable`,href:agentPath(agent.id)};
      return {text:`${agent.name} · ${status ? status.work || (status.state === 'working' ? 'Working' : status.state === 'waiting' ? 'Waiting' : status.state === 'offline' ? 'Unavailable' : 'Nothing right now') : 'Status unavailable'}`,href:agentPath(agent.id)};
    }),
  ];
  parts.push(...stats.parts);
  const count = waiting.status === 'live' ? waiting.total : undefined;
  return <header className="next-status-bar">
    <div className="next-status-line loom-pbar">
      <div className="next-status-start"><BarClock /><span className="next-system-separator" aria-hidden="true">·</span><div className="loom-pbar__name"><h1>{title}</h1></div></div>
      <Ticker live={live} parts={parts} go={go} />
      <div className="next-status-end">
        <span className="loom-pbar__brand" aria-label="loom">LOOM<i aria-hidden="true">//</i>OS</span>
        <span className="next-system-separator" aria-hidden="true">·</span>
        <BarStatus boxes={stats.enrolled} total={agents.length} working={working} known={known} live={live} go={go} />
        <a className="loom-pbar__needs loom-data" href="/p/inbox-preview" aria-label={count===undefined?'Needs you: unavailable':`${count} need${count===1?'s':''} you`} onClick={e=>{if(e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;e.preventDefault();go('/p/inbox-preview');}}>{count??'?'}</a>
      </div>
    </div>
  </header>;
}
