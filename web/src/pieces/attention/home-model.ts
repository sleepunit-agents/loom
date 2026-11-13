import type { LiveRecord } from '../../data';
import type { Ask } from './model';
export interface OwnedAgent extends LiveRecord { name: string }
export interface AgentStatus extends LiveRecord {
  agent: string; state: 'working' | 'waiting' | 'idle' | 'offline'; work: string; changedAt: number;
  jobs: { id: string; label: string; href?: string }[]; watched: { id: string; label: string; href?: string }[];
}
export const openAsks = (records: readonly Ask[]) => records.filter(ask => ask.state === 'open').sort((a,b) => a.createdAt-b.createdAt || a.id.localeCompare(b.id));
export const orderedAgents = (records: readonly OwnedAgent[]) => [...records].sort((a,b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
/** Multiple scoped reporters may describe one agent. Newest visible report wins, then stable id. */
export const latestStatus = (records: readonly AgentStatus[], agent: string) => records.filter(r => r.agent === agent).sort((a,b) => b.changedAt-a.changedAt || a.id.localeCompare(b.id))[0];
export const inboxPath = (ask?: Ask) => ask ? `/p/inbox-preview/ask/${encodeURIComponent(ask.id)}` : '/p/inbox-preview';
