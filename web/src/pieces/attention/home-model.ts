import type { LiveRecord } from '../../data';
import type { RuntimeRecords } from '../../../../src/pieces/runtime/records';
import type { Ask } from './model';
import { listedAsks, safeHref } from './model';
export interface ReportedItem { id: string; label: string; href?: string }
export interface OwnedAgent extends LiveRecord { name: string }
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
  jobs: ReportedItem[]; watched: ReportedItem[];
}
/** Reports may link to a new-side app or an HTTP(S) source, never an old-side route. */
export function reportLink(href?: string): { href: string; app: boolean } | undefined {
  if (!href || /[\s\\]/.test(href)) return;
  if (href.startsWith('/p/')) {
    const url = new URL(href, 'https://loom.invalid');
    if (url.pathname.startsWith('/p/')) return { href: url.pathname + url.search + url.hash, app: true };
    return;
  }
  const external = safeHref(href);
  if (external) return { href: external, app: false };
}
export const openAsks = (records: readonly Ask[]) => listedAsks(records).filter(ask => ask.state === 'open').sort((a,b) => a.createdAt-b.createdAt || a.id.localeCompare(b.id));
export const orderedAgents = <T extends OwnedAgent>(records: readonly T[]) => [...records].sort((a,b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
/** Multiple scoped reporters may describe one agent. Newest visible report wins, then stable id. */
export const latestStatus = (records: readonly AgentStatus[], agent: string) => records.filter(r => r.agent === agent).sort((a,b) => b.changedAt-a.changedAt || a.id.localeCompare(b.id))[0];
export const inboxPath = (ask?: Ask) => ask ? `/p/inbox-preview/ask/${encodeURIComponent(ask.id)}` : '/p/inbox-preview';

export type RuntimeJob = RuntimeRecords['job'] & LiveRecord;
/** Runtime identity keeps concurrent jobs separate, even with identical titles. */
export function currentRuntimeJobs(records: readonly RuntimeJob[], agent: string): RuntimeJob[] {
  const rank: Partial<Record<RuntimeJob['state'], number>> = { uncertain: 0, running: 1, starting: 2, waiting: 3, queued: 4 };
  return records.filter(job => job.agent === agent && rank[job.state] !== undefined)
    .sort((a,b) => rank[a.state]! - rank[b.state]! || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
