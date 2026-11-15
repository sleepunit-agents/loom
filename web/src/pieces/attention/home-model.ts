import type { LiveRecord } from '../../data';
import type { Ask } from './model';
import { listedAsks } from './model';
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
export const openAsks = (records: readonly Ask[]) => listedAsks(records).filter(ask => ask.state === 'open').sort((a,b) => a.createdAt-b.createdAt || a.id.localeCompare(b.id));
export const orderedAgents = <T extends OwnedAgent>(records: readonly T[]) => [...records].sort((a,b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));
/** Multiple scoped reporters may describe one agent. Newest visible report wins, then stable id. */
export const latestStatus = (records: readonly AgentStatus[], agent: string) => records.filter(r => r.agent === agent).sort((a,b) => b.changedAt-a.changedAt || a.id.localeCompare(b.id))[0];
export const inboxPath = (ask?: Ask) => ask ? `/p/inbox-preview/ask/${encodeURIComponent(ask.id)}` : '/p/inbox-preview';

export const agentPath = (agent: string) => `/p/agents-preview/agent/${encodeURIComponent(agent)}`;
