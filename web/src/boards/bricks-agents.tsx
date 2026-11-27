/** The `agents` brick: the member's agents as Home lists them (its roster, its order, its state line), one line
 * each, the name a chip that places that agent's own brick. */
import { useDataQuery } from '../data/graphql';
import { useDeskAgentStatuses } from '../pieces/attention/agent-status';
import { doingPhrase, useDoing } from '../pieces/attention/doing-model';
import { agentStateLine, latestStatus, orderedAgents, shownState, type AgentStatus } from '../pieces/attention/home-model';
import { useDeskRoster } from '../pieces/attention/roster';
import { useDeskWaitingCounts } from '../pieces/attention/waiting-counts';
import { useAgentNames } from './agents-data';
import { Chip, Loading, Unavailable } from './bricks';
import type { Form } from './layout';

/** The desktop bar's read of which of these agents have work in hand (pieces/attention/bar.tsx). */
export const agentsAtWorkQuery = 'query BrickAgentsAtWork($agents:[String!]!){agentsAtWork(agents:$agents)}';

function Row({ agent, state, needs, name }: { agent: string; state?: AgentStatus['state']; needs?: number; name(id: string): string }) {
  const doing = useDoing(agent), count = doing.items.length;
  return (
    <div className="board-line">
      <Chip place={{ brick: 'agent', params: { agent } }}>{name(agent)}</Chip>
      <span className="board-state" data-running={shownState(state, count) === 'working'}>{agentStateLine(state, count, needs)}</span>
      {doing.items[0] && <span>{doingPhrase(doing.items[0], name)}</span>}
      {count + doing.more > 1 && <span className="text-muted-foreground">+{count + doing.more - 1} more</span>}
    </div>
  );
}

export function Agents({ form }: { form: Form }) {
  const roster = useDeskRoster(), statuses = useDeskAgentStatuses(), waiting = useDeskWaitingCounts(), name = useAgentNames();
  const agents = orderedAgents(roster.records).map((a) => a.id);
  const work = useDataQuery<{ agentsAtWork: string[] }>(agentsAtWorkQuery, { agents }, { keep: true, pause: form !== 'compact' || !agents.length });
  if (roster.status === 'loading') return <Loading />;
  if (roster.status !== 'live') return <Unavailable what="roster" />;
  const needs = (agent: string) => (waiting.status === 'live' ? waiting.agents.get(agent) ?? 0 : undefined);
  if (form === 'compact') {
    const working = work.status === 'live' && Array.isArray(work.data?.agentsAtWork) ? work.data.agentsAtWork.filter((a) => agents.includes(a)).length : undefined;
    const asking = agents.filter((a) => (needs(a) ?? 0) > 0).length;
    return <p className="board-brief">{agents.length} {agents.length === 1 ? 'agent' : 'agents'}{working === undefined ? '' : ` · ${working} working`}{waiting.status === 'live' ? ` · ${asking} waiting on you` : ''}</p>;
  }
  if (!agents.length) return <p className="text-muted-foreground">No agents of your own.</p>;
  return <>{agents.map((agent) => <Row key={agent} agent={agent} name={name} needs={needs(agent)} state={statuses.status === 'live' ? latestStatus(statuses.records, agent)?.state : undefined} />)}</>;
}
