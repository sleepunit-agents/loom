import { taskSegment } from '../tasks/route';
import type { LiveRecord } from '../../data';
export interface Ask extends LiveRecord {
  agent?: string; project?: string; member?: string;
  ask: string; why?: string; if_yes?: string; if_no?: string; href?: string; refs?: string[];
  answers?: 'yes-no' | 'words'; sourceManaged?: true;
  waits_on?: { approval: string } | { task: string };
  source: { kind: 'conversation' | 'approval' | 'task' | 'piece'; id: string };
  state: 'open' | 'answered' | 'resolved'; createdAt: number; changedAt: number;
  answer?: { kind: string; text?: string; by: { kind: string; id: string }; at: number };
  resolution?: string;
}
export type Answer = { kind: 'yes' | 'no' | 'done' | 'dismiss' } | { kind: 'words'; text: string };
export function inFolder(ask: Ask, folder: string) {
  return folder === 'fyi' ? ask.state === 'resolved' : folder === 'answered' ? ask.state === 'answered' : ask.state === 'open' && (!folder.startsWith('agent:') || ask.agent === folder.slice(6));
}
export function matches(ask: Ask, query: string) {
  const text = [ask.ask, ask.why, ask.agent, ask.project, ask.id, ask.resolution, ...(ask.refs ?? [])].join(' ').toLowerCase();
  return query.toLowerCase().trim().split(/\s+/).every(word => text.includes(word));
}
/** A central answer cannot apply another piece's decision. Its app owns that action. */
export function decisionLink(ask: Ask): { path: string; label: string } | undefined {
  const approval = ask.waits_on && 'approval' in ask.waits_on ? ask.waits_on.approval : ask.source.kind === 'approval' ? ask.source.id : undefined;
  if (approval) return { path: `/p/approvals-preview/approval/${encodeURIComponent(approval)}`, label: 'Open approval' };
  const task = ask.waits_on && 'task' in ask.waits_on ? ask.waits_on.task : ask.source.kind === 'task' ? ask.source.id : undefined;
  if (task !== undefined) return { path: `/p/tasks-preview/task/${taskSegment(task)}`, label: 'Open task' };
}
export function safeHref(href?: string) {
  if (!href) return undefined;
  try { const url = new URL(href); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}

/** One visible decision: a same-audience conversation wait represents its source
 * approval. Raw records remain available for direct navigation/fresh checks. */
export function listedAsks(records: readonly Ask[]): Ask[] {
  const key = (approval: string, a: Ask) => JSON.stringify([approval,a.agent,a.project,a.member]);
  const representative = new Map<string,Ask>();
  for (const a of records) {
    if (a.state!=='open' || a.sourceManaged || a.source?.kind!=='conversation' || !a.waits_on || !('approval' in a.waits_on)) continue;
    const id=key(a.waits_on.approval,a),old=representative.get(id);
    if (!old || a.createdAt<old.createdAt || a.createdAt===old.createdAt && a.id.localeCompare(old.id)<0) representative.set(id,a);
  }
  return records.filter(a=>{
    if (a.state!=='open') return true;
    if (a.sourceManaged && a.source?.kind==='approval') return !representative.has(key(a.source.id,a));
    if (!a.sourceManaged && a.source?.kind==='conversation' && a.waits_on && 'approval' in a.waits_on) return representative.get(key(a.waits_on.approval,a))===a;
    return true;
  });
}
