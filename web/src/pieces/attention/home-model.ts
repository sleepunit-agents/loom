import type { LiveRecord } from '../../data';
import type { Ask } from './model';
import { safeHref } from './model';
export interface ReportedItem { id: string; label: string; href?: string }
export interface OwnedAgent extends LiveRecord { name: string }
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
export const openAsks = (records: readonly Ask[]) => records.filter(ask => ask.state === 'open').sort((a,b) => a.createdAt-b.createdAt || a.id.localeCompare(b.id));
export const orderedAgents = (records: readonly OwnedAgent[]) => [...records].sort((a,b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
/** Multiple scoped reporters may describe one agent. Newest visible report wins, then stable id. */
export const latestStatus = (records: readonly AgentStatus[], agent: string) => records.filter(r => r.agent === agent).sort((a,b) => b.changedAt-a.changedAt || a.id.localeCompare(b.id))[0];
export const inboxPath = (ask?: Ask) => ask ? `/p/inbox-preview/ask/${encodeURIComponent(ask.id)}` : '/p/inbox-preview';
