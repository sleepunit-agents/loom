/** The `agents` brick: the member's agents as Home lists them (its roster, its order, its state line), one line
 * each, the name a chip that places that agent's own brick. */
import { useDataQuery } from '../data/graphql';
import { useDeskAgentStatuses } from '../pieces/attention/agent-status';
import { doingPhrase, useDoing } from '../pieces/attention/doing-model';
import { agentStateLine, latestStatus, orderedAgents, shownState, type AgentStatus } from '../pieces/attention/home-model';
import { useDeskRoster } from '../pieces/attention/roster';
import { useDeskWaitingCounts } from '../pieces/attention/waiting-counts';
import { AgentFace, FACE } from './agent-face';
import { agentMood, agentTone, useAgentNames } from './agents-data';
import { Few, Loading, More, Note, Row, Rows, State, Unavailable, count as said } from './brick-kit';
import type { Form } from './layout';

/** The desktop bar's read of which of these agents have work in hand (pieces/attention/bar.tsx). */
export const agentsAtWorkQuery = 'query BrickAgentsAtWork($agents:[String!]!){agentsAtWork(agents:$agents)}';

function AgentRow({ agent, state, needs, name }: { agent: string; state?: AgentStatus['state']; needs?: number; name(id: string): string }) {
  const doing = useDoing(agent), count = doing.items.length, shown = shownState(state, count);
  return (
    <Row place={{ brick: 'agent', params: { agent } }}
      title={<span className="board-agent-name"><AgentFace agent={agent} state={agentMood(shown, needs)} size={FACE.row} />{name(agent)}</span>}
      end={<State tone={agentTone(shown, needs)}>{agentStateLine(state, count, needs)}</State>}>
      {doing.items[0] && <p className="board-note board-excerpt">{doingPhrase(doing.items[0], name)}{count + doing.more > 1 && <span className="board-agents-more"> +{count + doing.more - 1} more</span>}</p>}
    </Row>
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
    return <p className="board-brief">{said(agents.length, 'agent')}{working === undefined ? '' : ` · ${working} working`}{waiting.status === 'live' ? ` · ${asking} waiting on you` : ''}</p>;
  }
  if (!agents.length) return <Note>No agents of your own.</Note>;
  return <div className="board-agents"><Few of={agents} first={agents.length}>{(shown, hidden) => <><Rows beside>{shown.map((agent) => <AgentRow key={agent} agent={agent} name={name} needs={needs(agent)} state={statuses.status === 'live' ? latestStatus(statuses.records, agent)?.state : undefined} />)}</Rows><More n={hidden} /></>}</Few></div>;
}
