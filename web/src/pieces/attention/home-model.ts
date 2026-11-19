import type { LiveRecord } from '../../data';
export interface OwnedAgent extends LiveRecord { name: string; position?: number }
/** Only the shared directory identifies an agent; relationship cards are not its display identity. */
export interface AgentPerson extends LiveRecord { slug: string; name: string; kind: 'person' | 'agent'; agent?: string }
export function namedAgents(agents: readonly OwnedAgent[], people: readonly AgentPerson[]) {
  return agents.map(agent => {
    const person = people.find(p => p.id === `commons:${agent.id}` && p.slug === agent.id && p.agent === undefined && p.kind === 'agent' && p.name.trim());
    return { ...agent, name: person?.name ?? agent.name, ...(person ? { personPath: `/p/people-preview/person/${encodeURIComponent(person.slug)}` } : {}) };
  });
}
export interface AgentStatus extends LiveRecord {
  agent: string; state: 'working' | 'waiting' | 'idle' | 'offline'; work: string; changedAt: number;
}
export const orderedAgents = <T extends OwnedAgent>(records: readonly T[]) => [...records].sort((a,b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));
/** Multiple scoped reporters may describe one agent. Newest visible report wins, then stable id. */
export const latestStatus = (records: readonly AgentStatus[], agent: string) => records.filter(r => r.agent === agent).sort((a,b) => b.changedAt-a.changedAt || a.id.localeCompare(b.id))[0];

export const agentPath = (agent: string) => `/p/agents-preview/agent/${encodeURIComponent(agent)}`;
/** The word beside an agent's name, for Home and the rail alike. It agrees with the list of what the agent is
 * doing: with anything on that list it is working, whatever it last reported. */
export function agentStateWord(state: AgentStatus['state'] | undefined, doing = 0): string {
  return doing > 0 ? 'Working' : state === 'offline' ? 'Unavailable' : state === 'working' ? 'Working' : state === 'waiting' ? 'Waiting' : state ? 'Quiet' : 'No status reported';
}
/** The state its face and dot draw: working while it has something on its list. */
export const shownState = (state: AgentStatus['state'] | undefined, doing = 0): AgentStatus['state'] | undefined => doing > 0 ? 'working' : state;
